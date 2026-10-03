import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, Identity, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import { codexIdentityKey, identityRelation } from "./identity";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, type StoredAccount, type StoredState } from "./state";

describe("codexIdentityKey", () => {
  it("tells members of one workspace apart and ignores email case", () => {
    const alice = codexIdentityKey("ws-1", "Alice@Acme.com", "business");
    expect(alice).toBe("chatgpt|ws-1|alice@acme.com");
    expect(codexIdentityKey("ws-1", "bob@acme.com", "business")).not.toBe(alice);
    expect(codexIdentityKey("ws-1", "alice@acme.com", "business")).toBe(alice);
  });

  it("falls back to the workspace alone, then to email and plan", () => {
    expect(codexIdentityKey("ws-1", null, "business")).toBe("chatgpt|ws-1");
    expect(codexIdentityKey("ws-1", "  ", "business")).toBe("chatgpt|ws-1");
    expect(codexIdentityKey(null, "Alice@Acme.com", "plus")).toBe("chatgpt-email|alice@acme.com|plus");
    expect(codexIdentityKey(null, "alice@acme.com", null)).toBe("chatgpt-email|alice@acme.com|unknown");
    expect(codexIdentityKey(null, null, "plus")).toBeNull();
  });
});

describe("identityRelation", () => {
  const alice = "chatgpt|ws-1|alice@acme.com";
  const bob = "chatgpt|ws-1|bob@acme.com";

  it("compares member keys", () => {
    expect(identityRelation(alice, "alice@acme.com", alice)).toBe("same");
    expect(identityRelation(alice, "alice@acme.com", bob)).toBe("different");
    expect(identityRelation(alice, null, "chatgpt|ws-2|alice@acme.com")).toBe("different");
  });

  it("reads a workspace-only key saved by older versions through its saved email", () => {
    expect(identityRelation("chatgpt|ws-1", "Alice@Acme.com", alice)).toBe("same");
    expect(identityRelation("chatgpt|ws-1", "alice@acme.com", bob)).toBe("different");
    expect(identityRelation("chatgpt|ws-1", null, bob)).toBe("unknown");
    expect(identityRelation("chatgpt|ws-2", "bob@acme.com", bob)).toBe("different");
    expect(identityRelation(alice, "alice@acme.com", "chatgpt|ws-1")).toBe("unknown");
  });

  it("keeps exact matching for other keys", () => {
    expect(identityRelation("org-1|alice@acme.com", null, "org-1|alice@acme.com")).toBe("same");
    expect(identityRelation("org-1|alice@acme.com", null, "org-2|alice@acme.com")).toBe("different");
    expect(identityRelation("chatgpt-email|alice@acme.com|plus", "alice@acme.com", alice)).toBe("different");
  });
});

// ---------------------------------------------------------------- sign-in flow

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-identity-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // managed homes and state land here, never in the real ~/.paseo
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const WORKSPACE = "ws-business";

function member(email: string): Identity {
  return { signedIn: true, email, plan: "business", organization: null, identity: codexIdentityKey(WORKSPACE, email, "business") };
}

function stored(id: string, email: string, identity: string, kind: "main" | "managed" = "managed"): StoredAccount {
  return {
    id,
    family: "codex",
    label: email,
    autoLabel: true,
    kind,
    home: kind === "main" ? null : join(root, id),
    email,
    plan: "business",
    organization: null,
    identity,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

/** A Codex adapter whose next sign-in finishes at once as `signIn()`; the CLI login is someone else. */
function codexAdapter(signIn: () => Identity, loggedOut: string[]): FamilyAdapter {
  const finishedHomes = new Set<string>();
  const handle = (home: string | null): LoginHandle => ({
    progress: { step: "waiting", url: null, codeUrl: null, userCode: null, message: null },
    onProgress: () => undefined,
    submitCode: async () => undefined,
    cancel: () => undefined,
    finished: Promise.resolve().then(() => {
      if (home) finishedHomes.add(home);
      return { ok: true, message: null };
    }),
  });
  return {
    family: "codex",
    portable: false,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async () => ({}),
    identity: async (home: string | null) => (home && finishedHomes.has(home) ? signIn() : member("cli@acme.com")),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async (home: string | null) => handle(home),
    logout: async (home: string) => void loggedOut.push(home),
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

async function setUp(accounts: StoredAccount[]) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft: StoredState) => void draft.accounts.push(...accounts));
  let signingIn = member("alice@acme.com");
  const loggedOut: string[] = [];
  const codex = codexAdapter(() => signingIn, loggedOut);
  const service = new Service(
    { claude: { ...codex, family: "claude", available: async () => ({ ok: false, detail: "not in tests" }) } as FamilyAdapter, codex },
    store,
    { resolve: async () => ({ codex: "codex" as const }) } as unknown as FamilyResolver,
    {} as unknown as Reopener,
  );
  const logins = (service as unknown as { logins: Map<string, { view: { step: string; accountId: string | null; message: string | null } }> }).logins;
  const signIn = async (as: Identity, accountId?: string) => {
    signingIn = as;
    const started = await service.startLogin("codex", "code", accountId);
    await vi.waitFor(() => expect(["done", "failed"]).toContain(logins.get(started.id)?.view.step));
    return logins.get(started.id)!.view;
  };
  return { service, store, signIn, loggedOut };
}

describe("signing in to members of one workspace", () => {
  it("adds a second member of the same workspace", async () => {
    const { store, signIn } = await setUp([stored("codex-alice", "alice@acme.com", "chatgpt|ws-business|alice@acme.com")]);
    const view = await signIn(member("bob@acme.com"));
    expect(view.step).toBe("done");
    const added = (await store.read()).accounts.find((account) => account.id === view.accountId);
    expect(added?.identity).toBe("chatgpt|ws-business|bob@acme.com");
  });

  it("still refuses the same member twice, and signs the new home out", async () => {
    const { store, signIn, loggedOut } = await setUp([stored("codex-alice", "alice@acme.com", "chatgpt|ws-business|alice@acme.com")]);
    const view = await signIn(member("Alice@acme.com"));
    expect(view.step).toBe("failed");
    expect(view.message).toContain("already added");
    expect(loggedOut).toHaveLength(1);
    expect((await store.read()).accounts.filter((account) => account.kind === "managed")).toHaveLength(1);
  });

  it("adds another member next to an account saved with a workspace-only key", async () => {
    const { signIn } = await setUp([stored("codex-alice", "alice@acme.com", "chatgpt|ws-business")]);
    expect((await signIn(member("bob@acme.com"))).step).toBe("done");
  });

  it("refuses the member an account with a workspace-only key already is", async () => {
    const { signIn } = await setUp([stored("codex-alice", "alice@acme.com", "chatgpt|ws-business")]);
    const view = await signIn(member("alice@acme.com"));
    expect(view.step).toBe("failed");
    expect(view.message).toContain("already added");
  });

  it("signs an older account back in as the same member and upgrades its key", async () => {
    const { store, signIn } = await setUp([stored("codex-alice", "alice@acme.com", "chatgpt|ws-business")]);
    const view = await signIn(member("alice@acme.com"), "codex-alice");
    expect(view.step).toBe("done");
    const account = (await store.read()).accounts.find((entry) => entry.id === "codex-alice");
    expect(account?.identity).toBe("chatgpt|ws-business|alice@acme.com");
  });

  it("refuses to sign an older account back in as another member", async () => {
    const { store, signIn, loggedOut } = await setUp([stored("codex-alice", "alice@acme.com", "chatgpt|ws-business")]);
    const view = await signIn(member("bob@acme.com"), "codex-alice");
    expect(view.step).toBe("failed");
    expect(view.message).toContain("You signed in as bob@acme.com");
    expect(loggedOut).toEqual([join(root, "codex-alice")]);
    expect((await store.read()).accounts.find((entry) => entry.id === "codex-alice")?.identity).toBe("chatgpt|ws-business");
  });
});
