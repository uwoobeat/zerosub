import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAIN_ACCOUNT_ID, StateStore, StoredAccountSchema, salvageState } from "./state";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zerosub-state-"));
});

afterEach(async () => {
  await chmod(join(dir, "state.json"), 0o600).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const account = {
  id: "claude-main",
  family: "claude",
  label: "me",
  kind: "main",
  home: null,
  createdAt: "2026-09-01T00:00:00Z",
};

describe("salvageState", () => {
  it("keeps valid entries and drops only the broken ones", () => {
    const { state, dropped } = salvageState({
      accounts: [account, { id: "broken", family: "gemini" }],
      bindings: { a: { accountId: "claude-main", source: "thread", at: "x" }, b: { accountId: 7 } },
      sessions: {},
      defaults: { claude: "claude-main", codex: null },
    });
    expect(dropped).toBe(true);
    expect(state.accounts.map((entry) => entry.id)).toEqual(["claude-main"]);
    expect(Object.keys(state.bindings)).toEqual(["a"]);
    expect(state.defaults.claude).toBe("claude-main");
  });
});

describe("StateStore", () => {
  it("backs up a file it can't parse instead of silently discarding it", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, "{ not json");
    const store = new StateStore(path);
    expect((await store.read()).accounts).toEqual([]);
    const backups = (await readdir(dir)).filter((name) => name.startsWith("state.json.bad-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0] ?? ""), "utf8")).toBe("{ not json");
  });

  it("never overwrites a file it couldn't read", async () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ accounts: [account] }));
    await chmod(path, 0o000);
    const store = new StateStore(path);
    await expect(store.update(() => undefined)).rejects.toThrow();
    await chmod(path, 0o600);
    expect(JSON.parse(await readFile(path, "utf8")).accounts).toHaveLength(1);
  });
});

describe("scoped limits", () => {
  it("adds an empty scope list to older accounts and keeps the account-wide limit", () => {
    const parsed = StoredAccountSchema.parse({ ...account, limitedUntil: "2026-09-23T14:00:00Z", limitKind: "window" });
    expect(parsed.scopedLimits).toEqual([]);
    expect(parsed.limitedUntil).toBe("2026-09-23T14:00:00Z");
    expect(parsed.limitKind).toBe("window");
  });

  it("drops a malformed scope list without dropping the account", () => {
    const parsed = StoredAccountSchema.parse({ ...account, scopedLimits: [{ scopeId: 7 }] });
    expect(parsed.scopedLimits).toEqual([]);
    const { state, dropped } = salvageState({ accounts: [{ ...account, scopedLimits: [{ scopeId: 7 }] }] });
    expect(dropped).toBe(false);
    expect(state.accounts[0]?.limitedUntil).toBeNull();
    expect(state.accounts[0]?.scopedLimits).toEqual([]);
  });

  it("persists per-scope limits atomically next to the account-wide limit", async () => {
    const path = join(dir, "state.json");
    await writeFile(
      path,
      JSON.stringify({ accounts: [{ ...account, id: "antigravity-main", family: "antigravity", limitedUntil: "2026-09-23T20:00:00Z" }] }),
    );
    const store = new StateStore(path);
    await store.update((draft) => {
      draft.accounts[0]?.scopedLimits.push({
        scopeId: "gemini",
        limitedUntil: "2026-09-23T14:00:00Z",
        limitedAt: "2026-09-23T09:00:00Z",
        kind: "window",
      });
    });

    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.accounts[0].limitedUntil).toBe("2026-09-23T20:00:00Z");
    expect(saved.accounts[0].scopedLimits).toEqual([
      {
        scopeId: "gemini",
        limitedUntil: "2026-09-23T14:00:00Z",
        limitedAt: "2026-09-23T09:00:00Z",
        kind: "window",
      },
    ]);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("defaults the Antigravity main account id and default slot", async () => {
    expect(MAIN_ACCOUNT_ID.antigravity).toBe("antigravity-main");
    expect((await new StateStore(join(dir, "state.json")).read()).defaults.antigravity).toBeNull();
  });

  it("preserves Antigravity group limits alongside Codex continuation chains", async () => {
    const path = join(dir, "state.json");
    const store = new StateStore(path);
    const scopedLimits = [{ scopeId: "gemini", limitedUntil: "2026-10-30T14:00:00Z", limitedAt: "2026-10-29T09:00:00Z", kind: "window" as const }];
    const chain = { activeAgentId: "codex-agent", members: { "codex-agent": { accountId: MAIN_ACCOUNT_ID.codex, identity: null, email: null, seen: {} } } };
    const antigravityChain = {
      activeAgentId: "agy-agent",
      members: {
        "agy-agent": {
          accountId: MAIN_ACCOUNT_ID.antigravity, home: null, identity: null, email: null,
          generation: 3, configKey: "native/model|mode|think|{}", seen: {},
        },
      },
    };
    await store.update((draft) => {
      draft.accounts = [
        StoredAccountSchema.parse({ ...account, id: MAIN_ACCOUNT_ID.codex, family: "codex" }),
        StoredAccountSchema.parse({ ...account, id: MAIN_ACCOUNT_ID.antigravity, family: "antigravity", scopedLimits }),
      ];
      draft.defaults.antigravity = MAIN_ACCOUNT_ID.antigravity;
      draft.continuations["codex-root"] = chain;
      draft.antigravityContinuations["agy-root"] = antigravityChain;
      draft.antigravityAccountGenerations[MAIN_ACCOUNT_ID.antigravity] = 3;
    });
    const reloaded = await new StateStore(path).read();
    expect(reloaded.defaults.antigravity).toBe(MAIN_ACCOUNT_ID.antigravity);
    expect(reloaded.accounts.find((entry) => entry.family === "antigravity")?.scopedLimits).toEqual(scopedLimits);
    expect(reloaded.continuations["codex-root"]).toEqual(chain);
    expect(reloaded.antigravityContinuations["agy-root"]).toEqual(antigravityChain);
    expect(reloaded.antigravityAccountGenerations[MAIN_ACCOUNT_ID.antigravity]).toBe(3);
  });

  it("loads older state with empty Antigravity continuation defaults and salvages AGY records independently", () => {
    const codex = {
      activeAgentId: "codex-agent",
      members: { "codex-agent": { accountId: MAIN_ACCOUNT_ID.codex, identity: null, email: null, seen: {} } },
    };
    const { state, dropped } = salvageState({
      accounts: [account],
      continuations: { "codex-root": codex },
      antigravityContinuations: {
        broken: { activeAgentId: "bad", members: { bad: { accountId: 4 } } },
      },
      antigravityAccountGenerations: { "antigravity-main": -1 },
    });

    expect(dropped).toBe(true);
    expect(state.continuations["codex-root"]).toEqual(codex);
    expect(state.antigravityContinuations).toEqual({});
    expect(state.antigravityAccountGenerations).toEqual({});
    expect(salvageState({ accounts: [account] }).state.antigravityContinuations).toEqual({});
  });
});
