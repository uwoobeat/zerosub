import { describe, expect, it } from "vitest";
import { CREATE_CONTEXT_ENV, CreateContexts } from "./create-context";

describe("first-session model context", () => {
  const create = { config: { provider: "antigravity" as const, cwd: "/work", model: "claude-opus-5-5-high" }, env: { KEEP: "yes" } };
  const request = { agentId: "a", workspaceId: null, provider: "antigravity", cwd: "/work", reason: "create" as const, purpose: "interactive" as const, env: {} };

  it("matches concurrent requests without trusting or forwarding user-provided markers", () => {
    const contexts = new CreateContexts();
    const first = contexts.issue(create, 10);
    const second = contexts.issue({ ...create, config: { ...create.config, cwd: "/other" } }, 10);
    expect(contexts.consume({ ...request, cwd: "/other", env: second.env! }, 11).model).toBe(create.config.model);
    const result = contexts.consume({ ...request, env: first.env! }, 11);
    expect(result.model).toBe(create.config.model);
    expect(result.request.env).toEqual({ KEEP: "yes" });
    expect(contexts.consume({ ...request, env: first.env! }, 11).model).toBeNull();
    expect(contexts.consume({ ...request, env: { [CREATE_CONTEXT_ENV]: "forged" } }, 11).model).toBeNull();
  });

  it("expires and rejects mismatched, unsupported and non-create requests", () => {
    const contexts = new CreateContexts();
    const fresh = () => contexts.issue(create, 100).env!;
    expect(contexts.consume({ ...request, env: fresh(), cwd: "/different" }, 101).model).toBeNull();
    expect(contexts.consume({ ...request, env: fresh(), reason: "resume" }, 101).model).toBeNull();
    expect(contexts.consume({ ...request, env: fresh(), purpose: "history" }, 101).model).toBeNull();
    expect(contexts.consume({ ...request, env: fresh() }, 60_100).model).toBeNull();
    expect(contexts.issue({ ...create, config: { ...create.config, model: "default" } }).env?.[CREATE_CONTEXT_ENV]).toBeUndefined();
  });
});
