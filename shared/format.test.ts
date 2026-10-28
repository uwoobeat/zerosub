import { describe, expect, it } from "vitest";
import {
  accountSubtitle,
  formatAge,
  formatPlan,
  formatResetIn,
  modelUsageSummary,
  peakUsage,
  peakUsageForModel,
  shortLabel,
  usageSummary,
  usageSummaryForModel,
  usageWindowAppliesToModel,
  usageWindowsForModel,
} from "./format";
import type { AccountView, Usage } from "./model";

const NOW = Date.parse("2026-09-23T12:00:00Z");

describe("formatResetIn", () => {
  it("renders compact relative times", () => {
    expect(formatResetIn("2026-09-23T12:45:00Z", NOW)).toBe("in 45m");
    expect(formatResetIn("2026-09-23T14:00:00Z", NOW)).toBe("in 2h");
    expect(formatResetIn("2026-09-23T14:10:00Z", NOW)).toBe("in 2h 10m");
    expect(formatResetIn("2026-09-26T15:00:00Z", NOW)).toBe("in 3d 3h");
    expect(formatResetIn("2026-09-23T11:00:00Z", NOW)).toBe("now");
    expect(formatResetIn(null, NOW)).toBeNull();
    expect(formatResetIn("not a date", NOW)).toBeNull();
  });
});

describe("accountSubtitle", () => {
  it("drops an organization that only repeats the owner", () => {
    const email = "ada@example.com";
    expect(accountSubtitle({ email, organization: "ada@example.com's Organization" })).toBe(email);
    expect(accountSubtitle({ email, organization: "Ada's Organization" })).toBe(email);
    expect(accountSubtitle({ email, organization: email })).toBe(email);
    expect(accountSubtitle({ email, organization: null })).toBe(email);
  });

  it("keeps a real organization", () => {
    expect(accountSubtitle({ email: "a@acme.dev", organization: "Acme Engineering" })).toBe("a@acme.dev · Acme Engineering");
    expect(accountSubtitle({ email: null, organization: null })).toBeNull();
  });
});

describe("formatAge", () => {
  it("reads naturally", () => {
    expect(formatAge("2026-09-23T11:59:30Z", NOW)).toBe("just now");
    expect(formatAge("2026-09-23T11:54:00Z", NOW)).toBe("6m ago");
    expect(formatAge("2026-09-23T09:00:00Z", NOW)).toBe("3h ago");
    expect(formatAge("2026-09-21T12:00:00Z", NOW)).toBe("2d ago");
    expect(formatAge("garbage", NOW)).toBe("just now");
  });
});

describe("account presentation", () => {
  const account: AccountView = {
    id: "claude-a",
    family: "claude",
    label: "work",
    kind: "managed",
    email: "work@example.com",
    plan: "max",
    organization: null,
    status: "ready",
    isDefault: false,
    limitedUntil: null,
    usage: {
      fetchedAt: "2026-09-23T11:59:00Z",
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 30, resetsAt: "2026-09-23T14:00:00Z" },
        { id: "seven_day", label: "Weekly", usedPercent: 71.6, resetsAt: "2026-09-25T12:00:00Z" },
      ],
      error: null,
      cached: false,
      resets: null,
    },
    agentCount: 2,
    home: "/homes/claude-a",
  };

  it("summarises the busiest window", () => {
    expect(peakUsage(account.usage?.windows ?? [])?.id).toBe("seven_day");
    expect(usageSummary(account, NOW)).toBe("72% of weekly used · resets in 2d");
  });

  it("puts a reached limit first", () => {
    expect(usageSummary({ ...account, status: "limited", limitedUntil: "2026-09-23T13:30:00Z" }, NOW)).toBe(
      "Limit reached · resets in 1h 30m",
    );
  });

  it("names plans and trims long labels", () => {
    expect(formatPlan("prolite")).toBe("Pro Lite");
    expect(formatPlan("max")).toBe("Max");
    expect(formatPlan("something_new")).toBe("Something_new");
    expect(shortLabel({ label: "lovelace@analytical.example" })).toBe("lovelace@analytic…");
  });
});

describe("model-scoped usage", () => {
  const windows: Usage["windows"] = [
    { id: "account", label: "Monthly", usedPercent: 10, resetsAt: "2026-09-25T12:00:00Z" },
    {
      id: "gemini-5h",
      label: "Gemini 5h",
      usedPercent: 80,
      resetsAt: "2026-09-23T14:00:00Z",
      period: "5h",
      scope: { id: "gemini", label: "Gemini Models", models: ["gemini-3-pro"] },
    },
    {
      id: "3p-weekly",
      label: "Claude/GPT weekly",
      usedPercent: 40,
      resetsAt: "2026-09-25T12:00:00Z",
      period: "weekly",
      scope: { id: "3p", label: "Claude and GPT", models: ["claude-4", "gpt-5"] },
    },
    {
      id: "argon",
      label: "Argon weekly",
      usedPercent: 99,
      resetsAt: null,
      scope: { id: "argon", label: "Gemini 4 Argon", models: [] },
    },
  ];
  const usage: Usage = { fetchedAt: "2026-09-23T11:59:00Z", windows, error: null, cached: false, resets: null };

  it("keeps account-wide windows and matches scoped windows by exact model id", () => {
    expect(usageWindowsForModel(windows, "gemini-3-pro").map((window) => window.id)).toEqual(["account", "gemini-5h"]);
    expect(usageWindowsForModel(windows, "claude-4").map((window) => window.id)).toEqual(["account", "3p-weekly"]);
    expect(usageWindowsForModel(windows, "gpt-5.1").map((window) => window.id)).toEqual(["account"]);
  });

  it("never applies a scoped window to an unknown model", () => {
    for (const model of [null, undefined, ""]) {
      expect(usageWindowsForModel(windows, model).map((window) => window.id)).toEqual(["account"]);
    }
    expect(usageWindowsForModel(windows, "not-a-model").map((window) => window.id)).toEqual(["account"]);
    // An empty model list means the mapping is unknown, not "all models".
    expect(usageWindowAppliesToModel(windows[3]!, "anything")).toBe(false);
  });

  it("summarises the busiest window that governs the model", () => {
    expect(peakUsageForModel(windows, "gemini-3-pro")?.id).toBe("gemini-5h");
    expect(modelUsageSummary(usage, "gemini-3-pro")).toMatchObject({
      model: "gemini-3-pro",
      usedPercent: 80,
      resetsAt: "2026-09-23T14:00:00Z",
    });
    expect(usageSummaryForModel(usage, "gemini-3-pro", NOW)).toBe("80% of gemini 5h used · resets in 2h");
    expect(usageSummaryForModel(usage, "claude-4", NOW)).toBe("40% of claude/gpt weekly used · resets in 2d");
    expect(usageSummaryForModel(usage, "not-a-model", NOW)).toBe("10% of monthly used · resets in 2d");
  });

  it("reports unknown usage instead of an empty account when nothing applies", () => {
    const scopedOnly: Usage = {
      ...usage,
      windows: windows.filter((window) => window.scope),
    };
    expect(peakUsageForModel(scopedOnly.windows, null)).toBeNull();
    expect(usageSummaryForModel(scopedOnly, null, NOW)).toBeNull();
    expect(modelUsageSummary(usage, "gemini-3-pro")?.windows.map((window) => window.id)).toEqual(["account", "gemini-5h"]);
    expect(modelUsageSummary(undefined, "gemini-3-pro")).toBeNull();
  });
});
