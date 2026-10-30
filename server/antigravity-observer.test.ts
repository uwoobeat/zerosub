import { describe, expect, it } from "vitest";
import { observe } from "../tools/antigravity-hook-observer/index.server";
import type { PluginServerContext } from "@getpaseo/plugin/server";

describe("test-only Antigravity hook observer", () => {
  it("selects only the configured agent and emits aliases and redacted fields", () => {
    const handlers: Record<string, (event: any) => void> = {};
    const server = { on: (name: string, handler: (event: any) => void) => { handlers[name] = handler; return () => { delete handlers[name]; }; } };
    const records: object[] = [];
    const stop = observe(server as unknown as Pick<PluginServerContext, "on">, "private-agent", (record) => records.push(record));
    const agent = { id: "private-agent", provider: "antigravity" };
    handlers["agent.turn_started"]?.({ agent: { ...agent, id: "other" }, turnId: "secret" });
    handlers["agent.turn_started"]?.({ agent, turnId: "secret" });
    handlers["agent.turn_ended"]?.({ agent, turnId: "secret", outcome: { kind: "failed", error: { message: "secret token", code: "private code", scope: "private scope" } }, timeline: [{ type: "error", message: "private output" }] });
    handlers["agent.turn_ended"]?.({ agent, turnId: null, outcome: { kind: "failed", error: { message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h53m56s." } }, timeline: [] });
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ turn: "turn-1", matchedStart: true, errorMessage: "redacted", errorCodePresent: true, errorScopePresent: true, timelineErrorCount: 1 });
    expect(records[2]).toMatchObject({ turn: null, matchedStart: false, errorMessage: "observed-quota-wording" });
    expect(JSON.stringify(records)).not.toMatch(/secret|private|4h53m56s/);
    stop();
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it("is inert without an explicit agent", () => {
    const handlers: Record<string, (event: any) => void> = {};
    const server = { on: (name: string, handler: (event: any) => void) => { handlers[name] = handler; return () => {}; } };
    const records: object[] = [];
    observe(server as unknown as Pick<PluginServerContext, "on">, undefined, (record) => records.push(record));
    handlers["agent.turn_started"]?.({ agent: { id: "a", provider: "antigravity" }, turnId: "t" });
    expect(records).toEqual([]);
  });
});
