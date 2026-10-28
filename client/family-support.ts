import type { Family, FamilyCapabilities, LoginMethod, StateView } from "../shared/model";

/** Feature flags the UI must consult before offering an action. */
export type FamilyFeature = "managedAccounts" | "autoSwitch" | "resets" | "fork";

export function familyTitle(family: Family): string {
  if (family === "claude") return "Claude";
  if (family === "codex") return "ChatGPT (Codex)";
  return "Antigravity";
}

/**
 * What the daemon says this family can do here. A server from before capabilities existed reports
 * none at all, which is different from reporting `false`.
 */
export function capabilityFor(state: StateView | null, family: Family): FamilyCapabilities | null {
  return state?.capabilities?.[family] ?? null;
}

/**
 * Claude and Codex keep their pre-capability behaviour when an older server sends no flags, while
 * Antigravity stays off: a third provider must not appear supported just because it is in the enum.
 */
export function supportsFamily(state: StateView | null, family: Family, feature: FamilyFeature): boolean {
  const capabilities = capabilityFor(state, family);
  if (!capabilities) return family !== "antigravity";
  return capabilities[feature];
}

/**
 * Sign-in routes this host can actually finish. Claude and Codex fall back to their previous
 * browser/code pair on an older server; Antigravity requires an explicit capability.
 */
export function loginMethodsFor(state: StateView | null, family: Family): LoginMethod[] {
  const browserUsable = state?.browserSignIn !== false;
  const capabilities = capabilityFor(state, family);
  if (!capabilities) {
    if (family === "antigravity") return [];
    return browserUsable ? ["browser", "code"] : ["code"];
  }
  return capabilities.loginMethods.filter((method) => method === "code" || browserUsable);
}

/**
 * Adding or signing an account back in needs an isolated credential home, not just quota display.
 */
export function canAddAccount(state: StateView | null, family: Family): boolean {
  const capabilities = capabilityFor(state, family);
  if (!capabilities) return family !== "antigravity";
  return capabilities.managedAccounts && loginMethodsFor(state, family).length > 0;
}

/**
 * Keep the stored Antigravity switch off while the host can't do it. Showing it as off while
 * persisting `true` would silently enable switching when the capability comes back.
 */
export function normalizeAntigravityAutoSwitch<T extends { antigravityAutoSwitch: boolean }>(
  values: T,
  capability: boolean,
): T {
  if (capability || !values.antigravityAutoSwitch) return values;
  return { ...values, antigravityAutoSwitch: false };
}

/**
 * Whether a family is configured on this host at all. Claude and Codex keep their existing always-on
 * sections; Antigravity only shows up when Paseo maps a provider to it or an account already exists.
 */
export function familyAvailable(state: StateView | null, family: Family): boolean {
  if (family !== "antigravity") return true;
  if (!state) return false;
  if (state.accounts.some((account) => account.family === family)) return true;
  return Object.values(state.providers ?? {}).includes(family);
}

/**
 * The other provider a stopped agent may continue on. Only Claude and ChatGPT keep this path; an
 * Antigravity account has no equivalent target yet.
 */
export function forkTarget(state: StateView | null, family: Family): Family | null {
  const other: Family | null = family === "claude" ? "codex" : family === "codex" ? "claude" : null;
  if (!other) return null;
  if (!supportsFamily(state, family, "fork") || !supportsFamily(state, other, "fork")) return null;
  return other;
}
