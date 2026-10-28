import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".paseo");
}

/** Everything ZeroSub writes lives here: its registry and the per-account credential homes. */
export function dataDir(): string {
  return join(paseoHome(), "zerosub");
}

export function statePath(): string {
  return join(dataDir(), "state.json");
}

export function homesDir(): string {
  return join(dataDir(), "homes");
}

/** The config directory the Claude CLI uses when `CLAUDE_CONFIG_DIR` is not set. */
export function mainClaudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

/** Claude keeps its global config beside the config directory unless `CLAUDE_CONFIG_DIR` is set. */
export function mainClaudeGlobalConfig(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? join(resolve(configured), ".claude.json") : join(homedir(), ".claude.json");
}

export function mainCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

/**
 * The Antigravity CLI's own login lives under the operating system's real HOME. Its documented
 * account selector has no separate config-home variable, so `GEMINI_HOME` (used by the ACP runtime)
 * must not be treated as one here.
 */
export function mainAntigravityHome(): string {
  return homedir();
}

/** The CLI-owned credential file for `home`, or for the OS login when `home` is null. */
export function antigravityCredentialPath(home: string | null): string {
  return join(home ?? mainAntigravityHome(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}
