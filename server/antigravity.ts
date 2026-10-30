import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { LoginMethod, Usage, UsageWindow } from "../shared/model";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LimitHit,
  type LoginHandle,
  type RedeemReply,
  type TurnEvent,
} from "./adapter";
import { providerCommand } from "./binaries";
import { prepareAntigravityHome } from "./homes";
import { antigravityCredentialPath, homesDir, mainAntigravityHome } from "./paths";
import { run, stripAnsi } from "./process";

/** `--print /usage` normally takes a few seconds; this bounds a stuck CLI or network. */
const QUOTA_TIMEOUT_MS = 45_000;
/** Two reads inside this window usually belong to the same account refresh (identity + usage). */
const QUOTA_CACHE_MS = 30_000;

/** The official CLI's login flow is interactive; this is the outer bound for an abandoned sign-in. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long a canceled/timed-out PTY gets before its process group is killed outright. */
const LOGIN_KILL_GRACE_MS = 2_000;
/** A PTY login should print a URL and a prompt; more output than this is treated as a failure. */
const LOGIN_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
/** Only this much recent PTY output is kept for URL detection. */
const LOGIN_BUFFER_BYTES = 64 * 1024;
/** The operating system PTY helper; both Linux util-linux and macOS BSD provide it here. */
const LOGIN_SCRIPT_PATH = "/usr/bin/script";
/** Environment variables the macOS wrapper uses to find its private status files. */
const LOGIN_PID_ENV = "ZEROSUB_AGY_LOGIN_PID";
const LOGIN_STATUS_ENV = "ZEROSUB_AGY_LOGIN_STATUS";
/** A loopback SSH marker asks the CLI for its own code flow instead of a localhost callback. */
const LOGIN_LOOPBACK_SSH = "127.0.0.1 1 127.0.0.1 1";
/** Only the official Google OAuth consent host may be surfaced as `codeUrl`. */
const LOGIN_AUTH_HOST = "accounts.google.com";
/** Non-secret identity claims are read from a private, regular credential file. */
const IDENTITY_READ_LIMIT_BYTES = 64 * 1024;
const IDENTITY_JWT_LIMIT_CHARS = 16 * 1024;

/**
 * `scope` is the model group a bucket applies to. The UI keeps the group hierarchy, and routing can
 * later pick the windows for the model it is about to use. `period` is the CLI's own window key
 * (`5h`, `weekly`, …), preserved so a group can show both its short and weekly limits.
 */
export interface AntigravityScope {
  /** Stable key derived from the CLI's group name; the response carries no group ID of its own. */
  id: string;
  label: string;
  models: string[];
}

export type AntigravityUsageWindow = UsageWindow & {
  scope: AntigravityScope;
  period: string;
};

export interface AntigravityUsage extends Usage {
  windows: AntigravityUsageWindow[];
}

export type AntigravityQuotaErrorCode =
  | "model_turn"
  | "invalid_response"
  | "duplicate_id"
  | "no_windows"
  | "timed_out"
  | "unsuccessful"
  | "unavailable";

/** A failure that is safe to show to the user: it never carries CLI output, paths or credentials. */
export class AntigravityQuotaError extends Error {
  constructor(
    readonly code: AntigravityQuotaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AntigravityQuotaError";
  }
}

/** Exact bucket IDs observed from native `agy 1.4.6`; anything else is kept as an unknown group. */
const KNOWN_BUCKETS: Record<string, { group: string }> = {
  "gemini-weekly": { group: "Gemini Models" },
  "gemini-5h": { group: "Gemini Models" },
  "3p-weekly": { group: "Claude and GPT models" },
  "3p-5h": { group: "Claude and GPT models" },
  "gemini-argon-wtu-weekly": { group: "Gemini 4 Argon" },
};

const KNOWN_GROUPS: Record<string, string> = {
  "Gemini Models": "gemini-models",
  "Claude and GPT models": "claude-and-gpt-models",
  "Gemini 4 Argon": "gemini-4-argon",
};

/**
 * Deliberately empty: the exact `agy models` IDs for these groups were not verified without using
 * an account, so quota windows must not claim a model scope they cannot prove. The UI and routing
 * still show the group; only automatic per-model selection stays off until a real mapping exists.
 */
const VERIFIED_MODELS: Record<string, readonly string[]> = {};

/** Experimental mapping inferred from one observed limit, not an official model contract. */
export const EXPERIMENTAL_LIMIT_MODEL = "claude-opus-5-5-high";
export const EXPERIMENTAL_LIMIT_SCOPE = "claude-and-gpt-models";
export const EXPERIMENTAL_LIMIT_BUCKETS = ["3p-5h", "3p-weekly"] as const;
const OBSERVED_LIMIT = /^Individual quota reached\. Please upgrade your subscription to increase your limits\. Resets in (?:\d+[hms])+\.$/;

/** Apply the observed mapping locally, without presenting it as verified provider metadata. */
export function experimentalAntigravityBalanceUsage(model: string | null, usage: Usage): Usage | null {
  if (model !== EXPERIMENTAL_LIMIT_MODEL) return null;
  return {
    ...usage,
    windows: usage.windows.map((window) => window.scope?.id === EXPERIMENTAL_LIMIT_SCOPE
      ? { ...window, scope: { ...window.scope, models: [...new Set([...window.scope.models, model])] } }
      : window),
  };
}

export function isExperimentalAntigravityLimit(event: TurnEvent, model: string | null): boolean {
  if (!event.turnId || event.outcome.kind !== "failed" || model !== EXPERIMENTAL_LIMIT_MODEL ||
      !OBSERVED_LIMIT.test(event.outcome.error.message)) return false;
  const error = event.outcome.error as { scope?: unknown };
  return error.scope === undefined || error.scope === EXPERIMENTAL_LIMIT_SCOPE;
}

/**
 * Prepare a scoped detection for the future automatic path. The caller must independently bind
 * this event and usage to the same actual session account and prevent stale or duplicate turns.
 * This helper does not enable failover or change the general usage model mapping.
 */
export function experimentalAntigravityLimit(
  event: TurnEvent,
  model: string | null,
  usage: Usage | null,
  now: number,
): LimitHit | null {
  if (!isExperimentalAntigravityLimit(event, model) || event.outcome.kind !== "failed" || !usage || usage.cached || usage.error !== null ||
      !Number.isFinite(now)) return null;
  const fetchedAt = Date.parse(usage.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt > now || now - fetchedAt > 5 * 60_000) return null;
  const windows = usage.windows.filter((window) => window.scope?.id === EXPERIMENTAL_LIMIT_SCOPE);
  if (windows.length !== EXPERIMENTAL_LIMIT_BUCKETS.length ||
      windows.some((window) => !EXPERIMENTAL_LIMIT_BUCKETS.some((id) => id === window.id) ||
        !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) ||
      new Set(windows.map((window) => window.id)).size !== EXPERIMENTAL_LIMIT_BUCKETS.length ||
      !windows.some((window) => window.usedPercent === 100)) return null;
  return { kind: "window", scopeId: EXPERIMENTAL_LIMIT_SCOPE, resetsAt: null, message: event.outcome.error.message };
}

const BucketSchema = z.object({
  id: z.string().min(1).max(160),
  window: z.string().min(1).max(40),
  remaining_fraction: z.number().finite().min(0).max(1),
  reset_time: z.unknown().optional(),
});

const GroupSchema = z.object({
  name: z.string().max(200).optional(),
  buckets: z.array(z.unknown()).max(100),
});

const ResponseSchema = z.object({
  status: z.string(),
  num_turns: z.number().int(),
  command: z.object({
    name: z.string(),
    data: z.object({
      groups: z.array(z.unknown()).max(100),
    }),
  }),
});

function invalidResponse(): AntigravityQuotaError {
  return new AntigravityQuotaError("invalid_response", "Antigravity returned an unexpected usage response.");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Stable group key for an unknown group: its sorted bucket IDs, independent of display order. */
function unknownScopeId(bucketIds: readonly string[]): string {
  const digest = createHash("sha256").update([...new Set(bucketIds)].sort().join("\n")).digest("hex");
  return `group-${digest.slice(0, 12)}`;
}

function knownScopeIds(bucketIds: readonly string[]): string[] {
  const result = new Set<string>();
  for (const id of bucketIds) {
    const known = KNOWN_BUCKETS[id];
    if (!known) continue;
    const scope = KNOWN_GROUPS[known.group];
    if (scope) result.add(scope);
  }
  return [...result].sort();
}

function knownGroupLabel(buckets: readonly unknown[]): string | null {
  for (const raw of buckets) {
    const id = asRecord(raw)?.id;
    if (typeof id !== "string") continue;
    const known = KNOWN_BUCKETS[id];
    if (known) return known.group;
  }
  return null;
}

function periodLabel(period: string): string {
  switch (period.trim().toLowerCase()) {
    case "5h":
    case "5-hour":
      return "5-hour";
    case "weekly":
      return "Weekly";
    case "daily":
      return "Daily";
    case "monthly":
      return "Monthly";
    default:
      return period;
  }
}

/**
 * A reset time is shown only when it has an explicit zone. An unzoned timestamp would otherwise be
 * read in the daemon's local time and could move a limit's reset by hours; an unreadable one is
 * left null, never turned into a made-up future time.
 */
function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Reads the subscription quota from `agy --print /usage --output-format json`.
 *
 * The top-level `usage` object is the token count from the print run, not subscription quota; it is
 * deliberately ignored. A missing or malformed `remaining_fraction` fails the read instead of
 * becoming 0% used. Disabled groups and buckets are skipped, duplicate bucket IDs are rejected, and
 * unknown groups are kept so a new model group does not make the whole reading disappear.
 */
export function parseAntigravityUsage(raw: unknown, options: { fetchedAt?: string } = {}): AntigravityUsage {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  const response = parsed.data;
  if (response.status !== "SUCCESS") {
    throw new AntigravityQuotaError("unsuccessful", "Antigravity's usage command did not succeed.");
  }
  if (response.num_turns !== 0) {
    throw new AntigravityQuotaError("model_turn", "Antigravity's usage command ran a model turn, so its response was ignored.");
  }
  if (response.command.name !== "usage") throw invalidResponse();

  const windows: AntigravityUsageWindow[] = [];
  const usedWindowIds = new Set<string>();

  for (const rawGroup of response.command.data.groups) {
    // Check disabled before validating the rest: a disabled group is allowed to omit buckets.
    if (asRecord(rawGroup)?.disabled === true) continue;
    const groupResult = GroupSchema.safeParse(rawGroup);
    if (!groupResult.success) throw invalidResponse();
    const group = groupResult.data;

    const name = group.name?.trim() ?? "";
    const label = name || knownGroupLabel(group.buckets);
    if (!label) throw invalidResponse();

    // A known bucket ID is the strongest group key. Unknown groups use a deterministic hash of
    // their sorted bucket IDs, so a response that reorders or renames a group keeps the same scope.
    const bucketIds: string[] = [];
    for (const rawBucket of group.buckets) {
      const id = asRecord(rawBucket)?.id;
      if (typeof id === "string" && id.length > 0) bucketIds.push(id);
    }
    const knownScopes = knownScopeIds(bucketIds);
    const scope: AntigravityScope = {
      id: knownScopes.length === 1 ? (knownScopes[0] ?? unknownScopeId(bucketIds)) : unknownScopeId(bucketIds),
      label,
      models: [...(VERIFIED_MODELS[label] ?? [])],
    };

    for (const rawBucket of group.buckets) {
      // Likewise, a disabled bucket need not carry a fraction or other quota fields.
      if (asRecord(rawBucket)?.disabled === true) continue;
      const bucketResult = BucketSchema.safeParse(rawBucket);
      if (!bucketResult.success) throw invalidResponse();
      const bucket = bucketResult.data;
      if (usedWindowIds.has(bucket.id)) {
        throw new AntigravityQuotaError("duplicate_id", "Antigravity returned duplicate quota window identifiers.");
      }
      usedWindowIds.add(bucket.id);

      const usedPercent = Math.max(0, Math.min(100, (1 - bucket.remaining_fraction) * 100));
      windows.push({
        id: bucket.id,
        // The group is in `scope.label`; the client groups by scope, so the window repeats only its period.
        label: periodLabel(bucket.window),
        usedPercent,
        resetsAt: isoTimestamp(bucket.reset_time),
        scope,
        period: bucket.window,
      });
    }
  }

  if (windows.length === 0) {
    throw new AntigravityQuotaError("no_windows", "Antigravity didn't return any usable usage limits.");
  }
  return {
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    windows,
    error: null,
    cached: false,
    resets: null,
  };
}

/** Options that would turn a quota check into a model turn, a streamed session or a hidden log. */
const CONFLICTING_PREFIX: ReadonlyArray<RegExp> = [
  /^-p/,
  /^--print(?:=|$)/,
  /^--prompt/,
  /^-i/,
  /^-c/,
  /^--continue(?:=|$)/,
  /^--input-format(?:=|$)/,
  /^--output-format(?:=|$)/,
  /^--disable-slash-commands(?:=|$)/,
  /^--model(?:=|$)/,
  /^--conversation(?:=|$)/,
  /^--agent(?:=|$)/,
  /^--mode(?:=|$)/,
  /^--effort(?:=|$)/,
  /^--json-schema(?:=|$)/,
  /^--new-project(?:=|$)/,
  /^--project(?:=|$)/,
  /^--remote-control(?:=|$)/,
  /^--log-file(?:=|$)/,
  /^--help(?:=|$)/,
  /^-h$/,
  /^-$/,
  /^--$/,
];

/** Prefix flags that are harmless for a quota read; only these may take a separate value. */
const VALUE_FLAGS = new Set(["--add-dir", "--print-timeout"]);

function unsafePrefix(): AntigravityQuotaError {
  // The argument itself is not repeated: it came from provider config and may contain a prompt.
  return new AntigravityQuotaError(
    "unavailable",
    "Antigravity's configured command includes an option that conflicts with the usage check.",
  );
}

/**
 * Reject a provider wrapper prefix that could make `--print` behave like a session. Bare positional
 * arguments are refused too: an old or hand-written wrapper may put a prompt there, and the CLI
 * would then run it instead of the quota command.
 */
function assertSafePrefix(prefix: readonly string[]): void {
  let valueExpected = false;
  for (const argument of prefix) {
    if (valueExpected) {
      valueExpected = false;
      continue;
    }
    if (!argument.startsWith("-")) throw unsafePrefix();
    if (CONFLICTING_PREFIX.some((pattern) => pattern.test(argument))) throw unsafePrefix();
    const equals = argument.indexOf("=");
    if (equals < 0 && VALUE_FLAGS.has(argument)) valueExpected = true;
  }
  if (valueExpected) throw unsafePrefix();
}

/** The launch environment for a managed account: its own HOME, XDG roots and file-backed sign-in. */
export function antigravityEnv(home: string, platform: NodeJS.Platform = process.platform): EnvPatch {
  const patch: EnvPatch = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
    TMPDIR: join(home, "tmp"),
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    // Empty strings (not null: null means inherit) force the managed account away from a daemon's
    // API-key, ADC, endpoint or alternate-home environment. The main login (home === null) keeps
    // its original environment.
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GOOGLE_GENAI_API_KEY: "",
    GOOGLE_GEMINI_BASE_URL: "",
    GEMINI_BASE_URL: "",
    AGY_ADC_AUTH: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    GEMINI_HOME: "",
  };
  // An empty value is an explicit empty bus, unlike null (inherit). On Linux this keeps the CLI on
  // its own file credential instead of the desktop Secret Service keyring.
  if (platform === "linux") patch.DBUS_SESSION_BUS_ADDRESS = "";
  return patch;
}

/** Every directory this adapter's environment points at, all private to the account. */
const ANTIGRAVITY_DIRECTORIES = [
  [".gemini"],
  [".gemini", "antigravity-cli"],
  ["config"],
  ["data"],
  ["state"],
  ["cache"],
  ["runtime"],
  ["tmp"],
] as const;

/** Creates a directory private to this home without following a symlink out of it. */
async function ensurePrivateDirectory(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry?.isSymbolicLink()) {
    throw new Error("Refusing to prepare an Antigravity home through a symlink.");
  }
  if (entry && !entry.isDirectory()) throw new Error("An Antigravity home path is not a directory.");
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function isManagedHome(home: string): boolean {
  const root = resolve(homesDir());
  return resolve(home).startsWith(root + sep);
}

function describeQuotaError(error: unknown): string {
  return error instanceof AntigravityQuotaError ? error.message : "Antigravity usage couldn't be read.";
}

function asQuotaError(error: unknown): AntigravityQuotaError {
  return error instanceof AntigravityQuotaError
    ? error
    : new AntigravityQuotaError("unavailable", "Antigravity sign-in couldn't be verified.");
}

/** One POSIX shell word. Used only for the Linux `script -c` command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface LoginScriptPaths {
  pid: string;
  status: string;
}

/**
 * Builds the OS `script(1)` invocation that gives the official CLI a private PTY.
 *
 * Linux util-linux can run a command string directly; macOS BSD `script` has no `-c`, so a small
 * `/bin/sh` wrapper receives the command and its arguments as separate argv entries. Both wrappers
 * write their PID first and the child's exit status last, which gives the adapter a reliable kill
 * target and exit code even where `script` doesn't propagate the child status.
 */
export function buildLoginScriptCommand(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
  paths: LoginScriptPaths,
): { command: string; args: string[] } {
  if (platform === "linux") {
    const invocation = [command, ...args].map(shellQuote).join(" ");
    const inner = [
      `printf '%s' "$$" > ${shellQuote(paths.pid)}`,
      invocation,
      "zs_status=$?",
      `printf '%s' "$zs_status" > ${shellQuote(paths.status)}`,
      'exit "$zs_status"',
    ].join("; ");
    // `script -c` uses the caller's $SHELL. `exec /bin/sh` replaces that shell with POSIX sh while
    // keeping its PID (and thus the PTY process-group leader) for the kill path.
    const commandLine = `exec /bin/sh -c ${shellQuote(inner)}`;
    return {
      command: LOGIN_SCRIPT_PATH,
      args: ["-q", "-e", "-E", "never", "-f", "-c", commandLine, "/dev/null"],
    };
  }
  if (platform === "darwin") {
    const pidVariable = "$" + LOGIN_PID_ENV;
    const statusVariable = "$" + LOGIN_STATUS_ENV;
    const wrapper = [
      `printf '%s' "$$" > "${pidVariable}"`,
      '"$0" "$@"',
      "zs_status=$?",
      `printf '%s' "$zs_status" > "${statusVariable}"`,
      'exit "$zs_status"',
    ].join("\n");
    return {
      command: LOGIN_SCRIPT_PATH,
      args: ["-q", "-p", "/dev/null", "/bin/sh", "-c", wrapper, command, ...args],
    };
  }
  throw new Error("Antigravity sign-in is implemented with the OS script(1) helper on Linux and macOS only.");
}

/**
 * The PTY login environment. `TERM_PROGRAM` is deliberately untouched: the caller's real terminal
 * identity is preserved, never defaulted or borrowed from another terminal. A loopback SSH marker
 * is added only when the daemon isn't already in an SSH session, so the CLI uses its own code flow
 * instead of trying to open a localhost callback.
 */
export function antigravityLoginEnv(base: NodeJS.ProcessEnv, paths: LoginScriptPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const term = env.TERM?.trim();
  env.TERM = term && /^[A-Za-z0-9_.:+-]{1,80}$/.test(term) ? term : "xterm-256color";
  env.SHELL = "/bin/sh";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  env.BROWSER = "/usr/bin/false";
  if (!env.SSH_CONNECTION) env.SSH_CONNECTION = LOGIN_LOOPBACK_SSH;
  env[LOGIN_PID_ENV] = paths.pid;
  env[LOGIN_STATUS_ENV] = paths.status;
  return env;
}

/**
 * Only an official Google OAuth consent URL is surfaced. A code pasted by the user is never a URL,
 * and links to other Google hosts (account pages, documentation) are deliberately ignored.
 */
export function antigravityAuthUrl(text: string): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const candidate = match[0].replace(/[),.;\]]+$/, "");
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || url.hostname !== LOGIN_AUTH_HOST || url.port || url.username || url.password) continue;
      const oauthPath =
        url.pathname.startsWith("/o/oauth2/") || url.pathname.startsWith("/signin/oauth/");
      if (!url.searchParams.get("client_id") || !oauthPath) continue;
      return url.toString();
    } catch {
      // Not a URL; keep looking.
    }
  }
  return null;
}

/** Standard VT220 secondary device-attributes reply; no account or terminal data. */
export const DA2_RESPONSE = "\x1b[>1;10;0c";

/** Secondary device-attributes query (`CSI > ... c`), possibly split across PTY chunks. */
export function asksForDa2(buffer: string): boolean {
  return /\x1b\[>([0-9;]*)c/.test(buffer);
}

export interface AntigravityIdentityClaims {
  email: string | null;
  subject: string | null;
}

/** Stable display/dedup key from non-secret claims; never an authentication result by itself. */
export function antigravityIdentityKey(claims: AntigravityIdentityClaims): string | null {
  if (claims.subject) return `antigravity|sub|${claims.subject}`;
  if (claims.email) return `antigravity|email|${claims.email.toLowerCase()}`;
  return null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length === 0 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizeSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const subject = value.trim();
  if (subject.length === 0 || subject.length > 255 || /[\u0000-\u001f\u007f]/.test(subject)) return null;
  return subject;
}

/**
 * Reads only the non-secret `email`/`sub` claims from an ID token. The signature is not verified and
 * the result is display/dedup metadata; a successful quota read is what proves the sign-in works.
 */
function claimsFromIdToken(value: unknown): AntigravityIdentityClaims | null {
  if (typeof value !== "string" || value.length > IDENTITY_JWT_LIMIT_CHARS) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const email = normalizeEmail(record.email);
  const subject = normalizeSubject(record.sub);
  return email || subject ? { email, subject } : null;
}

function parseIdentityClaims(raw: string): AntigravityIdentityClaims | null {
  let text = raw.trim();
  if (text.startsWith("go-keyring-base64:")) {
    try {
      text = Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8").trim();
    } catch {
      return null;
    }
  }
  if (text.length === 0 || text.length > IDENTITY_READ_LIMIT_BYTES) return null;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const root = document as Record<string, unknown>;
  const token =
    root.token && typeof root.token === "object" && !Array.isArray(root.token)
      ? (root.token as Record<string, unknown>)
      : null;
  const claims = claimsFromIdToken(root.id_token ?? root.idToken ?? token?.id_token ?? token?.idToken);
  const email = normalizeEmail(root.email) ?? normalizeEmail(token?.email) ?? claims?.email ?? null;
  const subject = claims?.subject ?? null;
  return email || subject ? { email, subject } : null;
}

/**
 * Managed credentials must stay inside their home without symlinks. A main CLI login may use a
 * dotfiles directory link, but the token file itself must still be a regular, unlinked file.
 */
async function assertCredentialPathSafe(home: string | null): Promise<void> {
  const root = home ?? mainAntigravityHome();
  if (home !== null) {
    const homeEntry = await lstat(home).catch(() => null);
    if (homeEntry?.isSymbolicLink()) {
      throw new Error("Refusing to use an Antigravity credential through a symlinked account home.");
    }
  }
  const realRoot = await realpath(root).catch(() => null);
  // A new managed home doesn't exist yet; no credential link can exist inside it.
  if (!realRoot) return;
  // Managed homes must not reach another account through a parent or token link. The main login may
  // legitimately keep `~/.gemini` behind a dotfiles symlink, so only its token link is rejected.
  const candidates =
    home === null
      ? [antigravityCredentialPath(home)]
      : [join(root, ".gemini"), join(root, ".gemini", "antigravity-cli"), antigravityCredentialPath(home)];
  for (const candidate of candidates) {
    const entry = await lstat(candidate).catch(() => null);
    if (entry?.isSymbolicLink()) {
      throw new Error("Refusing to use an Antigravity credential through a symlink.");
    }
  }
  const realCredential = await realpath(antigravityCredentialPath(home)).catch(() => null);
  if (home !== null && realCredential && !realCredential.startsWith(realRoot + sep)) {
    throw new Error("Refusing to use an Antigravity credential outside the account home.");
  }
}

/**
 * Reads the official file's non-secret identity claims with a private, bounded, no-follow read.
 * It never returns, logs or stores an access/refresh/ID token, and any malformed or non-private
 * file simply yields null.
 */
export async function readAntigravityIdentityClaims(
  home: string | null,
): Promise<AntigravityIdentityClaims | null> {
  try {
    await assertCredentialPathSafe(home);
  } catch {
    return null;
  }
  const path = antigravityCredentialPath(home);
  const entry = await lstat(path).catch(() => null);
  if (!entry || !entry.isFile() || entry.size <= 0 || entry.size > IDENTITY_READ_LIMIT_BYTES) return null;
  if ((entry.mode & 0o077) !== 0 || (entry.mode & 0o400) === 0) return null;
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) return null;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > IDENTITY_READ_LIMIT_BYTES) return null;
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseIdentityClaims(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type CredentialProbe =
  | { state: "missing" }
  | { state: "unsafe" }
  | { state: "present" };

/**
 * Classifies the official credential file without reading it. A safe `ENOENT` (or an empty file)
 * means no sign-in; a symlink, permission failure, wrong owner/mode or an out-of-home path is
 * `unsafe` and must remain unknown rather than being reported as a signed-out account.
 */
async function probeAntigravityCredential(home: string | null): Promise<CredentialProbe> {
  try {
    await assertCredentialPathSafe(home);
  } catch {
    return { state: "unsafe" };
  }
  const path = antigravityCredentialPath(home);
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unsafe" };
  }
  if (!entry.isFile()) return { state: "unsafe" };
  if (entry.size <= 0) return { state: "missing" };
  if ((entry.mode & 0o077) !== 0 || (entry.mode & 0o400) === 0) return { state: "unsafe" };
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) return { state: "unsafe" };
  if (home !== null) {
    const realRoot = await realpath(home).catch(() => null);
    const realFile = await realpath(path).catch(() => null);
    if (!realRoot || !realFile || !realFile.startsWith(realRoot + sep)) return { state: "unsafe" };
  }
  return { state: "present" };
}

interface CredentialCheck {
  ok: boolean;
  message: string | null;
}

/**
 * Validates the official file's presence and privacy without reading its value. A missing file is
 * accepted only for the main login (it may be in the OS keychain); the quota verification that
 * follows is still required. Managed homes must have their own private file.
 */
async function validateAntigravityCredential(home: string | null): Promise<CredentialCheck> {
  const probe = await probeAntigravityCredential(home);
  if (probe.state === "present") return { ok: true, message: null };
  if (probe.state === "missing" && home === null) return { ok: true, message: null };
  if (probe.state === "missing") {
    return { ok: false, message: "The official CLI didn't save a private sign-in. Try again." };
  }
  return { ok: false, message: "The official CLI's credential path isn't private. Try again." };
}

function signedOutIdentity(): Identity {
  return { signedIn: false, email: null, plan: null, organization: null, identity: null };
}

async function readLoginStatus(path: string): Promise<number | null> {
  const text = await readFile(path, "utf8").catch(() => "");
  const value = text.trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const status = Number(value);
  return Number.isInteger(status) && status >= 0 && status <= 255 ? status : null;
}


export interface AntigravityAdapterOptions {
  loginTimeoutMs?: number;
  loginKillGraceMs?: number;
  loginOutputLimitBytes?: number;
}

export class AntigravityAdapter implements FamilyAdapter {
  readonly family = "antigravity" as const;
  /** Antigravity transcripts do not replay after a daemon restart, so accounts don't move a live one. */
  readonly portable = false;
  /** A native usage read starts a CLI process; frequent reads would be wasteful and rate-limited. */
  readonly usageSpacingMs = 120_000;

  /**
   * In-app sign-in is enabled only on Linux, where an independent HOME with an empty D-Bus address
   * was observed to use the official file credential. On macOS the new-login Keychain boundary is
   * not proven, so existing file-backed accounts may still show usage but no managed login is
   * offered. Automatic switching is experimental and applies only to the observed model and quota.
   */
  readonly capabilities = {
    managedAccounts: process.platform === "linux",
    loginMethods: (process.platform === "linux" ? ["code"] : []) as LoginMethod[],
    autoSwitch: true,
    resets: false,
    fork: false,
  };

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  private readonly quotaCache = new Map<string, { at: number; value: AntigravityUsage }>();
  private readonly quotaInFlight = new Map<string, Promise<AntigravityUsage>>();
  private readonly quotaEpoch = new Map<string, number>();

  /** Drops a home's reading and prevents a currently running old read from filling the cache again. */
  private invalidateQuota(home: string | null): void {
    const key = home ?? "";
    this.quotaCache.delete(key);
    this.quotaInFlight.delete(key);
    this.quotaEpoch.set(key, (this.quotaEpoch.get(key) ?? 0) + 1);
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const resolved = await providerCommand("antigravity").catch(() => null);
    if (!resolved) return { ok: false, detail: "Antigravity's command couldn't be resolved." };
    try {
      assertSafePrefix(resolved.prefix);
    } catch {
      return { ok: false, detail: "Antigravity's configured command includes an option that conflicts with ZeroSub." };
    }
    const result = await run(resolved.command, [...resolved.prefix, "--version"], {
      env: spawnEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" }),
      timeoutMs: 30_000,
    });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: "Antigravity CLI didn't respond to --version." };
  }

  async prepareHome(home: string): Promise<void> {
    this.invalidateQuota(home);
    // Refuse an existing credential symlink before the base preparation can follow it.
    await assertCredentialPathSafe(home);
    await prepareAntigravityHome(home);
    for (const parts of ANTIGRAVITY_DIRECTORIES) await ensurePrivateDirectory(join(home, ...parts));
    // Catch a link introduced while the directories were being prepared.
    await assertCredentialPathSafe(home);
  }

  /**
   * The CLI's own login (`home === null`) keeps whatever environment the daemon already has.
   * A managed home without its own private credential is rejected: otherwise native `agy` can fall
   * through to the OS account's keyring and report a different account's quota or session.
   */
  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return {};
    const credential = await validateAntigravityCredential(home);
    if (!credential.ok) {
      this.invalidateQuota(home);
      throw new AntigravityQuotaError(
        "unavailable",
        credential.message ?? "This Antigravity account has no private sign-in. Sign it in again.",
      );
    }
    return antigravityEnv(home);
  }

  /**
   * A successful quota read proves the CLI accepted this home's stored sign-in. Non-secret
   * `email`/`sub` claims are then read only for display and exact-key duplicate detection; they are
   * never treated as authentication. Without them the account remains usable but its identity is
   * unknown, so duplicate/re-login matching is not guaranteed.
   */
  async identity(home: string | null): Promise<Identity> {
    if (home !== null) {
      // A safe metadata check can definitively say this managed home has no credential, which must
      // surface as signed out so the UI offers sign-in. Unsafe paths and quota/network failures stay
      // unknown (throw) rather than guessing. The main login may use the OS keychain, so a missing
      // file there is not proof of being signed out.
      const probe = await probeAntigravityCredential(home);
      if (probe.state === "missing") {
        this.invalidateQuota(home);
        return signedOutIdentity();
      }
      if (probe.state === "unsafe") {
        this.invalidateQuota(home);
        throw new AntigravityQuotaError("unavailable", "This Antigravity account's credential path isn't safe.");
      }
    }
    try {
      await this.readQuota(home);
    } catch (error) {
      throw asQuotaError(error);
    }
    const claims = await readAntigravityIdentityClaims(home).catch(() => null);
    return {
      signedIn: true,
      email: claims?.email ?? null,
      plan: null,
      organization: null,
      identity: claims ? antigravityIdentityKey(claims) : null,
    };
  }

  /**
   * `renewLogin` doesn't change anything here: `agy --print /usage` is itself the official CLI
   * path that refreshes an expired sign-in, so ZeroSub never handles a refresh token.
   */
  async usage(home: string | null, _options: { renewLogin?: boolean } = {}): Promise<AntigravityUsage> {
    try {
      return await this.readQuota(home);
    } catch (error) {
      // Returning an empty window list lets the Service keep the last good reading and show the error.
      return {
        fetchedAt: new Date().toISOString(),
        windows: [],
        error: describeQuotaError(error),
        cached: false,
        resets: null,
      };
    }
  }

  /** One in-flight read per home; a success is reused briefly so identity and usage share one call. */
  private async readQuota(home: string | null): Promise<AntigravityUsage> {
    const key = home ?? "";
    // Never let a 30-second cache outlive a managed credential. A deleted or unsafe file must fail
    // before the cached success is returned. The main login may use the OS keychain, so a missing
    // file there is not treated as signed out; an unsafe path is still rejected.
    const probe = await probeAntigravityCredential(home);
    if (probe.state === "unsafe" || (home !== null && probe.state === "missing")) {
      this.invalidateQuota(home);
      throw new AntigravityQuotaError(
        "unavailable",
        probe.state === "missing"
          ? "This Antigravity account has no private sign-in. Sign it in again."
          : "This Antigravity account's credential path isn't safe.",
      );
    }
    const cached = this.quotaCache.get(key);
    if (cached && Date.now() - cached.at < QUOTA_CACHE_MS) return cached.value;

    const pending = this.quotaInFlight.get(key);
    if (pending) return pending;

    const epoch = this.quotaEpoch.get(key) ?? 0;
    const task = this.fetchQuota(home);
    this.quotaInFlight.set(key, task);
    task.then(
      (value) => {
        // A login/logout/prepare invalidated this home while the read was running: never let its
        // result become the new account's cached reading.
        if ((this.quotaEpoch.get(key) ?? 0) !== epoch) {
          if (this.quotaInFlight.get(key) === task) this.quotaInFlight.delete(key);
          return;
        }
        this.quotaCache.set(key, { at: Date.now(), value });
        if (this.quotaInFlight.get(key) === task) this.quotaInFlight.delete(key);
      },
      () => {
        if (this.quotaInFlight.get(key) === task) this.quotaInFlight.delete(key);
      },
    );
    return task;
  }

  private async fetchQuota(home: string | null): Promise<AntigravityUsage> {
    // A managed home must prove its own private credential before the native CLI runs. Without this
    // guard a missing file can fall through to the OS keychain and return another account's quota.
    const credential = await validateAntigravityCredential(home);
    if (!credential.ok) {
      throw new AntigravityQuotaError(
        "unavailable",
        credential.message ?? "This Antigravity account has no private sign-in. Sign it in again.",
      );
    }

    const resolved = await providerCommand("antigravity").catch(() => null);
    if (!resolved) {
      throw new AntigravityQuotaError("unavailable", "Antigravity's command couldn't be resolved.");
    }
    assertSafePrefix(resolved.prefix);

    const env = spawnEnv(await this.env(home));
    // Even the CLI's own login gets a quota process that cannot update itself mid-read.
    env.AGY_CLI_DISABLE_AUTO_UPDATE ??= "true";
    // An unauthenticated quota read must not pop a browser on the daemon machine. /usr/bin/false
    // exists on Linux and macOS; Windows doesn't use this managed path.
    if (process.platform !== "win32") env.BROWSER = "/usr/bin/false";

    const result = await run(resolved.command, [...resolved.prefix, "--print", "/usage", "--output-format", "json"], {
      env,
      cwd: tmpdir(),
      timeoutMs: QUOTA_TIMEOUT_MS,
    });
    if (result.timedOut) {
      throw new AntigravityQuotaError("timed_out", "Antigravity's usage check timed out.");
    }
    if (result.code !== 0) {
      // stderr is deliberately not included: it can contain account or environment data.
      throw new AntigravityQuotaError("unsuccessful", "Antigravity's usage check didn't finish.");
    }
    const text = result.stdout.trim();
    if (!text) throw new AntigravityQuotaError("invalid_response", "Antigravity returned an empty usage response.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AntigravityQuotaError("invalid_response", "Antigravity returned an unreadable usage response.");
    }
    return parseAntigravityUsage(raw);
  }

  /** Antigravity has no banked reset API ZeroSub can call without its own credentials handling. */
  async redeemReset(
    _home: string | null = null,
    _options: { onlyAtLimit?: boolean } = {},
  ): Promise<RedeemReply> {
    return {
      outcome: "unavailable",
      message: "Antigravity doesn't report banked resets that ZeroSub can spend.",
      left: null,
    };
  }

  /**
   * Starts the official CLI's own login inside a private OS PTY. Linux is enabled because an
   * independent HOME with an empty D-Bus address was observed to use the file credential. macOS is
   * deliberately not enabled yet: a brand-new managed HOME could still read/write the global
   * Keychain, and that boundary has not been proven for first sign-in.
   */
  async login(home: string | null, method: LoginMethod): Promise<LoginHandle> {
    if (process.platform !== "linux") {
      throw new Error("Antigravity sign-in is enabled on Linux only until macOS keychain isolation is verified.");
    }
    if (method !== "code") {
      throw new Error("Antigravity sign-in uses the code flow. Start it with the code option.");
    }
    const resolved = await providerCommand("antigravity").catch(() => null);
    if (!resolved) throw new Error("Antigravity's command couldn't be resolved.");
    assertSafePrefix(resolved.prefix);

    let tempDir: string;
    try {
      tempDir = await mkdtemp(join(tmpdir(), "zerosub-agy-login-"));
    } catch {
      throw new Error("Could not start the official Antigravity sign-in.");
    }
    const paths: LoginScriptPaths = { pid: join(tempDir, "pid"), status: join(tempDir, "status") };
    try {
      // A managed login starts before any credential exists, so it must use prepareHome and the
      // environment builder directly rather than env(), whose credential guard is for sessions.
      if (home) await this.prepareHome(home);
      const args = [...resolved.prefix, "--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"];
      const script = buildLoginScriptCommand(process.platform, resolved.command, args, paths);
      const base = spawnEnv(home ? antigravityEnv(home) : {});
      const env = antigravityLoginEnv(base, paths);
      this.invalidateQuota(home);
      return new AntigravityLogin({
        home,
        script,
        env,
        cwd: tmpdir(),
        tempDir,
        pidPath: paths.pid,
        statusPath: paths.status,
        timeoutMs: this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
        killGraceMs: this.options.loginKillGraceMs ?? LOGIN_KILL_GRACE_MS,
        outputLimitBytes: this.options.loginOutputLimitBytes ?? LOGIN_OUTPUT_LIMIT_BYTES,
        enableDa2: !env.TERM_PROGRAM,
        verify: async () => (await this.identity(home)).signedIn,
        onSettled: (ok) => {
          // A successful verify just obtained a fresh reading for this home. Let Service's final
          // identity check share it; failures/cancellation must invalidate any in-flight result.
          if (!ok) this.invalidateQuota(home);
        },
      });
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AntigravityQuotaError) throw error;
      throw new Error("Could not start the official Antigravity sign-in.");
    }
  }

  /** Removes only the CLI credential file inside this managed home; never the CLI's global login. */
  async logout(home: string): Promise<void> {
    if (!isManagedHome(home)) {
      throw new Error("Refusing to remove Antigravity credentials outside a ZeroSub-managed home.");
    }
    const credential = resolve(antigravityCredentialPath(home));
    if (!credential.startsWith(resolve(home) + sep)) {
      throw new Error("Refusing to remove an Antigravity credential outside the account home.");
    }
    const entry = await lstat(credential).catch(() => null);
    if (!entry) return;
    // A symlinked home or credential must not lead outside the managed root, and a symlinked
    // credential is not the file the CLI owns. Refuse rather than following a shared original.
    const homeEntry = await lstat(home).catch(() => null);
    if (homeEntry?.isSymbolicLink()) {
      throw new Error("Refusing to remove an Antigravity credential through a symlinked account home.");
    }
    const root = resolve(homesDir());
    const realRoot = await realpath(root).catch(() => root);
    const realHome = await realpath(home).catch(() => null);
    const realCredential = await realpath(credential).catch(() => null);
    if (
      !entry.isFile() ||
      !realHome ||
      !realHome.startsWith(realRoot + sep) ||
      !realCredential ||
      !realCredential.startsWith(realHome + sep)
    ) {
      throw new Error("Refusing to remove an Antigravity credential that leaves the account home.");
    }
    this.invalidateQuota(home);
    await rm(credential, { force: true }).catch(() => {
      throw new Error("Couldn't remove the Antigravity credential from this account's home.");
    });
  }

  /**
   * No verified Antigravity failure frame names a subscription limit and its model scope yet.
   * Generic 429s, capacity errors and assistant/tool text must not switch accounts. The service
   * performs experimental classification only after binding a turn to its account and quota.
   */
  detectLimit(): LimitHit | null {
    return null;
  }

  /** Likewise, no official sign-out frame was verified; guessing would fake a signed-out account. */
  detectSignOut(): string | null {
    return null;
  }
}

interface AntigravityLoginOptions {
  home: string | null;
  script: { command: string; args: string[] };
  env: NodeJS.ProcessEnv;
  cwd: string;
  tempDir: string;
  pidPath: string;
  statusPath: string;
  timeoutMs: number;
  killGraceMs: number;
  outputLimitBytes: number;
  /** Only a daemon without a real TERM_PROGRAM needs the minimal DA2 terminal handshake. */
  enableDa2: boolean;
  verify: () => Promise<boolean>;
  onSettled: (ok: boolean) => void;
}

/**
 * The product LoginHandle for the official CLI. The CLI runs under an OS `script(1)` PTY, so its
 * own TUI/code flow owns authentication and token storage. ZeroSub only relays a URL and the user's
 * code through the RPC, never reads a token, and validates success with the private credential
 * metadata plus a fresh quota read.
 */
class AntigravityLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child: ChildProcess;
  private readonly resolveFinished: (result: { ok: boolean; message: string | null }) => void;
  private buffer = "";
  private rawTail = "";
  private outputBytes = 0;
  private capturing = true;
  private settled = false;
  private canceled = false;
  private stopping = false;
  private da2Answered = false;
  private wrapperPid: number | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AntigravityLoginOptions) {
    super();
    this.update({ step: "starting", message: "Starting the official Antigravity sign-in…" });
    let resolveFinished!: (result: { ok: boolean; message: string | null }) => void;
    this.finished = new Promise((resolve) => {
      resolveFinished = resolve;
    });
    this.resolveFinished = resolveFinished;
    this.child = spawn(options.script.command, options.script.args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child.stdin?.on("error", () => undefined);
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (text: string) => this.onOutput(text));
    // `script` diagnostics may contain paths or the command line; they are never exposed.
    this.child.stderr?.on("data", (text: string) => { this.countOutput(text); });
    this.child.on("error", () => {
      this.stop();
      this.fail("Could not start the official Antigravity sign-in.");
    });
    this.child.on("close", () => {
      void this.onClose();
    });
    this.loginTimer = setTimeout(() => {
      this.stop();
      this.fail("Sign-in timed out. Try again.");
    }, Math.max(1, options.timeoutMs));
    this.loginTimer.unref();
  }

  async submitCode(code: string): Promise<void> {
    if (this.settled || this.canceled) throw new Error("This sign-in has ended. Start again.");
    if (!this.progress.codeUrl) throw new Error("Wait for the official sign-in page, then paste the code.");
    const value = code.trim().replace(/\s+/g, "");
    if (!value) throw new Error("Paste the code from the sign-in page.");
    if (value.length > 16_384) throw new Error("That code is too long.");
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error("This sign-in has ended. Start again.");
    // Stop retaining PTY output before any code exists in the stream. Even if the CLI echoes the
    // input, the code cannot enter the URL buffer or a progress/error message.
    this.capturing = false;
    this.buffer = "";
    this.rawTail = "";
    this.update({ step: "verifying", message: "Checking the code…" });
    try {
      stdin.write(`${value}\n`);
    } catch {
      throw new Error("This sign-in has ended. Start again.");
    }
  }

  cancel(): void {
    if (this.settled) return;
    this.canceled = true;
    this.stop();
    this.update({ step: "canceled", message: "Sign-in was canceled." });
    this.settle({ ok: false, message: "Sign-in was canceled." });
  }

  private onOutput(text: string): void {
    if (!this.countOutput(text) || !this.capturing) return;
    this.rawTail = (this.rawTail + text).slice(-4_096);
    if (this.options.enableDa2 && !this.da2Answered && asksForDa2(this.rawTail)) {
      // Minimal terminal negotiation for a daemon with no real TERM_PROGRAM. This is a fixed VT
      // response, never user input, and it is sent at most once before the code prompt.
      this.da2Answered = true;
      this.child.stdin?.write(DA2_RESPONSE);
    }
    this.buffer = (this.buffer + text).slice(-LOGIN_BUFFER_BYTES);
    const url = antigravityAuthUrl(stripAnsi(this.buffer));
    if (url && url !== this.progress.codeUrl) {
      this.update({
        step: "waiting",
        codeUrl: url,
        message: "Open the sign-in page, then paste the code it shows.",
      });
    }
  }

  /** Count and drain both streams after code submission, without retaining their contents. */
  private countOutput(text: string): boolean {
    if (this.settled || this.canceled) return false;
    this.outputBytes += Buffer.byteLength(text, "utf8");
    if (this.outputBytes > this.options.outputLimitBytes) {
      this.stop();
      this.fail("Sign-in output was too large. Try again.");
      return false;
    }
    return true;
  }

  private async onClose(): Promise<void> {
    this.clearLoginTimer();
    if (this.settled || this.canceled) return;
    const status = await readLoginStatus(this.options.statusPath);
    if (this.settled || this.canceled) return;
    if (status === null || status !== 0) {
      this.fail("The official CLI stopped before sign-in finished. Try again.");
      return;
    }
    this.update({ step: "verifying", message: "Checking the saved sign-in…" });
    const credential = await validateAntigravityCredential(this.options.home);
    if (this.settled || this.canceled) return;
    if (!credential.ok) {
      this.fail(credential.message ?? "The official CLI didn't save a private sign-in. Try again.");
      return;
    }
    let verified = false;
    try {
      verified = await this.options.verify();
    } catch {
      verified = false;
    }
    if (this.settled || this.canceled) return;
    if (!verified) {
      this.fail(
        "The official CLI saved a private sign-in, but ZeroSub couldn't verify it. Check the account's usage, then try again.",
      );
      return;
    }
    this.update({ step: "done", message: "Signed in." });
    this.settle({ ok: true, message: null });
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.update({ step: "failed", message });
    this.settle({ ok: false, message });
  }

  private settle(result: { ok: boolean; message: string | null }): void {
    if (this.settled) return;
    this.settled = true;
    this.buffer = "";
    this.rawTail = "";
    this.clearLoginTimer();
    try {
      this.options.onSettled(result.ok);
    } catch {
      // Cache invalidation must never hide the sign-in result.
    }
    this.resolveFinished(result);
    // When a cancel/timeout is killing a process group, keep the tiny PID/status directory until
    // the SIGKILL grace expires so the final retry can still find the wrapper's PID.
    if (!this.stopping) void rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.clearLoginTimer();
    const pid = this.readWrapperPid();
    if (pid) this.signalGroup(pid, "SIGTERM");
    // The detached PTY helper can already have children before the wrapper writes its PID.
    const scriptPid = this.child.pid;
    if (scriptPid && scriptPid !== pid) this.signalGroup(scriptPid, "SIGTERM");
    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      const late = pid ?? this.readWrapperPid();
      if (late) this.signalGroup(late, "SIGKILL");
      if (scriptPid && scriptPid !== late) this.signalGroup(scriptPid, "SIGKILL");
      this.child.kill("SIGKILL");
      void rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined);
    }, Math.max(1, this.options.killGraceMs));
    this.killTimer.unref();
  }

  private readWrapperPid(): number | null {
    if (this.wrapperPid !== null) return this.wrapperPid;
    try {
      const text = readFileSync(this.options.pidPath, "utf8").trim();
      if (!/^\d+$/.test(text)) return null;
      const pid = Number(text);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
      this.wrapperPid = pid;
      return pid;
    } catch {
      return null;
    }
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The wrapper may not be a group leader on a future `script`; try the process itself.
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }

  private clearLoginTimer(): void {
    if (!this.loginTimer) return;
    clearTimeout(this.loginTimer);
    this.loginTimer = null;
  }
}
