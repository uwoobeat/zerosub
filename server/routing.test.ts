import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { applyEnv } from "./adapter";
import { chooseAccount, headroomScore, isLimited, isUsable, mostAvailable } from "./routing";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
    home: `/homes/${partial.id}`,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    scopedLimits: [],
    createdAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function stateWith(accounts: StoredAccount[], patch: Partial<StoredState> = {}): StoredState {
  return { ...emptyState(), accounts, ...patch };
}

function usage(percent: number): Usage {
  return {
    fetchedAt: "2026-09-23T11:59:00Z",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
    error: null,
    cached: false,
    resets: null,
  };
}

const GEMINI = { id: "gemini", label: "Gemini Models", models: ["gemini-3-pro"] } as const;
const THIRD_PARTY = { id: "3p", label: "Claude and GPT", models: ["claude-4", "gpt-5"] } as const;
const ARGON = { id: "argon", label: "Gemini 4 Argon", models: ["gemini-4-argon"] } as const;

function groupedUsage(percent: { unscoped: number; gemini?: number; third?: number; argon?: number }): Usage {
  const windows: Usage["windows"] = [
    { id: "account", label: "Monthly", usedPercent: percent.unscoped, resetsAt: null },
  ];
  for (const [key, scope] of [["gemini", GEMINI], ["third", THIRD_PARTY], ["argon", ARGON]] as const) {
    const value = percent[key];
    if (value === undefined) continue;
    windows.push({
      id: `${key}-window`,
      label: `${scope.label} window`,
      usedPercent: value,
      resetsAt: null,
      scope: { id: scope.id, label: scope.label, models: [...scope.models] },
    });
  }
  return { fetchedAt: "2026-09-23T11:59:00Z", windows, error: null, cached: false, resets: null };
}

function scopedLimit(scopeId: string, limitedUntil = "2026-09-23T14:00:00Z") {
  return { scopeId, limitedUntil, limitedAt: "2026-09-23T12:00:00Z", kind: "window" as const };
}

const base = {
  agentId: "agent-1",
  family: "claude" as const,
  now: NOW,
  autoSwitch: true,
  balanceNewAgents: false,
  portable: true,
};

describe("chooseAccount", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const personal = account({ id: "claude-personal" });

  it("uses the CLI login when nothing else is configured", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...base, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.bind).toBeNull();
  });

  it("follows the chosen default", () => {
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null, antigravity: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("prefers the agent's own binding over the default", () => {
    const state = stateWith([main, work, personal], {
      defaults: { claude: "claude-work", codex: null, antigravity: null },
      bindings: { "agent-1": { accountId: "claude-personal", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-personal");
  });

  it("ignores a binding to a removed account", () => {
    const state = stateWith([main, work], {
      bindings: { "agent-1": { accountId: "claude-gone", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-main");
  });

  it("skips an exhausted account for the roomiest usable one", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited, personal], { defaults: { claude: "claude-work", codex: null, antigravity: null } });
    const decision = chooseAccount(state, {
      ...base,
      reason: "resume",
      usageOf: (id) => (id === "claude-main" ? usage(80) : usage(10)),
    });
    expect(decision?.account.id).toBe("claude-personal");
    expect(decision?.bind?.source).toBe("auto");
    expect(decision?.skipped?.why).toBe("limited");
  });

  it("keeps an exhausted account when automatic switching is off", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited], { defaults: { claude: "claude-work", codex: null, antigravity: null } });
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
  });

  it("treats an expired limit as usable again", () => {
    const recovered = account({ id: "claude-work", limitedUntil: "2026-09-23T11:00:00Z" });
    const state = stateWith([main, recovered], { defaults: { claude: "claude-work", codex: null, antigravity: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("spreads new agents by headroom when balancing", () => {
    const state = stateWith([main, work, personal]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "create",
      usageOf: (id) => ({ "claude-main": usage(60), "claude-work": usage(5), "claude-personal": usage(30) })[id],
    });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind?.source).toBe("balance");
  });

  it("does not rebalance agents that already exist", () => {
    const state = stateWith([main, work]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "resume",
      usageOf: (id) => (id === "claude-work" ? usage(0) : usage(90)),
    });
    expect(decision?.account.id).toBe("claude-main");
  });

  it("returns null when the family has no accounts", () => {
    expect(chooseAccount(emptyState(), { ...base, reason: "create", usageOf: () => null })).toBeNull();
  });
});

describe("mostAvailable", () => {
  it("breaks ties toward the default account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null });
    const work = account({ id: "claude-work" });
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null, antigravity: null } });
    expect(mostAvailable(state, "claude", () => usage(20), NOW)?.id).toBe("claude-work");
  });

  it("never picks a signed-out account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null, signedIn: false });
    const state = stateWith([main]);
    expect(mostAvailable(state, "claude", () => usage(0), NOW)).toBeUndefined();
  });
});

describe("model-scoped limits", () => {
  const future = "2026-09-23T14:00:00Z";
  const antigravity = (id: string, scoped: StoredAccount["scopedLimits"] = []) =>
    account({ id, family: "antigravity", scopedLimits: scoped });

  it("blocks only the model group its scoped limit names", () => {
    const blocked = antigravity("antigravity-a", [scopedLimit("gemini")]);
    const current = groupedUsage({ unscoped: 5, gemini: 100, third: 10, argon: 10 });

    expect(isLimited(blocked, NOW, { model: "gemini-3-pro", usage: current })).toBe(true);
    expect(isLimited(blocked, NOW, { model: "claude-4", usage: current })).toBe(false);
    expect(isLimited(blocked, NOW, { model: "gpt-5", usage: current })).toBe(false);
  });

  it("lets an exhausted Argon group leave Claude and Gemini usable", () => {
    const blocked = antigravity("antigravity-a", [scopedLimit("argon")]);
    const current = groupedUsage({ unscoped: 5, gemini: 10, third: 10, argon: 100 });

    expect(isLimited(blocked, NOW, { model: "gemini-4-argon", usage: current })).toBe(true);
    expect(isLimited(blocked, NOW, { model: "gemini-3-pro", usage: current })).toBe(false);
    expect(isLimited(blocked, NOW, { model: "claude-4", usage: current })).toBe(false);
  });

  it("never applies a scoped limit to an unknown or unmapped model", () => {
    const blocked = antigravity("antigravity-a", [scopedLimit("gemini")]);
    const current = groupedUsage({ unscoped: 5, gemini: 100 });

    for (const model of [null, undefined, "", "not-a-model"]) {
      expect(isLimited(blocked, NOW, { model, usage: current })).toBe(false);
    }
    // An empty `models` list means the provider didn't map the scope; don't guess it covers anything.
    const unmapped = groupedUsage({ unscoped: 5 });
    unmapped.windows.push({
      id: "argon-window",
      label: "Argon",
      usedPercent: 100,
      resetsAt: null,
      scope: { id: "argon", label: "Argon", models: [] },
    });
    expect(isLimited(blocked, NOW, { model: "anything", usage: unmapped })).toBe(false);
  });

  it("doesn't guess when no usage proves the scope still covers the model", () => {
    const blocked = antigravity("antigravity-a", [scopedLimit("gemini")]);
    expect(isLimited(blocked, NOW, { model: "gemini-3-pro", usage: null })).toBe(false);
    expect(isLimited(blocked, NOW, { model: "gemini-3-pro", usage: usage(10) })).toBe(false);
    expect(isLimited(blocked, NOW, { model: "gemini-3-pro" })).toBe(false);
  });

  it("keeps an account-wide limit blocking every model", () => {
    const blocked = account({ id: "antigravity-main", family: "antigravity", limitedUntil: future });
    const current = groupedUsage({ unscoped: 5, gemini: 10, third: 10 });
    expect(isLimited(blocked, NOW, { model: null, usage: current })).toBe(true);
    expect(isLimited(blocked, NOW, { model: "gemini-3-pro", usage: current })).toBe(true);
    expect(isLimited(blocked, NOW)).toBe(true);
  });

  it("makes an account unusable only for the model the scoped limit covers", () => {
    const blocked = antigravity("antigravity-a", [scopedLimit("gemini")]);
    const current = groupedUsage({ unscoped: 5, gemini: 100, third: 10 });
    expect(isUsable(blocked, NOW, { model: "gemini-3-pro", usage: current })).toBe(false);
    expect(isUsable(blocked, NOW, { model: "claude-4", usage: current })).toBe(true);
  });

  it("ignores an expired scoped limit", () => {
    const recovered = antigravity("antigravity-a", [scopedLimit("gemini", "2026-09-23T11:00:00Z")]);
    const current = groupedUsage({ unscoped: 5, gemini: 100 });
    expect(isLimited(recovered, NOW, { model: "gemini-3-pro", usage: current })).toBe(false);
  });
});

describe("scope-aware headroom", () => {
  it("uses only the windows that apply to the model", () => {
    const current = groupedUsage({ unscoped: 30, gemini: 90, third: 20 });
    expect(headroomScore(current, "gemini-3-pro")).toBe(90);
    expect(headroomScore(current, "claude-4")).toBe(30);
    expect(headroomScore(current, "not-a-model")).toBe(30);
  });

  it("doesn't borrow a scoped number for an unknown model, or invent 0%", () => {
    const scopedOnly: Usage = {
      ...groupedUsage({ unscoped: 0, gemini: 90 }),
      windows: groupedUsage({ unscoped: 0, gemini: 90 }).windows.filter((window) => window.scope),
    };
    expect(headroomScore(scopedOnly, null)).toBe(50);
    expect(headroomScore(null)).toBe(50);
  });

  it("picks different accounts for different model groups", () => {
    const a = account({ id: "antigravity-a", family: "antigravity" });
    const b = account({ id: "antigravity-b", family: "antigravity" });
    const state = stateWith([a, b]);
    const usageOf = (id: string) =>
      id === a.id
        ? groupedUsage({ unscoped: 5, gemini: 95, third: 5 })
        : groupedUsage({ unscoped: 80, gemini: 10, third: 80 });

    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), "gemini-3-pro")?.id).toBe(b.id);
    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), "claude-4")?.id).toBe(a.id);
  });

  it("skips an account only for the scope whose limit applies", () => {
    const a = account({ id: "antigravity-a", family: "antigravity", scopedLimits: [scopedLimit("argon")] });
    const b = account({ id: "antigravity-b", family: "antigravity" });
    const state = stateWith([a, b]);
    const usageOf = (id: string) =>
      id === a.id
        ? groupedUsage({ unscoped: 5, gemini: 5, third: 5, argon: 100 })
        : groupedUsage({ unscoped: 80, gemini: 80, third: 80, argon: 0 });

    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), "gemini-4-argon")?.id).toBe(b.id);
    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), "claude-4")?.id).toBe(a.id);
  });

  it("doesn't let a scoped limit block an unknown model in ranking", () => {
    const a = account({ id: "antigravity-a", family: "antigravity", scopedLimits: [scopedLimit("argon")] });
    const b = account({ id: "antigravity-b", family: "antigravity" });
    const state = stateWith([a, b]);
    const usageOf = (id: string) =>
      id === a.id
        ? groupedUsage({ unscoped: 2, gemini: 20, third: 20, argon: 100 })
        : groupedUsage({ unscoped: 5, gemini: 5, third: 5, argon: 0 });

    expect(mostAvailable(state, "antigravity", usageOf, NOW)?.id).toBe(a.id);
  });
});

describe("scoped routing decisions", () => {
  const blocked = account({
    id: "antigravity-a",
    family: "antigravity",
    scopedLimits: [scopedLimit("gemini")],
  });
  const other = account({ id: "antigravity-b", family: "antigravity" });
  const state = stateWith([blocked, other]);
  const usageOf = (id: string) =>
    id === blocked.id
      ? groupedUsage({ unscoped: 10, gemini: 100, third: 10 })
      : groupedUsage({ unscoped: 50, gemini: 50, third: 50 });
  const antigravity = { ...base, family: "antigravity" as const, model: "gemini-3-pro" };

  it("moves away only for the model group the scoped limit covers", () => {
    const gemini = chooseAccount(state, { ...antigravity, reason: "resume", usageOf });
    expect(gemini?.account.id).toBe("antigravity-b");
    expect(gemini?.skipped?.why).toBe("limited");

    const claude = chooseAccount(state, { ...antigravity, model: "claude-4", reason: "resume", usageOf });
    expect(claude?.account.id).toBe("antigravity-a");
    expect(claude?.skipped).toBeNull();
  });

  it("leaves the default in place when the model is unknown", () => {
    const decision = chooseAccount(state, { ...antigravity, model: null, reason: "resume", usageOf });
    expect(decision?.account.id).toBe("antigravity-a");
    expect(decision?.skipped).toBeNull();
  });

  it("does not balance new Antigravity agents without a known model", () => {
    const fresh = stateWith([blocked, other], {
      defaults: { claude: null, codex: null, antigravity: "antigravity-b" },
    });
    const decision = chooseAccount(fresh, {
      ...base,
      family: "antigravity",
      balanceNewAgents: true,
      reason: "create",
      usageOf,
    });
    expect(decision?.account.id).toBe("antigravity-b");
    expect(decision?.bind).toBeNull();
  });

  it("balances new Antigravity agents when the model is known", () => {
    const decision = chooseAccount(state, {
      ...antigravity,
      balanceNewAgents: true,
      reason: "create",
      usageOf,
    });
    expect(decision?.account.id).toBe("antigravity-b");
    expect(decision?.bind?.source).toBe("balance");
  });
});

describe("non-portable conversations (Codex)", () => {
  const main = account({ id: "codex-main", family: "codex", kind: "main", home: null });
  const work = account({ id: "codex-work", family: "codex" });
  const codex = { ...base, family: "codex" as const, portable: false };

  it("pins a thread to the account it first opens on", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...codex, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-main");
    expect(decision?.bind).toMatchObject({ accountId: "codex-main", source: "thread" });
  });

  it("keeps an existing thread on its exhausted account instead of breaking it", () => {
    const limited = account({ id: "codex-main", family: "codex", kind: "main", home: null, limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([limited, work], {
      bindings: { "agent-1": { accountId: "codex-main", source: "thread", at: "x" } },
    });
    expect(chooseAccount(state, { ...codex, reason: "resume", usageOf: () => null })?.account.id).toBe("codex-main");
  });

  it("starts new agents on a usable account", () => {
    const limited = account({ id: "codex-main", family: "codex", kind: "main", home: null, limitedUntil: "2026-09-23T14:00:00Z" });
    const decision = chooseAccount(stateWith([limited, work]), { ...codex, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-work");
    expect(decision?.bind).toMatchObject({ accountId: "codex-work", source: "thread" });
  });
});

describe("applyEnv", () => {
  it("sets values and drops inherited overrides", () => {
    expect(applyEnv({ CODEX_HOME: "/homes/work", CODEX_SQLITE_HOME: null }, { KEEP: "1", CODEX_SQLITE_HOME: "/x" })).toEqual({
      KEEP: "1",
      CODEX_HOME: "/homes/work",
    });
  });
});

describe("disabled accounts", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const off = { disabled: true };

  it("routes around a disabled account but keeps the agent's own binding", () => {
    const pinned = stateWith([main, account({ id: "claude-work", ...off })], {
      bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(pinned, { ...base, reason: "refresh", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.skipped?.why).toBe("disabled");
    expect(decision?.bind).toBeNull(); // so the agent returns once the account is enabled again
  });

  it("skips a disabled default even with automatic switching off", () => {
    const state = stateWith([account({ id: "claude-main", kind: "main", home: null, ...off }), work]);
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind).toBeNull();
  });

  it("pins a new ChatGPT thread where it actually starts", () => {
    const codexMain = account({ id: "codex-main", family: "codex", kind: "main", home: null, ...off });
    const codexWork = account({ id: "codex-work", family: "codex" });
    const decision = chooseAccount(stateWith([codexMain, codexWork]), {
      ...base,
      family: "codex",
      portable: false,
      reason: "create",
      usageOf: () => null,
    });
    expect(decision?.account.id).toBe("codex-work");
    expect(decision?.bind).toMatchObject({ accountId: "codex-work", source: "thread" });
  });

  it("leaves an existing ChatGPT thread on its disabled account, since it can't move", () => {
    const codexMain = account({ id: "codex-main", family: "codex", kind: "main", home: null });
    const codexWork = account({ id: "codex-work", family: "codex", ...off });
    const state = stateWith([codexMain, codexWork], {
      bindings: { "agent-1": { accountId: "codex-work", source: "thread", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(state, { ...base, family: "codex", portable: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-work");
  });

  it("is never the most available account", () => {
    const state = stateWith([main, account({ id: "claude-work", ...off })]);
    const usageOf = (id: string) => usage(id === "claude-main" ? 90 : 5);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-main");
  });
});
