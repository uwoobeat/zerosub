import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import {
  DEFAULT_CONTINUE_PROMPT,
  normalizeAutoSwitchPreferences,
  preferences,
  type Preferences,
} from "../shared/preferences";
import { consentAntigravityBalance } from "../shared/rpc";
import { familyAvailable, normalizeAntigravityAutoSwitch, supportsFamily } from "./family-support";
import { useStore, type ZeroSubStore } from "./store";

/** Settings → Plugins → zerosub. Accounts themselves live in the sidebar surface. */
export function PreferencesScreen({
  theme,
  host,
  store,
  onOpenAccounts,
}: PluginSurfaceProps & { store: ZeroSubStore; onOpenAccounts(): void }) {
  const settings = useSettings(preferences);
  const { state } = useStore(store);
  const multiHost = useHosts().length > 1;
  const antigravity = familyAvailable(state, "antigravity");
  const antigravitySwitch = supportsFamily(state, "antigravity", "autoSwitch");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Preferences">
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }
  const values = normalizeAutoSwitchPreferences(settings.values);
  const save = (patch: Partial<Preferences>) => {
    const next = normalizeAntigravityAutoSwitch({ ...values, ...patch }, antigravitySwitch);
    void settings.save(next, settings.revision);
  };
  return (
    <>
      {multiHost ? (
        <Text style={muted}>These apply to agents on {host.label}. Each host keeps its own accounts and preferences.</Text>
      ) : null}
      <SettingsSection title="Accounts">
        <SettingsCard>
          <SettingsAction
            label="Add, remove, and choose default accounts"
            actionLabel="Open accounts"
            onPress={onOpenAccounts}
          />
          <SettingsSwitch
            label="Move open agents when the default changes"
            hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
            value={values.moveAgentsOnDefaultChange}
            disabled={settings.saving}
            onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Automatic switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="Claude and ChatGPT agents move to the account with the most room left."
            value={values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Continue after a switch or reset"
            hint="Controls whether supported account switches and resets send a follow-up to continue the task."
            value={values.autoContinue}
            disabled={settings.saving}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          {antigravity ? (
            <SettingsSwitch
              label="Switch Antigravity accounts when one hits its limit"
              hint={
                antigravitySwitch
                  ? "Independent of Claude and ChatGPT switching. Off by default; only supported Antigravity limit events trigger a handoff."
                  : "Off and unavailable on this host until Antigravity account switching is supported and verified."
              }
              value={antigravitySwitch ? values.antigravityAutoSwitch : false}
              disabled={settings.saving || !antigravitySwitch}
              onValueChange={(antigravityAutoSwitch) => save({ antigravityAutoSwitch })}
            />
          ) : null}
          <SettingsInput
            label="Follow-up message"
            initialValue={values.continuePrompt}
            onChangeText={setPrompt}
            disabled={settings.saving || !values.autoContinue}
            error={settings.saveError}
          />
          <SettingsAction
            label="Save the follow-up message"
            actionLabel="Save"
            disabled={settings.saving || prompt === null || !prompt.trim()}
            onPress={() => {
              if (prompt?.trim()) save({ continuePrompt: prompt.trim() });
            }}
          />
          <SettingsAction
            label="Restore the default follow-up"
            actionLabel="Restore"
            disabled={settings.saving || values.continuePrompt === DEFAULT_CONTINUE_PROMPT}
            onPress={() => save({ continuePrompt: DEFAULT_CONTINUE_PROMPT })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New agents and composer">
        <SettingsCard>
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New Claude and ChatGPT agents start on the account with the most room instead of the default."
            value={values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          {antigravity ? <>
            <SettingsSwitch
              label="Start new Antigravity agents on the account with the most room"
              hint={values.antigravityBalanceNewAgents && state?.antigravityBalance?.consentRequired
                ? "Support changed; turn this on again to consent. Experimental and applies only to new agents."
                : "Experimental: Gemini models use the Gemini group, and Claude/GPT models use their shared group quota; missing quota falls back to the default. Applies only to new agents."}
              value={Boolean(values.antigravityBalanceNewAgents && state?.antigravityBalance && !state.antigravityBalance.consentRequired)}
              disabled={settings.saving || !state?.antigravityBalance?.available || !supportsFamily(state, "antigravity", "balanceNewAgents")}
              onValueChange={(enabled) => {
                const revision = state?.antigravityBalance?.revision;
                setBalanceError(null);
                void (async () => {
                  const next = normalizeAntigravityAutoSwitch({
                    ...values,
                    antigravityBalanceNewAgents: enabled,
                  }, antigravitySwitch);
                  if (!await settings.save(next, settings.revision)) return;
                  if (enabled && revision !== undefined) {
                    try { await store.rpc(consentAntigravityBalance, { revision }); }
                    catch { setBalanceError("Could not confirm consent. Turn the setting on again when support is available."); }
                  }
                })();
              }}
            />
            {balanceError ? <Text style={{ color: theme.colors.statusDanger }}>{balanceError}</Text> : null}
          </> : null}
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Off unless you turn it on: resets are scarce."
            value={values.autoRedeem}
            disabled={settings.saving || !values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
          <SettingsSwitch
            label="When every account is out, fork the chat to the other provider"
            hint="A stopped Claude chat carries on in a new ChatGPT agent, or the other way round, with the conversation so far and no more permissions than the original. The original stays as it was."
            value={values.forkOtherProvider}
            disabled={settings.saving || !values.autoSwitch}
            onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
          />
          <SettingsSwitch
            label="Show the account pill in the composer"
            hint="Appears on subscription agents once a provider has two or more accounts."
            value={values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
