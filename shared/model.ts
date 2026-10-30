import { z } from "zod";

/** The subscription families this plugin manages. Custom provider profiles map onto one of them. */
export const FamilySchema = z.enum(["claude", "codex", "antigravity"]);
export type Family = z.infer<typeof FamilySchema>;

export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  antigravity: "Antigravity",
};

/**
 * A group of models a provider limits together. Providers such as Antigravity report a shared
 * window for several model groups plus separate windows for individual groups, so a window alone
 * doesn't say which model it applies to.
 */
export const UsageScopeSchema = z.object({
  /** Stable provider key for the group, e.g. a bucket's group id. */
  id: z.string(),
  /** The provider's own name for the group. */
  label: z.string(),
  /**
   * Exact CLI model IDs this group covers. Empty means the provider didn't say (automatic
   * matching is unknown); it never means "every model".
   */
  models: z.array(z.string()),
});
export type UsageScope = z.infer<typeof UsageScopeSchema>;

export const UsageWindowSchema = z.object({
  /** Stable key, e.g. `five_hour`, `seven_day`, `seven_day_opus`, `primary`, `secondary`. */
  id: z.string(),
  label: z.string(),
  /** 0–100. */
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  /**
   * Which models this window covers, when the provider reports model-specific limits. Absent for
   * the account-wide windows Claude and Codex report.
   */
  scope: UsageScopeSchema.optional(),
  /** The provider's own period name, e.g. `5h` or `weekly`. */
  period: z.string().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Banked limit resets the provider has granted this account (Claude "limit reset", Codex reset credits). */
export const ResetOfferSchema = z.object({
  /** Resets left to use. */
  available: z.number(),
  /** The provider will accept a redeem right now. */
  usableNow: z.boolean(),
  /** Why it can't be used yet, in plain words, when it can't. */
  blockedReason: z.string().nullable(),
  /** Use-by date of the next reset, if it expires. */
  expiresAt: z.string().nullable(),
  /** Which limits a reset refills, e.g. "5-hour", "weekly". Empty when the provider doesn't say. */
  refills: z.array(z.string()),
  /** The provider's own name for the reset, if it gives one. */
  label: z.string().nullable(),
});
export type ResetOffer = z.infer<typeof ResetOfferSchema>;

export const UsageSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(UsageWindowSchema),
  /** Why usage could not be read, if it could not. Old windows may still be shown. */
  error: z.string().nullable(),
  /** Read from the CLI's own cache rather than the provider, so possibly out of date. */
  cached: z.boolean().default(false),
  /** Banked resets, when the provider reports any. */
  resets: ResetOfferSchema.nullable().default(null),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountKindSchema = z.enum([
  /** The login the CLI uses on its own (`~/.claude`, `~/.codex`). */
  "main",
  /** Created by this plugin: an isolated credential home that shares everything else with main. */
  "managed",
]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

/** `disabled`: the user set it aside for a while; it stays signed in but nothing is routed to it. */
export const AccountStatusSchema = z.enum(["ready", "signed_out", "limited", "checking", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  kind: AccountKindSchema,
  email: z.string().nullable(),
  plan: z.string().nullable(),
  organization: z.string().nullable(),
  status: AccountStatusSchema,
  isDefault: z.boolean(),
  limitedUntil: z.string().nullable(),
  usage: UsageSchema.nullable(),
  agentCount: z.number(),
  home: z.string().nullable(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const AgentRouteSchema = z.object({
  agentId: z.string(),
  family: FamilySchema,
  /** Account the agent uses now, or will use when its session next opens. */
  accountId: z.string(),
  /** Current model of the agent, when Paseo reports it, so usage can be scoped to it. */
  model: z.string().nullable().optional(),
  /** Chosen for this agent explicitly (by the user or an automatic switch) rather than following the default. */
  pinned: z.boolean(),
  /** The live session still runs on a different account and is waiting to be reopened. */
  pendingAccountId: z.string().nullable(),
  /**
   * The conversation can move to another account in place. False for Codex agents that already
   * have history: ChatGPT accounts can't read each other's encrypted reasoning, so switching
   * continues the work in a new agent instead.
   */
  movable: z.boolean(),
});
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const LoginStepSchema = z.enum([
  "starting",
  /** Waiting for the user to finish on the sign-in page (and paste a code, if using `codeUrl`). */
  "waiting",
  "verifying",
  "done",
  "failed",
  "canceled",
]);
export type LoginStep = z.infer<typeof LoginStepSchema>;

export const LoginMethodSchema = z.enum([
  /** Finishes by itself when the link is opened on the daemon machine. */
  "browser",
  /** Works from any device: paste a code back (Claude) or type a code on the page (ChatGPT). */
  "code",
]);
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

/**
 * What ZeroSub can actually do for a family here. A family being in `FamilySchema` doesn't mean
 * every account, login or failover path is implemented for it yet.
 */
export const FamilyCapabilitiesSchema = z.object({
  balanceNewAgents: z.boolean().optional(),
  /** Isolated credential homes can be created and routed per account. */
  managedAccounts: z.boolean(),
  /** Sign-in flows this deployment can complete. */
  loginMethods: z.array(LoginMethodSchema),
  /** Accounts can move automatically when a limit is reached. */
  autoSwitch: z.boolean(),
  /** Banked resets can be listed or spent. */
  resets: z.boolean(),
  /** Work can be handed to this family from another provider. */
  fork: z.boolean(),
});
export type FamilyCapabilities = z.infer<typeof FamilyCapabilitiesSchema>;

export const LoginViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  method: LoginMethodSchema,
  /** Set once the account exists (immediately when signing an existing account back in). */
  accountId: z.string().nullable(),
  step: LoginStepSchema,
  /** Link that completes by itself (browser callback) or the device-code page. */
  url: z.string().nullable(),
  /** Link whose page shows a code to paste back; works from any device. */
  codeUrl: z.string().nullable(),
  /** Device code the user types on the sign-in page (ChatGPT device flow). */
  userCode: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
});
export type LoginView = z.infer<typeof LoginViewSchema>;

export const StateViewSchema = z.object({
  accounts: z.array(AccountViewSchema),
  agents: z.array(AgentRouteSchema),
  logins: z.array(LoginViewSchema),
  /** Paseo provider IDs (including custom profiles) that route through each family. */
  providers: z.record(z.string(), FamilySchema),
  /**
   * What this deployment can do for each family, keyed by family id. Missing families use their
   * safe defaults rather than assuming every account feature works.
   */
  capabilities: z.record(z.string(), FamilyCapabilitiesSchema).default({}),
  antigravityBalance: z.object({
    supported: z.boolean(),
    available: z.boolean(),
    consentRequired: z.boolean(),
    revision: z.number().int().nonnegative(),
  }).optional(),
  /** Live sessions can be reopened on another account without waiting for the next session start. */
  canReopen: z.boolean(),
  /**
   * A browser on the daemon's machine can finish a sign-in by itself. False on servers, containers
   * and daemons started over SSH, where only the code sign-in works.
   */
  browserSignIn: z.boolean().default(true),
  showComposerPill: z.boolean(),
  warnings: z.array(z.string()),
});
export type StateView = z.infer<typeof StateViewSchema>;
