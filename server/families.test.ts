import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVAILABILITY_TIMEOUT_MS, FamilyResolver, bringsOwnAuth, bringsOwnRoot, familiesFromConfig } from "./families";

const none = {};

function fakePaseo(options: {
  config?: unknown;
  configError?: unknown;
  entries?: unknown;
  snapshotPromise?: Promise<unknown>;
  snapshotError?: unknown;
}): Parameters<FamilyResolver["resolve"]>[0] {
  return {
    config: {
      get: async () => {
        if (options.configError) throw options.configError;
        return { config: options.config ?? {} };
      },
    },
    providers: {
      snapshot: async () => {
        if (options.snapshotError) throw options.snapshotError;
        if (options.snapshotPromise) return options.snapshotPromise;
        return { entries: options.entries ?? [] };
      },
      listAvailable: vi.fn(() => new Promise(() => {})),
    },
  } as unknown as Parameters<FamilyResolver["resolve"]>[0];
}

async function resolveFamilies(options: Parameters<typeof fakePaseo>[0]): Promise<Record<string, string>> {
  return new FamilyResolver().resolve(fakePaseo(options));
}

describe("familiesFromConfig", () => {
  it("maps the built-in families, including native Antigravity", () => {
    expect(familiesFromConfig({}, none)).toEqual({
      claude: "claude",
      codex: "codex",
      antigravity: "antigravity",
    });
    expect(familiesFromConfig(undefined, none).antigravity).toBe("antigravity");
  });

  it("maps a custom profile that directly extends a family", () => {
    expect(
      familiesFromConfig(
        {
          "antigravity-work": { extends: "antigravity" },
          "claude-fast": { extends: "claude" },
          "codex-work": { extends: "codex" },
        },
        none,
      ),
    ).toEqual({
      claude: "claude",
      codex: "codex",
      antigravity: "antigravity",
      "antigravity-work": "antigravity",
      "claude-fast": "claude",
      "codex-work": "codex",
    });
  });

  it("leaves profiles with their own credentials or endpoint alone", () => {
    const families = familiesFromConfig(
      {
        antigravity: { env: { GEMINI_API_KEY: "key" } },
        "antigravity-work": { extends: "antigravity" },
        "antigravity-adc": { extends: "antigravity", env: { AGY_ADC_AUTH: "1" } },
        "antigravity-home": { extends: "antigravity", env: { GEMINI_HOME: "/tmp/agy" } },
        "claude-proxy": { extends: "claude", env: { ANTHROPIC_BASE_URL: "https://proxy.example" } },
      },
      none,
    );
    expect(families.antigravity).toBeUndefined();
    expect(families["antigravity-work"]).toBeUndefined();
    expect(families["antigravity-adc"]).toBeUndefined();
    expect(families["antigravity-home"]).toBeUndefined();
    expect(families["claude-proxy"]).toBeUndefined();
    // Unrelated families are unaffected.
    expect(families.claude).toBe("claude");
    expect(families.codex).toBe("codex");
  });

  it("leaves provider profiles that override HOME/XDG alone", () => {
    const families = familiesFromConfig(
      {
        "antigravity-home": { extends: "antigravity", env: { HOME: "/tmp/agy-home" } },
        "antigravity-xdg": { extends: "antigravity", env: { XDG_CONFIG_HOME: "/tmp/agy-config" } },
        "claude-home": { extends: "claude", env: { HOME: "/tmp/claude-home" } },
        "codex-xdg": { extends: "codex", env: { XDG_STATE_HOME: "/tmp/codex-state" } },
      },
      none,
    );
    for (const id of ["antigravity-home", "antigravity-xdg", "claude-home", "codex-xdg"]) {
      expect(families[id]).toBeUndefined();
    }
    expect(families.claude).toBe("claude");
    expect(families.codex).toBe("codex");
    expect(families.antigravity).toBe("antigravity");
  });

  it("does not treat the daemon's normal HOME/XDG or GEMINI_HOME as a provider override", () => {
    const families = familiesFromConfig(
      {},
      {
        HOME: "/home/person",
        XDG_CONFIG_HOME: "/home/person/.config",
        XDG_STATE_HOME: "/home/person/.local/state",
        GEMINI_HOME: "/tmp/acp-only",
      },
    );
    expect(families.antigravity).toBe("antigravity");
  });

  it("inherits an exclusion from the parent profile's configuration", () => {
    const families = familiesFromConfig(
      {
        antigravity: { env: { GOOGLE_GEMINI_BASE_URL: "https://example.test" } },
        "antigravity-work": { extends: "antigravity" },
      },
      none,
    );
    expect(families.antigravity).toBeUndefined();
    expect(families["antigravity-work"]).toBeUndefined();
  });

  it("lets a child explicitly clear a parent credential or root override", () => {
    const families = familiesFromConfig(
      {
        claude: { env: { ANTHROPIC_API_KEY: "key" } },
        "claude-cleared": { extends: "claude", env: { ANTHROPIC_API_KEY: "" } },
        "claude-inherited": { extends: "claude" },
        antigravity: { env: { GEMINI_HOME: "/tmp/parent-agy" } },
        "antigravity-cleared": { extends: "antigravity", env: { GEMINI_HOME: "" } },
      },
      none,
    );
    expect(families.claude).toBeUndefined();
    expect(families["claude-cleared"]).toBe("claude");
    expect(families["claude-inherited"]).toBeUndefined();
    expect(families.antigravity).toBeUndefined();
    expect(families["antigravity-cleared"]).toBe("antigravity");
  });

  it("does not guess that a generic ACP profile is Antigravity", () => {
    expect(
      familiesFromConfig(
        {
          "acp-agent": { extends: "acp" },
          "antigravity-acp": { extends: "acp", env: { GEMINI_HOME: "/tmp/agy-acp" } },
        },
        none,
      ),
    ).toEqual({ claude: "claude", codex: "codex", antigravity: "antigravity" });
  });

  it("keeps an Antigravity API-key or ADC mode in the daemon environment out of account routing", () => {
    expect(familiesFromConfig({}, { GEMINI_API_KEY: "key" }).antigravity).toBeUndefined();
    expect(familiesFromConfig({}, { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" }).antigravity).toBeUndefined();
    // The other families keep their existing config-only rule.
    expect(familiesFromConfig({}, { ANTHROPIC_API_KEY: "key" }).claude).toBe("claude");
    expect(familiesFromConfig({}, { OPENAI_API_KEY: "key" }).codex).toBe("codex");
  });
});

describe("FamilyResolver availability", () => {
  it("uses the ready catalog without waiting for legacy availability probes", async () => {
    const paseo = fakePaseo({ entries: [{ provider: "antigravity", status: "ready", enabled: true }] });
    const families = await new FamilyResolver().resolve(paseo);
    expect(families.antigravity).toBe("antigravity");
    expect(paseo.providers.listAvailable).not.toHaveBeenCalled();
  });

  it.each([
    { status: "ready", enabled: false },
    { status: "loading", enabled: true },
    { status: "error", enabled: true },
    { status: "unavailable", enabled: true },
    { status: "ready" },
  ])("excludes an unconfirmed catalog entry: %j", async (entry) => {
    const families = await resolveFamilies({ entries: [{ provider: "antigravity", ...entry }] });
    expect(families.antigravity).toBeUndefined();
  });

  it("keeps Antigravity providers only when the provider catalog reports each ready provider ID", async () => {
    const families = await resolveFamilies({
      config: { providers: { "antigravity-work": { extends: "antigravity" } } },
      entries: [
        { provider: "antigravity", status: "ready", enabled: true },
        { provider: "antigravity-work", status: "unavailable", enabled: true },
        { provider: "claude", status: "ready", enabled: true },
      ],
    });
    expect(families).toEqual({ claude: "claude", codex: "codex", antigravity: "antigravity" });
  });

  it("keeps a custom Antigravity provider when its own provider ID is available", async () => {
    const families = await resolveFamilies({
      config: { providers: { "antigravity-work": { extends: "antigravity" } } },
      entries: [
        { provider: "antigravity", status: "ready", enabled: true },
        { provider: "antigravity-work", status: "ready", enabled: true },
      ],
    });
    expect(families.antigravity).toBe("antigravity");
    expect(families["antigravity-work"]).toBe("antigravity");
  });

  it("fails Antigravity closed when the native provider is unavailable", async () => {
    const families = await resolveFamilies({
      entries: [{ provider: "antigravity", status: "unavailable", enabled: true }],
    });
    expect(families.antigravity).toBeUndefined();
    expect(families.claude).toBe("claude");
    expect(families.codex).toBe("codex");
  });

  it("fails Antigravity closed when provider config cannot be read", async () => {
    const families = await resolveFamilies({
      configError: new Error("config unavailable"),
      entries: [{ provider: "antigravity", status: "ready", enabled: true }],
    });
    expect(families.antigravity).toBeUndefined();
    expect(families.claude).toBe("claude");
    expect(families.codex).toBe("codex");
  });

  it("fails Antigravity closed when provider availability cannot be read", async () => {
    const families = await resolveFamilies({
      config: { providers: {} },
      snapshotError: new Error("availability unavailable"),
    });
    expect(families.antigravity).toBeUndefined();
    expect(families.claude).toBe("claude");
    expect(families.codex).toBe("codex");
  });
});

describe("FamilyResolver availability timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fails Antigravity closed when the provider catalog does not answer in time", async () => {
    let rejectLate!: (reason?: unknown) => void;
    const pending = new Promise<unknown>((_, reject) => {
      rejectLate = reject;
    });
    const promise = new FamilyResolver().resolve(
      fakePaseo({ config: { providers: {} }, snapshotPromise: pending }),
    );
    await vi.advanceTimersByTimeAsync(AVAILABILITY_TIMEOUT_MS);
    const families = await promise;

    expect(families).toEqual({ claude: "claude", codex: "codex" });
    expect(vi.getTimerCount()).toBe(0);

    // The abandoned IPC answer must not become an unhandled rejection after the timeout.
    rejectLate(new Error("late availability answer"));
    await Promise.resolve();
  });

  it("clears its timeout after a normal availability answer", async () => {
    const families = await new FamilyResolver().resolve(
      fakePaseo({ entries: [{ provider: "antigravity", status: "ready", enabled: true }] }),
    );
    expect(families.antigravity).toBe("antigravity");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bringsOwnAuth", () => {
  it("ignores empty values", () => {
    expect(bringsOwnAuth("antigravity", { GEMINI_API_KEY: "" })).toBe(false);
    expect(bringsOwnAuth("antigravity", { GEMINI_API_KEY: "key" })).toBe(true);
    expect(bringsOwnAuth("antigravity", undefined)).toBe(false);
  });

  it("keeps GEMINI_HOME out of the native credential keys", () => {
    expect(bringsOwnAuth("antigravity", { GEMINI_HOME: "/tmp/agy" })).toBe(false);
    expect(bringsOwnRoot("antigravity", { GEMINI_HOME: "/tmp/agy" })).toBe(true);
  });
});
