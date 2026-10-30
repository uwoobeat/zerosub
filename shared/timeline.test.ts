import { describe, expect, it } from "vitest";
import { SwitchRowSchema } from "./timeline";

describe("switch timeline compatibility", () => {
  const old = { family: "claude", from: "A", to: "B", reason: "limit", resetsAt: null, continued: false, at: "2026-10-30T00:00:00Z" };

  it("accepts old rows and preserves an optional Antigravity group label", () => {
    expect(SwitchRowSchema.parse(old).scopeLabel).toBeUndefined();
    expect(SwitchRowSchema.parse({ ...old, family: "antigravity", scopeLabel: "Claude and GPT models" }).scopeLabel).toBe("Claude and GPT models");
  });
});
