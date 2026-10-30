import { describe, expect, it } from "vitest";
import type { AccountView, FamilyCapabilities, StateView, Usage, UsageWindow } from "../shared/model";
import {
  canAddAccount,
  familyAvailable,
  familyTitle,
  forkTarget,
  loginMethodsFor,
  normalizeAntigravityAutoSwitch,
  supportsFamily,
} from "./family-support";
import {
  accountUsageNote,
  focusedUsageGroup,
  groupMissingNote,
  groupStatus,
  groupUsageNote,
  hasScopedWindows,
  modelLimitReached,
  resetNote,
  scopedLimitState,
  usageGroups,
  usageNoteForModel,
} from "./quota";

const NOW = Date.parse("2026-10-24T12:00:00Z");

function view(overrides: Partial<StateView> = {}): StateView {
  return {
    accounts: [],
    agents: [],
    logins: [],
    providers: {},
    capabilities: {},
    canReopen: false,
    browserSignIn: true,
    showComposerPill: true,
    warnings: [],
    ...overrides,
  };
}

function capabilities(overrides: Partial<FamilyCapabilities> = {}): FamilyCapabilities {
  return {
    managedAccounts: true,
    loginMethods: ["code"],
    autoSwitch: false,
    resets: false,
    fork: false,
    ...overrides,
  };
}

function window(overrides: Partial<UsageWindow> & Pick<UsageWindow, "id" | "label">): UsageWindow {
  return {
    usedPercent: 0,
    resetsAt: null,
    ...overrides,
  };
}

function usage(windows: UsageWindow[], overrides: Partial<Usage> = {}): Usage {
  return {
    fetchedAt: "2026-10-24T11:59:00Z",
    windows,
    error: null,
    cached: false,
    resets: null,
    ...overrides,
  };
}

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "account-1",
    family: "antigravity",
    label: "Work",
    kind: "main",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault: true,
    limitedUntil: null,
    usage: null,
    agentCount: 0,
    home: null,
    ...overrides,
  };
}

describe("family support", () => {
  it("keeps Claude and ChatGPT behaviour when an older server sends no capabilities", () => {
    const state = view();
    expect(supportsFamily(state, "claude", "managedAccounts")).toBe(true);
    expect(supportsFamily(state, "codex", "resets")).toBe(true);
    expect(forkTarget(state, "claude")).toBe("codex");
    expect(forkTarget(state, "codex")).toBe("claude");
    expect(loginMethodsFor(state, "claude")).toEqual(["browser", "code"]);
    expect(canAddAccount(state, "claude")).toBe(true);
  });

  it("never assumes Antigravity is supported from its enum membership alone", () => {
    const state = view();
    expect(supportsFamily(state, "antigravity", "managedAccounts")).toBe(false);
    expect(supportsFamily(state, "antigravity", "resets")).toBe(false);
    expect(forkTarget(state, "antigravity")).toBeNull();
    expect(loginMethodsFor(state, "antigravity")).toEqual([]);
    expect(canAddAccount(state, "antigravity")).toBe(false);
    expect(familyAvailable(state, "antigravity")).toBe(false);
    expect(familyAvailable(state, "claude")).toBe(true);
    expect(familyAvailable(state, "codex")).toBe(true);
  });

  it("reads explicit capabilities, including code-only sign-in", () => {
    const state = view({
      providers: { antigravity: "antigravity" },
      capabilities: { antigravity: capabilities({ loginMethods: ["code"] }) },
    });
    expect(supportsFamily(state, "antigravity", "managedAccounts")).toBe(true);
    expect(loginMethodsFor(state, "antigravity")).toEqual(["code"]);
    expect(canAddAccount(state, "antigravity")).toBe(true);
    expect(familyAvailable(state, "antigravity")).toBe(true);
  });

  it("does not offer adding or signing in when accounts are not managed", () => {
    const state = view({
      providers: { antigravity: "antigravity" },
      capabilities: { antigravity: capabilities({ managedAccounts: false }) },
    });
    expect(canAddAccount(state, "antigravity")).toBe(false);
    expect(familyAvailable(state, "antigravity")).toBe(true);
  });

  it("also honours an explicit managed-account flag for Claude or ChatGPT", () => {
    const state = view({ capabilities: { claude: capabilities({ managedAccounts: false }) } });
    expect(canAddAccount(state, "claude")).toBe(false);
    expect(canAddAccount(state, "codex")).toBe(true);
  });

  it("drops a browser-only sign-in on a host without a browser", () => {
    const state = view({
      browserSignIn: false,
      capabilities: { antigravity: capabilities({ loginMethods: ["browser"] }) },
    });
    expect(loginMethodsFor(state, "antigravity")).toEqual([]);
    expect(canAddAccount(state, "antigravity")).toBe(false);
    expect(loginMethodsFor(view({ browserSignIn: false }), "codex")).toEqual(["code"]);
  });

  it("honours a family that says it cannot fork", () => {
    const state = view({
      capabilities: {
        claude: capabilities({ fork: true }),
        codex: capabilities({ fork: false }),
      },
    });
    expect(forkTarget(state, "claude")).toBeNull();
    expect(forkTarget(state, "codex")).toBeNull();
  });

  it("only shows Antigravity once a provider or account exists", () => {
    expect(familyAvailable(view(), "antigravity")).toBe(false);
    expect(
      familyAvailable(view({ providers: { antigravity: "antigravity" } }), "antigravity"),
    ).toBe(true);
    expect(
      familyAvailable(view({ accounts: [account()] }), "antigravity"),
    ).toBe(true);
    expect(familyTitle("antigravity")).toBe("Antigravity");
  });

  it("turns the stored Antigravity switch off while the capability is missing", () => {
    const on = { antigravityAutoSwitch: true, autoSwitch: true };
    expect(normalizeAntigravityAutoSwitch(on, false)).toEqual({ antigravityAutoSwitch: false, autoSwitch: true });
    expect(normalizeAntigravityAutoSwitch(on, true)).toBe(on);
    const off = { antigravityAutoSwitch: false };
    expect(normalizeAntigravityAutoSwitch(off, false)).toBe(off);
  });
});

describe("usage groups", () => {
  const scoped = [
    window({
      id: "gemini-5h",
      label: "5-hour",
      usedPercent: 10,
      period: "5h",
      scope: { id: "gemini", label: "Gemini Models", models: ["gemini-flash", "gemini-pro"] },
    }),
    window({
      id: "gemini-weekly",
      label: "Weekly",
      usedPercent: 40,
      period: "weekly",
      scope: { id: "gemini", label: "Gemini Models", models: ["gemini-flash", "gemini-pro"] },
    }),
    window({
      id: "3p-5h",
      label: "5-hour",
      usedPercent: 100,
      period: "5h",
      scope: { id: "partner", label: "Claude and GPT", models: ["claude-sonnet", "gpt-oss"] },
    }),
    window({
      id: "argon-weekly",
      label: "Weekly",
      usedPercent: 51.32,
      period: "weekly",
      scope: { id: "argon", label: "Gemini 4 Argon", models: ["gemini-4-argon"] },
    }),
  ];

  it("shows every group once with its own windows", () => {
    const groups = usageGroups(scoped);
    expect(groups.map((group) => group.id)).toEqual(["scope:gemini", "scope:partner", "scope:argon"]);
    expect(groups.map((group) => group.windows.length)).toEqual([2, 1, 1]);
    expect(groups[0]?.models).toEqual(["gemini-flash", "gemini-pro"]);
    expect(hasScopedWindows(scoped)).toBe(true);
    expect(groups[0]?.windows).toEqual(scoped.slice(0, 2));
  });

  it("selects only the chosen group's windows and falls back when it disappears", () => {
    const groups = usageGroups(scoped);
    expect(focusedUsageGroup(groups, null)?.windows).toEqual(scoped.slice(0, 2));
    expect(focusedUsageGroup(groups, "scope:partner")?.windows).toEqual([scoped[2]]);
    expect(focusedUsageGroup(groups, "scope:argon")?.windows).toEqual([scoped[3]]);
    expect(focusedUsageGroup(groups.slice(0, 2), "scope:argon")?.id).toBe("scope:gemini");
    expect(focusedUsageGroup([], "scope:argon")).toBeNull();
  });

  it("never treats equal readings as one shared group", () => {
    const groups = usageGroups([
      window({ id: "a-5h", label: "5-hour", usedPercent: 100, scope: { id: "a", label: "A", models: [] } }),
      window({ id: "b-5h", label: "5-hour", usedPercent: 100, scope: { id: "b", label: "B", models: [] } }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => groupStatus(group, usage([])))).toEqual([
      "Limit reached for this group",
      "Limit reached for this group",
    ]);
  });

  it("does not turn one exhausted group into an exhausted account", () => {
    const oneOut = account({ usage: usage(scoped) });
    expect(scopedLimitState(oneOut)).toBe("some");
    const allOut = account({
      usage: usage([
        window({ id: "a", label: "Weekly", usedPercent: 100, scope: { id: "a", label: "A", models: [] } }),
        window({ id: "b", label: "Weekly", usedPercent: 100, scope: { id: "b", label: "B", models: [] } }),
      ]),
    });
    expect(scopedLimitState(allOut)).toBe("all");
    expect(scopedLimitState(account({ usage: usage(scoped), status: "ready" }))).toBe("some");
    expect(scopedLimitState(account({ usage: usage([window({ id: "w", label: "Weekly", usedPercent: 40 })]) }))).toBe("none");
    expect(scopedLimitState(account({ status: "limited" }))).toBe("all");
  });

  it("treats cached, failed and blocked accounts as unknown, not exhausted", () => {
    expect(scopedLimitState(account({ usage: usage(scoped, { cached: true }) }))).toBe("unknown");
    expect(scopedLimitState(account({ usage: usage(scoped, { error: "timeout" }) }))).toBe("unknown");
    expect(scopedLimitState(account({ usage: usage(scoped), status: "signed_out" }))).toBe("unknown");
    expect(scopedLimitState(account({ usage: usage(scoped), status: "disabled" }))).toBe("unknown");
  });

  it("only treats a raw 100% as a reached group limit", () => {
    const almost = usageGroups([
      window({ id: "almost", label: "Weekly", usedPercent: 99.9, scope: { id: "a", label: "A", models: [] } }),
    ]);
    expect(groupStatus(almost[0]!, usage([]))).toBe("Available for this group");
    expect(scopedLimitState(account({ usage: usage([
      window({ id: "almost", label: "Weekly", usedPercent: 99.9, scope: { id: "a", label: "A", models: [] } }),
    ]) }))).toBe("none");
    const exact = usageGroups([
      window({ id: "full", label: "Weekly", usedPercent: 100, scope: { id: "a", label: "A", models: [] } }),
    ]);
    expect(groupStatus(exact[0]!, usage([]))).toBe("Limit reached for this group");
  });

  it("keeps cached, failed and unknown readings apart", () => {
    const groups = usageGroups(scoped);
    const argon = groups[2]!;
    expect(groupStatus(argon, usage(scoped, { cached: true }))).toBe("Cached · availability unverified");
    expect(groupStatus(argon, usage(scoped, { cached: true, error: "timeout" }))).toBe(
      "Cached reading · last refresh failed",
    );
    expect(groupStatus(argon, usage(scoped, { error: "timeout" }))).toBe("Usage couldn't be read");
    expect(groupStatus(argon, usage(scoped))).toBe("Available for this group");
    expect(
      groupStatus({ id: "empty", label: "Empty", models: [], accountWide: false, windows: [] }, null),
    ).toBe("No usage reported for this group");
  });

  it("names a period the provider did not report without inventing a value", () => {
    const groups = usageGroups(scoped);
    expect(groupMissingNote(groups[0]!)).toBeNull();
    expect(groupMissingNote(groups[2]!)).toBe("Only the weekly limit was reported for this group.");
    expect(groupUsageNote(groups[2]!, NOW)).toBe("51% of weekly used");
    expect(groupMissingNote({ id: "x", label: "X", models: [], accountWide: true, windows: [] })).toBeNull();
  });

  it("groups unscoped windows separately and never as a model scope", () => {
    const groups = usageGroups([
      window({ id: "five_hour", label: "5-hour", usedPercent: 30 }),
      window({ id: "seven_day", label: "Weekly", usedPercent: 70 }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["window:five_hour", "window:seven_day"]);
    expect(groups.every((group) => group.accountWide)).toBe(true);
  });
});

describe("reset wording", () => {
  it("asks for a re-check instead of implying a passed reset restored headroom", () => {
    expect(resetNote("2026-10-24T13:00:00Z", NOW)).toBe("resets in 1h");
    expect(resetNote("2026-10-24T11:00:00Z", NOW)).toBe("reset time passed · refresh to verify");
    expect(resetNote(null, NOW)).toBe("");
  });
});

describe("model context", () => {
  const usageWithScopes = usage([
    window({
      id: "gemini-weekly",
      label: "Weekly",
      usedPercent: 30,
      scope: { id: "gemini", label: "Gemini Models", models: ["gemini-pro"] },
    }),
    window({
      id: "argon-weekly",
      label: "Weekly",
      usedPercent: 90,
      scope: { id: "argon", label: "Gemini 4 Argon", models: ["gemini-4-argon"] },
    }),
  ]);

  it("uses only windows that name the exact model", () => {
    expect(usageNoteForModel(usageWithScopes, "gemini-pro", NOW)).toBe("30% of weekly used");
    expect(usageNoteForModel(usageWithScopes, "gemini-4-argon", NOW)).toBe("90% of weekly used");
  });

  it("does not estimate a number for an unknown or missing model", () => {
    expect(usageNoteForModel(usageWithScopes, "some-new-model", NOW)).toBeNull();
    expect(usageNoteForModel(usageWithScopes, null, NOW)).toBeNull();
    expect(accountUsageNote(account({ usage: usageWithScopes }), null, NOW)).toBeNull();
    expect(accountUsageNote(account({ usage: usageWithScopes }), "some-new-model", NOW)).toBeNull();
  });

  it("keeps account-wide windows for Claude and ChatGPT", () => {
    const claudeUsage = usage([window({ id: "seven_day", label: "Weekly", usedPercent: 72 })]);
    expect(accountUsageNote(account({ family: "claude", usage: claudeUsage }), null, NOW)).toBe("72% of weekly used");
  });

  it("marks only the model context that is actually out", () => {
    const out = usage([
      window({ id: "m-weekly", label: "Weekly", usedPercent: 100, scope: { id: "m", label: "M", models: ["m"] } }),
      window({ id: "n-weekly", label: "Weekly", usedPercent: 10, scope: { id: "n", label: "N", models: ["n"] } }),
    ]);
    const work = account({ usage: out });
    expect(modelLimitReached(work, "m")).toBe(true);
    expect(modelLimitReached(work, "n")).toBe(false);
    expect(modelLimitReached(work, null)).toBe(false);

    const almost = usage([
      window({ id: "m-weekly", label: "Weekly", usedPercent: 99.9, scope: { id: "m", label: "M", models: ["m"] } }),
    ]);
    expect(modelLimitReached(account({ usage: almost }), "m")).toBe(false);
    expect(modelLimitReached(account({ usage: out, status: "signed_out" }), "m")).toBe(false);
    expect(modelLimitReached(account({ usage: usage([...out.windows], { cached: true }) }), "m")).toBe(false);
  });
});
