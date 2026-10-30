import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageSchema } from "../shared/model";
import { applyEnv, spawnEnv, type FamilyAdapter } from "./adapter";
import {
  AntigravityAdapter,
  AntigravityQuotaError,
  antigravityAuthUrl,
  antigravityEnv,
  antigravityIdentityKey,
  antigravityLoginEnv,
  asksForDa2,
  buildLoginScriptCommand,
  experimentalAntigravityBalanceUsage,
  experimentalAntigravityLimit,
  parseAntigravityUsage,
  readAntigravityIdentityClaims,
  shellQuote,
} from "./antigravity";

vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    mainAntigravityHome: () => "/home/example",
    antigravityCredentialPath: (home: string | null) =>
      home
        ? joinPath(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
        : joinPath("/home/example", ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  };
});

vi.mock("./homes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./homes")>();
  return { ...actual, prepareAntigravityHome: async () => undefined };
});

const FIXED_AT = "2026-10-24T00:00:00.000Z";

function rawResponse(groups: unknown[]): Record<string, unknown> {
  return {
    status: "SUCCESS",
    num_turns: 0,
    // Token counts from the print run: explicitly not subscription quota.
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 999 },
    command: { name: "usage", data: { groups } },
    response: "<TSV text>",
  };
}

function fullGroups(): unknown[] {
  return [
    {
      name: "Gemini Models",
      buckets: [
        {
          id: "gemini-weekly",
          name: "Gemini Weekly Limit",
          window: "weekly",
          remaining_fraction: 1,
          reset_time: "2026-10-30T00:42:59Z",
        },
        {
          id: "gemini-5h",
          name: "Gemini 5 Hour Limit",
          window: "5h",
          remaining_fraction: 0.25,
          reset_time: "2026-10-24T05:42:59Z",
        },
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [
        { id: "3p-weekly", window: "weekly", remaining_fraction: 0.9 },
        { id: "3p-5h", window: "5h", remaining_fraction: 0.5 },
      ],
    },
    {
      name: "Gemini 4 Argon",
      buckets: [
        {
          id: "gemini-argon-wtu-weekly",
          window: "weekly",
          remaining_fraction: 0.5132234692573547,
        },
      ],
    },
  ];
}

function parseOneBucket(bucket: Record<string, unknown>): ReturnType<typeof parseAntigravityUsage>["windows"][number] | undefined {
  return parseAntigravityUsage(rawResponse([{ name: "Test Group", buckets: [bucket] }]), { fetchedAt: FIXED_AT })
    .windows[0];
}

describe("Antigravity quota parsing", () => {
  it("reads all five verified buckets as group-scoped subscription windows", () => {
    const usage = parseAntigravityUsage(rawResponse(fullGroups()), { fetchedAt: FIXED_AT });

    expect(usage.fetchedAt).toBe(FIXED_AT);
    expect(usage.error).toBeNull();
    expect(usage.cached).toBe(false);
    expect(usage.resets).toBeNull();
    expect(usage.windows.map((window) => window.id)).toEqual([
      "gemini-weekly",
      "gemini-5h",
      "3p-weekly",
      "3p-5h",
      "gemini-argon-wtu-weekly",
    ]);

    expect(usage.windows[0]).toMatchObject({
      id: "gemini-weekly",
      label: "Weekly",
      usedPercent: 0,
      resetsAt: "2026-10-30T00:42:59.000Z",
      period: "weekly",
      scope: { id: "gemini-models", label: "Gemini Models", models: [] },
    });
    expect(usage.windows[1]).toMatchObject({
      id: "gemini-5h",
      label: "5-hour",
      usedPercent: 75,
      resetsAt: "2026-10-24T05:42:59.000Z",
      scope: { id: "gemini-models", label: "Gemini Models", models: [] },
    });
    expect(usage.windows[2]?.usedPercent).toBeCloseTo(10);
    expect(usage.windows[2]?.resetsAt).toBeNull();
    expect(usage.windows[3]?.usedPercent).toBe(50);
    expect(usage.windows[4]?.usedPercent).toBeCloseTo(48.67765307426453);
    expect(usage.windows[4]?.scope).toMatchObject({ id: "gemini-4-argon", label: "Gemini 4 Argon", models: [] });
    expect(UsageSchema.safeParse(usage).success).toBe(true);
  });

  it("keeps dynamic groups and skips disabled groups and buckets", () => {
    const usage = parseAntigravityUsage(
      rawResponse([
        {
          name: "Gemini Models",
          buckets: [
            { id: "disabled-bucket", window: "weekly", disabled: true },
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.5 },
          ],
        },
        {
          name: "Disabled group",
          disabled: true,
        },
        {
          name: "New Model Group",
          buckets: [
            { id: "new-monthly", window: "monthly", remaining_fraction: 0.25, reset_time: "not-a-date" },
          ],
        },
      ]),
    );

    expect(usage.windows.map((window) => window.id)).toEqual(["gemini-5h", "new-monthly"]);
    expect(usage.windows[1]).toMatchObject({
      label: "Monthly",
      usedPercent: 75,
      resetsAt: null,
      period: "monthly",
      scope: { label: "New Model Group", models: [] },
    });
    expect(usage.windows[1]?.scope.id).toMatch(/^group-[0-9a-f]{12}$/);
  });

  it("derives unknown scopes from their bucket IDs, not from name order", () => {
    const groups = [
      { name: "Same", buckets: [{ id: "a", window: "5h", remaining_fraction: 1 }] },
      { name: "Same", buckets: [{ id: "b", window: "5h", remaining_fraction: 1 }] },
    ];
    const first = parseAntigravityUsage(rawResponse(groups));
    const reversed = parseAntigravityUsage(rawResponse([...groups].reverse()));
    const ids = new Map(first.windows.map((window) => [window.id, window.scope.id]));
    expect(ids.get("a")).not.toBe(ids.get("b"));
    expect(new Map(reversed.windows.map((window) => [window.id, window.scope.id]))).toEqual(ids);
  });

  it("keeps a known group's scope through renames, reordering and split groups", () => {
    const original = parseAntigravityUsage(
      rawResponse([
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 },
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.5 },
          ],
        },
      ]),
    );
    const renamed = parseAntigravityUsage(
      rawResponse([
        {
          name: "Gemini Model Limits",
          buckets: [
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.5 },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 },
          ],
        },
      ]),
    );
    const split = parseAntigravityUsage(
      rawResponse([
        { name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 }] },
        { name: "Gemini Models", buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.5 }] },
      ]),
    );
    expect(new Set(original.windows.map((window) => window.scope.id))).toEqual(new Set(["gemini-models"]));
    expect(new Set(renamed.windows.map((window) => window.scope.id))).toEqual(new Set(["gemini-models"]));
    expect(new Set(split.windows.map((window) => window.scope.id))).toEqual(new Set(["gemini-models"]));
  });

  it("rejects a duplicate bucket ID across groups", () => {
    expect(() =>
      parseAntigravityUsage(
        rawResponse([
          { name: "One", buckets: [{ id: "bucket-secret-1", window: "5h", remaining_fraction: 0.5 }] },
          { name: "Two", buckets: [{ id: "bucket-secret-1", window: "weekly", remaining_fraction: 0.5 }] },
        ]),
      ),
    ).toThrow(AntigravityQuotaError);
    try {
      parseAntigravityUsage(
        rawResponse([
          { name: "One", buckets: [{ id: "bucket-secret-1", window: "5h", remaining_fraction: 0.5 }] },
          { name: "Two", buckets: [{ id: "bucket-secret-1", window: "weekly", remaining_fraction: 0.5 }] },
        ]),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "duplicate_id" });
      expect((error as Error).message).not.toContain("bucket-secret-1");
    }
  });

  it("rejects fractions outside 0..1 and does not turn a missing fraction into 0% used", () => {
    for (const fraction of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined]) {
      expect(() => parseOneBucket({ id: "bad", window: "weekly", remaining_fraction: fraction })).toThrow(
        AntigravityQuotaError,
      );
    }
    expect(() => parseOneBucket({ id: "missing", window: "weekly" })).toThrow(AntigravityQuotaError);
  });

  it("accepts 0 and 1 as the exact range ends", () => {
    expect(parseOneBucket({ id: "empty", window: "weekly", remaining_fraction: 0 })?.usedPercent).toBe(100);
    expect(parseOneBucket({ id: "full", window: "weekly", remaining_fraction: 1 })?.usedPercent).toBe(0);
  });

  it("keeps a correct reset time and leaves an unusable one null", () => {
    expect(parseOneBucket({ id: "iso", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-24T00:42:59Z" })?.resetsAt).toBe(
      "2026-10-24T00:42:59.000Z",
    );
    expect(
      parseOneBucket({ id: "offset", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-24T00:42:59.123+00:00" })
        ?.resetsAt,
    ).toBe("2026-10-24T00:42:59.123Z");
    for (const reset of ["2026-10-24T00:42:59", "not-a-date", "", 123, null]) {
      expect(parseOneBucket({ id: "bad-time", window: "weekly", remaining_fraction: 1, reset_time: reset })?.resetsAt).toBeNull();
    }
  });

  it("rejects an unsuccessful, model-running or unexpected command response", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...rawResponse([]), status: "ERROR" }, "unsuccessful"],
      [{ ...rawResponse([]), num_turns: 1 }, "model_turn"],
      [{ ...rawResponse([]), num_turns: "0" }, "invalid_response"],
      [{ ...rawResponse([]), command: { name: "models", data: { groups: [] } } }, "invalid_response"],
      [{ ...rawResponse([]), command: { name: "usage", data: {} } }, "invalid_response"],
    ];
    for (const [raw, code] of cases) {
      try {
        parseAntigravityUsage(raw);
        throw new Error("expected parsing to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AntigravityQuotaError);
        expect(error).toMatchObject({ code });
      }
    }
  });

  it("reports no usable windows instead of an empty 0% reading", () => {
    expect(() => parseAntigravityUsage(rawResponse([]))).toThrowError(
      expect.objectContaining({ code: "no_windows" }),
    );
    expect(() =>
      parseAntigravityUsage(
        rawResponse([{ name: "Disabled", disabled: true, buckets: [{ id: "x", window: "weekly", remaining_fraction: 0.5 }] }]),
      ),
    ).toThrowError(expect.objectContaining({ code: "no_windows" }));
  });

  it("ignores unknown fields and the print run's token counts", () => {
    const raw = rawResponse([
      {
        name: "Dynamic",
        future_group_field: true,
        buckets: [{ id: "dynamic-5h", window: "5h", remaining_fraction: 0.5, future_bucket_field: "kept out" }],
      },
    ]);
    const usage = parseAntigravityUsage(raw);
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]?.id).toBe("dynamic-5h");
    expect(usage.windows.some((window) => window.id === "total_tokens")).toBe(false);
  });
});

describe("Antigravity environment and capabilities", () => {
  it("leaves the CLI's own login environment untouched", async () => {
    expect(await new AntigravityAdapter().env(null)).toEqual({});
  });

  it("isolates HOME and the XDG roots for a managed home", () => {
    const home = "/var/lib/zerosub/homes/antigravity-a";
    const base = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      TMPDIR: join(home, "tmp"),
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GOOGLE_GENAI_API_KEY: "",
      GOOGLE_GEMINI_BASE_URL: "",
      GEMINI_BASE_URL: "",
      AGY_ADC_AUTH: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
      GEMINI_HOME: "",
    };
    expect(antigravityEnv(home, "linux")).toEqual({ ...base, DBUS_SESSION_BUS_ADDRESS: "" });
    expect(antigravityEnv(home, "darwin")).toEqual(base);
  });

  it("forces empty auth overrides through both applyEnv and spawnEnv", () => {
    const home = "/var/lib/zerosub/homes/antigravity-a";
    const patch = antigravityEnv(home);
    const applied = applyEnv(patch, {
      GEMINI_API_KEY: "user-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/user-adc.json",
      GEMINI_HOME: "/tmp/user-gemini",
    });
    expect(applied.GEMINI_API_KEY).toBe("");
    expect(applied.GOOGLE_APPLICATION_CREDENTIALS).toBe("");
    expect(applied.GEMINI_HOME).toBe("");

    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "user-key";
    try {
      expect(spawnEnv(patch).GEMINI_API_KEY).toBe("");
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
    }
  });

  it("creates the isolated directories used by the environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-antigravity-home-"));
    try {
      await new AntigravityAdapter().prepareHome(home);
      for (const name of ["config", "data", "state", "cache", "runtime", "tmp"]) {
        expect((await stat(join(home, name))).isDirectory()).toBe(true);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports Linux-only sign-in, experimental automatic switching and no resets", async () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.family).toBe("antigravity");
    expect(adapter.portable).toBe(false);
    expect(adapter.usageSpacingMs).toBe(120_000);
    expect(adapter.capabilities).toMatchObject({
      managedAccounts: process.platform === "linux",
      loginMethods: process.platform === "linux" ? ["code"] : [],
      autoSwitch: true,
      resets: false,
      fork: false,
    });
    expect(adapter.detectLimit()).toBeNull();
    expect(adapter.detectSignOut()).toBeNull();
    await expect(adapter.redeemReset()).resolves.toMatchObject({ outcome: "unavailable", left: null });
    await expect(adapter.login(null, "browser")).rejects.toThrow(/code flow|Linux only/);
  });

  it("does not automatically classify the observed quota error without verified turn scope", () => {
    const adapter: FamilyAdapter = new AntigravityAdapter();
    // Observed in a Paseo 0.14.0 agent's lastError with agy 1.4.10; the hook envelope is synthetic.
    expect(adapter.detectLimit({
      turnId: "synthetic-turn",
      outcome: { kind: "failed", error: { message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h53m56s." } },
      timeline: [],
    })).toBeNull();
    expect(adapter.capabilities?.autoSwitch).toBe(true);
  });
});

describe("experimental Antigravity balance mapping", () => {
  it("maps only the observed model and group without altering the original quota", () => {
    const usage = UsageSchema.parse({
      fetchedAt: FIXED_AT, cached: false, error: null, resets: null,
      windows: [
        { id: "3p-5h", label: "5 hours", usedPercent: 20, resetsAt: null,
          scope: { id: "claude-and-gpt-models", label: "Claude", models: ["another-model"] } },
        { id: "other", label: "Other", usedPercent: 10, resetsAt: null,
          scope: { id: "other", label: "Other", models: ["claude-opus-5-5-high"] } },
      ],
    });
    const mapped = experimentalAntigravityBalanceUsage("claude-opus-5-5-high", usage)!;
    expect(mapped.windows[0]?.scope?.models).toEqual(["another-model", "claude-opus-5-5-high"]);
    expect(mapped.windows[1]).toEqual(usage.windows[1]);
    expect(usage.windows[0]?.scope?.models).toEqual(["another-model"]);
    expect(experimentalAntigravityBalanceUsage("unknown-model", usage)).toBeNull();
    expect(experimentalAntigravityBalanceUsage(null, usage)).toBeNull();
  });

  it.each([
    ["gemini-3.8-flash-medium", "gemini-models"],
    ["gemini-4-argon-high", "gemini-4-argon"],
    ["claude-sonnet-5-5-low", "claude-and-gpt-models"],
    ["gpt-oss-120b-medium", "claude-and-gpt-models"],
  ])("maps %s to %s only", (model, scopeId) => {
    const usage = UsageSchema.parse({ fetchedAt: FIXED_AT, cached: false, error: null, resets: null,
      windows: ["gemini-models", "gemini-4-argon", "claude-and-gpt-models"].map((id) => ({
        id, label: id, usedPercent: 20, resetsAt: null, scope: { id, label: id, models: [] },
      })) });
    const mapped = experimentalAntigravityBalanceUsage(model, usage)!;
    expect(mapped.windows.filter((window) => window.scope?.models.includes(model)).map((window) => window.scope?.id)).toEqual([scopeId]);
  });

});

describe("experimental Antigravity limit evidence", () => {
  it("requires the observed failure, model, complete fresh quota and an exhausted window", () => {
    const now = Date.parse(FIXED_AT);
    const event = {
      turnId: "turn-1",
      outcome: { kind: "failed" as const, error: { message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h53m56s." } },
      timeline: [],
    };
    const usage = parseAntigravityUsage(rawResponse(fullGroups()), { fetchedAt: FIXED_AT });
    usage.windows[3]!.usedPercent = 100;
    const model = "claude-opus-5-5-high";
    expect(experimentalAntigravityLimit(event, model, usage, now)).toMatchObject({ kind: "window", scopeId: "claude-and-gpt-models" });
    expect(experimentalAntigravityLimit({ ...event, turnId: null }, model, usage, now)).toBeNull();
    expect(experimentalAntigravityLimit({ ...event, outcome: { kind: "canceled", reason: "user" } }, model, usage, now)).toBeNull();
    expect(experimentalAntigravityLimit({ ...event, outcome: { kind: "failed", error: { message: "429 RESOURCE_EXHAUSTED" } } }, model, usage, now)).toBeNull();
    expect(experimentalAntigravityLimit(event, "claude-opus-5-5-low", usage, now)).toBeNull();
    expect(experimentalAntigravityLimit(event, model, { ...usage, cached: true }, now)).toBeNull();
    expect(experimentalAntigravityLimit(event, model, { ...usage, error: "failed" }, now)).toBeNull();
    expect(experimentalAntigravityLimit(event, model, usage, now + 300_001)).toBeNull();
    expect(experimentalAntigravityLimit(event, model, usage, now - 1)).toBeNull();
    expect(experimentalAntigravityLimit(event, model, { ...usage, windows: usage.windows.filter((w) => w.id !== "3p-weekly") }, now)).toBeNull();
    expect(experimentalAntigravityLimit(event, model, { ...usage, windows: usage.windows.map((w) => ({ ...w, usedPercent: 50 })) }, now)).toBeNull();
  });
});

describe("Antigravity login command and terminal negotiation", () => {
  const paths = { pid: "/tmp/zerosub login pid", status: "/tmp/zerosub login status" };

  it("builds a Linux util-linux script(1) command with shell-safe quoting", () => {
    const command = buildLoginScriptCommand(
      "linux",
      "/opt/a b'c/agy",
      ["--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"],
      paths,
    );
    expect(command.command).toBe("/usr/bin/script");
    expect(command.args.slice(0, 6)).toEqual(["-q", "-e", "-E", "never", "-f", "-c"]);
    expect(command.args[7]).toBe("/dev/null");
    const line = command.args[6] ?? "";
    expect(line).toContain("exec /bin/sh -c ");
    expect(line).toContain("a b");
    expect(line).toContain("c/agy");
    expect(line).toContain("zerosub login pid");
    expect(line).toContain("zerosub login status");
    expect(line).toContain("--print");
    expect(line).toContain("zs_status=$?");
  });

  it("quotes shell words without allowing interpolation", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
  });

  it("builds a macOS BSD script(1) command without shell re-parsing the arguments", () => {
    const command = buildLoginScriptCommand(
      "darwin",
      "/opt/homebrew/bin/agy",
      ["--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"],
      paths,
    );
    expect(command.command).toBe("/usr/bin/script");
    expect(command.args.slice(0, 5)).toEqual(["-q", "-p", "/dev/null", "/bin/sh", "-c"]);
    const wrapper = command.args[5] ?? "";
    expect(wrapper).toContain("$ZEROSUB_AGY_LOGIN_PID");
    expect(wrapper).toContain("$ZEROSUB_AGY_LOGIN_STATUS");
    expect(wrapper).toContain('"$0" "$@"');
    expect(command.args[6]).toBe("/opt/homebrew/bin/agy");
    expect(command.args.slice(7)).toEqual([
      "--print",
      "/usage",
      "--output-format",
      "json",
      "--log-file",
      "/dev/null",
    ]);
    expect(command.args).not.toContain("-E");
  });

  it("refuses unsupported platforms", () => {
    expect(() => buildLoginScriptCommand("win32", "agy", [], paths)).toThrow(/Linux and macOS/);
  });

  it("preserves the real TERM_PROGRAM and does not fabricate one", () => {
    const withTerminal = antigravityLoginEnv(
      { TERM: "xterm-256color", TERM_PROGRAM: "Paseo", SSH_CONNECTION: "real ssh" },
      paths,
    );
    expect(withTerminal.TERM_PROGRAM).toBe("Paseo");
    expect(withTerminal.SSH_CONNECTION).toBe("real ssh");
    expect(withTerminal.TERM).toBe("xterm-256color");
    expect(withTerminal.SHELL).toBe("/bin/sh");
    expect(withTerminal.BROWSER).toBe("/usr/bin/false");
    expect(withTerminal.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(withTerminal.ZEROSUB_AGY_LOGIN_PID).toBe(paths.pid);
    expect(withTerminal.ZEROSUB_AGY_LOGIN_STATUS).toBe(paths.status);

    const daemonWithoutTerminalProgram = antigravityLoginEnv({}, paths);
    expect(daemonWithoutTerminalProgram.TERM_PROGRAM).toBeUndefined();
    expect("TERM_PROGRAM" in daemonWithoutTerminalProgram).toBe(false);
    expect(daemonWithoutTerminalProgram.TERM).toBe("xterm-256color");
    expect(daemonWithoutTerminalProgram.SSH_CONNECTION).toBe("127.0.0.1 1 127.0.0.1 1");
    expect(antigravityLoginEnv({ TERM: "bad\nterm" }, paths).TERM).toBe("xterm-256color");
  });

  it("detects a split secondary device-attributes query", () => {
    expect(asksForDa2("\x1b[>0;1;2c")).toBe(true);
    expect(asksForDa2(`${"\x1b[>"}c`)).toBe(true);
    expect(asksForDa2("\x1b[>")).toBe(false);
    expect(asksForDa2("\x1b[>0;1;2")).toBe(false);
  });

  it("surfaces only an exact Google OAuth consent URL", () => {
    expect(
      antigravityAuthUrl("Open https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=s1)."),
    ).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=s1");
    expect(antigravityAuthUrl("https://accounts.google.com/signin/oauth/consent?client_id=abc")).toBe(
      "https://accounts.google.com/signin/oauth/consent?client_id=abc",
    );
    for (const text of [
      "https://accounts.google.com.evil.test/o/oauth2/v2/auth?client_id=abc",
      "https://myaccount.google.com/",
      "http://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
      "https://antigravity.google/docs",
      "https://accounts.google.com/",
      "https://accounts.google.com/docs?client_id=abc",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://other@accounts.google.com/o/oauth2/v2/auth?client_id=abc",
      "https://accounts.google.com:4443/o/oauth2/v2/auth?client_id=abc",
      "4/0AbCdEf-not-a-url",
    ]) {
      expect(antigravityAuthUrl(text)).toBeNull();
    }
  });
});

describe("Antigravity non-secret identity claims", () => {
  function idToken(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `header.${payload}.signature`;
  }

  async function writeCredential(home: string, value: unknown, mode = 0o600): Promise<string> {
    const directory = join(home, ".gemini", "antigravity-cli");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "antigravity-oauth-token");
    await writeFile(path, JSON.stringify(value), { mode });
    return path;
  }

  it("extracts email and subject from a nested token without returning any token", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-antigravity-claims-"));
    try {
      await writeCredential(home, {
        token: {
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          email: "Display.User@Example.com",
          id_token: idToken({ email: "Claim.User@Example.com", sub: "google-sub-123" }),
        },
      });
      const claims = await readAntigravityIdentityClaims(home);
      expect(claims).toEqual({ email: "Display.User@Example.com", subject: "google-sub-123" });
      expect(antigravityIdentityKey(claims!)).toBe("antigravity|sub|google-sub-123");
      const serialized = JSON.stringify(claims);
      expect(serialized).not.toContain("synthetic-access-token");
      expect(serialized).not.toContain("synthetic-refresh-token");
      expect(serialized).not.toContain("signature");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to an email claim and returns null when neither claim exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-antigravity-claims-"));
    try {
      await writeCredential(home, { email: "Only.Email@Example.com" });
      expect(await readAntigravityIdentityClaims(home)).toEqual({
        email: "Only.Email@Example.com",
        subject: null,
      });
      expect(antigravityIdentityKey({ email: "Only.Email@Example.com", subject: null })).toBe(
        "antigravity|email|only.email@example.com",
      );

      await writeCredential(home, { access_token: "synthetic-access-token" });
      expect(await readAntigravityIdentityClaims(home)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reads the CLI's id_token_email field when no ID token is present", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-antigravity-claims-"));
    try {
      await writeCredential(home, {
        token: { token_type: "Bearer" },
        auth_method: "oauth",
        id_token_email: "Profile.Email@Example.com",
      });
      const claims = await readAntigravityIdentityClaims(home);
      expect(claims).toEqual({ email: "Profile.Email@Example.com", subject: null });
      expect(antigravityIdentityKey(claims!)).toBe("antigravity|email|profile.email@example.com");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a non-private or symlinked credential file", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-antigravity-claims-"));
    const outside = await mkdtemp(join(tmpdir(), "zerosub-antigravity-outside-"));
    try {
      await writeCredential(home, { email: "Private@Example.com" }, 0o644);
      expect(await readAntigravityIdentityClaims(home)).toBeNull();

      const target = join(outside, "token");
      await writeFile(target, JSON.stringify({ email: "Outside@Example.com" }), { mode: 0o600 });
      const credential = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      await rm(credential, { force: true });
      await symlink(target, credential);
      expect(await readAntigravityIdentityClaims(home)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
