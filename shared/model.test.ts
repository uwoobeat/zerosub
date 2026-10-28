import { describe, expect, it } from "vitest";
import {
  AgentRouteSchema,
  FAMILY_LABEL,
  FamilyCapabilitiesSchema,
  FamilySchema,
  StateViewSchema,
  UsageWindowSchema,
} from "./model";

describe("family contract", () => {
  it("includes Antigravity without changing the existing labels", () => {
    expect(FamilySchema.parse("antigravity")).toBe("antigravity");
    expect(FAMILY_LABEL).toEqual({ claude: "Claude", codex: "ChatGPT", antigravity: "Antigravity" });
  });
});

describe("usage window contract", () => {
  it("keeps Claude and Codex windows unscoped", () => {
    const window = UsageWindowSchema.parse({ id: "five_hour", label: "5-hour", usedPercent: 30, resetsAt: null });
    expect(window.scope).toBeUndefined();
    expect(window.period).toBeUndefined();
  });

  it("accepts an optional scope and period for model-specific limits", () => {
    const window = UsageWindowSchema.parse({
      id: "gemini-5h",
      label: "Gemini 5h",
      usedPercent: 20,
      resetsAt: "2026-10-24T00:00:00Z",
      period: "5h",
      scope: { id: "gemini", label: "Gemini Models", models: ["gemini-3-pro"] },
    });
    expect(window.scope?.models).toEqual(["gemini-3-pro"]);
    expect(window.period).toBe("5h");
  });
});

describe("view contract", () => {
  it("defaults capabilities to an empty record for older servers", () => {
    const view = StateViewSchema.parse({
      agents: [],
      accounts: [],
      logins: [],
      providers: {},
      canReopen: false,
      showComposerPill: true,
      warnings: [],
    });
    expect(view.capabilities).toEqual({});
  });

  it("describes what a family can do", () => {
    const capabilities = FamilyCapabilitiesSchema.parse({
      managedAccounts: false,
      loginMethods: ["browser"],
      autoSwitch: false,
      resets: false,
      fork: false,
    });
    expect(capabilities.loginMethods).toEqual(["browser"]);
  });

  it("keeps an agent's model optional", () => {
    const base = { agentId: "a", family: "antigravity", accountId: "antigravity-main", pinned: false, pendingAccountId: null, movable: false };
    expect(AgentRouteSchema.parse(base).model).toBeUndefined();
    expect(AgentRouteSchema.parse({ ...base, model: "gemini-3-pro" }).model).toBe("gemini-3-pro");
    expect(AgentRouteSchema.parse({ ...base, model: null }).model).toBeNull();
  });
});
