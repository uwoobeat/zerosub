import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem } from "./adapter";
import { AntigravityContinuations } from "./antigravity-continuations";
import { StateStore, StoredAccountSchema } from "./state";

type PaseoApi = PluginHookContext["paseo"];
type Snapshot = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type TimelineEntry = {
  item: AgentTimelineItem;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  turnId?: string;
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "zerosub-agy-continuations-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const statePath = join(dir, "state.json");
  let store = new StateStore(statePath);
  const accounts = ["a", "b", "c"].map((id) => StoredAccountSchema.parse({
    id,
    family: "antigravity",
    label: id.toUpperCase(),
    kind: "managed",
    home: join(dir, `home-${id}`),
    identity: null,
    email: null,
    createdAt: "2026-10-01T00:00:00Z",
  }));
  await store.update((draft) => {
    draft.accounts = accounts;
    draft.defaults.antigravity = "a";
    draft.bindings.root = { accountId: "a", source: "thread", at: "now" };
    draft.sessions.root = { accountId: "a", family: "antigravity", openedAt: "now", authHome: accounts[0]!.home };
  });

  const agents = new Map<string, Snapshot>();
  const timelines = new Map<string, TimelineEntry[]>();
  const epochs = new Map<string, string>();
  const accepted = new Map<string, Set<string>>();
  const created: Array<{ id: string; idempotencyKey?: string; config: unknown; labels: Record<string, string> }> = [];
  const sends: Array<{ id: string; text: string; messageId?: string }> = [];
  let clock = 0;
  let failAfterSend: "once" | null = null;
  let failBeforeSend = false;
  let dropCreateReply = false;
  let forceGap = new Set<string>();
  let failTimeline = new Set<string>();
  let mergeRange: { id: string; start: number; end: number } | null = null;
  let becomeBusyOnNextTimelineRead: string | null = null;

  function addAgent(id: string, values: Partial<Snapshot> = {}): Snapshot {
    const at = new Date(Date.parse("2026-10-01T00:00:00Z") + clock++ * 1000).toISOString();
    const agent = {
      id,
      provider: "antigravity",
      model: "claude-model",
      title: "Fix the build",
      cwd: dir,
      workspaceId: "workspace-1",
      status: "idle",
      currentModeId: "careful",
      thinkingOptionId: "high",
      effectiveThinkingOptionId: "high",
      features: [{ type: "toggle", id: "fast_mode", value: true, label: "Fast" }],
      labels: {},
      archivedAt: null,
      providerUnavailable: false,
      lastUserMessageAt: null,
      activeTurn: null,
      pendingPermissions: [],
      ...values,
    } as Snapshot;
    agents.set(id, agent);
    timelines.set(id, []);
    epochs.set(id, `epoch-${id}`);
    accepted.set(id, new Set());
    return agent;
  }

  function append(id: string, item: AgentTimelineItem, turnId?: string): void {
    const entries = timelines.get(id)!;
    const seq = entries.length + 1;
    const timestamp = new Date(Date.parse("2026-10-01T00:00:00Z") + clock++ * 1000).toISOString();
    entries.push({ item, timestamp, seqStart: seq, seqEnd: seq, ...(turnId ? { turnId } : {}) });
    agents.get(id)!.updatedAt = timestamp;
    if (item.type === "user_message") agents.get(id)!.lastUserMessageAt = timestamp;
  }

  function userTurn(id: string, text: string, answer?: string): void {
    const turnId = `human-turn-${clock}`;
    append(id, { type: "user_message", text, clientMessageId: `human-${clock}` }, turnId);
    if (answer) append(id, { type: "assistant_message", text: answer }, turnId);
  }

  function trimBefore(id: string, minSeq: number): void {
    timelines.set(id, (timelines.get(id) ?? []).filter((entry) => entry.seqStart >= minSeq));
  }

  function resetTimeline(id: string, epoch: string): void {
    timelines.set(id, []);
    epochs.set(id, epoch);
  }

  addAgent("root", { lastUserMessageAt: "2026-10-01T00:00:00Z" });
  append("root", { type: "user_message", text: "Repair the build and preserve the API." }, "human-turn-1");
  append("root", { type: "assistant_message", text: "The parser is repaired; the tests remain." }, "human-turn-1");

  const create = vi.fn(async (request: { agentId: string; idempotencyKey?: string; config: { provider: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> }; title: string; labels: Record<string, string> }) => {
    const id = request.agentId;
    created.push({ id, idempotencyKey: request.idempotencyKey, config: request.config, labels: request.labels });
    if (agents.has(id)) return {};
    const binding = (await store.read()).bindings[id];
    expect(binding?.accountId).toBeTruthy();
    const [provider, model] = request.config.provider.split("/");
    addAgent(id, {
      provider: provider ?? "antigravity",
      model: model ?? null,
      title: request.title,
      labels: request.labels,
      currentModeId: request.config.modeId ?? null,
      thinkingOptionId: request.config.thinkingOptionId ?? null,
      effectiveThinkingOptionId: request.config.thinkingOptionId ?? null,
      features: Object.entries(request.config.featureValues ?? {}).map(([featureId, value]) => ({
        type: typeof value === "boolean" ? "toggle" : "select",
        id: featureId,
        label: featureId,
        value,
      })) as Snapshot["features"],
    });
    if (dropCreateReply) {
      dropCreateReply = false;
      throw new Error("create reply lost");
    }
    return {};
  });

  const refetch = async (id: string, options: { direction?: "tail" | "before"; cursor?: { epoch: string; seq: number }; limit?: number }) => {
    if (failTimeline.has(id)) throw new Error(`timeline read failed for ${id}`);
    const all = timelines.get(id);
    if (!all) throw new Error("missing timeline");
    const epoch = epochs.get(id)!;
    const eligible = options.direction === "before" ? all.filter((entry) => entry.seqEnd < (options.cursor?.seq ?? 0)) : all;
    let entries = eligible.slice(-(options.limit ?? 500));
    if (mergeRange?.id === id) {
      const selected = entries.filter((entry) => entry.seqStart >= mergeRange!.start && entry.seqEnd <= mergeRange!.end);
      if (selected.length >= 2) {
        entries = entries.filter((entry) => !selected.includes(entry));
        entries.push({
          item: { type: "assistant_message", text: selected.map((entry) => entry.item.type === "assistant_message" ? entry.item.text : "projected user update").join("\n") },
          timestamp: selected[0]!.timestamp,
          seqStart: selected[0]!.seqStart,
          seqEnd: selected.at(-1)!.seqEnd,
        });
        entries.sort((left, right) => left.seqStart - right.seqStart);
      }
      mergeRange = null;
    }
    const minSeq = all[0]?.seqStart ?? 0;
    const maxSeq = all.at(-1)?.seqEnd ?? 0;
    const result = {
      epoch,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      entries,
      startCursor: entries.length ? { epoch, seq: entries[0]!.seqStart } : null,
      endCursor: entries.length ? { epoch, seq: entries.at(-1)!.seqEnd } : null,
      hasOlder: eligible.length > entries.length,
      hasNewer: false,
      gap: forceGap.has(id),
      staleCursor: false,
    };
    if (becomeBusyOnNextTimelineRead) {
      const busyId = becomeBusyOnNextTimelineRead;
      becomeBusyOnNextTimelineRead = null;
      agents.set(busyId, { ...agents.get(busyId)!, status: "running" });
    }
    return result;
  };

  const paseo = {
    providers: { listModels: async () => ({ models: [{ id: "claude-model", isDefault: true }] }) },
    workspaces: { ref: () => ({ agents: { create } }) },
    agents: {
      create,
      list: async (options?: { filter?: { includeArchived?: boolean } }) => ({
        entries: [...agents.values()]
          .filter((agent) => options?.filter?.includeArchived || !agent.archivedAt)
          .map((agent) => ({ agent: structuredClone(agent) })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? { agent: structuredClone(agents.get(id)!) } : null,
        send: async (text: string, options?: { messageId?: string }) => {
          sends.push({ id, text, messageId: options?.messageId });
          if (failBeforeSend) {
            failBeforeSend = false;
            throw new Error("connection lost before receipt");
          }
          const messageId = options?.messageId ?? `message-${clock}`;
          if (accepted.get(id)!.has(messageId)) return;
          accepted.get(id)!.add(messageId);
          const turnId = `agy-turn-${clock++}`;
          append(id, { type: "user_message", text, clientMessageId: messageId }, turnId);
          const bound = (await store.read()).bindings[id];
          if (bound) {
            await store.update((draft) => {
              draft.sessions[id] = {
                accountId: bound.accountId,
                family: "antigravity",
                openedAt: "now",
                authGeneration: draft.antigravityAccountGenerations[bound.accountId] ?? 0,
                authHome: draft.accounts.find((account) => account.id === bound.accountId)?.home ?? null,
              };
            });
          }
          if (failAfterSend) {
            failAfterSend = null;
            throw new Error("send reply lost after daemon accepted it");
          }
        },
        timeline: {
          refetch: (options: { direction?: "tail" | "before"; cursor?: { epoch: string; seq: number }; limit?: number }) => refetch(id, options),
          append: async () => ({ seq: 1, epoch: "epoch" }),
        },
      }),
    },
  } as unknown as PaseoApi;

  const makeManager = (nextStore = store) => new AntigravityContinuations(nextStore);
  const switchTo = (agentId: string, accountId: string, manager = makeManager()) => manager.continue(
    paseo,
    agentId,
    accounts.find((account) => account.id === accountId)!,
    "you selected another account",
  );
  const restart = async () => {
    store = new StateStore(statePath);
    return makeManager(store);
  };

  return {
    accounts, agents, timelines, epochs, created, sends, append, userTurn, trimBefore, resetTimeline, switchTo, paseo, makeManager,
    get store() { return store; }, restart,
    set failAfterSend(value: "once" | null) { failAfterSend = value; },
    set failBeforeSend(value: boolean) { failBeforeSend = value; },
    set dropCreateReply(value: boolean) { dropCreateReply = value; },
    set forceGap(value: Set<string>) { forceGap = value; },
    set failTimeline(value: Set<string>) { failTimeline = value; },
    set mergeRange(value: { id: string; start: number; end: number } | null) { mergeRange = value; },
    set becomeBusyOnNextTimelineRead(value: string | null) { becomeBusyOnNextTimelineRead = value; },
  };
}

describe("Antigravity task continuations", () => {
  it("records automatic handoffs across restarts and refuses an already handled turn", async () => {
    const t = await setup();
    const automatic = {
      turnId: "failed-turn", openedAt: "session-1", lastUserMessageAt: t.agents.get("root")!.lastUserMessageAt ?? null,
      continuePrompt: "Continue", validate: async () => true,
    };
    await t.makeManager().continue(t.paseo, "root", t.accounts[1]!, "the model quota ran out", automatic);
    expect((await t.store.read()).antigravityContinuations.root?.automatic).toEqual([
      expect.objectContaining({ sourceAgentId: "root", turnId: "failed-turn", openedAt: "session-1", status: "completed" }),
    ]);
    const restarted = await t.restart();
    await expect(restarted.continue(t.paseo, "root", t.accounts[1]!, "quota", automatic)).rejects.toThrow();
    expect(t.sends).toHaveLength(1);
  });

  it("rechecks automatic eligibility before dispatch and leaves the source untouched when invalid", async () => {
    const t = await setup();
    await expect(t.makeManager().continue(t.paseo, "root", t.accounts[1]!, "quota", {
      turnId: "failed-turn", openedAt: "session-1", lastUserMessageAt: t.agents.get("root")!.lastUserMessageAt ?? null,
      continuePrompt: "Continue", validate: async () => false,
    })).rejects.toThrow(/no longer valid/);
    expect(t.created).toHaveLength(0);
    expect(t.sends).toHaveLength(0);
  });

  it("shares the automatic switch limit across tabs after a restart", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.get(b.agentId)!.lastUserMessageAt = null;
    await t.store.update((draft) => {
      const chain = draft.antigravityContinuations.root!;
      chain.activeAgentId = "root";
      chain.automatic = Array.from({ length: 4 }, (_, index) => ({
        sourceAgentId: index % 2 ? b.agentId : "root", turnId: `old-${index}`, openedAt: "session", at: Date.now(), status: "completed" as const,
      }));
    });
    const manager = await t.restart();
    await expect(manager.continue(t.paseo, "root", t.accounts[2]!, "quota", {
      turnId: "next", openedAt: "session", lastUserMessageAt: t.agents.get("root")!.lastUserMessageAt ?? null,
      continuePrompt: "Continue", validate: async () => true,
    })).rejects.toThrow(/switched too often/);
    expect(t.sends).toHaveLength(1);
  });

  it("reuses A and B tabs and sends only the updates a parked tab has not received", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    expect(t.created).toHaveLength(1);
    expect(t.sends[0]!.text).toContain("Repair the build and preserve the API.");
    expect(t.sends[0]!.text).toContain("The parser is repaired");

    t.userTurn(b.agentId, "Only change the tests now. Keep the parser.", "The regression test passes.");
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    expect(t.sends.at(-1)!.text).toContain("Only change the tests now");
    expect(t.sends.at(-1)!.text).toContain("The regression test passes");
    expect(t.sends.at(-1)!.text).not.toContain("Repair the build and preserve the API.");

    t.append("root", { type: "assistant_message", text: "The tests pass; no source changes were needed." }, "human-turn-final");
    expect((await t.switchTo("root", "b")).agentId).toBe(b.agentId);
    expect(t.created).toHaveLength(1);
    expect(t.sends.at(-1)!.text).toContain("The tests pass; no source changes were needed.");
    expect(t.sends.at(-1)!.text).not.toContain("regression test passes");
  });

  it("keeps three-account updates and independent same-workspace tasks separate", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.userTurn(b.agentId, "Use the compatibility API.");
    const c = await t.switchTo(b.agentId, "c");
    t.append(c.agentId, { type: "assistant_message", text: "Compatibility checks are green." }, "turn-c");
    expect((await t.switchTo(c.agentId, "a")).agentId).toBe("root");
    expect(t.sends.at(-1)!.text).toContain("Use the compatibility API");
    expect(t.sends.at(-1)!.text).toContain("Compatibility checks are green");

    t.agents.set("other", { ...t.agents.get("root")!, id: "other", labels: {}, lastUserMessageAt: null });
    t.timelines.set("other", []);
    t.epochs.set("other", "epoch-other");
    await t.store.update((draft) => {
      draft.bindings.other = { accountId: "a", source: "thread", at: "now" };
      draft.sessions.other = { accountId: "a", family: "antigravity", openedAt: "now", authGeneration: 0, authHome: t.accounts[0]!.home };
    });
    t.append("other", { type: "user_message", text: "A separate task." }, "separate-turn");
    const separate = await t.switchTo("other", "b");
    expect(t.created).toHaveLength(3);
    expect(t.sends.at(-1)!.text).toContain("A separate task.");
    expect(t.sends.at(-1)!.text).not.toContain("Use the compatibility API");
    expect(separate.agentId).not.toBe(b.agentId);
  });

  it("adopts a legacy continuation descendant before reusing its original account tab", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    await t.store.update((draft) => { delete draft.antigravityContinuations.root; });
    t.userTurn(b.agentId, "Keep the public API unchanged.");

    const back = await t.switchTo(b.agentId, "a");

    expect(back.agentId).toBe("root");
    expect(t.sends.at(-1)!.text).toContain("Keep the public API unchanged.");
    expect((await t.store.read()).antigravityContinuations.root?.members[b.agentId]).toBeDefined();
  });

  it("refuses to adopt ambiguous legacy tabs for the same task and account", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    await t.store.update((draft) => { delete draft.antigravityContinuations.root; });
    const duplicateId = "legacy-b-duplicate";
    t.agents.set(duplicateId, {
      ...t.agents.get(b.agentId)!,
      id: duplicateId,
      labels: { ["zerosub.continued-from"]: "root" },
      lastUserMessageAt: null,
    });
    t.timelines.set(duplicateId, []);
    t.epochs.set(duplicateId, `epoch-${duplicateId}`);
    await t.store.update((draft) => {
      draft.bindings[duplicateId] = { accountId: "b", source: "thread", at: "now" };
      draft.sessions[duplicateId] = {
        accountId: "b",
        family: "antigravity",
        openedAt: "now",
        authGeneration: 0,
        authHome: t.accounts[1]!.home,
      };
    });

    await expect(t.switchTo("root", "b")).rejects.toThrow(/more than one compatible Antigravity tab/i);

    expect(t.created).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("accepts unknown identities but rejects a tab from an observed re-login generation", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    await t.store.update((draft) => { draft.antigravityAccountGenerations.a = 1; });
    const fresh = await t.switchTo(b.agentId, "a");
    expect(fresh.agentId).not.toBe("root");
    expect(t.created).toHaveLength(2);
    expect((await t.store.read()).antigravityContinuations.root?.members.root?.generation).toBe(0);
  });

  it("treats unknown-to-known identity enrichment as the same account", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    await t.store.update((draft) => {
      draft.accounts.find((account) => account.id === "a")!.identity = "subject-a";
      draft.accounts.find((account) => account.id === "a")!.email = "a@example.invalid";
    });

    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    expect(t.created).toHaveLength(1);
  });

  it("does not mistake a pre-existing session for a new login when first building the chain", async () => {
    const t = await setup();
    await t.store.update((draft) => {
      draft.sessions.root!.authGeneration = 0;
      draft.antigravityAccountGenerations.a = 1;
    });
    const b = await t.switchTo("root", "b");
    expect((await t.store.read()).antigravityContinuations.root?.members.root?.generation).toBe(0);
    const fresh = await t.switchTo(b.agentId, "a");
    expect(fresh.agentId).not.toBe("root");
  });

  it("opens a new tab when the account HOME changes before a task chain exists", async () => {
    const t = await setup();
    await t.store.update((draft) => { draft.accounts.find((account) => account.id === "a")!.home = join(dir, "new-home-a"); });
    const state = await t.store.read();
    expect(t.makeManager().needsFreshTab(state, "root", "a")).toBe(true);

    const b = await t.switchTo("root", "b");
    const fresh = await t.switchTo(b.agentId, "a");

    expect(fresh.agentId).not.toBe("root");
    expect(t.created).toHaveLength(2);
  });

  it("uses the target account's current generation when reserving a new tab", async () => {
    const t = await setup();
    await t.store.update((draft) => {
      draft.antigravityAccountGenerations.a = 1;
      draft.sessions.root!.authGeneration = 1;
    });
    const b = await t.switchTo("root", "b");
    let chain = (await t.store.read()).antigravityContinuations.root!;
    expect(chain.members[b.agentId]?.generation).toBe(0);

    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    chain = (await t.store.read()).antigravityContinuations.root!;
    expect(chain.members.root?.generation).toBe(1);
  });

  it("does not trust a requested binding as session attribution", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    await t.store.update((draft) => { delete draft.sessions[b.agentId]; });

    await expect(t.switchTo("root", "b")).rejects.toThrow(/changed workspace or account/i);

    expect(t.created).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
    expect((await t.store.read()).bindings[b.agentId]?.accountId).toBe("b");
  });

  it("does not reuse a tab with a different model or permission configuration", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    const root = t.agents.get("root")!;
    t.agents.set("root", { ...root, currentModeId: "safe" });
    const next = await t.switchTo("root", "b");
    expect(next.agentId).not.toBe(b.agentId);
    expect(t.created).toHaveLength(2);
  });

  it("refuses a switch while any task tab is running or waiting for permission", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.set("root", { ...t.agents.get("root")!, status: "running" });
    await expect(t.switchTo(b.agentId, "c")).rejects.toThrow(/another Antigravity tab.*working/i);
    t.agents.set("root", { ...t.agents.get("root")!, status: "idle", pendingPermissions: [{ id: "permission" }] } as Snapshot);
    await expect(t.switchTo(b.agentId, "c")).rejects.toThrow(/another Antigravity tab.*permission/i);
    expect(t.created).toHaveLength(1);
  });

  it("rechecks every task tab for new turns immediately before sending", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.userTurn("root", "Preserve this update.");
    t.becomeBusyOnNextTimelineRead = b.agentId;

    await expect(t.switchTo("root", "c")).rejects.toThrow(/another Antigravity tab.*working/i);

    expect(t.created).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("recovers an accepted send by its canonical receipt without sending twice", async () => {
    const t = await setup();
    t.failAfterSend = "once";
    await expect(t.switchTo("root", "b")).rejects.toThrow(/send reply lost/);
    const retried = await t.switchTo("root", "b");
    expect(retried.agentId).toBe(t.created[0]!.id);
    expect(t.created).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("reuses durable cursors after plugin restart and stops when canonical history has a gap", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    const restarted = await t.restart();
    t.userTurn(b.agentId, "Persist the retry behavior.");
    const back = await restarted.continue(t.paseo, b.agentId, t.accounts[0]!, "you selected another account");
    expect(back.agentId).toBe("root");
    expect(t.created).toHaveLength(1);
    expect(t.sends.at(-1)!.text).toContain("Persist the retry behavior.");

    t.forceGap = new Set(["root"]);
    await expect(t.switchTo("root", "c")).rejects.toThrow(/retained history has a gap/i);
    expect(t.created).toHaveLength(1);
  });

  it("refuses to continue from a new empty timeline epoch after daemon restart", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.resetTimeline(b.agentId, "post-restart-b");
    t.userTurn(b.agentId, "Continue.");

    await expect(t.switchTo(b.agentId, "c")).rejects.toThrow(/new or shortened timeline epoch.*start a new Antigravity agent.*full task context/i);
    expect(t.created).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("propagates parked timeline failures instead of dropping their latest instruction", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.userTurn("root", "STOP: do not push anything.");
    t.failTimeline = new Set(["root"]);

    await expect(t.switchTo(b.agentId, "c")).rejects.toThrow(/timeline read failed for root/i);
    expect(t.created).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("rejects projected timeline entries that cross a saved cursor", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.userTurn("root", "Only change the tests now.");
    await t.switchTo(b.agentId, "a");
    t.mergeRange = { id: "root", start: 2, end: 3 };

    await expect(t.switchTo("root", "b")).rejects.toThrow(/projected timeline entry across the saved cursor/i);
    expect(t.created).toHaveLength(1);
  });

  it("settles another account's pending send idempotently before switching again", async () => {
    const t = await setup();
    t.failBeforeSend = true;
    await expect(t.switchTo("root", "b")).rejects.toThrow(/connection lost before receipt/);
    const first = t.sends[0]!;

    const c = await t.switchTo("root", "c");

    expect(c.agentId).not.toBe(first.id);
    expect(t.sends).toHaveLength(3);
    expect(t.sends[1]!.id).toBe(first.id);
    expect(t.sends[1]!.messageId).toBe(first.messageId);
    expect(t.sends[1]!.text).toBe(first.text);
    expect(t.sends[2]!.id).toBe(c.agentId);
  });

  it("clears an unsent reservation when an existing destination already has every update", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    const chain = (await t.store.read()).antigravityContinuations.root!;
    await t.store.update((draft) => {
      draft.antigravityContinuations.root!.pending = {
        agentId: b.agentId,
        sourceAgentId: "root",
        accountId: "b",
        messageId: "zerosub-antigravity-handoff-unstarted",
        prompt: "",
        seen: chain.members[b.agentId]!.seen,
        observed: {},
        stage: "creating",
      };
    });

    expect((await t.switchTo("root", "b")).agentId).toBe(b.agentId);
    expect((await t.store.read()).antigravityContinuations.root?.pending).toBeUndefined();
    expect(t.sends).toHaveLength(1);
  });

  it("keeps missing task members visible so pruning cannot erase unverified history", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.delete("root");
    t.timelines.delete("root");
    t.epochs.delete("root");
    await t.makeManager().prune(t.paseo, new Set([b.agentId]));
    t.userTurn(b.agentId, "Continue.");

    await expect(t.switchTo(b.agentId, "c")).rejects.toThrow(/task tab root was removed from this task's verified history.*start a new Antigravity agent.*full task context/i);
    expect((await t.store.read()).antigravityContinuations.root?.members.root?.missing).toBe(true);
    expect(t.created).toHaveLength(1);
  });

  it("refuses a retained timeline window that no longer includes the task baseline", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.userTurn(b.agentId, "Continue.");
    t.trimBefore(b.agentId, 2);

    await expect(t.switchTo(b.agentId, "c")).rejects.toThrow(/retained timeline no longer contains its complete history/i);
    expect(t.created).toHaveLength(1);
  });

  it("keeps the reserved tab ID after losing a creation response", async () => {
    const t = await setup();
    t.dropCreateReply = true;
    await expect(t.switchTo("root", "b")).rejects.toThrow(/create reply lost/);
    const next = await t.switchTo("root", "b");
    expect(next.agentId).toBe(t.created[0]!.id);
    expect(t.created.length).toBeGreaterThanOrEqual(1);
    expect(t.created.every((entry) => entry.id === t.created[0]!.id && entry.idempotencyKey === entry.id)).toBe(true);
    expect(t.created[0]!.idempotencyKey).toBe(t.created[0]!.id);
    expect(t.sends).toHaveLength(1);
  });

  it("retries an uncertain send with the same prompt and message ID", async () => {
    const t = await setup();
    // Make the next SDK call reject before adding a receipt; the tab is still idle.
    t.failBeforeSend = true;
    t.userTurn("root", "Do not lose this instruction.");
    await expect(t.switchTo("root", "b")).rejects.toThrow(/connection lost before receipt/);
    const first = t.sends.at(-1)!;
    const retried = await t.switchTo("root", "b");
    const second = t.sends.at(-1)!;
    expect(retried.agentId).toBe(first.id);
    expect(second.text).toBe(first.text);
    expect(second.messageId).toBe(first.messageId);
    expect(t.sends).toHaveLength(2);
  });

  it("retains archived history, prunes missing members and preserves pending deliveries", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.set(b.agentId, { ...t.agents.get(b.agentId)!, archivedAt: "2026-10-02T00:00:00Z" });
    await t.makeManager().prune(t.paseo, new Set(["root", b.agentId]));
    let chain = (await t.store.read()).antigravityContinuations.root!;
    expect(chain.members[b.agentId]).toBeDefined();
    await t.makeManager().prune(t.paseo, new Set(["root"]));
    chain = (await t.store.read()).antigravityContinuations.root!;
    expect(chain.members[b.agentId]).toBeDefined();

    t.userTurn("root", "Keep this instruction available.");
    t.failBeforeSend = true;
    await expect(t.switchTo("root", "c")).rejects.toThrow(/connection lost before receipt/);
    const pending = (await t.store.read()).antigravityContinuations.root!.pending;
    await t.makeManager().prune(t.paseo, new Set(["root"]));

    chain = (await t.store.read()).antigravityContinuations.root!;
    expect(chain.pending).toEqual(pending);
    expect(chain.members[pending!.agentId]).toBeDefined();
  });
});
