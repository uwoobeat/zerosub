import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Usage, UsageWindow } from "../shared/model";
import { preferences } from "../shared/preferences";
import type { EnvPatch, FamilyAdapter } from "./adapter";
import { parseAntigravityUsage } from "./antigravity";
import { CreateContexts, CREATE_CONTEXT_ENV } from "./create-context";
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

async function setup(autoSwitch = false) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => {
    draft.accounts = [stored(MAIN), stored(A), stored(B)];
    draft.defaults.antigravity = A;
  });
  const usage = vi.fn<FamilyAdapter["usage"]>(async () => reading([]));
  const prepareHome = vi.fn(async (_home: string) => undefined);
  const login = vi.fn<FamilyAdapter["login"]>(async () => { throw new Error("not in this test"); });
  const redeemReset = vi.fn<FamilyAdapter["redeemReset"]>(async () => ({ outcome: "none", message: "none", left: null }));
  const adapter: FamilyAdapter = {
    family: "antigravity", portable: false, usageSpacingMs: 0,
    capabilities: { managedAccounts: true, loginMethods: ["code"], autoSwitch, resets: false, fork: false },
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
  let incompleteAgentList = false;
  let agentUnregistered = false;
  const timelines = new Map<string, Array<{ item: { type: "user_message" | "assistant_message"; text: string; clientMessageId?: string }; timestamp: string; seqStart: number; seqEnd: number; turnId?: string }>>();
  timelines.set(AGENT, [{
    item: { type: "user_message", text: "Continue the task" }, timestamp: "2026-10-01T00:00:00Z", seqStart: 1, seqEnd: 1, turnId: "initial-turn",
  }]);
  const created = vi.fn(async (request: { agentId: string; title: string; labels: Record<string, string>; config: { provider: string } }) => {
    children.push({ ...agent, id: request.agentId, title: request.title, labels: request.labels, lastUserMessageAt: null });
    timelines.set(request.agentId, []);
    return {};
  });
  const sent: Array<{ id: string; text: string; messageId?: string }> = [];
  const notes = vi.fn(async (_item: unknown) => undefined);
  const paseo = {
    agents: {
      list: async () => ({
        entries: [agent, ...children].map((agent) => ({ agent })),
        pageInfo: incompleteAgentList ? { hasMore: true, nextCursor: "truncated" } : { hasMore: false, nextCursor: null },
      }),
      ref: (id = AGENT) => ({
        refresh: async () => {
          if (agentUnregistered) return null;
          const child = children.find((entry) => entry.id === id);
          return { agent: child ?? agent };
        },
        send: async (text: string, options?: { messageId?: string }) => {
          sent.push({ id, text, messageId: options?.messageId });
          const entries = timelines.get(id) ?? [];
          const seq = (entries.at(-1)?.seqEnd ?? 0) + 1;
          entries.push({ item: { type: "user_message", text, clientMessageId: options?.messageId }, timestamp: new Date(Date.now() + seq * 1000).toISOString(), seqStart: seq, seqEnd: seq, turnId: `turn-${seq}` });
          timelines.set(id, entries);
          const child = children.find((entry) => entry.id === id);
          if (child) child.lastUserMessageAt = entries.at(-1)!.timestamp;
          const bound = (await store.read()).bindings[id];
          if (bound) await store.update((draft) => { draft.sessions[id] = {
            accountId: bound.accountId,
            family: "antigravity",
            openedAt: new Date().toISOString(),
            authGeneration: draft.antigravityAccountGenerations[bound.accountId] ?? 0,
            authHome: draft.accounts.find((account) => account.id === bound.accountId)?.home ?? null,
          }; });
        },
        timeline: {
          append: notes,
          refetch: async (options: { direction?: "tail" | "before"; cursor?: { epoch: string; seq: number }; limit?: number } = {}) => {
            const entries = timelines.get(id) ?? [];
            const epoch = `epoch-${id}`;
            const eligible = options.direction === "before" ? entries.filter((entry) => entry.seqEnd < (options.cursor?.seq ?? 0)) : entries;
            const page = eligible.slice(-(options.limit ?? 500));
            return {
              entries: page,
              epoch,
              window: { minSeq: entries[0]?.seqStart ?? 0, maxSeq: entries.at(-1)?.seqEnd ?? 0, nextSeq: (entries.at(-1)?.seqEnd ?? 0) + 1 },
              startCursor: page.length ? { epoch, seq: page[0]!.seqStart } : null,
              endCursor: page.length ? { epoch, seq: page.at(-1)!.seqEnd } : null,
              hasOlder: eligible.length > page.length,
              hasNewer: false,
              gap: false,
              staleCursor: false,
            };
          },
        },
      }),
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
  return {
    store, service, adapter, usage, prepareHome, login, redeemReset, agent, paseo, open, created, sent, notes, reopened, providerFamilies, timelines,
    set incompleteAgentList(value: boolean) { incompleteAgentList = value; },
    set agentUnregistered(value: boolean) { agentUnregistered = value; },
  };
}

describe("Antigravity service integration", () => {
  it.each([
    ["claude-opus-5-5-high", "claude-and-gpt-models", ["3p-5h", "3p-weekly"]],
    ["claude-sonnet-5-5-low", "claude-and-gpt-models", ["3p-5h", "3p-weekly"]],
    ["gpt-oss-120b-medium", "claude-and-gpt-models", ["3p-5h", "3p-weekly"]],
    ["gemini-3.8-flash-medium", "gemini-models", ["gemini-5h", "gemini-weekly"]],
    ["gemini-4-argon-high", "gemini-4-argon", ["gemini-argon-wtu-weekly"]],
  ])("balances an unregistered %s agent using fresh account quotas", async (model, scope, buckets) => {
    const fixture = await setup();
    const { service, store, adapter, paseo } = fixture;
    fixture.agentUnregistered = true;
    adapter.capabilities!.balanceNewAgents = true;
    await service["ensureFamily"]("antigravity");
    service["availability"].set("antigravity", { ok: true, detail: null, at: Date.now() });
    await service["balanceSupport"]();
    const revision = (await store.read()).antigravityBalanceConsent.revision;
    await service.consentAntigravityBalance(revision);
    service.setPreferences(preferences.schema.parse({ antigravityBalanceNewAgents: true, autoSwitch: false }));
    const make = (short: number, weekly: number) => reading(buckets.map((id, index) =>
      ({ ...quota(scope, "", index === 0 ? short : weekly), id, scope: { id: scope, label: scope, models: [] } })));
    service["antigravityReadings"].set(A, { home: stored(A).home, generation: 0, usage: make(80, 80) });
    service["antigravityReadings"].set(B, { home: stored(B).home, generation: 0, usage: make(45, 35) });
    await store.update((draft) => { draft.antigravityAccountGenerations[A] = 0; draft.antigravityAccountGenerations[B] = 0; });
    const contexts = new CreateContexts();
    const create = contexts.issue({ config: { provider: "antigravity", cwd: "/work", model, modeId: "careful", thinkingOptionId: "high", featureValues: { test: true } }, env: { KEEP: "yes" } });
    const captured = contexts.consume({ agentId: AGENT, workspaceId: "workspace-a", provider: "antigravity", reason: "create", purpose: "interactive", cwd: "/work", env: create.env! });
    expect(captured.model).toBe(model);
    expect(create.config).toMatchObject({ modeId: "careful", thinkingOptionId: "high", featureValues: { test: true } });
    expect(captured.request.env[CREATE_CONTEXT_ENV]).toBeUndefined();
    const opened = await service.onSessionOpen(captured.request, { paseo, signal: new AbortController().signal } as never, captured.model);
    expect(opened?.env).toMatchObject({ KEEP: "yes", HOME: stored(B).home });
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: B, source: "balance" });
    expect(state.sessions[AGENT]?.accountId).toBe(B);
    expect(contexts.consume({ ...captured.request, env: create.env! }).model).toBeNull();
    service["antigravityReadings"].set(B, { home: stored(B).home, generation: 0, usage: make(99, 99) });
    const resumed = await service.onSessionOpen({ ...captured.request, reason: "resume" }, { paseo, signal: new AbortController().signal } as never);
    expect(resumed?.env.HOME).toBe(stored(B).home);
    expect((await store.read()).bindings[AGENT]?.accountId).toBe(B);
    const retried = await service.onSessionOpen(captured.request, { paseo, signal: new AbortController().signal } as never, captured.model);
    expect(retried?.env.HOME).toBe(stored(B).home);
  });

  it.each(["user", "quota"] as const)("rechecks %s changes while a balanced home is prepared", async (change) => {
    const fixture = await setup();
    const { service, store, adapter, paseo, prepareHome } = fixture;
    fixture.agentUnregistered = true;
    await service["ensureFamily"]("antigravity");
    adapter.capabilities!.balanceNewAgents = true;
    service["availability"].set("antigravity", { ok: true, detail: null, at: Date.now() });
    const state = await service["balanceSupport"]();
    await service.consentAntigravityBalance(state.antigravityBalanceConsent.revision);
    service.setPreferences(preferences.schema.parse({ antigravityBalanceNewAgents: true }));
    const make = (value: number) => reading(["3p-5h", "3p-weekly"].map((id) => ({
      id, label: id, usedPercent: value, resetsAt: null,
      scope: { id: "claude-and-gpt-models", label: "Claude", models: [] },
    })));
    service["antigravityReadings"].set(A, { home: stored(A).home, generation: 0, usage: make(80) });
    service["antigravityReadings"].set(B, { home: stored(B).home, generation: 0, usage: make(20) });
    let finish!: (value: undefined) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    prepareHome.mockImplementationOnce(() => { started(); return new Promise<undefined>((resolve) => { finish = resolve; }); });
    const request = { agentId: AGENT, workspaceId: null, provider: "antigravity", reason: "create", purpose: "interactive", env: {}, cwd: "/work" } as const;
    const opened = service.onSessionOpen(request, { paseo, signal: new AbortController().signal } as never, "claude-opus-5-5-high");
    await waiting;
    if (change === "user") {
      await store.update((draft) => { draft.bindings[AGENT] = { accountId: A, source: "user", at: new Date().toISOString() }; });
    } else {
      service["antigravityReadings"].set(B, { home: stored(B).home, generation: 0, usage: make(99) });
    }
    finish(undefined);
    expect((await opened)?.env.HOME).toBe(stored(A).home);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: A, source: change === "user" ? "user" : "balance" });
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(A);
  });

  it("does not record a session when the route times out while preparing a home", async () => {
    const { service, store, prepareHome, paseo } = await setup();
    let finish!: (value: undefined) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    prepareHome.mockImplementationOnce(() => { started(); return new Promise<undefined>((resolve) => { finish = resolve; }); });
    const controller = new AbortController();
    const request = { agentId: AGENT, workspaceId: null, provider: "antigravity", reason: "create", purpose: "interactive", env: {}, cwd: "/work" } as const;
    const opened = service.onSessionOpen(request, { paseo, signal: controller.signal } as never);
    await waiting;
    controller.abort();
    finish(undefined);
    expect(await opened).toBeUndefined();
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
  });
  it("captures the actual session and model for each turn and keeps a newer capture on a late end", async () => {
    const { service, store, open, paseo, agent } = await setup();
    await open();
    agent.model = "claude-opus-5-5-high";
    await service.onTurnStarted(agent, { paseo } as never, "first");
    const first = await service["antigravityTurns"].get(AGENT)?.capture;
    expect(first).toMatchObject({ turnId: "first", accountId: A, home: stored(A).home, model: agent.model });
    await service.onTurnStarted(agent, { paseo } as never, "second");
    await service.onTurnEnded({ agent, turnId: "first", outcome: { kind: "canceled", reason: "user" }, timeline: [] } as never, { paseo } as never);
    expect(service["antigravityTurns"].get(AGENT)?.turnId).toBe("second");
    await store.update((draft) => { draft.antigravityAccountGenerations[A] = (draft.antigravityAccountGenerations[A] ?? 0) + 1; });
    await service.onTurnStarted(agent, { paseo } as never, "third");
    expect(await service["antigravityTurns"].get(AGENT)?.capture).toBeNull();
  });

  it("routes new sessions and quota through the selected private home without querying usage on the hook", async () => {
    const { service, store, usage, open, paseo } = await setup();
    const request = await open();
    expect(request?.env).toEqual({ KEEP: "yes", HOME: stored(A).home, DBUS_SESSION_BUS_ADDRESS: "" });
    expect(usage).not.toHaveBeenCalled();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(A);
    const view = await service.view(paseo as never);
    expect(view.agents[0]).toMatchObject({ family: "antigravity", model: "claude-model", accountId: A });
    await service.refreshUsage(A, true);
    expect(usage).toHaveBeenCalledWith(stored(A).home, expect.objectContaining({ renewLogin: false, quotaContext: expect.any(Object) }));
  });

  it("falls back to the CLI login when private-home validation fails, preserving the requested binding", async () => {
    const { store, open, prepareHome } = await setup();
    await store.update((draft) => {
      draft.bindings[AGENT] = { accountId: A, source: "user", at: new Date().toISOString() };
      draft.sessions[AGENT] = { accountId: B, family: "antigravity", openedAt: new Date().toISOString(), authHome: stored(B).home };
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
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits).toEqual([
      expect.objectContaining({ scopeId: "argon", limitedUntil: null }),
      expect.objectContaining({ scopeId: "third-party", limitedUntil: null }),
    ]);
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

  it("records an observed sign-out and re-login even when Antigravity identity remains unknown", async () => {
    const { service, adapter, store, open, paseo } = await setup();
    await open();
    await store.update((draft) => { draft.accounts.find((account) => account.id === A)!.signedIn = false; });
    adapter.identity = async () => ({ signedIn: true, email: null, plan: null, organization: null, identity: null });

    await service.view(paseo as never, true);

    const state = await store.read();
    expect(state.antigravityAccountGenerations[A]).toBe(1);
    expect(state.sessions[AGENT]?.authGeneration).toBe(0);
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

  it("does not apply a quota read started before reauthentication", async () => {
    const { usage, service, store } = await setup();
    let finish!: (value: Usage) => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    usage.mockImplementationOnce(() => {
      started();
      return new Promise<Usage>((resolve) => { finish = resolve; });
    });
    const refresh = service.refreshUsage(A, true);
    await hasStarted;
    await store.update((draft) => { draft.antigravityAccountGenerations[A] = (draft.antigravityAccountGenerations[A] ?? 0) + 1; });
    finish(reading([quota("argon", "argon-model", 100)]));
    await refresh;
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits).toEqual([]);
    expect(service["usage"].has(A)).toBe(false);
  });

  it("does not join or let an old completion erase a new generation's in-flight quota", async () => {
    const { usage, service, store } = await setup();
    const resolvers: Array<(value: Usage) => void> = [];
    usage.mockImplementation(() => new Promise<Usage>((resolve) => { resolvers.push(resolve); }));
    const first = service.refreshUsage(A, true);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    await store.update((draft) => { draft.antigravityAccountGenerations[A] = 1; });
    const second = service.refreshUsage(A, true);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]!(reading([quota("argon", "argon-model", 100)]));
    await first;
    const third = service.refreshUsage(A, true);
    await Promise.resolve();
    expect(usage).toHaveBeenCalledTimes(2);
    resolvers[1]!(reading([quota("argon", "argon-model", 20)]));
    await Promise.all([second, third]);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits).toEqual([]);
    expect(service["antigravityReadings"].get(A)?.generation).toBe(1);
  });

  it("requires fresh consent after explicit support withdrawal, including after restart", async () => {
    const { service, adapter, store } = await setup();
    await service["ensureFamily"]("antigravity");
    service["availability"].set("antigravity", { ok: true, detail: null, at: Date.now() });
    adapter.capabilities!.balanceNewAgents = true;
    let state = await service["balanceSupport"]();
    await service.consentAntigravityBalance(state.antigravityBalanceConsent.revision);
    adapter.capabilities!.balanceNewAgents = false;
    state = await service["balanceSupport"]();
    expect(state.antigravityBalanceConsent.consented).toBe(false);
    const restored = new StateStore(join(root, "state.json"));
    expect((await restored.read()).antigravityBalanceConsent.consented).toBe(false);
    adapter.capabilities!.balanceNewAgents = true;
    const oldRevision = state.antigravityBalanceConsent.revision;
    state = await service["balanceSupport"]();
    await expect(service.consentAntigravityBalance(oldRevision)).rejects.toThrow();
    await service.consentAntigravityBalance(state.antigravityBalanceConsent.revision);
    expect((await store.read()).antigravityBalanceConsent.consented).toBe(true);
  });

  it.each(["generation", "home", "deleted"] as const)("discards a late identity after %s changes", async (change) => {
    const { adapter, service, store } = await setup();
    let finish!: (value: Awaited<ReturnType<FamilyAdapter["identity"]>>) => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    adapter.identity = vi.fn(() => {
      started();
      return new Promise<Awaited<ReturnType<FamilyAdapter["identity"]>>>((resolve) => { finish = resolve; });
    });
    const refresh = service["refreshIdentity"](A);
    await hasStarted;
    await store.update((draft) => {
      if (change === "generation") draft.antigravityAccountGenerations[A] = 1;
      if (change === "home") draft.accounts.find((account) => account.id === A)!.home = "/new-home";
      if (change === "deleted") draft.accounts = draft.accounts.filter((account) => account.id !== A);
    });
    finish({ signedIn: false, email: "old@example.invalid", plan: null, organization: null, identity: "old" });
    await refresh;
    const state = await store.read();
    const account = state.accounts.find((item) => item.id === A);
    if (change === "deleted") expect(account).toBeUndefined();
    else expect(account).toMatchObject({ signedIn: true, email: null, identity: null });
    expect(state.antigravityAccountGenerations[A] ?? 0).toBe(change === "generation" ? 1 : 0);
    expect(service["identityCheckedAt"].has(A)).toBe(false);
  });

  it("still applies an identity read for the current authentication generation", async () => {
    const { adapter, service, store } = await setup();
    adapter.identity = vi.fn(async () => ({ signedIn: true, email: "current@example.invalid", plan: null, organization: null, identity: "current" }));
    await service["refreshIdentity"](A);
    expect((await store.read()).accounts.find((account) => account.id === A)).toMatchObject({
      signedIn: true, email: "current@example.invalid", identity: "current",
    });
    expect(service["identityCheckedAt"].has(A)).toBe(true);
  });

  it("retains an expired scope when a fresh reading omits its group", async () => {
    const { usage, service, store } = await setup();
    await store.update((draft) => {
      draft.accounts.find((entry) => entry.id === A)!.scopedLimits = [{
        scopeId: "missing", limitedAt: new Date(Date.now() - 3_600_000).toISOString(),
        limitedUntil: new Date(Date.now() - 1_000).toISOString(), kind: "window",
      }];
    });
    usage.mockResolvedValue(reading([quota("other", "other-model", 10)]));
    await service.refreshUsage(A, true);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits.map((limit) => limit.scopeId)).toEqual(["missing"]);
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

  it("automatically hands off a matched failed turn to a fresh eligible account", async () => {
    const { service, agent, usage, open, paseo, created, sent, store } = await setup(true);
    agent.model = "claude-opus-5-5-high";
    service.setPreferences(preferences.schema.parse({ antigravityAutoSwitch: true, autoSwitch: true, autoContinue: true }));
    usage.mockImplementation(async (home) => {
      const remaining = home === stored(A).home ? 0 : home === stored(B).home ? 0.9 : 0.2;
      return parseAntigravityUsage({ status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [
        { name: "Claude and GPT models", buckets: [
          { id: "3p-5h", window: "5h", remaining_fraction: remaining, reset_time: new Date(Date.now() + 60_000).toISOString() },
          { id: "3p-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: new Date(Date.now() + 3_600_000).toISOString() },
        ] },
      ] } } });
    });
    await open();
    await service.onTurnStarted(agent, { paseo } as never, "failed-turn");
    const event = { agent, turnId: "failed-turn", outcome: { kind: "failed", error: { message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h53m56s." } }, timeline: [] } as never;
    await service.onTurnEnded(event, { paseo } as never);
    expect(created).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect((await store.read()).bindings[sent[0]!.id]?.accountId).toBe(B);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(A);
    await service.onTurnEnded(event, { paseo } as never);
    expect(sent).toHaveLength(1);
  });

  it("does not use a failure without a matching started turn", async () => {
    const { service, agent, open, paseo, created, usage } = await setup(true);
    agent.model = "claude-opus-5-5-high";
    service.setPreferences(preferences.schema.parse({ antigravityAutoSwitch: true, autoSwitch: true }));
    await open();
    await service.onTurnEnded({ agent, turnId: "unknown", outcome: { kind: "failed", error: {
      message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h53m56s.",
    } }, timeline: [] } as never, { paseo } as never);
    expect(created).not.toHaveBeenCalled();
    // The ordinary post-turn upkeep may read quota, but it cannot start a handoff.
    expect(usage.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("preserves a reserved destination account when its session opens", async () => {
    const { store, service, paseo } = await setup(true);
    await store.update((draft) => {
      draft.accounts.find((account) => account.id === B)!.limitedUntil = new Date(Date.now() + 60_000).toISOString();
      draft.bindings.target = { accountId: B, source: "thread", at: "now" };
      draft.antigravityContinuations[AGENT] = {
        activeAgentId: AGENT,
        members: { target: { accountId: B, home: stored(B).home, identity: null, email: null, generation: 0, configKey: "test", seen: {}, unstarted: true } },
        pending: { agentId: "target", sourceAgentId: AGENT, accountId: B, messageId: "reserved", prompt: "test", seen: {}, observed: {}, stage: "creating" },
      };
    });
    service.setPreferences(preferences.schema.parse({ antigravityAutoSwitch: true, autoSwitch: true }));
    const request = await service.onSessionOpen({ agentId: "target", provider: "antigravity", reason: "create", purpose: "interactive", env: {}, cwd: "/work" } as never, { paseo } as never);
    expect(request?.env.HOME).toBe(stored(B).home);
    expect((await store.read()).sessions.target?.accountId).toBe(B);
  });

  it("retains a known group limit when a later reading omits a required bucket", async () => {
    const { usage, service, store } = await setup();
    await store.update((draft) => {
      draft.accounts.find((entry) => entry.id === A)!.scopedLimits = [{ scopeId: "claude-and-gpt-models",
        limitedAt: new Date(Date.now() - 3_600_000).toISOString(), limitedUntil: null, kind: "window" }];
    });
    usage.mockResolvedValue(reading([{ ...quota("claude-and-gpt-models", "claude-opus-5-5-high", 5), id: "3p-5h" }]));
    await service.refreshUsage(A, true);
    expect((await store.read()).accounts.find((entry) => entry.id === A)?.scopedLimits).toHaveLength(1);
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

  it("does not enable new-agent balancing when a future adapter supports automatic switching", async () => {
    const { usage, service, open, store } = await setup(true);
    service.setPreferences(preferences.schema.parse({ balanceNewAgents: true, autoSwitch: true, antigravityAutoSwitch: true }));
    usage.mockResolvedValueOnce(reading([quota("third-party", "claude-model", 80)]))
      .mockResolvedValueOnce(reading([quota("third-party", "claude-model", 10)]));
    await service.refreshUsage(A, true);
    await service.refreshUsage(B, true);
    expect((await open())?.env.HOME).toBe(stored(A).home);
    expect((await store.read()).bindings[AGENT]?.source).toBe("thread");
  });

  it("continues an existing conversation on the chosen account in the same workspace without reopening the original", async () => {
    const { service, store, agent, open, paseo, created, sent, reopened } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    const result = await service.setAgentAccount(paseo as never, AGENT, B);
    expect(result.continuedIn?.agentId).toBeTruthy();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ config: { provider: "antigravity/claude-model", modeId: "careful", thinkingOptionId: "high" } }));
    expect(sent[0]?.text).toContain("Continue the task");
    const state = await store.read();
    expect(state.bindings[result.continuedIn!.agentId]?.accountId).toBe(B);
    expect(state.sessions[AGENT]?.accountId).toBe(A);
    expect(state.bindings[AGENT]?.accountId).toBe(A);
    expect(reopened).not.toHaveBeenCalled();
    expect(state.continuations).toEqual({});
    expect(state.antigravityContinuations).toHaveProperty(AGENT);
  });

  it("doesn't prune task tabs when Paseo returns an incomplete agent list", async () => {
    const t = await setup();
    await t.open();
    t.agent.lastUserMessageAt = new Date().toISOString();
    const child = (await t.service.setAgentAccount(t.paseo as never, AGENT, B)).continuedIn!.agentId;
    t.incompleteAgentList = true;

    await (t.service as unknown as { prune(paseo: typeof t.paseo): Promise<void> }).prune(t.paseo as never);

    const chain = (await t.store.read()).antigravityContinuations[AGENT]!;
    expect(chain.members[AGENT]).toBeDefined();
    expect(chain.members[child]).toBeDefined();
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

  it("opens a fresh tab for the same account after re-authentication even before a chain exists", async () => {
    const { service, store, agent, open, paseo, created } = await setup();
    await open();
    agent.lastUserMessageAt = new Date().toISOString();
    await store.update((draft) => { draft.antigravityAccountGenerations[A] = 1; });

    const result = await service.setAgentAccount(paseo as never, AGENT, A);

    expect(result.continuedIn?.agentId).toBeTruthy();
    expect(result.continuedIn?.agentId).not.toBe(AGENT);
    expect(created).toHaveBeenCalledTimes(1);
    const chain = (await store.read()).antigravityContinuations[AGENT]!;
    expect(chain.members[AGENT]?.generation).toBe(0);
    expect(chain.members[result.continuedIn!.agentId]?.generation).toBe(1);
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
    paseo.agents.ref = () => ({
      ...originalRef(),
      timeline: {
        ...originalRef().timeline,
        refetch: async () => ({
          entries: [], epoch: "lost", window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
          startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, gap: false, staleCursor: false,
        }),
      },
    });
    await expect(service.setAgentAccount(paseo as never, AGENT, B)).rejects.toThrow(/history is unavailable/);
    expect(created).not.toHaveBeenCalled();
  });
});
