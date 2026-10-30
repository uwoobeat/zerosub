import type { PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";

// Set only in a separately authorized test daemon. Empty means observe nothing.
const target = process.env.ZEROSUB_OBSERVER_AGENT_ID;
const observedQuota = /^Individual quota reached\. Please upgrade your subscription to increase your limits\. Resets in (?:\d+[hms])+\.$/;

export function observe(server: Pick<PluginServerContext, "on">, targetId: string | undefined, emit: (record: object) => void) {
  const turns = new Map<string, string>();
  let next = 0;
  const alias = (id: string | null) => {
    if (id === null) return null;
    let value = turns.get(id);
    if (!value) {
      value = `turn-${++next}`;
      turns.set(id, value);
    }
    return value;
  };
  const started = new Set<string>();
  const selected = (agent: { id: string; provider: string }) => Boolean(targetId && agent.id === targetId && agent.provider === "antigravity");
  const start = server.on("agent.turn_started", (event) => {
    if (!selected(event.agent)) return;
    const turn = alias(event.turnId);
    if (turn) started.add(turn);
    emit({ event: "started", at: new Date().toISOString(), turn });
  });
  const end = server.on("agent.turn_ended", (event: PluginLifecycleEvents["agent.turn_ended"]) => {
    if (!selected(event.agent)) return;
    const turn = alias(event.turnId);
    const error = event.outcome.kind === "failed" ? event.outcome.error : undefined;
    emit({
      event: "ended", at: new Date().toISOString(), turn,
      matchedStart: turn !== null && started.has(turn), outcome: event.outcome.kind,
      errorMessage: error ? (observedQuota.test(error.message) ? "observed-quota-wording" : "redacted") : null,
      errorCodePresent: typeof error?.code === "string",
      errorScopePresent: Boolean(error && Object.hasOwn(error, "scope")),
      timelineErrorCount: event.timeline.filter((item) => item.type === "error").length,
    });
  });
  return () => { start(); end(); };
}

export default function contribute(server: PluginServerContext) {
  return observe(server, target, (record) => console.log("[zerosub-agy-observer]", JSON.stringify(record)));
}
