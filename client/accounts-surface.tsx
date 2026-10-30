import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { accountSubtitle, formatAge, formatPlan, usageSummary } from "../shared/format";
import { FAMILY_LABEL, type AccountView, type Family, type StateView } from "../shared/model";
import { preferences } from "../shared/preferences";
import {
  clearAccountLimit,
  consentAntigravityBalance,
  removeAccount,
  renameAccount,
  setAccountEnabled,
  setDefaultAccount,
  type ReopenSummary,
} from "../shared/rpc";
import { AddAccountModal } from "./add-account";
import {
  canAddAccount,
  familyAvailable,
  familyTitle,
  normalizeAntigravityAutoSwitch,
  supportsFamily,
} from "./family-support";
import {
  focusedUsageGroup,
  groupChipLabel,
  groupMissingNote,
  groupStatus,
  groupUsageNote,
  hasScopedWindows,
  scopedLimitState,
  usageGroups,
  type UsageGroup,
} from "./quota";
import { ResetConfirm, redeemToast, resetBadge } from "./reset-confirm";
import { describe, useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, UsageBar, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

export function AccountsSurface(props: PluginSurfaceProps & { store: ZeroSubStore }) {
  const { theme, layout, host, store } = props;
  const { state, error } = useStore(store);
  const text = useText(theme);
  const [adding, setAdding] = useState<{ family: Family; accountId?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshUsage = useCallback(async () => {
    setRefreshing(true);
    try {
      await store.refresh({ refreshUsage: true });
    } finally {
      setRefreshing(false);
    }
  }, [store]);
  // Each host runs its own copy of the plugin with its own accounts; Paseo's host picker switches.
  const hosts = useHosts();
  const multiHost = hosts.length > 1;
  const hostStatus = hosts.find((entry) => entry.serverId === host.id)?.status;
  const offline = hostStatus !== undefined && hostStatus !== "online";
  // Keep usage moving while the screen is open.
  useEffect(() => store.watch(VISIBLE_POLL_MS), [store]);

  const families: Family[] = (["claude", "codex", "antigravity"] as const).filter((family) =>
    familyAvailable(state, family),
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 20 : 28,
          maxWidth: 820,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ gap: 6 }}>
          <Text style={[text.small, { fontWeight: "600", letterSpacing: 0.4 }]}>ZeroSub</Text>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={text.title} accessibilityRole="header">
              Subscription accounts
            </Text>
            {state ? (
              <IconButton
                theme={theme}
                icon="RefreshCw"
                label="Refresh usage"
                tooltip="Refresh usage for every account now"
                tooltipPlacement="bottom"
                busy={refreshing}
                onPress={() => void refreshUsage()}
              />
            ) : null}
          </View>
          <Text style={text.muted}>
            Keep several subscription accounts signed in. Each agent uses one; when an account hits
            its limit, agents move to another and keep going.
          </Text>
        </View>

        {multiHost ? <HostScope theme={theme} label={host.label} /> : null}

        {error && (offline || !state) ? (
          <Card theme={theme}>
            <Text style={text.danger}>
              {offline
                ? `Can't reach ${host.label}. Its accounts are saved on that machine${
                    state ? "; this is how they looked last." : " and show up here once it reconnects."
                  }`
                : `Could not reach the daemon: ${error}`}
            </Text>
            <Button
              theme={theme}
              label="Try again"
              icon="RefreshCw"
              tooltip="Ask this host for its accounts again"
              tooltipAlign="start"
              onPress={() => void store.refresh()}
            />
          </Card>
        ) : null}

        {state?.warnings.map((warning) => (
          <Card theme={theme} key={warning}>
            <Text style={text.warning}>{warning}</Text>
          </Card>
        ))}

        {!state && !error ? <Text style={text.muted}>Loading accounts…</Text> : null}

        {state
          ? families.map((family) => (
              <FamilySection
                key={family}
                family={family}
                accounts={state.accounts.filter((account) => account.family === family)}
                theme={theme}
                compact={layout.compact}
                store={store}
                canAdd={canAddAccount(state, family)}
                canReset={supportsFamily(state, family, "resets")}
                onAdd={() => setAdding({ family })}
                onSignIn={(account) => setAdding({ family, accountId: account.id })}
              />
            ))
          : null}

        <AutomationSettings theme={theme} state={state} store={store} />
      </ScrollView>

      {adding ? (
        <AddAccountModal
          theme={theme}
          layout={layout}
          host={host}
          multiHost={multiHost}
          store={store}
          family={adding.family}
          accountId={adding.accountId}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </View>
  );
}

/** Says whose accounts these are when the app knows several hosts. */
function HostScope({ theme, label }: { theme: Theme; label: string }) {
  const text = useText(theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name="Server" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.strong}>Accounts on {label}</Text>
        <Text style={text.small}>
          Only agents on this host use them. Each host keeps its own accounts and settings, so sign in on
          each host you use. Switch hosts with the host picker at the top; a host shows up there once ZeroSub
          is installed on it.
        </Text>
      </View>
    </View>
  );
}

function FamilySection({
  family,
  accounts,
  theme,
  compact,
  store,
  canAdd,
  canReset,
  onAdd,
  onSignIn,
}: {
  family: Family;
  accounts: AccountView[];
  theme: Theme;
  compact: boolean;
  store: ZeroSubStore;
  canAdd: boolean;
  canReset: boolean;
  onAdd(): void;
  onSignIn(account: AccountView): void;
}) {
  const text = useText(theme);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={text.heading} accessibilityRole="header">
          {familyTitle(family)}
        </Text>
        {canAdd ? (
          <Button
            theme={theme}
            icon="Plus"
            label={compact ? "Add" : "Add account"}
            accessibilityLabel={`Add ${FAMILY_LABEL[family]} account`}
            tooltip={`Sign in another ${FAMILY_LABEL[family]} account`}
            tooltipAlign="end"
            onPress={onAdd}
          />
        ) : null}
      </View>
      {!canAdd ? (
        <Text style={text.small}>
          This host can show {FAMILY_LABEL[family]} usage, but adding or signing in an account isn't available yet.
        </Text>
      ) : null}
      {accounts.length === 0 && canAdd ? (
        <Text style={text.muted}>No {FAMILY_LABEL[family]} accounts yet.</Text>
      ) : null}
      {chunk(accounts, compact ? 1 : 2).map((row) => (
        <View key={row.map((account) => account.id).join()} style={{ flexDirection: "row", gap: 10 }}>
          {row.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              theme={theme}
              store={store}
              canRelogin={canAdd}
              canReset={canReset}
              onSignIn={() => onSignIn(account)}
            />
          ))}
          {!compact && row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

function AccountCard({
  account,
  theme,
  store,
  canRelogin,
  canReset,
  onSignIn,
}: {
  account: AccountView;
  theme: Theme;
  store: ZeroSubStore;
  canRelogin: boolean;
  canReset: boolean;
  onSignIn(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"default" | "remove" | "clear" | "toggle" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const resets = canReset ? account.usage?.resets ?? null : null;
  const plan = formatPlan(account.plan);
  const summary = usageSummary(account);
  const subtitle = accountSubtitle(account);
  const signedOut = account.status === "signed_out";
  const disabled = account.status === "disabled";
  const faded = disabled ? { opacity: 0.55 } : null;
  const windows = account.usage?.windows ?? [];
  const scoped = useMemo(() => (hasScopedWindows(windows) ? usageGroups(windows) : []), [windows]);
  const [focusGroupId, setFocusGroupId] = useState<string | null>(null);
  const focused = focusedUsageGroup(scoped, focusGroupId);
  const usageError = account.usage?.error ?? null;
  const limitState = scopedLimitState(account);
  const agents = account.agentCount === 0 ? "No agents" : `${account.agentCount} agent${account.agentCount === 1 ? "" : "s"}`;
  const freshness = !signedOut && account.usage
    ? account.usage.cached
      ? `cached · last checked ${formatAge(account.usage.fetchedAt)}`
      : `updated ${formatAge(account.usage.fetchedAt)}`
    : null;

  // Sets the account aside for a while, or brings it back; its agents move off it and back.
  const toggle = useCallback(async () => {
    const enabling = account.status === "disabled";
    setBusy("toggle");
    try {
      const result = await store.rpc(setAccountEnabled, { accountId: account.id, enabled: enabling });
      const message = describeReopen(`${account.label} is ${enabling ? "enabled" : "disabled"}`, result);
      const stayed =
        result.stayed > 0
          ? ` · ${result.stayed} conversation${result.stayed === 1 ? " stays" : "s stay"} on it (they can't change accounts)`
          : "";
      toast.show(`${message}${stayed}`, { variant: "success", durationMs: 5_000 });
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  const makeDefault = useCallback(async () => {
    setBusy("default");
    try {
      const summary = await store.rpc(setDefaultAccount, { accountId: account.id });
      toast.show(describeReopen(`${account.label} is now the default`, summary), { variant: "success" });
      await store.refresh();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  // For when the user knows better, e.g. after upgrading the plan or buying credits.
  const markAvailable = useCallback(async () => {
    setBusy("clear");
    try {
      await store.rpc(clearAccountLimit, { accountId: account.id });
      toast.show(`${account.label} is available again`, { variant: "success" });
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  const remove = useCallback(async () => {
    setBusy("remove");
    try {
      const result = await store.rpc(removeAccount, { accountId: account.id });
      toast.show(
        result.movedAgents > 0
          ? `Removed ${account.label}; ${result.movedAgents} agent(s) moved to the default account`
          : `Removed ${account.label}`,
        { variant: "success" },
      );
      await store.refresh();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  }, [account, store, toast]);

  return (
    <Card theme={theme} fill>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={faded}>
          <Avatar theme={theme} label={account.label} />
        </View>
        <View style={[{ flex: 1, minWidth: 0, gap: 3 }, faded]}>
          <Text style={text.strong} numberOfLines={1}>
            {account.label}
          </Text>
          {subtitle ? (
            <Text style={text.small} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: -4, marginRight: -6 }}>
          {account.status === "limited" ? (
            <IconButton
              theme={theme}
              icon="CircleCheck"
              label="Mark as available again (it has room)"
              tooltip="Mark as available: use it again before its limit resets, e.g. after upgrading"
              busy={busy === "clear"}
              onPress={() => void markAvailable()}
            />
          ) : null}
          {!account.isDefault && !signedOut && !disabled ? (
            <IconButton
              theme={theme}
              icon="Star"
              label="Make default"
              tooltip="Make default: new agents start on this account"
              busy={busy === "default"}
              onPress={() => void makeDefault()}
            />
          ) : null}
          <IconButton
            theme={theme}
            icon={disabled ? "CirclePlay" : "CirclePause"}
            label={disabled ? "Enable account" : "Disable for now (agents won't use it)"}
            tooltip={
              disabled
                ? "Enable: agents can use this account again"
                : "Disable for now: agents stop using it and move to your other accounts"
            }
            busy={busy === "toggle"}
            onPress={() => void toggle()}
          />
          <IconButton theme={theme} icon="Pencil" label="Rename" tooltip="Rename this account" onPress={() => setRenaming(true)} />
          {account.kind !== "main" ? (
            <IconButton
              theme={theme}
              icon="Trash2"
              label="Remove"
              tooltip="Remove: sign it out and delete its saved login"
              tone="danger"
              busy={busy === "remove"}
              onPress={() => setConfirmRemove(true)}
            />
          ) : null}
        </View>
      </View>

      <View style={[{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }, faded]}>
        {account.isDefault ? <Badge theme={theme} label="Default" tone="accent" /> : null}
        {disabled ? <Badge theme={theme} label="Disabled" /> : null}
        {plan ? <Badge theme={theme} label={plan} /> : null}
        {account.kind === "main" ? <Badge theme={theme} label="CLI login" /> : null}
        {!signedOut && !disabled && account.status === "limited" ? (
          <Badge theme={theme} label="Limit reached" tone="danger" />
        ) : null}
        {!signedOut && !disabled && account.status !== "limited" && limitState === "all" ? (
          <Badge theme={theme} label="Limit reached" tone="danger" />
        ) : null}
        {!signedOut && !disabled && limitState === "some" ? (
          <Badge theme={theme} label="Some groups at limit" tone="warning" />
        ) : null}
        {account.status === "signed_out" ? <Badge theme={theme} label="Signed out" tone="warning" /> : null}
        {!signedOut && account.usage?.cached ? (
          <Badge theme={theme} label={usageError ? "Cached · refresh failed" : "Cached"} tone="warning" />
        ) : null}
        {resets && !signedOut ? <Badge theme={theme} label={resetBadge(resets)} tone="accent" /> : null}
      </View>

      <View style={[{ gap: 10 }, faded]}>
        {signedOut ? (
          <Text style={text.small}>Sign in again to use this account.</Text>
        ) : scoped.length > 0 ? (
          <ScopedUsage
            theme={theme}
            usage={account.usage}
            groups={scoped}
            focused={focused}
            onFocus={setFocusGroupId}
          />
        ) : windows.length > 0 ? (
          <>
            {account.usage?.cached ? (
              <Text style={text.warning}>Cached reading · availability isn't verified.</Text>
            ) : null}
            {windows.map((limit) => <UsageBar key={limit.id} theme={theme} limit={limit} />)}
            {usageError ? <Text style={text.warning}>{usageError}</Text> : null}
          </>
        ) : (
          <Text style={text.small}>
            {usageError ?? summary ?? (account.usage ? "No usage reported — availability unknown." : "Checking usage…")}
          </Text>
        )}
        {!signedOut && resets?.blockedReason ? <Text style={text.small}>{resets.blockedReason}</Text> : null}
      </View>

      {/* Pinned to the bottom, so cards side by side line up however much each one shows. */}
      <View
        style={{
          marginTop: "auto",
          minHeight: 38,
          paddingTop: 10,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          columnGap: 8,
          rowGap: 8,
        }}
      >
        <Text style={[text.small, { flexShrink: 1 }]} numberOfLines={1}>
          {disabled ? "Disabled · agents won't use it" : freshness ? `${agents} · ${freshness}` : agents}
        </Text>
        {signedOut ? (
          canRelogin ? (
            <Button
              theme={theme}
              size="small"
              tone="primary"
              icon="LogIn"
              label="Sign in"
              tooltip="Sign this account in again"
              tooltipAlign="end"
              onPress={onSignIn}
            />
          ) : (
            <Text style={[text.small, { flexShrink: 1 }]}>Signing in again isn't available on this host yet.</Text>
          )
        ) : disabled ? (
          <Button
            theme={theme}
            size="small"
            tone="primary"
            icon="CirclePlay"
            label="Enable"
            tooltip="Use this account again; its agents move back to it"
            tooltipAlign="end"
            busy={busy === "toggle"}
            onPress={() => void toggle()}
          />
        ) : resets ? (
          <Button
            theme={theme}
            size="small"
            tone={account.status === "limited" ? "primary" : "secondary"}
            icon="TimerReset"
            label="Use reset"
            accessibilityLabel="Use a banked reset"
            tooltip="Spend a banked reset to refill this account's limits now"
            tooltipAlign="end"
            disabled={!resets.usableNow}
            onPress={() => setConfirmReset(true)}
          />
        ) : null}
      </View>
      <Modal title="Use a banked reset?" open={confirmReset} onOpenChange={setConfirmReset}>
        <Modal.Content>
          <ResetConfirm
            theme={theme}
            store={store}
            account={account}
            onCancel={() => setConfirmReset(false)}
            onFinished={(result) => {
              setConfirmReset(false);
              const { message, variant } = redeemToast(account.label, result);
              if (variant === "error") toast.error(message);
              else toast.show(message, { variant, durationMs: 5_000 });
            }}
          />
        </Modal.Content>
      </Modal>

      {renaming ? (
        <RenameModal theme={theme} account={account} store={store} onClose={() => setRenaming(false)} />
      ) : null}
      <Modal title={`Remove ${account.label}?`} open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Modal.Content>
          <Text style={text.body}>
            {account.family === "claude"
              ? "This signs the account out on this machine and deletes its saved login. Agents using it move to the default account; their conversations are kept."
              : account.family === "codex"
                ? "This signs the account out on this machine and deletes its saved login. New agents use the default account. Existing ChatGPT conversations on it can't move, so start new agents for them."
                : "This signs the account out on this machine and deletes its saved login. New agents use the default account. Existing Antigravity conversations on it can't move to another account, so start new agents for them."}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Keep this account" tooltipAlign="end" onPress={() => setConfirmRemove(false)} />
            <Button
              theme={theme}
              tone="danger"
              icon="Trash2"
              label="Remove"
              tooltip="Sign it out and delete its saved login; its agents move to the default"
              tooltipAlign="end"
              busy={busy === "remove"}
              onPress={() => void remove()}
            />
          </View>
        </Modal.Content>
      </Modal>
    </Card>
  );
}

function ScopedUsage({
  theme,
  usage,
  groups,
  focused,
  onFocus,
}: {
  theme: Theme;
  usage: AccountView["usage"];
  groups: UsageGroup[];
  focused: UsageGroup | null;
  onFocus(id: string): void;
}) {
  const text = useText(theme);
  const note = focused ? groupUsageNote(focused) : null;
  const missing = focused ? groupMissingNote(focused) : null;
  return (
    <View style={{ gap: 12 }}>
      {usage?.cached || usage?.error ? (
        <Text style={text.warning}>
          {usage.cached
            ? usage.error
              ? `Cached reading · last refresh failed: ${usage.error}`
              : "Cached reading · availability isn't verified."
            : `Usage couldn't be read: ${usage.error}`}
        </Text>
      ) : null}

      {groups.length > 1 && focused ? (
        <View style={{ gap: 6 }}>
          <Text style={text.small}>Select a model group</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {groups.map((group) => {
              const selected = group.id === focused.id;
              return (
                <Pressable
                  key={group.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${group.label} usage`}
                  accessibilityState={{ selected }}
                  onPress={() => onFocus(group.id)}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 5,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    backgroundColor: selected ? theme.colors.surface2 : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: selected ? theme.colors.accent : theme.colors.foregroundMuted,
                      fontSize: 12,
                      fontWeight: "600",
                    }}
                  >
                    {groupChipLabel(group.label)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {focused ? (
        <View style={{ padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2, gap: 2 }}>
          <Text style={text.strong}>{focused.label}</Text>
          <Text style={text.small}>
            {groupStatus(focused, usage)}
            {note ? ` · ${note}` : ""}
          </Text>
        </View>
      ) : null}

      {focused ? (
        <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          {focused.windows.map((limit) => <UsageBar key={limit.id} theme={theme} limit={limit} showMissingReset />)}
          {missing ? <Text style={text.small}>{missing}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function RenameModal({
  theme,
  account,
  store,
  onClose,
}: {
  theme: Theme;
  account: AccountView;
  store: ZeroSubStore;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [label, setLabel] = useState(account.label);
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    const next = label.trim();
    if (!next) return;
    setSaving(true);
    try {
      await store.rpc(renameAccount, { accountId: account.id, label: next });
      await store.refresh();
      onClose();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSaving(false);
    }
  }, [label, account.id, store, onClose, toast]);
  const inputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
    }),
    [theme],
  );
  return (
    <Modal title="Rename account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>A short name you'll recognise in the composer, like "Work" or "Personal".</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          autoFocus
          maxLength={40}
          placeholder="Account name"
          placeholderTextColor={theme.colors.foregroundMuted}
          onSubmitEditing={() => void save()}
          style={inputStyle}
          accessibilityLabel="Account name"
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current name" tooltipAlign="end" onPress={onClose} />
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            tooltip="Save the new name"
            tooltipAlign="end"
            busy={saving}
            disabled={!label.trim()}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function Avatar({ theme, label }: { theme: Theme; label: string }) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>{initial}</Text>
    </View>
  );
}

function AutomationSettings({ theme, state, store }: { theme: Theme; state: StateView | null; store: ZeroSubStore }) {
  const settings = useSettings(preferences);
  const text = useText(theme);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  if (settings.status === "loading") return null;
  if (settings.status !== "ready") {
    return <Text style={text.danger}>Preferences unavailable: {settings.error}</Text>;
  }
  const antigravity = familyAvailable(state, "antigravity");
  const antigravitySwitch = supportsFamily(state, "antigravity", "autoSwitch");
  const save = (patch: Partial<typeof settings.values>) => {
    const next = normalizeAntigravityAutoSwitch({ ...settings.values, ...patch }, antigravitySwitch);
    void settings.save(next, settings.revision);
  };
  return (
    <View style={{ gap: 10 }}>
      <Text style={text.heading} accessibilityRole="header">
        Automatic switching
      </Text>
      <SettingsCard>
        <SettingsSwitch
          label="Switch accounts when one hits its limit"
          hint="Claude and ChatGPT agents move to the account with the most room left."
          value={settings.values.autoSwitch}
          disabled={settings.saving}
          onValueChange={(autoSwitch) => save({ autoSwitch })}
        />
        <SettingsSwitch
          label="Keep going after a switch"
          hint="Sends a short follow-up so the interrupted task continues."
          value={settings.values.autoContinue}
          disabled={settings.saving || !settings.values.autoSwitch}
          onValueChange={(autoContinue) => save({ autoContinue })}
        />
        {antigravity ? (
          <SettingsSwitch
            label="Switch Antigravity accounts automatically"
            hint={
              antigravitySwitch
                ? "Off by default. Also requires the main automatic switching setting above."
                : "Off and unavailable on this host until Antigravity account switching is supported and verified."
            }
            value={antigravitySwitch ? settings.values.antigravityAutoSwitch : false}
            disabled={settings.saving || !antigravitySwitch || !settings.values.autoSwitch}
            onValueChange={(antigravityAutoSwitch) => save({ antigravityAutoSwitch })}
          />
        ) : null}
        <SettingsSwitch
          label="Spread new agents across accounts"
          hint="New Claude and ChatGPT agents start on the account with the most room instead of the default."
          value={settings.values.balanceNewAgents}
          disabled={settings.saving}
          onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
        />
        {antigravity ? <>
          <SettingsSwitch
            label="Start new Antigravity agents on the account with the most room"
            hint={settings.values.antigravityBalanceNewAgents && state?.antigravityBalance?.consentRequired
              ? "Support changed; turn this on again to consent. Experimental and limited to new Claude Opus 5.5 high agents."
              : "Experimental: Claude Opus 5.5 high only. Uses the freshest shared group quota; missing quota falls back to the default. Applies only to new agents."}
            value={Boolean(settings.values.antigravityBalanceNewAgents && state?.antigravityBalance && !state.antigravityBalance.consentRequired)}
            disabled={settings.saving || !state?.antigravityBalance?.available || !supportsFamily(state, "antigravity", "balanceNewAgents")}
            onValueChange={(enabled) => {
              const revision = state?.antigravityBalance?.revision;
              setBalanceError(null);
              void (async () => {
                if (!await settings.save({ ...settings.values, antigravityBalanceNewAgents: enabled }, settings.revision)) return;
                if (enabled && revision !== undefined) {
                  try { await store.rpc(consentAntigravityBalance, { revision }); }
                  catch { setBalanceError("Could not confirm consent. Turn the setting on again when support is available."); }
                }
              })();
            }}
          />
          {balanceError ? <Text style={text.danger}>{balanceError}</Text> : null}
        </> : null}
        <SettingsSwitch
          label="Move open agents when the default changes"
          hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
          value={settings.values.moveAgentsOnDefaultChange}
          disabled={settings.saving}
          onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
        />
        <SettingsSwitch
          label="Use banked resets when every account is out"
          hint="Spends one of the account's banked resets instead of stopping. Resets are scarce, so this is off unless you turn it on."
          value={settings.values.autoRedeem}
          disabled={settings.saving || !settings.values.autoSwitch}
          onValueChange={(autoRedeem) => save({ autoRedeem })}
        />
        <SettingsSwitch
          label="When every account is out, fork the chat to the other provider"
          hint="A stopped Claude chat carries on in a new ChatGPT agent, or the other way round, with the conversation so far. The new agent gets no more permissions than the original; the original stays as it was."
          value={settings.values.forkOtherProvider}
          disabled={settings.saving || !settings.values.autoSwitch}
          onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
        />
      </SettingsCard>
      {settings.saveError ? <Text style={text.danger}>{settings.saveError}</Text> : null}
    </View>
  );
}

export function describeReopen(prefix: string, summary: ReopenSummary): string {
  const parts = [prefix];
  if (summary.continuedIn) parts.push(`continuing in “${summary.continuedIn.title}”`);
  if (summary.reopened.length > 0) parts.push(`${summary.reopened.length} agent(s) switched`);
  if (summary.deferred.length > 0) parts.push(`${summary.deferred.length} will switch after their current turn`);
  if (summary.failed.length > 0) parts.push(`${summary.failed.length} will switch on their next restart`);
  return parts.join(" · ");
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
