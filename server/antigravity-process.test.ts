import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityAdapter } from "./antigravity";
import type { LoginHandle } from "./adapter";
import { run } from "./process";

const cli = vi.hoisted(() => ({ command: "", prefix: [] as string[], mainHome: "/home/example" }));

vi.mock("./binaries", () => ({
  providerCommand: async () => ({ command: cli.command, prefix: cli.prefix }),
}));

vi.mock("./process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process")>();
  return { ...actual, run: vi.fn(actual.run) };
});

vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    mainAntigravityHome: () => cli.mainHome,
    antigravityCredentialPath: (home: string | null) =>
      joinPath(home ?? cli.mainHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  };
});

vi.mock("./homes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./homes")>();
  return { ...actual, prepareAntigravityHome: async () => undefined };
});

const SUCCESS_RESPONSE = {
  status: "SUCCESS",
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.5,
              reset_time: "2026-10-30T00:42:59Z",
            },
          ],
        },
      ],
    },
  },
};

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function writeCli(source: string): Promise<string> {
  const directory = await tempDir("zerosub-antigravity-cli-");
  const path = join(directory, "agy");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

function successSource(): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(SUCCESS_RESPONSE))});`;
}

interface FakeLoginOptions {
  behavior?: "success" | "sleep" | "secret" | "large" | "large-after";
  codeFile?: string;
  pidFile?: string;
  da2File?: string;
}

function loginSource(options: FakeLoginOptions = {}): string {
  const behavior = options.behavior ?? "success";
  const codeFile = options.codeFile ? JSON.stringify(options.codeFile) : "null";
  const pidFile = options.pidFile ? JSON.stringify(options.pidFile) : "null";
  const da2File = options.da2File ? JSON.stringify(options.da2File) : "null";
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("--log-file")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(SUCCESS_RESPONSE))});
  process.exit(0);
}
const pidFile = ${pidFile};
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const tty = fs.openSync("/dev/tty", "r+");
const codeFile = ${codeFile};
const da2File = ${da2File};
const behavior = ${JSON.stringify(behavior)};
function sleepForever() {
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
function prompt() {
  if (behavior === "secret") {
    fs.writeSync(tty, "SECRET_TOKEN=do-not-expose\\n");
    process.exit(1);
  }
  if (behavior === "large") {
    const chunk = "x".repeat(4096);
    for (let i = 0; i < 16; i += 1) fs.writeSync(tty, chunk);
    setTimeout(() => {}, 30000);
    return;
  }
  fs.writeSync(tty, "Visit https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=s1\\nEnter authorization code: ");
  if (behavior === "sleep") {
    sleepForever();
    return;
  }
  const buffer = Buffer.alloc(512);
  const n = fs.readSync(tty, buffer, 0, buffer.length, null);
  const code = buffer.toString("utf8", 0, n).trim();
  if (codeFile) fs.writeFileSync(codeFile, code + "\\n");
  if (behavior === "large-after") {
    for (let i = 0; i < 16; i += 1) fs.writeSync(tty, "x".repeat(4096));
    sleepForever();
    return;
  }
  const home = process.env.HOME;
  const directory = home + "/.gemini/antigravity-cli";
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(directory + "/antigravity-oauth-token", "synthetic-token", { mode: 0o600 });
  fs.writeSync(tty, "SIGNED IN\\n");
  process.exit(0);
}
if (da2File) {
  fs.writeSync(tty, "\\u001b[>");
  setTimeout(() => {
    fs.writeSync(tty, "1;10");
    setTimeout(() => {
      fs.writeSync(tty, "c");
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      let reply = "";
      const replyBuffer = Buffer.alloc(64);
      const deadline = Date.now() + 2000;
      while (!reply.includes("c") && Date.now() < deadline) {
        const n = fs.readSync(tty, replyBuffer, 0, replyBuffer.length, null);
        if (n <= 0) break;
        reply += replyBuffer.toString("utf8", 0, n);
      }
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      fs.writeFileSync(da2File, reply);
      prompt();
    }, 30);
  }, 30);
} else {
  prompt();
}
`;
}

async function managedHome(): Promise<string> {
  const home = join(await tempDir("zerosub-antigravity-login-home-"), "home");
  await new AntigravityAdapter().prepareHome(home);
  return home;
}

async function writeCredential(home: string, value: unknown, mode = 0o600): Promise<string> {
  const directory = join(home, ".gemini", "antigravity-cli");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "antigravity-oauth-token");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
  return path;
}

async function waitFor<T>(read: () => T | null | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the sign-in");
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => null);
    if (value !== null && value !== "") return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the sign-in file");
}

async function waitForGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the sign-in process is still running");
}

const originalTermProgram = process.env.TERM_PROGRAM;

afterEach(async () => {
  cli.command = "";
  cli.prefix = [];
  cli.mainHome = "/home/example";
  delete process.env.ZEROSUB_ANTIGRAVITY_MARKER;
  delete process.env.ZEROSUB_ANTIGRAVITY_COUNTER;
  if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
  else process.env.TERM_PROGRAM = originalTermProgram;
  vi.mocked(run).mockClear();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("Antigravity quota process", () => {
  it("runs the CLI and reads its group buckets", async () => {
    cli.command = await writeCli(successSource());
    const usage = await new AntigravityAdapter().usage(null);

    expect(usage.error).toBeNull();
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]).toMatchObject({
      id: "gemini-weekly",
      usedPercent: 50,
      period: "weekly",
      resetsAt: "2026-10-30T00:42:59.000Z",
      scope: { id: "gemini-models", label: "Gemini Models", models: [] },
    });
  });

  it("refuses a conflicting wrapper prefix before spawning the CLI", async () => {
    const marker = join(await tempDir("zerosub-antigravity-marker-"), "ran");
    process.env.ZEROSUB_ANTIGRAVITY_MARKER = marker;
    cli.command = await writeCli('require("node:fs").writeFileSync(process.env.ZEROSUB_ANTIGRAVITY_MARKER, "ran");');
    cli.prefix = ["--disable-slash-commands"];

    const usage = await new AntigravityAdapter().usage(null);
    expect(usage.error).toContain("conflicts");
    await expect(access(marker)).rejects.toThrow();

    cli.prefix = ["--print"];
    const availability = await new AntigravityAdapter().available();
    expect(availability.ok).toBe(false);
    expect(availability.detail).toContain("conflicts");
    await expect(access(marker)).rejects.toThrow();

    // A bare positional could be an old wrapper's prompt, so it is rejected too.
    cli.prefix = ["hello"];
    const positional = await new AntigravityAdapter().usage(null);
    expect(positional.error).toContain("conflicts");
    await expect(access(marker)).rejects.toThrow();

    // A combined short print flag must not sneak a prompt into the quota read.
    cli.prefix = ["-pdo-not-run-this"];
    const combined = await new AntigravityAdapter().usage(null);
    expect(combined.error).toContain("conflicts");
    await expect(access(marker)).rejects.toThrow();
  });

  it("allows a harmless prefix flag with its separate value", async () => {
    cli.command = await writeCli(successSource());
    cli.prefix = ["--add-dir", "/tmp"];
    const usage = await new AntigravityAdapter().usage(null);
    expect(usage.error).toBeNull();
    expect(usage.windows).toHaveLength(1);
  });

  it("keeps stderr and credential-like values out of errors", async () => {
    cli.command = await writeCli('process.stderr.write("SECRET_TOKEN=abc\\n"); process.exit(1);');
    const usage = await new AntigravityAdapter().usage(null);

    expect(usage.windows).toEqual([]);
    expect(usage.error).toBe("Antigravity's usage check didn't finish.");
    expect(JSON.stringify(usage)).not.toContain("SECRET_TOKEN");
  });

  it("rejects unreadable and empty responses", async () => {
    cli.command = await writeCli('process.stdout.write("not json");');
    expect((await new AntigravityAdapter().usage(null)).error).toBe(
      "Antigravity returned an unreadable usage response.",
    );

    cli.command = await writeCli("process.exit(0);");
    expect((await new AntigravityAdapter().usage(null)).error).toBe("Antigravity returned an empty usage response.");
  });

  it("rejects a response that ran a model turn", async () => {
    cli.command = await writeCli(
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ...SUCCESS_RESPONSE, num_turns: 1 }))});`,
    );
    const usage = await new AntigravityAdapter().usage(null);
    expect(usage.windows).toEqual([]);
    expect(usage.error).toContain("model turn");
  });

  it("verifies a sign-in with a successful quota read without inventing identity", async () => {
    cli.command = await writeCli(successSource());
    expect(await new AntigravityAdapter().identity(null)).toEqual({
      signedIn: true,
      email: null,
      plan: null,
      organization: null,
      identity: null,
    });
  });

  it("allows a main login's dotfiles directory link while refusing a linked token", async () => {
    cli.mainHome = await tempDir("zerosub-antigravity-main-home-");
    const dotfiles = await tempDir("zerosub-antigravity-dotfiles-");
    const directory = join(dotfiles, "antigravity-cli");
    const credential = join(directory, "antigravity-oauth-token");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(credential, JSON.stringify({ email: "main@example.com" }), { mode: 0o600 });
    await symlink(dotfiles, join(cli.mainHome, ".gemini"), "dir");
    cli.command = await writeCli(successSource());
    const adapter = new AntigravityAdapter();

    expect((await adapter.usage(null)).error).toBeNull();
    await expect(adapter.identity(null)).resolves.toMatchObject({
      signedIn: true,
      email: "main@example.com",
      identity: "antigravity|email|main@example.com",
    });

    const target = join(dotfiles, "linked-token");
    await writeFile(target, "synthetic-token", { mode: 0o600 });
    await rm(credential);
    await symlink(target, credential);
    await expect(adapter.identity(null)).rejects.toThrow(/isn't safe/);
    expect((await adapter.usage(null)).windows).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("synthetic-token");
  });

  it("leaves an account's state alone when the CLI cannot verify its sign-in", async () => {
    cli.command = await writeCli('process.stderr.write("SECRET\\n"); process.exit(1);');
    try {
      await new AntigravityAdapter().identity(null);
      throw new Error("expected identity to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "unsuccessful" });
      expect((error as Error).message).toBe("Antigravity's usage check didn't finish.");
      expect((error as Error).message).not.toContain("SECRET");
    }
  });

  it("reports availability without leaking version output", async () => {
    cli.command = await writeCli("process.exit(0);");
    expect(await new AntigravityAdapter().available()).toEqual({ ok: true, detail: null });

    cli.command = await writeCli('process.stderr.write("SECRET\\n"); process.exit(1);');
    const availability = await new AntigravityAdapter().available();
    expect(availability).toEqual({ ok: false, detail: "Antigravity CLI didn't respond to --version." });
    expect(JSON.stringify(availability)).not.toContain("SECRET");
  });

  it("shares one read between identity and usage", async () => {
    const counter = join(await tempDir("zerosub-antigravity-count-"), "count");
    process.env.ZEROSUB_ANTIGRAVITY_COUNTER = counter;
    cli.command = await writeCli(
      `require("node:fs").appendFileSync(process.env.ZEROSUB_ANTIGRAVITY_COUNTER, "x"); ${successSource()}`,
    );

    const adapter = new AntigravityAdapter();
    await adapter.identity(null);
    await adapter.usage(null);
    expect(await readFile(counter, "utf8")).toBe("x");
  });

  it("reports a managed home with no credential as signed out without launching the CLI", async () => {
    const home = await managedHome();
    const adapter = new AntigravityAdapter();
    vi.mocked(run).mockClear();
    await expect(adapter.identity(home)).resolves.toEqual({
      signedIn: false,
      email: null,
      plan: null,
      organization: null,
      identity: null,
    });
    expect(vi.mocked(run)).not.toHaveBeenCalled();
  });

  it("rejects a managed home without a private credential before native usage", async () => {
    const home = await managedHome();
    const adapter = new AntigravityAdapter();
    vi.mocked(run).mockClear();
    await expect(adapter.env(home)).rejects.toThrow(/private sign-in/);
    const usage = await adapter.usage(home);
    expect(usage.windows).toEqual([]);
    expect(usage.error).toContain("private sign-in");
    expect(vi.mocked(run)).not.toHaveBeenCalled();
  });

  it("keeps a present credential's quota failure unknown instead of signed out", async () => {
    const home = await managedHome();
    await writeCredential(home, "synthetic-token");
    cli.command = await writeCli('process.stderr.write("SECRET\\n"); process.exit(1);');
    await expect(new AntigravityAdapter().identity(home)).rejects.toThrow(
      "Antigravity's usage check didn't finish.",
    );
  });

  it("clears API-key/ADC environment for a managed home and reads non-secret claims", async () => {
    const home = await managedHome();
    const claims = Buffer.from(JSON.stringify({ email: "Claim.User@Example.com", sub: "sub-42" })).toString("base64url");
    await writeCredential(home, {
      token: {
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        id_token: `header.${claims}.signature`,
      },
    });
    cli.command = await writeCli(successSource());
    const adapter = new AntigravityAdapter();

    await expect(adapter.env(home)).resolves.toMatchObject({
      HOME: home,
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GOOGLE_GENAI_API_KEY: "",
      GOOGLE_GEMINI_BASE_URL: "",
      GEMINI_BASE_URL: "",
      AGY_ADC_AUTH: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
      GEMINI_HOME: "",
    });
    const identity = await adapter.identity(home);
    expect(identity).toMatchObject({
      signedIn: true,
      email: "Claim.User@Example.com",
      identity: "antigravity|sub|sub-42",
    });
    expect(JSON.stringify(identity)).not.toContain("synthetic-access-token");
    expect(JSON.stringify(identity)).not.toContain("synthetic-refresh-token");
  });

  it("rejects a credential symlink before preparing or using a managed home", async () => {
    const home = await managedHome();
    const outside = await tempDir("zerosub-antigravity-link-target-");
    const target = join(outside, "token");
    await writeFile(target, "keep", { mode: 0o600 });
    const credential = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    await symlink(target, credential);
    const adapter = new AntigravityAdapter();

    await expect(adapter.prepareHome(home)).rejects.toThrow(/symlink/);
    await expect(adapter.env(home)).rejects.toThrow(/private/);
    await expect(adapter.identity(home)).rejects.toThrow(/isn't safe/);
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  it("never returns a cached managed reading after its credential disappears", async () => {
    const home = await managedHome();
    const credential = await writeCredential(home, "synthetic-token");
    cli.command = await writeCli(successSource());
    const adapter = new AntigravityAdapter();
    expect((await adapter.usage(home)).windows).toHaveLength(1);
    await rm(credential, { force: true });
    const after = await adapter.usage(home);
    expect(after.windows).toEqual([]);
    expect(after.error).toContain("private sign-in");
    await expect(adapter.identity(home)).resolves.toMatchObject({ signedIn: false });
  });

  it("does not let a pre-login read refill the cache after invalidation", async () => {
    const home = await managedHome();
    await writeCredential(home, "synthetic-token");
    vi.mocked(run).mockClear();
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resolveFirst!: (value: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => void;
    vi.mocked(run).mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });
    vi.mocked(run).mockImplementationOnce(async () => ({
      code: 0,
      stdout: JSON.stringify(SUCCESS_RESPONSE),
      stderr: "",
      timedOut: false,
    }));
    const adapter = new AntigravityAdapter();
    const first = adapter.usage(home);
    await runStarted;
    await adapter.prepareHome(home);
    resolveFirst({ code: 0, stdout: JSON.stringify(SUCCESS_RESPONSE), stderr: "", timedOut: false });
    await first;

    const second = await adapter.usage(home);
    expect(second.windows).toHaveLength(1);
    expect(vi.mocked(run).mock.calls.length).toBe(2);
  });

  it.skipIf(process.platform !== "linux")(
    "completes the official PTY code flow without TERM_PROGRAM and negotiates DA2",
    async () => {
      const home = await managedHome();
      const artifacts = await tempDir("zerosub-antigravity-login-artifacts-");
      const codeFile = join(artifacts, "code");
      const da2File = join(artifacts, "da2");
      const previousTerm = process.env.TERM_PROGRAM;
      delete process.env.TERM_PROGRAM;
      cli.command = await writeCli(loginSource({ codeFile, da2File }));
      const adapter = new AntigravityAdapter({ loginTimeoutMs: 10_000, loginKillGraceMs: 200 });
      vi.mocked(run).mockClear();
      let handle: LoginHandle | null = null;
      try {
        handle = await adapter.login(home, "code");
        const codeUrl = await waitFor(() => handle?.progress.codeUrl);
        expect(new URL(codeUrl).hostname).toBe("accounts.google.com");
        await handle.submitCode("fake-code-123");
        await expect(handle.finished).resolves.toEqual({ ok: true, message: null });
        expect(handle.progress.step).toBe("done");
        expect(JSON.stringify(handle.progress)).not.toContain("fake-code-123");
        const code = await readFile(codeFile, "utf8");
        expect(code.trim()).toBe("fake-code-123");
        expect(code).not.toContain("\x1b[>");
        const da2 = await readFile(da2File, "utf8");
        expect(da2).toContain("\x1b[>1;10;0c");
        expect(da2).not.toContain("fake-code-123");
        const credential = await lstat(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
        expect(credential.isFile()).toBe(true);
        expect(credential.mode & 0o077).toBe(0);
        // Service's final identity check and usage share the fresh post-login verification.
        expect(vi.mocked(run).mock.calls.length).toBe(1);
        await adapter.identity(home);
        await adapter.usage(home);
        expect(vi.mocked(run).mock.calls.length).toBe(1);
      } finally {
        handle?.cancel();
        if (previousTerm === undefined) delete process.env.TERM_PROGRAM;
        else process.env.TERM_PROGRAM = previousTerm;
      }
    },
  );

  it.skipIf(process.platform !== "linux")("cancels the PTY process group", async () => {
    const home = await managedHome();
    const pidFile = join(await tempDir("zerosub-antigravity-pid-"), "pid");
    cli.command = await writeCli(loginSource({ behavior: "sleep", pidFile }));
    const adapter = new AntigravityAdapter({ loginTimeoutMs: 30_000, loginKillGraceMs: 100 });
    let handle: LoginHandle | null = null;
    try {
      handle = await adapter.login(home, "code");
      await waitFor(() => handle?.progress.codeUrl);
      const pid = Number((await waitForFile(pidFile)).trim());
      handle.cancel();
      await expect(handle.finished).resolves.toEqual({ ok: false, message: "Sign-in was canceled." });
      await waitForGone(pid);
    } finally {
      handle?.cancel();
    }
  });

  it.skipIf(process.platform !== "linux")("cancels immediately before the wrapper PID is available", async () => {
    const home = await managedHome();
    const pidFile = join(await tempDir("zerosub-antigravity-early-cancel-"), "pid");
    cli.command = await writeCli(loginSource({ behavior: "sleep", pidFile }));
    const handle = await new AntigravityAdapter({ loginTimeoutMs: 30_000, loginKillGraceMs: 100 }).login(home, "code");
    const scriptPid = (handle as unknown as { child: { pid: number } }).child.pid;
    const kill = vi.spyOn(process, "kill");
    try {
      // No await: the wrapper has not run or written its PID yet.
      handle.cancel();
      expect(kill).toHaveBeenCalledWith(-scriptPid, "SIGTERM");
      await expect(handle.finished).resolves.toEqual({ ok: false, message: "Sign-in was canceled." });
      await waitForGone(scriptPid);
      // A child that did start during cancellation must also be gone after the kill grace.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const nativePid = await readFile(pidFile, "utf8").catch(() => null);
      if (nativePid) await waitForGone(Number(nativePid));
    } finally {
      kill.mockRestore();
      handle.cancel();
    }
  });

  it.skipIf(process.platform !== "linux")("times out and kills the PTY process group", async () => {
    const home = await managedHome();
    const pidFile = join(await tempDir("zerosub-antigravity-pid-"), "pid");
    cli.command = await writeCli(loginSource({ behavior: "sleep", pidFile }));
    const adapter = new AntigravityAdapter({ loginTimeoutMs: 800, loginKillGraceMs: 100 });
    let handle: LoginHandle | null = null;
    try {
      handle = await adapter.login(home, "code");
      await expect(handle.finished).resolves.toEqual({
        ok: false,
        message: "Sign-in timed out. Try again.",
      });
      const pid = Number((await waitForFile(pidFile)).trim());
      await waitForGone(pid);
    } finally {
      handle?.cancel();
    }
  });

  it.skipIf(process.platform !== "linux")("does not expose a PTY secret in progress or errors", async () => {
    const home = await managedHome();
    cli.command = await writeCli(loginSource({ behavior: "secret" }));
    const handle = await new AntigravityAdapter({ loginTimeoutMs: 5_000 }).login(home, "code");
    try {
      const result = await handle.finished;
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("SECRET_TOKEN");
      expect(JSON.stringify(handle.progress)).not.toContain("SECRET_TOKEN");
    } finally {
      handle.cancel();
    }
  });

  it.skipIf(process.platform !== "linux")("bounds PTY output and fails closed", async () => {
    const home = await managedHome();
    cli.command = await writeCli(loginSource({ behavior: "large" }));
    const handle = await new AntigravityAdapter({
      loginTimeoutMs: 5_000,
      loginKillGraceMs: 100,
      loginOutputLimitBytes: 1_024,
    }).login(home, "code");
    try {
      await expect(handle.finished).resolves.toEqual({
        ok: false,
        message: "Sign-in output was too large. Try again.",
      });
    } finally {
      handle.cancel();
    }
  });

  it.skipIf(process.platform !== "linux")("keeps the output bound after code capture has stopped", async () => {
    const home = await managedHome();
    const pidFile = join(await tempDir("zerosub-antigravity-after-code-"), "pid");
    cli.command = await writeCli(loginSource({ behavior: "large-after", pidFile }));
    const handle = await new AntigravityAdapter({ loginTimeoutMs: 5_000, loginKillGraceMs: 100, loginOutputLimitBytes: 2048 }).login(home, "code");
    try {
      await waitFor(() => handle.progress.codeUrl);
      const pid = Number((await waitForFile(pidFile)).trim());
      await handle.submitCode("synthetic-code");
      await expect(handle.finished).resolves.toEqual({ ok: false, message: "Sign-in output was too large. Try again." });
      expect(JSON.stringify(handle.progress)).not.toContain("synthetic-code");
      await waitForGone(pid);
    } finally {
      handle.cancel();
    }
  });

  it.skipIf(process.platform !== "linux")("rejects the browser method for a code-only flow", async () => {
    await expect(new AntigravityAdapter().login(null, "browser")).rejects.toThrow(/code flow/);
  });

  it("removes only the managed account's credential file", async () => {
    const paseo = await tempDir("zerosub-paseo-");
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = paseo;
    const home = join(paseo, "zerosub", "homes", "antigravity-test");
    const credential = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
    await writeFile(credential, "synthetic-token-not-read", { mode: 0o600 });
    await writeFile(join(home, "keep.txt"), "keep");

    try {
      await new AntigravityAdapter().logout(home);
      await expect(access(credential)).rejects.toThrow();
      expect(await readFile(join(home, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
    }
  });

  it("refuses to remove credentials outside a managed home", async () => {
    const outside = await tempDir("zerosub-antigravity-outside-");
    await expect(new AntigravityAdapter().logout(outside)).rejects.toThrow(/managed home/);
  });

  it("does not follow a symlinked credential out of the account home", async () => {
    const paseo = await tempDir("zerosub-paseo-");
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = paseo;
    const home = join(paseo, "zerosub", "homes", "antigravity-link");
    const outside = await tempDir("zerosub-antigravity-target-");
    const targetDirectory = join(outside, "antigravity-cli");
    const target = join(targetDirectory, "antigravity-oauth-token");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(target, "keep-me", { mode: 0o600 });
    await mkdir(home, { recursive: true });
    await symlink(outside, join(home, ".gemini"), "dir");

    try {
      await expect(new AntigravityAdapter().logout(home)).rejects.toThrow(/account home/);
      expect(await readFile(target, "utf8")).toBe("keep-me");
    } finally {
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
    }
  });

  it("reports a bounded timeout without leaking its stderr", async () => {
    vi.mocked(run).mockImplementationOnce(async () => ({
      code: null,
      stdout: "",
      stderr: "SECRET_TIMEOUT_DETAIL",
      timedOut: true,
    }));
    const usage = await new AntigravityAdapter().usage(null);
    expect(usage.windows).toEqual([]);
    expect(usage.error).toBe("Antigravity's usage check timed out.");
    expect(JSON.stringify(usage)).not.toContain("SECRET_TIMEOUT_DETAIL");
  });
});
