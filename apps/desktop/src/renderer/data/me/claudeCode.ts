import { isHumanId, reauthRefusal, refuse } from "../admin/common";
import { INSTANCE_ORIGIN } from "../admin/secrets";
import { now } from "../store";
import { writer } from "../writer";
import { issueToken } from "./tokens";
import { buildInstallCommand, claudeCodeTokenName } from "./claudeCodeCommand";
import type { MeResult } from "./types";

// Claude Code (area 9a, Preferenze): il comando d'installazione monouso con
// il token dentro. Crea un token nuovo (+R, come `createToken`: maintainer,
// 29 ott 2026) e lo mostra una volta, dentro il comando. Rifarlo crea un
// altro comando con un altro token; quello vecchio vale finché non lo si
// revoca in Tokens.

export { buildInstallCommand, claudeCodeTokenName } from "./claudeCodeCommand";
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
