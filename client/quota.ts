import { formatPercent, formatResetIn, modelUsageSummary, peakUsage } from "../shared/format";
import type { AccountView, Usage, UsageWindow } from "../shared/model";

/**
 * The provider's model groups, as reported. Windows with the same `scope.id` are one group and are
 * shown once; windows without a scope stay separate because they are account-wide.
 */
export interface UsageGroup {
  id: string;
  label: string;
  /** Known model IDs sharing this group's quota. Empty when membership hasn't been verified. */
  models: string[];
  accountWide: boolean;
  windows: UsageWindow[];
}

export function hasScopedWindows(windows: readonly UsageWindow[]): boolean {
  return windows.some((limit) => Boolean(limit.scope));
}

export function usageGroups(windows: readonly UsageWindow[]): UsageGroup[] {
  const groups: UsageGroup[] = [];
  const byId = new Map<string, UsageGroup>();
  for (const limit of windows) {
    const scope = limit.scope;
    const id = scope ? `scope:${scope.id}` : `window:${limit.id}`;
    let group = byId.get(id);
    if (!group) {
      group = {
        id,
        label: scope?.label || limit.label,
        models: scope ? [...scope.models] : [],
        accountWide: !scope,
        windows: [],
      };
      byId.set(id, group);
      groups.push(group);
    } else if (scope) {
      for (const model of scope.models) {
        if (!group.models.includes(model)) group.models.push(model);
      }
    }
    group.windows.push(limit);
  }
  return groups;
}

/** Keep the selected group when possible; fall back to the first reported group. */
export function focusedUsageGroup(groups: readonly UsageGroup[], id: string | null): UsageGroup | null {
  return groups.find((group) => group.id === id) ?? groups[0] ?? null;
}

/** The busiest window in this group only. Another group's limit never makes this one look spent. */
export function groupPeak(group: UsageGroup): UsageWindow | null {
  return peakUsage(group.windows);
}

/** "51% of weekly used · resets in 9h". Null means no number is known, not 0%. */
export function groupUsageNote(group: UsageGroup, now: number = Date.now()): string | null {
  const peak = groupPeak(group);
  if (!peak) return null;
  const reset = formatResetIn(peak.resetsAt, now);
  return `${formatPercent(peak.usedPercent)} of ${peak.label.toLowerCase()} used${reset ? ` · resets ${reset}` : ""}`;
}

/**
 * Whether the group's own windows make it available. A cached reading never claims current
 * availability, and an unused group doesn't inherit another group's exhaustion.
 */
export function groupStatus(group: UsageGroup, usage: Usage | null | undefined): string {
  if (usage?.cached) return usage.error ? "Cached reading · last refresh failed" : "Cached · availability unverified";
  if (usage?.error) return "Usage couldn't be read";
  const peak = groupPeak(group);
  if (!peak) return "No usage reported for this group";
  if (peak.usedPercent >= 100) return "Limit reached for this group";
  return "Available for this group";
}

/** True only when a window that governs this exact model reports a reached limit. */
export function modelLimitReached(account: AccountView, model: string | null | undefined): boolean {
  if (account.status === "signed_out" || account.status === "disabled") return false;
  if (account.usage?.cached || account.usage?.error) return false;
  const peak = modelUsageSummary(account.usage, model)?.peak ?? null;
  return peak ? peak.usedPercent >= 100 : false;
}

/**
 * Whether the account as a whole is out, only some reported groups are out, or none are. A single
 * exhausted group never makes the account look exhausted; an account-wide limit still does.
 *
 * `unknown` covers cached/failed readings and signed-out/disabled accounts: a stale 100% must not
 * be presented as current exhaustion.
 */
export type ScopedLimitState = "none" | "some" | "all" | "unknown";

export function scopedLimitState(account: AccountView): ScopedLimitState {
  if (account.status === "signed_out" || account.status === "disabled") return "unknown";
  if (account.usage?.cached || account.usage?.error) return "unknown";
  const windows = account.usage?.windows ?? [];
  if (!hasScopedWindows(windows)) return account.status === "limited" ? "all" : "none";
  const groups = usageGroups(windows);
  if (groups.length === 0) return account.status === "limited" ? "all" : "none";
  const exhausted = groups.filter((group) => {
    const peak = groupPeak(group);
    return peak ? peak.usedPercent >= 100 : false;
  }).length;
  if (exhausted === groups.length) return "all";
  if (exhausted > 0) return "some";
  // No reported group is out, but the daemon says the account is limited: keep its verdict.
  return account.status === "limited" ? "all" : "none";
}

/** Says which expected period the provider didn't report, without inventing a reading for it. */
export function groupMissingNote(group: UsageGroup): string | null {
  if (group.accountWide || group.windows.length === 0) return null;
  if (group.windows.length > 1) return null;
  const only = group.windows[0]?.label.toLowerCase() ?? "one";
  return `Only the ${only} limit was reported for this group.`;
}

/** "resets in 2h", or an explicit call to re-check once the stated reset time has passed. */
export function resetNote(resetsAt: string | null, now: number = Date.now()): string {
  const reset = formatResetIn(resetsAt, now);
  if (reset === "now") return "reset time passed · refresh to verify";
  return reset ? `resets ${reset}` : "";
}

/** One line about the busiest window that governs `model`; null when no figure applies. */
export function usageNoteForModel(
  usage: Usage | null | undefined,
  model: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const summary = modelUsageSummary(usage, model);
  const peak = summary?.peak ?? null;
  if (!peak) return null;
  const reset = formatResetIn(peak.resetsAt, now);
  return `${formatPercent(peak.usedPercent)} of ${peak.label.toLowerCase()} used${reset ? ` · resets ${reset}` : ""}`;
}

/**
 * A menu/pill line for an account. Model-scoped providers only show windows matching the agent's
 * model; an unknown model gets no percentage rather than the busiest number from another group.
 */
export function accountUsageNote(
  account: AccountView,
  model: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const windows = account.usage?.windows ?? [];
  if (!hasScopedWindows(windows)) return usageNoteForModel(account.usage, undefined, now);
  return usageNoteForModel(account.usage, model, now);
}
