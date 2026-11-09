import { isHumanId, reauthRefusal, refuse } from "../admin/common";
import { INSTANCE_ORIGIN } from "../admin/secrets";
import { now } from "../store";
import { writer } from "../writer";
import { issueToken } from "./tokens";
import type { MeResult } from "./types";

// Claude Code (area 9a, Preferenze): il comando d'installazione monouso con
// il token dentro. Crea un token nuovo (+R, come `createToken`: maintainer,
// 29 ott 2026) e lo mostra una volta, dentro il comando. Rifarlo crea un
// altro comando con un altro token; quello vecchio vale finché non lo si
// revoca in Tokens.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Il comando, nella stessa forma del web (`buildInstallCommand` di
 * `apps/web/src/routes/settings/claude-code.tsx`): marketplace, plugin,
 * poi `setup` per ultimo, con l'url dell'istanza e il token.
 */
export function buildInstallCommand(url: string, token: string): string {
  return `claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins && claude plugin install stubwise@stubwise && npx -y @stubwise/mcp@latest setup --url ${url} --token ${token}`;
}

/** Il nome del token del comando: «Claude Code · Oct 29». */
export function claudeCodeTokenName(at: string): string {
  const d = new Date(at);
  return `Claude Code · ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Crea il comando (+R) e il suo token: tutt'e due si vedono solo qui. */
export async function createClaudeCodeCommand(): Promise<
  MeResult<{ command: string; tokenId: string; tokenName: string }>
> {
  const me = await writer("me.createClaudeCodeCommand");
  if (!isHumanId(me)) return refuse.forbidden();
  const reauth = reauthRefusal(me, "me.createClaudeCodeCommand");
  if (reauth) return reauth;
  const tokenName = claudeCodeTokenName(now());
  const { tokenId, token } = issueToken(me, tokenName, null);
  return { ok: true, command: buildInstallCommand(INSTANCE_ORIGIN, token), tokenId, tokenName };
}
