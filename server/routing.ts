import { peakUsage, usageWindowsForModel } from "../shared/format";
import type { Family, Usage } from "../shared/model";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type StoredAccount,
  type StoredState,
} from "./state";

/** The model an agent runs, plus the account usage needed to know which scopes cover it. */
export interface ScopeContext {
  model?: string | null;
  usage?: Usage | null;
}

/** Scope ids whose windows apply to `model`; empty when the model (or the scope's models) is unknown. */
function scopedIdsForModel(usage: Usage | null | undefined, model: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!usage) return ids;
  for (const window of usageWindowsForModel(usage.windows, model)) {
    if (window.scope) ids.add(window.scope.id);
  }
  return ids;
}

/**
 * A per-scope limit only blocks the account when the model's own usage windows prove that scope
 * covers it. Unknown models and scopes with no model list are left alone rather than guessed.
 */
function hasActiveScopedLimit(account: StoredAccount, now: number, context: ScopeContext): boolean {
  if (account.scopedLimits.length === 0) return false;
  const scopes = scopedIdsForModel(context.usage, context.model);
  if (scopes.size === 0) return false;
  return account.scopedLimits.some((limit) => {
    if (!scopes.has(limit.scopeId)) return false;
    const until = Date.parse(limit.limitedUntil);
    return Number.isFinite(until) && until > now;
  });
}

export function isLimited(account: StoredAccount, now: number, context: ScopeContext = {}): boolean {
  if (account.limitedUntil) {
    const until = Date.parse(account.limitedUntil);
    if (Number.isFinite(until) && until > now) return true;
  }
  return hasActiveScopedLimit(account, now, context);
}

export function isUsable(account: StoredAccount, now: number, context: ScopeContext = {}): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now, context);
}

/**
 * Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery.
 * Only windows that apply to `model` count: an unknown model gets the account-wide windows alone,
 * never another model group's headroom.
 */
export function headroomScore(usage: Usage | null | undefined, model?: string | null): number {
  const peak = usage ? peakUsage(usageWindowsForModel(usage.windows, model)) : null;
  return peak ? peak.usedPercent : 50;
}

/** The usable account with the most room, preferring the default, then the CLI login, on ties. */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  model?: string | null,
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const candidates = accountsOf(state, family).filter(
    (account) => !exclude.has(account.id) && isUsable(account, now, { model, usage: usageOf(account.id) }),
  );
  const rank = (account: StoredAccount) => [
    headroomScore(usageOf(account.id), model),
    account.id === preferred ? 0 : 1,
    account.kind === "main" ? 0 : 1,
    Date.parse(account.createdAt) || 0,
  ];
  candidates.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return candidates[0];
}

export interface RouteInput {
  agentId: string;
  family: Family;
  reason: "create" | "resume" | "refresh" | "import";
  now: number;
  autoSwitch: boolean;
  balanceNewAgents: boolean;
  /** The model this agent runs, when Paseo reports it; scopes usage and limits to that model. */
  model?: string | null;
  /**
   * Whether an existing conversation can open on a different account. When it can't (Codex), a
   * thread stays on the account it started on, and only brand-new agents are balanced or rerouted.
   */
  portable: boolean;
  usageOf(accountId: string): Usage | null | undefined;
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" } | null;
}

/**
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
 * roomiest account, else the default. An exhausted or signed-out choice is swapped for the roomiest
 * usable account when automatic switching is on — for new agents always, and for existing ones
 * only when their conversation can move between accounts. A disabled choice is always swapped,
 * and the agent keeps its own binding so it returns once the account is enabled again.
 */
export function chooseAccount(state: StoredState, input: RouteInput): RouteDecision | null {
  const accounts = accountsOf(state, input.family);
  if (accounts.length === 0) return null;
  const at = new Date(input.now).toISOString();
  const fresh = input.reason === "create";
  const contextFor = (account: StoredAccount): ScopeContext => ({ model: input.model, usage: input.usageOf(account.id) });

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;

  // Without a model we can't tell which Antigravity quota group a new agent will use, so spreading
  // it by headroom would be a guess. Other families, and Antigravity with a known model, still balance.
  const knownModel = typeof input.model === "string" && input.model.trim() !== "";
  const canBalance = input.balanceNewAgents && !(input.family === "antigravity" && !knownModel);
  if (!account && fresh && canBalance && accounts.length > 1) {
    account = mostAvailable(state, input.family, input.usageOf, input.now, new Set(), input.model);
    if (account) bind = { accountId: account.id, source: "balance", at };
  }
  if (!account) {
    // An imported Codex thread most likely came from the user's own CLI, so it belongs to that login.
    const imported = !input.portable && input.reason === "import" ? mainAccount(state, input.family) : undefined;
    account = imported ?? defaultAccount(state, input.family);
    // A thread that can't move is pinned to the account it first opened on.
    if (account && !input.portable) bind = { accountId: account.id, source: "thread", at };
  }
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn
    ? "signed_out"
    : account.disabled
      ? "disabled"
      : isLimited(account, input.now, contextFor(account))
        ? "limited"
        : null;
  const mayMove = fresh || input.portable;
  if (why && mayMove && (input.autoSwitch || why !== "limited")) {
    const alternative = mostAvailable(
      state,
      input.family,
      input.usageOf,
      input.now,
      new Set([account.id]),
      input.model,
    );
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A thread that can't move lives where it starts. Otherwise a disabled account keeps its
      // agents' bindings, so they return when it's enabled again; a limit re-pins them.
      bind =
        !input.portable
          ? { accountId: alternative.id, source: "thread", at }
          : why === "disabled"
            ? null
            : { accountId: alternative.id, source: "auto", at };
    }
  }
  return { account, bind, skipped };
}

/** The account an agent is routed to right now, without side effects (for display). */
export function effectiveAccountId(state: StoredState, agentId: string, family: Family): string | undefined {
  const bound = findAccount(state, state.bindings[agentId]?.accountId);
  if (bound && bound.family === family) return bound.id;
  return defaultAccount(state, family)?.id;
}
