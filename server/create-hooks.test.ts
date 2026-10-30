import { describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { CREATE_CONTEXT_ENV } from "./create-context";

const fake = vi.hoisted(() => ({ open: vi.fn(async (request: unknown, _context: unknown, _model: unknown) => request) }));
vi.mock("./service", () => ({
  Service: class {
    start = async () => undefined;
    stop = async () => undefined;
    setPreferences = () => undefined;
    onSessionOpen = fake.open;
  },
  describe: String,
}));
vi.mock("./claude", () => ({ ClaudeAdapter: class {} }));
vi.mock("./codex", () => ({ CodexAdapter: class {} }));
vi.mock("./antigravity", async (original) => {
  const actual = await original<typeof import("./antigravity")>();
  return { ...actual, AntigravityAdapter: class {} };
});

describe("create and session hook integration", () => {
  it("passes each issued model to the corresponding first hook and strips its marker", async () => {
    fake.open.mockClear();
    const hooks = new Map<string, (input: { request: any }, context: any) => any>();
    const server = {
      before: (name: string, handler: (input: { request: any }, context: any) => any) => hooks.set(name, handler),
      on: () => undefined,
      handle: () => undefined,
      registerSettings: () => ({ read: async () => ({ status: "loading" }), subscribe: () => () => undefined }),
    };
    const stop = contribute(server as never);
    const context = { paseo: {}, signal: new AbortController().signal };
    const create = hooks.get("agent.create")!;
    const open = hooks.get("agent.session_open")!;
    const first = create({ request: { config: { provider: "antigravity", cwd: "/first", model: "claude-opus-5-5-high" }, env: { KEEP: "1" } } }, context);
    const second = create({ request: { config: { provider: "antigravity", cwd: "/second", model: "default" }, env: {} } }, context);
    const request = (id: string, cwd: string, env: Record<string, string>) => ({ agentId: id, provider: "antigravity", cwd, workspaceId: null, reason: "create", purpose: "interactive", env });
    await open({ request: request("second", "/second", second.env) }, context);
    const result = await open({ request: request("first", "/first", first.env) }, context);
    expect(fake.open.mock.calls[0]?.[2]).toBeNull();
    expect(fake.open.mock.calls[1]?.[2]).toBe("claude-opus-5-5-high");
    expect(result.env).toEqual({ KEEP: "1" });
    expect(result.env[CREATE_CONTEXT_ENV]).toBeUndefined();
    await stop();
  });
});
