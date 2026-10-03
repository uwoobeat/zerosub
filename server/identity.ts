/**
 * Codex identity keys. A ChatGPT Business/Team workspace has one account (workspace) ID shared by
 * every member, so the key pairs it with the member's email. Codex's app-server exposes no member
 * ID, and reading one out of the CLI's token file would mean handling credentials ZeroSub must not.
 */

const WORKSPACE = "chatgpt|";

/** The key for a ChatGPT login: workspace plus member, or the best fallback the CLI gives. */
export function codexIdentityKey(accountId: string | null, email: string | null, plan: string | null): string | null {
  const member = email?.trim().toLowerCase() || null;
  if (accountId && member) return `${WORKSPACE}${accountId}|${member}`;
  // Without the email two members of one workspace can't be told apart; keep them one account.
  if (accountId) return `${WORKSPACE}${accountId}`;
  // Without the workspace ID, email plus plan still tells a personal plan from a workspace.
  if (member) return `chatgpt-email|${member}|${plan ?? "unknown"}`;
  return null;
}

/** `chatgpt|<workspace>` and `chatgpt|<workspace>|<member>` as parts, or null for other keys. */
function workspaceKey(key: string): { workspace: string; member: string | null } | null {
  if (!key.startsWith(WORKSPACE)) return null;
  const [workspace, member, ...rest] = key.slice(WORKSPACE.length).split("|");
  if (!workspace || rest.length > 0) return null;
  return { workspace, member: member || null };
}

/**
 * Whether a stored account and a fresh sign-in are the same login. Accounts saved before member
 * keys existed hold only the workspace ID; their saved email stands in for the member, and
 * `unknown` means there is no way to tell, so callers neither reject nor merge on it.
 */
export function identityRelation(
  stored: string,
  storedEmail: string | null,
  fresh: string,
): "same" | "different" | "unknown" {
  if (stored === fresh) return "same";
  const before = workspaceKey(stored);
  const after = workspaceKey(fresh);
  if (!before || !after) return "different";
  if (before.workspace !== after.workspace) return "different";
  const beforeMember = before.member ?? storedEmail?.trim().toLowerCase() ?? null;
  if (!beforeMember || !after.member) return "unknown";
  return beforeMember === after.member ? "same" : "different";
}
