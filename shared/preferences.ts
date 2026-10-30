import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Sent after a switch or a reset, so it must read right for both. */
export const DEFAULT_CONTINUE_PROMPT =
  "You were interrupted by a usage limit; that has been sorted out. Continue exactly where you left off.";

/** Distinguishes independent provider switches from older settings where Antigravity was gated by autoSwitch. */
export const AUTO_SWITCH_SETTINGS_MODE = "provider-independent-v1" as const;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Automatically switch Claude and ChatGPT agents to another account when their account hits a limit. */
    autoSwitch: z.boolean().default(true),
    /**
     * Independently switch Antigravity agents to another account when their account hits a limit.
     * Off by default and only active when the host reports automatic switching support.
     */
    antigravityAutoSwitch: z.boolean().default(false),
    /** Internal compatibility marker; absent settings retain the former shared master-switch meaning. */
    autoSwitchSettingsMode: z.literal(AUTO_SWITCH_SETTINGS_MODE).optional(),
    /** After a supported account switch or reset, send a follow-up so the interrupted task keeps going. */
    autoContinue: z.boolean().default(true),
    continuePrompt: z.string().trim().min(1).max(500).default(DEFAULT_CONTINUE_PROMPT),
    /**
     * When the default account changes, open agents that follow it move to the new one. Off, each
     * stays pinned to the account it runs on (so it stays there when it next opens too), unless that
     * account can't be used right now, and the new default is for new agents and ones that aren't
     * open at the time. Codex threads never move either way.
     */
    moveAgentsOnDefaultChange: z.boolean().default(true),
    /** New agents start on the account with the most headroom instead of the default. */
    balanceNewAgents: z.boolean().default(false),
    /** Experimental Antigravity first-session selection; consent is stored separately. */
    antigravityBalanceNewAgents: z.boolean().default(false),
    /** When every account of a provider is at its limit, spend a banked reset instead of stopping. */
    autoRedeem: z.boolean().default(false),
    /**
     * When every account of a provider is at its limit, carry the chat on in a new agent on the
     * other provider (Claude ↔ ChatGPT), in a mode no more permissive than the original's.
     */
    forkOtherProvider: z.boolean().default(false),
    /** Show the account pill in the composer of Claude and Codex agents. */
    showComposerPill: z.boolean().default(true),
  }),
});

export type Preferences = z.output<typeof preferences.schema>;

/** Preserve the old effective AGY state once, then let the two provider switches vary independently. */
export function normalizeAutoSwitchPreferences(values: Preferences): Preferences {
  if (values.autoSwitchSettingsMode === AUTO_SWITCH_SETTINGS_MODE) return values;
  return {
    ...values,
    antigravityAutoSwitch: values.autoSwitch && values.antigravityAutoSwitch,
    autoSwitchSettingsMode: AUTO_SWITCH_SETTINGS_MODE,
  };
}
