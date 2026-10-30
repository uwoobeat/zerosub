import { randomBytes } from "node:crypto";
import type { PluginBeforeRequests, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { experimentalAntigravityBalanceMapping } from "./antigravity";

export const CREATE_CONTEXT_ENV = "ZEROSUB_CREATE_CONTEXT";
const TTL_MS = 60_000;
const MAX_CONTEXTS = 1024;

/** One-use, process-local proof of the model observed in an agent.create hook. */
export class CreateContexts {
  private readonly entries = new Map<string, { provider: string; cwd: string; model: string; expires: number }>();

  issue(request: PluginBeforeRequests["agent.create"], now = Date.now()): PluginBeforeRequests["agent.create"] {
    const env = { ...request.env };
    delete env[CREATE_CONTEXT_ENV];
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    const model = request.config.model?.trim();
    if (request.config.provider === "antigravity" && model && experimentalAntigravityBalanceMapping(model) !== null) {
      while (this.entries.size >= MAX_CONTEXTS) this.entries.delete(this.entries.keys().next().value!);
      const key = randomBytes(24).toString("hex");
      this.entries.set(key, { provider: request.config.provider, cwd: request.config.cwd, model, expires: now + TTL_MS });
      env[CREATE_CONTEXT_ENV] = key;
    }
    return { ...request, env };
  }

  consume(request: PluginSessionOpenRequest, now = Date.now()): { request: PluginSessionOpenRequest; model: string | null } {
    const env = { ...request.env };
    const key = env[CREATE_CONTEXT_ENV];
    delete env[CREATE_CONTEXT_ENV];
    const entry = key ? this.entries.get(key) : undefined;
    if (key) this.entries.delete(key);
    const model = entry && entry.expires > now && request.reason === "create" && request.purpose === "interactive" &&
      entry.provider === request.provider && entry.cwd === request.cwd ? entry.model : null;
    return { request: { ...request, env }, model };
  }
}
