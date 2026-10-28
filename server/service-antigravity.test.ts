import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Usage, UsageWindow } from "../shared/model";
import { preferences } from "../shared/preferences";
import type { EnvPatch, FamilyAdapter } from "./adapter";
import { parseAntigravityUsage } from "./antigravity";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, StoredAccountSchema } from "./state";

let root: string;
let oldHome: string | undefined;
const A = "antigravity-a";
const B = "antigravity-b";
const AGENT = "agent-a";
const MAIN = MAIN_ACCOUNT_ID.antigravity;
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-agy-service-"));
  oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (oldHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = oldHome;
  await rm(root, { recursive: true, force: true });
});

function stored(id: string) {
  return StoredAccountSchema.parse({
    id, family: "antigravity", label: id, autoLabel: false,
    kind: id === MAIN ? "main" : "managed", home: id === MAIN ? null : join(root, "zerosub", "homes", id),
    createdAt: new Date().toISOString(),
  });
}

function quota(scopeId: string, model: string, usedPercent: number, resetsAt = new Date(Date.now() + 60_000).toISOString()): UsageWindow {
  return { id: `${scopeId}-weekly`, label: "Weekly", usedPercent, resetsAt, period: "weekly", scope: { id: scopeId, label: scopeId, models: [model] } };
}

function reading(windows: UsageWindow[], extra: Partial<Usage> = {}): Usage {
  return { fetchedAt: new Date().toISOString(), windows, error: null, cached: false, resets: null, ...extra };
}

async function setup() {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => {
    draft.accounts = [stored(MAIN), stored(A), stored(B)];
    draft.defaults.antigravity = A;
  });
  const usage = vi.fn(async () => reading([]));
  const prepareHome = vi.fn(async (_home: string) => undefined);
  const login = vi.fn<FamilyAdapter["login"]>(async () => { throw new Error("not in this test"); });
  const redeemReset = vi.fn<FamilyAdapter["redeemReset"]>(async () => ({ outcome: "none", message: "none", left: null }));
  const adapter: FamilyAdapter = {
    family: "antigravity", portable: false, usageSpacingMs: 0,
    capabilities: { managedAccounts: true, loginMethods: ["code"], autoSwitch: false, resets: false, fork: false },
    available: async () => ({ ok: false, detail: null }),
    prepareHome, env: async (home): Promise<EnvPatch> => home ? { HOME: home, DBUS_SESSION_BUS_ADDRESS: "" } : {},
    identity: async () => ({ signedIn: true, email: null, plan: null, organization: null, identity: null }),
    usage, login, redeemReset, logout: async () => undefined, detectLimit: () => null, detectSignOut: () => null,
  };
  const agent = {
    id: AGENT, provider: "antigravity", model: "claude-model", status: "idle", title: "Work",
    archivedAt: null, lastUserMessageAt: null as string | null, labels: {} as Record<string, string>, workspaceId: "workspace-a", cwd: "/work",
    currentModeId: "careful", thinkingOptionId: "high",
  };
  const children: typeof agent[] = [];
  const created = vi.fn(async (request: { agentId: string; title: string; labels: Record<string, string>; config: { provider: string } }) => {
    children.push({ ...agent, id: request.agentId, title: request.title, labels: request.labels });
    return {};
  });
  const notes = vi.fn(async (_item: unknown) => undefined);
  const paseo = {
    agents: {
      list: async () => ({ entries: [agent, ...children].map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id = AGENT) => ({ refresh: async () => ({ agent: children.find((child) => child.id === id) ?? agent }), timeline: { append: notes, refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Continue the task" } }] }) } }),
    },
    workspaces: { ref: () => ({ agents: { create: created } }) },
  };
  const reopened = vi.fn(async () => ({ ok: true as const }));
  const providerFamilies: Record<string, "antigravity"> = { antigravity: "antigravity" };
  const service = new Service(
    { antigravity: adapter }, store,
    { resolve: async () => providerFamilies } as unknown as FamilyResolver,
    { locate: async () => "/test/paseo", reopen: reopened } as unknown as Reopener,
  );
  services.push(service);
  service.attach(paseo as never);
  const open = (reason = "create", env: Record<string, string> = { KEEP: "yes" }) => service.onSessionOpen({ agentId: AGENT, provider: "antigravity", reason, purpose: "interactive", env, cwd: "/work" } as never, { paseo } as never);
  return { store, service, adapter, usage, prepareHome, login, redeemReset, agent, paseo, open, created, notes, reopened, providerFamilies };
}

describe("Antigravity service integration", () => {
  it("routes new sessions and quota through the selected private home without querying usage on the hook", async () => {
    const { service, store, usage, open, paseo } = await setup();
    const request = await open();
    expect(request?.env).toEqual({ KEEP: "yes", HOME: stored(A).home, DBUS_SESSION_BUS_ADDRESS: "" });
    expect(usage).not.toHaveBeenCalled();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(A);
    const view = await service.view(paseo as never);
    expect(view.agents[0]).toMatchObject({ family: "antigravity", model: "claude-model", accountId: A });
    await service.refreshUsage(A, true);
    expect(usage).toHaveBeenCalledWith(stored(A).home, { renewLogin: false });
  });

  it("falls back to the CLI login when private-home validation fails, preserving the requested binding", async () => {
    const { store, open, prepareHome } = await setup();
    await store.update((draft) => {
      draft.bindings[AGENT] = { accountId: A, source: "user", at: new Date().toISOString() };
      draft.sessions[AGENT] = { accountId: B, family: "antigravity", openedAt: new Date().toISOString() };
    });
    prepareHome.mockRejectedValueOnce(new Error("unsafe home"));
    expect(await open("refresh")).toBeUndefined();
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
    expect((await store.read()).bindings[AGENT]?.accountId).toBe(A);
  });

  it.each<Record<string, string>>([{ GEMINI_API_KEY: "separate-key" }, { HOME: "/separate/account" }])("leaves a session's explicitly configured authentication environment alone: %o", async (env) => {
    const { open, store, prepareHome } = await setup();
    expect(await open("create", env)).toBeUndefined();
    expect(prepareHome).not.toHaveBeenCalled();
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
  });

  it("forgets an earlier managed session when the next session brings its own authentication", async () => {
    const { open, store } = await setup();
    await open();
    expect(await open("refresh", { HOME: "/custom/account" })).toBeUndefined();
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
    expect((await store.read()).bindings[AGENT]?.accountId).toBe(A);
  });

  it("records a full Argon quota as a scope limit while keeping the account ready", async () => {
    const { usage, service, store, paseo } = await setup();
    usage.mockResolvedValue(reading([quota("argon", "argon-model", 100), quota("third-party", "claude-model", 5)]));
    await service.refreshUsage(A, true);
    const account = (await store.read()).accounts.find((entry) => entry.id === A);
    expect(account?.limitedUntil).toBeNull();
    expect(account?.scopedLimits).toEqual([expect.objectContaining({ scopeId: "argon", kind: "window" })]);
    expect((await service.view(paseo as never)).accounts.find((entry) => entry.id === A)?.status).toBe("ready");
  });

  it("doesn't retain an old managed-session attribution after credential validation fails", async () => {
    const { store, adapter, open } = await setup();
    await open();
    adapter.env = async () => { throw new Error("missing credential file"); };
    expect(await open("refresh")).toBeUndefined();
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
    expect((await store.read()).bindings[AGENT]?.accountId).toBe(A);
  });

  it("doesn't invent future limits from missing or expired resets", async () => {
    const { usage, service, store } = await setup();
    usage.mockResolvedValue(reading([{ ...quota("argon", "argon-model", 100), resetsAt: null }, quota("third-party", "claude-model", 100, new Date(Date.now() - 1000).toISOString())]));
    await service.refreshUsage(A, true);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits).toEqual([]);
  });

  it("stops refreshing subscriptions after the provider leaves subscription routing", async () => {
    const { usage, service, providerFamilies } = await setup();
    delete providerFamilies.antigravity;
    await service.refreshUsage(A, true);
    expect(usage).not.toHaveBeenCalled();
  });

  it("exposes sign-in again on an explicit refresh when the adapter confirms a missing credential", async () => {
    const { service, adapter, paseo } = await setup();
    adapter.identity = async () => ({ signedIn: false, email: null, plan: null, organization: null, identity: null });
    const view = await service.view(paseo as never, true);
    expect(view.accounts.find((account) => account.id === A)?.status).toBe("signed_out");
  });

  it("doesn't bypass usage spacing through an explicit identity refresh", async () => {
    const { service, adapter, paseo } = await setup();
    Object.defineProperty(adapter, "usageSpacingMs", { value: 120_000 });
    const identity = vi.fn(adapter.identity);
    adapter.identity = identity;
    await service.refreshUsage(A, true);
    await service.view(paseo as never, true);
    // The other two accounts may be checked; the recently read account must not start another CLI.
    expect(identity.mock.calls.some(([home]) => home === stored(A).home)).toBe(false);
  });

  it("keeps fresh notifications and budgets, clears only an old scope with confirmed room", async () => {
    const { usage, service, store } = await setup();
    await store.update((draft) => {
      const account = draft.accounts.find((entry) => entry.id === A)!;
      account.scopedLimits = [
        { scopeId: "fresh", limitedAt: new Date().toISOString(), limitedUntil: new Date(Date.now() + 60_000).toISOString(), kind: "window" },
        { scopeId: "old", limitedAt: new Date(Date.now() - 20 * 60_000).toISOString(), limitedUntil: new Date(Date.now() + 60_000).toISOString(), kind: "window" },
        { scopeId: "budget", limitedAt: new Date(Date.now() - 20 * 60_000).toISOString(), limitedUntil: new Date(Date.now() + 60_000).toISOString(), kind: "budget" },
      ];
    });
    usage.mockResolvedValue(reading([quota("fresh", "a", 5), quota("old", "b", 5), quota("budget", "c", 5)]));
    await service.refreshUsage(A, true);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits.map((limit) => limit.scopeId)).toEqual(["fresh", "budget"]);
  });

  it.each([{ cached: true }, { error: "quota unavailable" }])("never persists a limit from an untrusted reading %o", async (extra) => {
    const { usage, service, store } = await setup();
    usage.mockResolvedValue(reading([quota("argon", "argon-model", 100)], extra));
    await service.refreshUsage(A, true);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits).toEqual([]);
  });

  it("enforces unsupported sign-in, reset and cross-provider fork at the server boundary", async () => {
    const { service, paseo, login, redeemReset } = await setup();
    await expect(service.startLogin("antigravity", "browser")).rejects.toThrow(/sign-in method/);
    expect(login).not.toHaveBeenCalled();
    expect((await service.redeem(paseo as never, A)).outcome).toBe("unavailable");
    expect(redeemReset).not.toHaveBeenCalled();
    await expect(service.forkAgent(paseo as never, AGENT)).rejects.toThrow(/doesn't support/);
  });

  it("keeps automatic switching off despite the global preference and an opt-in flag", async () => {
    const { adapter, service, store, open, paseo, created, reopened } = await setup();
    service.setPreferences(preferences.schema.parse({ antigravityAutoSwitch: true, autoSwitch: true }));
    adapter.detectLimit = () => ({ kind: "window", resetsAt: new Date(Date.now() + 60_000).toISOString(), message: "official limit", scopeId: "third-party" });
    await open();
    await service.onTurnEnded({ agent: { id: AGENT, provider: "antigravity" }, turnId: "turn-a", outcome: { kind: "failed", error: { message: "official limit" } }, timeline: [] } as never, { paseo } as never);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(A);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.limitedUntil).toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(reopened).not.toHaveBeenCalled();
  });

  it("doesn't balance real parsed quotas with unknown model mappings", async () => {
    const { usage, service, open, store } = await setup();
    service.setPreferences(preferences.schema.parse({ balanceNewAgents: true, autoSwitch: true, antigravityAutoSwitch: true }));
    const raw = (remaining_fraction: number) => parseAntigravityUsage({
      status: "SUCCESS", num_turns: 0,
      command: { name: "usage", data: { groups: [{ name: "Claude and GPT models", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction, reset_time: new Date(Date.now() + 60_000).toISOString() }] }] } },
    });
    usage.mockResolvedValueOnce(raw(0)).mockResolvedValueOnce(raw(1));
    await service.refreshUsage(A, true);
    await service.refreshUsage(B, true);
    expect((await open())?.env.HOME).toBe(stored(A).home);
    expect((await store.read()).bindings[AGENT]?.source).toBe("thread");
  });

  it("continues an existing conversation on the chosen account in the same workspace without reopening the original", async () => {
    const { service, store, agent, open, paseo, created, reopened } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    const result = await service.setAgentAccount(paseo as never, AGENT, B);
    expect(result.continuedIn?.agentId).toBeTruthy();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ config: { provider: "antigravity/claude-model", modeId: "careful", thinkingOptionId: "high" }, prompt: expect.stringContaining("earlier Antigravity session") }));
    const state = await store.read();
    expect(state.bindings[result.continuedIn!.agentId]?.accountId).toBe(B);
    expect(state.sessions[AGENT]?.accountId).toBe(A);
    expect(state.bindings[AGENT]?.accountId).toBe(A);
    expect(reopened).not.toHaveBeenCalled();
  });

  it("waits for a busy conversation to finish before a manual continuation", async () => {
    const { service, agent, paseo, created } = await setup();
    agent.status = "running";
    agent.lastUserMessageAt = new Date().toISOString();
    await expect(service.setAgentAccount(paseo as never, AGENT, B)).rejects.toThrow(/working right now/);
    expect(created).not.toHaveBeenCalled();
  });

  it("uses the actual session instead of a pending thread binding for manual continuation", async () => {
    const { service, store, agent, open, paseo, created } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    await store.update((draft) => { draft.bindings[AGENT] = { accountId: B, source: "thread", at: new Date().toISOString() }; });
    expect((await service.setAgentAccount(paseo as never, AGENT, B)).continuedIn).not.toBeNull();
    expect(created).toHaveBeenCalledTimes(1);
    expect((await store.read()).bindings[AGENT]?.accountId).toBe(A);
    await service.setAgentAccount(paseo as never, AGENT, A);
    expect(created).toHaveBeenCalledTimes(1);
    expect((await store.read()).bindings[AGENT]?.accountId).toBe(A);
  });

  it("reuses one continuation for simultaneous requests to the same target", async () => {
    const { service, agent, open, paseo, created } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    const [first, second] = await Promise.all([service.setAgentAccount(paseo as never, AGENT, B), service.setAgentAccount(paseo as never, AGENT, B)]);
    expect(first.continuedIn).toEqual(second.continuedIn);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("protects the account owning a live conversation even if its binding names another account", async () => {
    const { service, store, agent, open, paseo } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    await store.update((draft) => { draft.bindings[AGENT] = { accountId: B, source: "thread", at: new Date().toISOString() }; });
    await expect(service.remove(paseo as never, A)).rejects.toThrow(/conversation/);
    expect((await service.setAccountEnabled(paseo as never, A, false)).stayed).toBe(1);
  });

  it("pins the original conversation to its real account when a pending target is removed", async () => {
    const { service, store, agent, open, paseo } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    await store.update((draft) => { draft.bindings[AGENT] = { accountId: B, source: "thread", at: new Date().toISOString() }; });
    await service.remove(paseo as never, B);
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: A, source: "thread" });
    expect(state.sessions[AGENT]?.accountId).toBe(A);
    expect(state.accounts.some((entry) => entry.id === A)).toBe(true);
  });

  it("doesn't create a continuation when the native transcript was lost after restart", async () => {
    const { service, agent, paseo, created } = await setup();
    agent.lastUserMessageAt = new Date().toISOString();
    const originalRef = paseo.agents.ref;
    paseo.agents.ref = () => ({ ...originalRef(), timeline: { ...originalRef().timeline, refetch: async () => ({ entries: [] }) } });
    await expect(service.setAgentAccount(paseo as never, AGENT, B)).rejects.toThrow(/history is unavailable/);
    expect(created).not.toHaveBeenCalled();
  });
});
