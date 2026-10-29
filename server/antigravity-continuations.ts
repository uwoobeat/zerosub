import { randomUUID } from "node:crypto";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "./adapter";
import { fitInstructions } from "./continuations";
import { buildTranscript, CONTINUED_FROM_LABEL, continueInNewAgent } from "./handoff";
import { Mutex } from "./json-file";
import { isUsable } from "./routing";
import {
  MAIN_ACCOUNT_ID,
  StateStore,
  findAccount,
  type AntigravityContinuation,
  type AntigravityContinuationMember,
  type StoredAccount,
  type StoredState,
} from "./state";

type PaseoApi = PluginHookContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type Mark = AntigravityContinuationMember["seen"][string];
type Entry = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>["entries"][number];
type Update = { item: AgentTimelineItem; timestamp: string };
type Pending = NonNullable<AntigravityContinuation["pending"]>;

const MESSAGE_PREFIX = "zerosub-antigravity-handoff-";
const MAX_PAGES = 100;

function samePlace(left: Agent, right: Agent): boolean {
  if (left.provider !== right.provider || left.workspaceId !== right.workspaceId) return false;
  return Boolean(left.workspaceId) || left.cwd === right.cwd;
}

function busy(agent: Agent): boolean {
  return agent.status === "running" || agent.status === "initializing" || Boolean(agent.activeTurn) ||
    Boolean(agent.pendingPermissions?.length);
}

function ready(agent: Agent): boolean {
  return !agent.archivedAt && !agent.providerUnavailable && !busy(agent) &&
    (agent.status === "idle" || agent.status === "closed" || agent.status === "error");
}

function configKey(agent: Agent): string {
  const features = [...(agent.features ?? [])]
    .map((feature) => [feature.id, feature.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    agent.provider,
    agent.model ?? agent.runtimeInfo?.model ?? null,
    agent.currentModeId,
    agent.thinkingOptionId ?? null,
    agent.effectiveThinkingOptionId ?? null,
    features,
  ]);
}

function accountForAgent(state: StoredState, agentId: string): StoredAccount | undefined {
  const session = state.sessions[agentId];
  if (session && session.family !== "antigravity") return undefined;
  // A binding is the requested destination, not proof that an unrecorded session ran there.
  const id = session?.accountId ?? MAIN_ACCOUNT_ID.antigravity;
  const account = findAccount(state, id);
  return account?.family === "antigravity" ? account : undefined;
}

function memberFor(
  account: StoredAccount,
  state: StoredState,
  agent: Agent,
  useSessionGeneration = false,
): AntigravityContinuationMember {
  const session = state.sessions[agent.id];
  const sessionBelongsHere = useSessionGeneration && session?.family === "antigravity" && session.accountId === account.id;
  return {
    accountId: account.id,
    home: sessionBelongsHere ? session.authHome ?? null : account.home,
    identity: account.identity,
    email: account.email,
    generation: sessionBelongsHere
      ? session.authGeneration ?? 0
      : state.antigravityAccountGenerations[account.id] ?? 0,
    configKey: configKey(agent),
    seen: {},
  };
}

function memberMatchesAccount(entry: AntigravityContinuationMember, state: StoredState, account: StoredAccount): boolean {
  return entry.accountId === account.id && entry.home === account.home &&
    compatibleIdentity(entry.identity, account.identity) && compatibleIdentity(entry.email, account.email) &&
    entry.generation === (state.antigravityAccountGenerations[account.id] ?? 0);
}

function compatibleIdentity(left: string | null | undefined, right: string | null | undefined): boolean {
  return left == null || right == null || left === right;
}

function boundTo(state: StoredState, agentId: string, accountId: string): boolean {
  const session = state.sessions[agentId];
  if (session) return session.family === "antigravity" && session.accountId === accountId;
  return accountId === MAIN_ACCOUNT_ID.antigravity;
}

function reservedFor(state: StoredState, agentId: string, accountId: string): boolean {
  return state.bindings[agentId]?.accountId === accountId;
}

function currentAccount(state: StoredState, id: string): StoredAccount | undefined {
  const account = findAccount(state, id);
  return account?.family === "antigravity" && isUsable(account, Date.now()) ? account : undefined;
}

async function snapshot(paseo: PaseoApi, agentId: string): Promise<Agent | undefined> {
  return (await paseo.agents.ref(agentId).refresh())?.agent;
}

function chainOf(state: StoredState, agentId: string): string | undefined {
  return Object.keys(state.antigravityContinuations).find((id) => state.antigravityContinuations[id]?.members[agentId]);
}

function delivered(entry: Entry, messageId: string): boolean {
  return Boolean(entry.turnId) && entry.item.type === "user_message" && entry.item.clientMessageId === messageId;
}

/** Commit exactly the cursor range reserved before the SDK send. */
function completeHandoff(chain: AntigravityContinuation, receipt: Mark, target: Agent): void {
  const pending = chain.pending!;
  const member = chain.members[pending.agentId];
  if (!member) throw new Error("The reserved Antigravity tab is missing from its task record.");
  // The first delivered handoff is the durable copy of inherited task context.
  // Keep it recognizable even after its source tab is deleted or pruned.
  chain.baselineMessageId ??= pending.messageId;
  const baselineMark = pending.seen[pending.sourceAgentId];
  if (!chain.baselineSource && baselineMark) {
    chain.baselineSource = { agentId: pending.sourceAgentId, mark: baselineMark };
  }
  applyObserved(chain, pending.observed);
  member.seen = pending.seen;
  member.timelineMark = receipt;
  member.lastHandoffMessageId = pending.messageId;
  member.updatedAt = target.updatedAt;
  member.lastUserMessageAt = target.lastUserMessageAt;
  delete member.missing;
  delete member.unstarted;
  chain.activeAgentId = pending.agentId;
  delete chain.pending;
}

interface Destination {
  targetId: string;
  agent?: Agent;
  entry?: AntigravityContinuationMember;
}

interface Gathered {
  updates: Update[];
  seen: Record<string, Mark>;
  observed: Pending["observed"];
  fallback: boolean;
  contextVerified: boolean;
}

/** Account-bound Antigravity tabs for one task. This state and lock chain are separate from Codex. */
export class AntigravityContinuations {
  private readonly locks = new Map<string, { mutex: Mutex; users: number }>();
  private readonly inFlight = new Map<string, Promise<{ agentId: string; title: string }>>();

  constructor(private readonly store: StateStore) {}

  continue(
    paseo: PaseoApi,
    sourceAgentId: string,
    target: StoredAccount,
    why: string,
  ): Promise<{ agentId: string; title: string }> {
    const key = `${sourceAgentId}:${target.id}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.dispatch(paseo, sourceAgentId, target, why).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  /** Returns true when the current AGY session predates an observed re-authentication. */
  needsFreshTab(state: StoredState, agentId: string, accountId: string): boolean {
    const session = state.sessions[agentId];
    const generation = state.antigravityAccountGenerations[accountId] ?? 0;
    if (session?.family === "antigravity" && session.accountId === accountId &&
      (session.authGeneration ?? 0) !== generation) return true;
    const account = findAccount(state, accountId);
    if (session?.family === "antigravity" && session.accountId === accountId && account?.family === "antigravity" &&
      (session.authHome === undefined ? account.home !== null : session.authHome !== account.home)) return true;
    const root = chainOf(state, agentId);
    const member = root ? state.antigravityContinuations[root]?.members[agentId] : undefined;
    return Boolean(member && account?.family === "antigravity" && !memberMatchesAccount(member, state, account));
  }

  /** Confirm list omissions individually; Paseo's directory may filter background/unavailable tabs. */
  async prune(paseo: PaseoApi, knownIds: ReadonlySet<string>): Promise<void> {
    const state = await this.store.read();
    for (const [root, initial] of Object.entries(state.antigravityContinuations)) {
      const candidates = Object.keys(initial.members).filter((id) => !knownIds.has(id));
      if (initial.pending || candidates.length === 0) continue;
      await this.locked(root, async () => {
        const current = (await this.store.read()).antigravityContinuations[root];
        if (!current || current.pending) return;
        const stillMissing = new Set<string>();
        for (const id of candidates) {
          if (knownIds.has(id)) continue;
          try {
            if (!await snapshot(paseo, id)) stillMissing.add(id);
          } catch {
            // A failed refresh is not proof that an agent was deleted.
          }
        }
        if (stillMissing.size === 0) return;
        await this.store.update((draft) => {
          const chain = draft.antigravityContinuations[root];
          if (!chain || chain.pending) return;
          for (const id of stillMissing) {
            const member = chain.members[id];
            if (!member) continue;
            if (member.unstarted) {
              delete chain.members[id];
              for (const other of Object.values(chain.members)) delete other.seen[id];
            } else {
              // Keep historical membership as a tombstone: deleting it would hide possibly
              // undelivered updates from later recovery checks.
              member.missing = true;
            }
          }
          if (Object.keys(chain.members).length === 0) delete draft.antigravityContinuations[root];
          else if (!chain.members[chain.activeAgentId]) chain.activeAgentId = Object.keys(chain.members)[0]!;
        });
      });
    }
  }

  private async dispatch(
    paseo: PaseoApi,
    sourceAgentId: string,
    target: StoredAccount,
    why: string,
  ): Promise<{ agentId: string; title: string }> {
    const original = await snapshot(paseo, sourceAgentId);
    if (!original || original.archivedAt) throw new Error("The original Antigravity agent is no longer available.");
    const state = await this.store.read();
    const task = await findTask(paseo, state, original);
    return this.locked(task.root, async () => {
      let chain = await this.openChain(task.root, task.related, sourceAgentId);
      if (!chain.members[sourceAgentId]) {
        throw new Error("This Antigravity tab is no longer part of the task. Switch accounts from the task's current tab.");
      }
      const settled = await this.settlePending(paseo, task.root, chain, target.id);
      if ("done" in settled) return settled.done;
      const reserved = settled.reserved;
      chain = (await this.store.read()).antigravityContinuations[task.root]!;
      const sourceAgent = await waitForSource(paseo, original);
      const latest = await this.store.read();
      const account = currentAccount(latest, target.id);
      if (!account || !account.signedIn || account.disabled) {
        throw new Error("That Antigravity account is no longer available. Sign it in or enable it before switching.");
      }
      const current = currentAccount(latest, account.id);
      if (!current || !current.signedIn || current.disabled || !sameAccount(account, current)) {
        throw new Error("The Antigravity account changed during the handoff. Check the active tab and try again.");
      }
      const snapshots = await memberSnapshots(paseo, chain, sourceAgent);
      const destination = pickDestination(latest, chain, snapshots, sourceAgent, current, reserved);
      const expectedGeneration = latest.antigravityAccountGenerations[current.id] ?? 0;
      let targetHistoryMissing = false;
      if (destination.agent) {
        const targetHistory = await readUpdates(paseo, destination.targetId, undefined, undefined, true, true);
        targetHistoryMissing = !hasTaskContext(chain, destination.targetId, targetHistory);
      }
      const gathered = await gatherUpdates(paseo, latest, chain, snapshots, sourceAgent, destination, targetHistoryMissing);
      const prompt = composePrompt(chain, destination, gathered, why);
      if (destination.agent && !prompt) {
        await this.store.update((draft) => {
          const currentChain = draft.antigravityContinuations[task.root]!;
          const member = currentChain.members[destination.targetId]!;
          member.seen = gathered.seen;
          applyObserved(currentChain, gathered.observed);
          if (currentChain.pending?.stage === "creating" && currentChain.pending.agentId === destination.targetId) {
            delete currentChain.pending;
          }
          currentChain.activeAgentId = destination.targetId;
        });
        return { agentId: destination.targetId, title: destination.agent.title ?? "Antigravity task" };
      }
      const messageId = reserved?.messageId ?? `${MESSAGE_PREFIX}${randomUUID()}`;
      await this.confirmUnchanged(paseo, chain, snapshots, sourceAgent, destination, current, expectedGeneration);
      await this.reserve(task.root, sourceAgent, destination, gathered, current, messageId, prompt, expectedGeneration);
      const reservedChain = (await this.store.read()).antigravityContinuations[task.root]!;
      return this.deliver(paseo, task.root, reservedChain, snapshots, sourceAgent, destination, current, prompt, messageId, why, expectedGeneration);
    });
  }

  private locked<T>(root: string, section: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(root);
    if (!lock) this.locks.set(root, (lock = { mutex: new Mutex(), users: 0 }));
    lock.users += 1;
    return lock.mutex.run(section).finally(() => {
      if (--lock.users === 0) this.locks.delete(root);
    });
  }

  private async openChain(root: string, related: Agent[], sourceAgentId: string): Promise<AntigravityContinuation> {
    const existing = (await this.store.read()).antigravityContinuations[root];
    if (existing) return existing;
    const next = await this.store.update((draft) => {
      const members: AntigravityContinuation["members"] = {};
      for (const agent of related) {
        const account = accountForAgent(draft, agent.id);
        if (!account) continue;
        members[agent.id] = memberFor(account, draft, agent, true);
        draft.bindings[agent.id] ??= { accountId: account.id, source: "thread", at: new Date().toISOString() };
      }
      if (!members[sourceAgentId]) {
        throw new Error("Couldn't establish this Antigravity tab's account. Reopen it before switching.");
      }
      draft.antigravityContinuations[root] = { activeAgentId: sourceAgentId, members };
    });
    return next.antigravityContinuations[root]!;
  }

  private async settlePending(
    paseo: PaseoApi,
    root: string,
    chain: AntigravityContinuation,
    requestedAccountId: string,
  ): Promise<{ done: { agentId: string; title: string } } | { reserved?: Pending }> {
    const pending = chain.pending;
    if (!pending) return {};
    const agent = await snapshot(paseo, pending.agentId);
    const sameAccount = pending.accountId === requestedAccountId;
    if (pending.stage === "creating") {
      if (!sameAccount) {
        await this.store.update((draft) => {
          const current = draft.antigravityContinuations[root];
          if (current?.pending?.messageId !== pending.messageId) return;
          delete current.pending;
          if (current.members[pending.agentId]?.unstarted) {
            delete current.members[pending.agentId];
            for (const member of Object.values(current.members)) delete member.seen[pending.agentId];
            if (draft.sessions[pending.agentId]?.family !== "antigravity" &&
              draft.bindings[pending.agentId]?.accountId === pending.accountId) delete draft.bindings[pending.agentId];
          }
        });
        return {};
      }
      if (agent?.archivedAt) {
        await this.store.update((draft) => {
          const current = draft.antigravityContinuations[root];
          if (current?.pending?.messageId !== pending.messageId) return;
          delete current.pending;
          if (current.members[pending.agentId]?.unstarted) {
            delete current.members[pending.agentId];
            for (const member of Object.values(current.members)) delete member.seen[pending.agentId];
          }
        });
        return {};
      }
      return { reserved: pending };
    }
    if (agent && !agent.archivedAt) {
      const history = await readUpdates(paseo, pending.agentId, undefined, pending.messageId);
      if (history.entries.some((entry) => delivered(entry, pending.messageId))) {
        await this.store.update((draft) => completeHandoff(draft.antigravityContinuations[root]!, history.mark, agent));
        return sameAccount ? { done: { agentId: agent.id, title: agent.title ?? "Antigravity task" } } : {};
      }
    }
    if (!agent || agent.archivedAt) {
      await this.store.update((draft) => {
        const current = draft.antigravityContinuations[root];
        if (current?.pending?.messageId === pending.messageId) delete current.pending;
      });
      return {};
    }
    if (busy(agent)) throw new Error("The previous Antigravity handoff may still be running. Wait for that tab to stop before switching again.");
    const state = await this.store.read();
    const account = findAccount(state, pending.accountId);
    const member = chain.members[pending.agentId];
    const attributed = boundTo(state, pending.agentId, pending.accountId) ||
      Boolean(member?.unstarted && reservedFor(state, pending.agentId, pending.accountId));
    if (!account || account.family !== "antigravity" || !account.signedIn || account.disabled || !member ||
      !memberMatchesAccount(member, state, account) || !attributed) {
      throw new Error(`The previous handoff to ${pending.agentId} is unresolved and its account is unavailable. Restore that account or archive the destination tab before switching.`);
    }
    if (!pending.prompt) {
      throw new Error(`The previous handoff to ${pending.agentId} predates safe retry data and cannot be confirmed. Check or archive that destination tab before switching.`);
    }
    // The daemon persists messageId receipts. Replaying the exact request resolves completed
    // receipts without starting another turn and leaves pending/changed requests rejected.
    await paseo.agents.ref(pending.agentId).send(pending.prompt, { messageId: pending.messageId });
    const receipt = await waitForReceipt(paseo, pending.agentId, pending.messageId);
    const target = await snapshot(paseo, pending.agentId);
    if (!target) throw new Error("The Antigravity destination disappeared while recovering its send receipt.");
    await this.store.update((draft) => completeHandoff(draft.antigravityContinuations[root]!, receipt.mark, target));
    return sameAccount ? { done: { agentId: target.id, title: target.title ?? "Antigravity task" } } : {};
  }

  private async confirmUnchanged(
    paseo: PaseoApi,
    chain: AntigravityContinuation,
    beforeMembers: Map<string, Agent>,
    source: Agent,
    destination: Destination,
    account: StoredAccount,
    expectedGeneration: number,
  ): Promise<void> {
    const sourceNow = await snapshot(paseo, source.id);
    const targetNow = destination.agent && await snapshot(paseo, destination.targetId);
    const membersNow = await memberSnapshots(paseo, chain, source);
    const state = await this.store.read();
    for (const [id, before] of beforeMembers) {
      const now = membersNow.get(id);
      if (!now || !samePlace(before, now) || configKey(before) !== configKey(now) ||
        before.lastUserMessageAt !== now.lastUserMessageAt || before.updatedAt !== now.updatedAt ||
        Boolean(before.archivedAt) !== Boolean(now.archivedAt)) {
        throw new Error("An Antigravity task tab changed during the handoff. Check the task and try again.");
      }
    }
    for (const id of membersNow.keys()) {
      if (!beforeMembers.has(id)) {
        throw new Error("An Antigravity task tab appeared during the handoff. Check the task and try again.");
      }
      const member = chain.members[id];
      const isReservedTarget = id === chain.pending?.agentId && member?.unstarted &&
        reservedFor(state, id, member.accountId);
      if (member && !boundTo(state, id, member.accountId) && !isReservedTarget) {
        throw new Error("An Antigravity task tab changed account during the handoff. Check the task and try again.");
      }
    }
    const destinationReserved = chain.pending?.agentId === destination.targetId &&
      chain.members[destination.targetId]?.unstarted && reservedFor(state, destination.targetId, account.id);
    if (!unchanged(source, sourceNow) ||
      (destination.agent && (!targetNow || !unchanged(destination.agent, targetNow) ||
        (!boundTo(state, destination.targetId, account.id) && !destinationReserved))) ||
      !sameAccount(account, findAccount(state, account.id)) ||
      (state.antigravityAccountGenerations[account.id] ?? 0) !== expectedGeneration) {
      throw new Error("The Antigravity task or account changed during the handoff. Check the active tab and try again.");
    }
  }

  private async reserve(
    root: string,
    source: Agent,
    destination: Destination,
    gathered: Gathered,
    account: StoredAccount,
    messageId: string,
    prompt: string,
    expectedGeneration: number,
  ): Promise<void> {
    const targetId = destination.targetId;
    await this.store.update((draft) => {
      const chain = draft.antigravityContinuations[root]!;
      if ((draft.antigravityAccountGenerations[account.id] ?? 0) !== expectedGeneration ||
        !sameAccount(account, findAccount(draft, account.id))) {
        throw new Error("The Antigravity account was re-authenticated during the handoff. Try again from the current task tab.");
      }
      if (!destination.agent) {
        chain.members[targetId] = { ...memberFor(account, draft, source), generation: expectedGeneration, unstarted: true };
      }
      chain.pending = {
        agentId: targetId,
        sourceAgentId: source.id,
        accountId: account.id,
        messageId,
        prompt,
        seen: gathered.seen,
        observed: gathered.observed,
        stage: "creating",
      };
      if (!destination.agent) draft.bindings[targetId] = { accountId: account.id, source: "thread", at: new Date().toISOString() };
    });
  }

  private async deliver(
    paseo: PaseoApi,
    root: string,
    chain: AntigravityContinuation,
    beforeMembers: Map<string, Agent>,
    source: Agent,
    destination: Destination,
    account: StoredAccount,
    prompt: string,
    messageId: string,
    why: string,
    expectedGeneration: number,
  ): Promise<{ agentId: string; title: string }> {
    const targetId = destination.targetId;
    if (chain.pending?.agentId !== targetId || chain.pending.messageId !== messageId) {
      throw new Error("The Antigravity task reservation disappeared before delivery.");
    }
    let result: { agentId: string; title: string };
    let targetAgent = destination.agent;
    if (destination.agent) {
      result = { agentId: targetId, title: destination.agent.title ?? "Antigravity task" };
    } else {
      result = await continueInNewAgent({
        paseo,
        sourceAgentId: source.id,
        why,
        agentId: targetId,
        deferPrompt: true,
        bind: async () => {},
      });
      const created = await waitForCreated(paseo, targetId);
      targetAgent = created;
      const sourceNow = await snapshot(paseo, source.id);
      const state = await this.store.read();
      const entry = state.antigravityContinuations[root]?.members[targetId];
      const createdOk = created !== undefined && ready(created) && samePlace(source, created) &&
        !created.lastUserMessageAt && configKey(created) === configKey(source) && entry !== undefined &&
        memberMatchesAccount(entry, state, account) &&
        (boundTo(state, targetId, account.id) || (entry.unstarted && chain.pending?.agentId === targetId && reservedFor(state, targetId, account.id))) &&
        (state.antigravityAccountGenerations[account.id] ?? 0) === expectedGeneration;
      if (!unchanged(source, sourceNow) || !createdOk || !sameAccount(account, findAccount(state, account.id))) {
        throw new Error("The Antigravity task or account changed while its tab was being created. Check the active tab and try again.");
      }
    }
    const beforeSend = await this.store.read();
    const currentChain = beforeSend.antigravityContinuations[root];
    if (!currentChain) throw new Error("The Antigravity task reservation disappeared before delivery.");
    const expectedMembers = new Map(beforeMembers);
    if (targetAgent) expectedMembers.set(targetId, targetAgent);
    await this.confirmUnchanged(paseo, currentChain, expectedMembers, source, { ...destination, agent: targetAgent }, account, expectedGeneration);
    const state = await this.store.read();
    if (!sameAccount(account, findAccount(state, account.id)) ||
      (state.antigravityAccountGenerations[account.id] ?? 0) !== expectedGeneration ||
      (!boundTo(state, targetId, account.id) &&
        !(state.antigravityContinuations[root]?.members[targetId]?.unstarted &&
          state.antigravityContinuations[root]?.pending?.agentId === targetId && reservedFor(state, targetId, account.id)))) {
      throw new Error("The Antigravity account was re-authenticated before the handoff arrived. Check the target tab before retrying.");
    }
    await this.store.update((draft) => { draft.antigravityContinuations[root]!.pending!.stage = "sending"; });
    // A failed or disconnected send leaves the reservation in place; a retry first looks for its receipt.
    await paseo.agents.ref(targetId).send(prompt, { messageId });
    const receipt = await waitForReceipt(paseo, targetId, messageId);
    if (!receipt.delivered) {
      throw new Error(`The Antigravity handoff to ${targetId} was accepted without a verifiable timeline receipt. Check that tab before switching again.`);
    }
    const deliveredAgent = await snapshot(paseo, targetId);
    if (!deliveredAgent) throw new Error("The Antigravity destination disappeared after accepting its handoff.");
    await this.store.update((draft) => completeHandoff(draft.antigravityContinuations[root]!, receipt.mark, deliveredAgent));
    return result;
  }
}

function sameAccount(left: StoredAccount, right: StoredAccount | undefined): boolean {
  return right !== undefined && right.family === "antigravity" && right.id === left.id && right.home === left.home &&
    compatibleIdentity(right.identity, left.identity) && compatibleIdentity(right.email, left.email) && right.signedIn && !right.disabled;
}

function unchanged(before: Agent, now: Agent | undefined): boolean {
  return now !== undefined && ready(now) && samePlace(before, now) && configKey(before) === configKey(now) &&
    now.lastUserMessageAt === before.lastUserMessageAt;
}

async function findTask(paseo: PaseoApi, state: StoredState, original: Agent): Promise<{ root: string; related: Agent[] }> {
  let root = chainOf(state, original.id);
  const related: Agent[] = [original];
  if (!root) {
    let parent = original.labels?.[CONTINUED_FROM_LABEL];
    while (parent && !related.some((agent) => agent.id === parent)) {
      const agent = await snapshot(paseo, parent);
      if (!agent || !samePlace(original, agent)) break;
      related.push(agent);
      root = chainOf(state, agent.id);
      if (root) break;
      parent = agent.labels?.[CONTINUED_FROM_LABEL];
    }
  }
  root ??= related.at(-1)!.id;
  if (!state.antigravityContinuations[root]) await adoptDescendants(paseo, original, related);
  return { root, related };
}

/** A complete agent listing is required before adopting descendants; workspace peers stay separate. */
async function adoptDescendants(paseo: PaseoApi, original: Agent, related: Agent[]): Promise<void> {
  const all: Agent[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error("Couldn't identify every Antigravity task tab. Check its tabs before retrying.");
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    all.push(...result.entries.map(({ agent }) => agent).filter((agent) => samePlace(original, agent)));
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  for (let added = true; added;) {
    added = false;
    for (const agent of all) {
      const known = new Set(related.map((entry) => entry.id));
      const parent = agent.labels?.[CONTINUED_FROM_LABEL];
      if (!known.has(agent.id) && parent && known.has(parent)) {
        related.unshift(agent);
        added = true;
      }
    }
  }
}

async function waitForSource(paseo: PaseoApi, original: Agent): Promise<Agent> {
  const agent = await snapshot(paseo, original.id);
  if (!agent || !ready(agent)) throw new Error("Wait for this Antigravity agent to stop and resolve any permission request before switching.");
  if (agent.lastUserMessageAt !== original.lastUserMessageAt) {
    throw new Error("This Antigravity agent received another message while switching. Check its current turn before retrying.");
  }
  return agent;
}

async function waitForCreated(paseo: PaseoApi, agentId: string): Promise<Agent | undefined> {
  let agent = await snapshot(paseo, agentId);
  for (let attempt = 0; agent?.status === "initializing" && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent = await snapshot(paseo, agentId);
  }
  return agent;
}

async function memberSnapshots(paseo: PaseoApi, chain: AntigravityContinuation, source: Agent): Promise<Map<string, Agent>> {
  const snapshots = new Map<string, Agent>();
  for (const id of Object.keys(chain.members)) {
    const agent = await snapshot(paseo, id);
    if (!agent) continue;
    snapshots.set(id, agent);
    if (samePlace(source, agent) && !agent.archivedAt && busy(agent)) {
      throw new Error("Another Antigravity tab in this task is working or waiting for permission. Finish it before switching.");
    }
  }
  return snapshots;
}

function applyObserved(chain: AntigravityContinuation, observed: Pending["observed"]): void {
  for (const [id, observation] of Object.entries(observed)) {
    const member = chain.members[id];
    if (!member) continue;
    member.timelineMark = observation.mark;
    if (observation.updatedAt !== undefined) member.updatedAt = observation.updatedAt;
    if (observation.lastUserMessageAt !== undefined) member.lastUserMessageAt = observation.lastUserMessageAt;
    delete member.missing;
  }
}

function pickDestination(
  state: StoredState,
  chain: AntigravityContinuation,
  snapshots: Map<string, Agent>,
  source: Agent,
  account: StoredAccount,
  reserved?: Pending,
): Destination {
  const matches = Object.entries(chain.members).flatMap(([id, entry]) => {
    const agent = snapshots.get(id);
    return id !== source.id && !entry.missing && memberMatchesAccount(entry, state, account) && entry.configKey === configKey(source) &&
      boundTo(state, id, account.id) && agent !== undefined && samePlace(source, agent) &&
      !agent.archivedAt && !agent.providerUnavailable && configKey(agent) === configKey(source)
      ? [{ id, entry, agent }]
      : [];
  });
  if (reserved) {
    if (reserved.accountId !== account.id) throw new Error("A previous Antigravity handoff reserved a different account. Check that tab before retrying.");
    const existing = matches.find(({ id }) => id === reserved.agentId);
    if (existing) {
      if (!ready(existing.agent)) throw new Error(`The reserved Antigravity tab ${existing.id} isn't ready. Check it before retrying.`);
      return { targetId: existing.id, agent: existing.agent, entry: existing.entry };
    }
    const entry = chain.members[reserved.agentId];
    if (entry && !memberMatchesAccount(entry, state, account)) {
      throw new Error(`The reserved Antigravity tab ${reserved.agentId} changed account identity. Check it before retrying.`);
    }
    return { targetId: reserved.agentId };
  }
  if (matches.length > 1) {
    throw new Error("More than one compatible Antigravity tab belongs to this task and account. Check the task's tabs before switching.");
  }
  const candidate = matches[0];
  if (!candidate) return { targetId: randomUUID() };
  const { id: targetId, entry, agent } = candidate;
  if (entry.unstarted && agent.lastUserMessageAt) {
    throw new Error(`The unstarted Antigravity tab ${targetId} received another message. Check it and archive it before retrying.`);
  }
  if (!ready(agent)) throw new Error("The account's existing Antigravity tab isn't ready to continue. Check it before switching.");
  return { targetId, agent, entry };
}

async function gatherUpdates(
  paseo: PaseoApi,
  state: StoredState,
  chain: AntigravityContinuation,
  snapshots: Map<string, Agent>,
  source: Agent,
  destination: Destination,
  forceFallback = false,
): Promise<Gathered> {
  const known = destination.entry?.seen ?? {};
  const others = Object.keys(chain.members).filter((id) => id !== destination.targetId && !chain.members[id]!.unstarted);
  const seen = { ...known };
  const updates: Update[] = [];
  const observed: Pending["observed"] = {};
  const completeHistories = new Map<string, Awaited<ReturnType<typeof readUpdates>>>();
  for (const id of others) {
    const member = chain.members[id]!;
    const agent = snapshots.get(id);
    if (member.missing) {
      throw new Error(`Antigravity task tab ${id} was removed from this task's verified history. Start a new Antigravity agent and provide the full task context.`);
    }
    if (!agent) {
      throw new Error(`Antigravity task tab ${id} is missing. Check its timeline or start a new Antigravity agent with the full task context.`);
    }
    if (!samePlace(source, agent) || !boundTo(state, id, member.accountId)) {
      throw new Error(`Antigravity task tab ${id} changed workspace or account. Check the task before switching.`);
    }
    if (agent.archivedAt || agent.providerUnavailable) {
      const metadataUnchanged = member.updatedAt !== undefined && member.updatedAt === agent.updatedAt &&
        member.timelineMark !== undefined && (member.lastUserMessageAt ?? null) === agent.lastUserMessageAt;
      if (!metadataUnchanged) {
        throw new Error(`Antigravity task tab ${id} has unavailable history that may contain unshared updates. Restore it or start a new Antigravity agent with the full task context.`);
      }
      continue;
    }
    const priorMark = member.timelineMark ?? (chain.baselineSource?.agentId === id ? chain.baselineSource.mark : undefined);
    const deliveredMark = known[id];
    const unchangedAtCursor = !forceFallback && priorMark && deliveredMark &&
      priorMark.epoch === deliveredMark.epoch && priorMark.seq === deliveredMark.seq &&
      member.updatedAt !== undefined && member.updatedAt === agent.updatedAt &&
      (member.lastUserMessageAt ?? null) === agent.lastUserMessageAt;
    if (unchangedAtCursor) continue;
    const readFrom = forceFallback ? undefined : known[id];
    const delta = await readUpdates(paseo, id, readFrom);
    if (priorMark && (priorMark.epoch !== delta.mark.epoch || delta.mark.seq < priorMark.seq)) {
      throw new Error(`Antigravity task tab ${id} has a new or shortened timeline epoch. Start a new Antigravity agent and provide the full task context.`);
    }
    seen[id] = delta.mark;
    observed[id] = {
      mark: delta.mark,
      updatedAt: agent.updatedAt,
      lastUserMessageAt: agent.lastUserMessageAt,
    };
    if (!readFrom) completeHistories.set(id, delta);
    updates.push(...delta.entries);
  }

  const needsBaseline = forceFallback || !destination.agent || destination.entry?.unstarted === true;
  const contextVerified = !chain.baselineMessageId || [...completeHistories.entries()].some(([id, history]) =>
    hasTaskContext(chain, id, history),
  );
  if (needsBaseline && !contextVerified) {
    throw new Error("The original Antigravity task context is no longer verifiable. Start a new Antigravity agent and provide the full task context.");
  }
  return {
    updates: byTime(updates), seen, observed, fallback: forceFallback, contextVerified,
  };
}

function hasTaskContext(
  chain: AntigravityContinuation,
  agentId: string,
  history: Awaited<ReturnType<typeof readUpdates>>,
  requireComplete = false,
): boolean {
  if (requireComplete && !history.complete) return false;
  const member = chain.members[agentId];
  if (chain.baselineMessageId === undefined) {
    return history.entries.some((entry) => entry.item.type === "user_message" && entry.item.text.trim().length > 0);
  }
  if (history.entries.some((entry) => delivered(entry, chain.baselineMessageId!))) return true;
  if (member?.lastHandoffMessageId && member.timelineMark && member.timelineMark.epoch === history.mark.epoch &&
    history.mark.seq >= member.timelineMark.seq) return true;
  const baseline = chain.baselineSource;
  return baseline?.agentId === agentId && baseline.mark.epoch === history.mark.epoch && history.mark.seq >= baseline.mark.seq;
}

function byTime(updates: Update[]): Update[] {
  return updates.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function ownHandoff(item: Extract<AgentTimelineItem, { type: "user_message" }>, chain: AntigravityContinuation): boolean {
  if (chain.baselineMessageId !== undefined && item.clientMessageId === chain.baselineMessageId) return false;
  if (item.clientMessageId?.startsWith(MESSAGE_PREFIX)) return true;
  return Object.keys(chain.members).length > 1 && item.text.startsWith("This task is continuing from an earlier Antigravity session");
}

function composePrompt(chain: AntigravityContinuation, destination: Destination, gathered: Gathered, why: string): string {
  const fresh = !destination.agent || destination.entry?.unstarted;
  const origin = fresh ? gathered.updates.find(({ item }) => item.type === "user_message" && !ownHandoff(item, chain))?.item : undefined;
  const items = gathered.updates.map(({ item }) => item).filter((item) => {
    if (item.type !== "user_message") return true;
    if (item.clientMessageId === chain.baselineMessageId) return Boolean(fresh);
    return item === origin || !ownHandoff(item, chain);
  });
  const instructions = fitInstructions(items.filter((item) => item.type === "user_message").map((item) => item.text));
  const progress = buildTranscript(items.filter((item) => item.type !== "user_message"));
  if (fresh && !instructions.trim()) {
    throw new Error("This Antigravity conversation's history is unavailable. Start a new Antigravity agent and provide the full task context.");
  }
  if ((fresh || gathered.fallback) && chain.baselineMessageId && !gathered.contextVerified) {
    throw new Error("The original Antigravity task context is no longer verifiable. Start a new Antigravity agent and provide the full task context.");
  }
  if (gathered.fallback && !instructions.trim()) {
    throw new Error("The current Antigravity tab doesn't contain enough history to rebuild this task. Start a new Antigravity agent and provide the full task context.");
  }
  if (!fresh && !instructions.trim() && !progress.trim()) return "";
  return [
    `This task is continuing because ${why}.`,
    fresh ? "Continue in a new tab for this Antigravity account." : "You are returning to an existing tab for this Antigravity account.",
    ...(gathered.fallback ? ["The destination timeline no longer contains its previous task baseline. This handoff rebuilds the context from verified task history; check the files before proceeding."] : []),
    "These are only the task updates this tab has not received. Later user instructions take precedence over earlier plans.",
    "<user-updates>", instructions, "</user-updates>",
    "<progress-updates>", progress, "</progress-updates>",
    "Before acting, inspect the current files, git status and diff. Keep completed work, and respect any pause, stop or completion instruction in the updates.",
  ].join("\n");
}

async function readUpdates(
  paseo: PaseoApi,
  agentId: string,
  since?: Mark,
  receiptId?: string,
  allowTruncated = false,
  tailOnly = false,
): Promise<{
  mark: Mark;
  entries: Entry[];
  complete: boolean;
}> {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: 500, projection: "canonical" });
  if (page.gap || page.staleCursor) throw new Error("This Antigravity task's retained history has a gap. Check its timeline before switching.");
  const mark = { epoch: page.epoch, seq: page.window.maxSeq };
  if (since && since.epoch !== page.epoch) {
    throw new Error("This Antigravity task's timeline epoch changed. Start a new Antigravity agent and provide the full task context.");
  }
  const after = since?.seq ?? -1;
  const complete = page.window.minSeq <= 1 || Boolean(since && since.seq >= page.window.minSeq - 1);
  if (!complete && !receiptId && !allowTruncated) {
    throw new Error("This Antigravity task's retained timeline no longer contains its complete history. Check its timeline before switching.");
  }
  const pageFloor = complete ? after : Math.max(after, page.window.minSeq - 1);
  const entries = [...page.entries];
  const hasReceipt = () => receiptId !== undefined && entries.some((entry) => delivered(entry, receiptId));
  for (let pages = 1; !tailOnly && page.hasOlder && (page.startCursor?.seq ?? 0) > pageFloor && !hasReceipt(); pages += 1) {
    if (pages >= MAX_PAGES || !page.startCursor) throw new Error("Couldn't read the complete Antigravity task history. Check its timeline before switching.");
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 500, projection: "canonical" });
    if (page.epoch !== mark.epoch || page.staleCursor || page.gap) {
      throw new Error("This Antigravity task's history changed during the handoff. Check its timeline and retry.");
    }
    entries.unshift(...page.entries);
  }
  if (page.gap) throw new Error("This Antigravity task's retained history has a gap. Check its timeline before switching.");
  const overlapping = entries.some((entry) => entry.seqStart <= after && entry.seqEnd > after);
  if (overlapping) {
    throw new Error("Paseo returned a projected timeline entry across the saved cursor. Retry after the timeline changes.");
  }
  const covered = !page.hasOlder || (page.startCursor?.seq ?? 0) <= pageFloor;
  return { mark, entries: entries.filter((entry) => entry.seqStart > after), complete: complete && covered };
}

async function waitForReceipt(paseo: PaseoApi, agentId: string, messageId: string): Promise<{ delivered: boolean; mark: Mark }> {
  let mark: Mark = { epoch: "", seq: 0 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const history = await readUpdates(paseo, agentId, undefined, messageId);
    mark = history.mark;
    if (history.entries.some((entry) => delivered(entry, messageId))) return { delivered: true, mark };
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { delivered: false, mark };
}
