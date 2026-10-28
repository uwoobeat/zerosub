import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Family } from "../shared/model";

type PaseoApi = PluginHandlerContext["paseo"];

/**
 * Environment keys that mean a provider entry brings its own credentials or endpoint. Such entries
 * (API keys, Bedrock/Vertex, a proxy, a hand-made config dir) are left exactly as configured.
 */
const OWN_AUTH_KEYS: Record<Family, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"],
  antigravity: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_BASE_URL",
    "AGY_ADC_AUTH",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ],
};

/**
 * A provider profile that redirects the CLI's config/state root has its own credential store. This
 * is checked only on provider entries: the daemon always has HOME/XDG, and treating that as a
 * provider override would hide every subscription family.
 */
const OWN_ROOT_KEYS: Record<Family, readonly string[]> = {
  claude: ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"],
  codex: ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"],
  antigravity: [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    // ACP's account root, not the native CLI's selector. It still means this provider entry is not
    // sharing the native CLI login, so it must not be routed through a managed home.
    "GEMINI_HOME",
  ],
};

const FAMILIES: readonly Family[] = ["claude", "codex", "antigravity"];

export function bringsOwnAuth(family: Family, env: Record<string, unknown> | undefined): boolean {
  if (!env) return false;
  return OWN_AUTH_KEYS[family].some((key) => typeof env[key] === "string" && env[key] !== "");
}

export function bringsOwnRoot(family: Family, env: Record<string, unknown> | undefined): boolean {
  if (!env) return false;
  return OWN_ROOT_KEYS[family].some((key) => typeof env[key] === "string" && env[key] !== "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isFamily(value: unknown): value is Family {
  return value === "claude" || value === "codex" || value === "antigravity";
}

/**
 * Maps Paseo provider IDs to the subscription family they run on: the built-in `claude`, `codex`
 * and `antigravity` providers, plus custom profiles that directly extend one of them without their
 * own credentials.
 *
 * A generic `extends: "acp"` profile is not guessed to be Antigravity: ACP has a separate auth
 * runtime and its quota path hasn't been verified. For Antigravity the daemon environment is
 * checked too, because an API key or ADC variable there selects a credential mode a managed HOME
 * can't isolate.
 */
export function familiesFromConfig(
  providers: Record<string, unknown> | undefined,
  daemonEnv: Record<string, string | undefined> = process.env,
): Record<string, Family> {
  const result: Record<string, Family> = {};
  const entries = providers ?? {};
  const hasOwnAuth = (family: Family, id: string, env?: Record<string, unknown>): boolean => {
    const entry = asRecord(entries[id]);
    const source = env ?? asRecord(entry?.env);
    if (bringsOwnAuth(family, source) || bringsOwnRoot(family, source)) return true;
    // Daemon credential/endpoint variables also select a mode a managed home can't isolate. Root
    // overrides are deliberately not checked here: HOME/XDG always exist for the daemon.
    return family === "antigravity" && bringsOwnAuth(family, daemonEnv);
  };

  for (const family of FAMILIES) {
    if (!hasOwnAuth(family, family)) result[family] = family;
  }
  for (const [id, value] of Object.entries(entries)) {
    if (isFamily(id)) continue;
    const entry = asRecord(value);
    const base = entry?.extends;
    if (!isFamily(base)) continue;
    // A direct extension inherits the parent profile's env. Merge it so an explicit empty value in
    // the child can clear a parent credential/root override instead of being excluded by surprise.
    const parentEnv = asRecord(asRecord(entries[base])?.env) ?? {};
    const childEnv = asRecord(entry?.env) ?? {};
    if (hasOwnAuth(base, base, { ...parentEnv, ...childEnv })) continue;
    result[id] = base;
  }
  return result;
}

const CACHE_MS = 30_000;
/** Catalog reads are on the session-open path; never let a stuck daemon IPC hold the hook. */
export const AVAILABILITY_TIMEOUT_MS = 1_500;

/** Enabled, ready provider IDs from Paseo's catalog, or null when the read fails or times out. */
function availableProviderIds(paseo: PaseoApi): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: Set<string> | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(null), AVAILABILITY_TIMEOUT_MS);
    timer.unref?.();
    try {
      // listAvailable probes every provider again and can wait on unrelated CLIs. The catalog
      // already tracks readiness and is the same source Paseo uses to populate its provider UI.
      paseo.providers.snapshot().then(
        (snapshot) => {
          if (settled) return;
          try {
            const providers = snapshot?.entries ?? [];
            finish(
              new Set(
                providers
                  .filter((entry) => entry.enabled === true && entry.status === "ready" && typeof entry.provider === "string")
                  .map((entry) => entry.provider as string),
              ),
            );
          } catch {
            finish(null);
          }
        },
        () => finish(null),
      );
    } catch {
      finish(null);
    }
  });
}

/** Reads provider profiles from the daemon config, cached briefly because session opens are hot. */
export class FamilyResolver {
  private cache: { at: number; value: Record<string, Family> } | null = null;

  async resolve(paseo: PaseoApi): Promise<Record<string, Family>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const value = await this.load(paseo);
    this.cache = { at: Date.now(), value };
    return value;
  }

  private async load(paseo: PaseoApi): Promise<Record<string, Family>> {
    let providers: Record<string, unknown> | undefined;
    let configRead = false;
    try {
      const { config } = await paseo.config.get();
      providers = asRecord(config.providers);
      configRead = true;
    } catch (error) {
      console.warn("[ZeroSub] could not read provider config; using built-in Claude and Codex only", describe(error));
    }

    const value = familiesFromConfig(providers);
    // Without a trustworthy config, Antigravity must fail closed. Claude and Codex keep their
    // existing config-independent fallback.
    if (!configRead) return withoutAntigravity(value);
    const available = await availableProviderIds(paseo);
    if (!available) {
      console.warn("[ZeroSub] could not confirm available providers; keeping Antigravity off");
      return withoutAntigravity(value);
    }
    for (const [id, family] of Object.entries(value)) {
      if (family === "antigravity" && !available.has(id)) delete value[id];
    }
    return value;
  }
}

/** Antigravity is available only when Paseo reports the actual provider; never assume it. */
function withoutAntigravity(value: Record<string, Family>): Record<string, Family> {
  for (const [id, family] of Object.entries(value)) if (family === "antigravity") delete value[id];
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
