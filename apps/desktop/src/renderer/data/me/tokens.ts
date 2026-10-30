import { accessState } from "../access/index";
import { isHumanId, reauthRefusal, refuse } from "../admin/common";
import { forgetSecret, matchSecret, storeSecret } from "../admin/secrets";
import {
  getSessionCredential,
  getSessionPersonId,
  setSessionCredential,
  setSessionPersonId,
} from "../session";
import { gate, newId, now, state } from "../store";
import { writer } from "../writer";
import { logSecurity } from "./securityLog";
import type { MeResult, PersonalToken, TokenView } from "./types";

// I token personali (area 9a, Preferenze → Tokens): crearne uno (+R) lo
// mostra una volta (`stw_pat_…`), l'elenco dice nome, date e ultimo uso,
// MAI il valore, nemmeno troncato. Revocare lo fa smettere di valere.
//
// `callWithToken` simula un tool che chiama via PAT (Claude Code col plugin):
// è l'unica strada per una chiamata «da token» nel prototipo, e serve a
// provare che un PAT non soddisfa mai la riconferma (`second-factor.md`).

const NAME_MAX = 100;

const isExpired = (t: PersonalToken): boolean =>
  t.expiresAt !== null && Date.parse(t.expiresAt) <= Date.parse(now());

/** I miei token, i più recenti prima: mai il valore. */
export async function listTokens(): Promise<TokenView[]> {
  const me = await gate("me.listTokens");
  return state.tokens
    .filter((t) => t.personId === me)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      expired: isExpired(t),
      lastUsedAt: t.lastUsedAt,
    }));
}

/**
 * Crea un token senza cancello né controlli: lo usano `createToken` e
 * `createClaudeCodeCommand`, dopo averli fatti. Il valore torna solo qui.
 */
export function issueToken(
  personId: string,
  name: string,
  expiresAt: string | null,
): { tokenId: string; token: string } {
  const id = newId("pat");
  const { id: secretId, value } = storeSecret("pat", personId);
  state.tokens.push({
    id,
    personId,
    name,
    createdAt: now(),
    expiresAt,
    lastUsedAt: null,
    secretId,
  });
  logSecurity(personId, "token_created", null);
  return { tokenId: id, token: value };
}

/**
 * Crea un token (+R) con nome e scadenza facoltativa (`null` = non scade;
 * nel passato: `invalid: expires_past`). Il valore torna una volta.
 */
export async function createToken(input: {
  name: string;
  expiresAt: string | null;
}): Promise<MeResult<{ tokenId: string; token: string }>> {
  const me = await writer("me.createToken");
  if (!isHumanId(me)) return refuse.forbidden();
  const name = input.name.trim();
  if (!name || name.length > NAME_MAX) return refuse.invalid("name");
  if (input.expiresAt !== null) {
    const at = Date.parse(input.expiresAt);
    if (Number.isNaN(at)) return refuse.invalid("expires");
    if (at <= Date.parse(now())) return refuse.invalid("expires_past");
  }
  const reauth = reauthRefusal(me, "me.createToken");
  if (reauth) return reauth;
  return { ok: true, ...issueToken(me, name, input.expiresAt) };
}

/** Revoca un mio token: il valore si dimentica e smette di valere. */
export async function revokeToken(id: string): Promise<MeResult> {
  const me = await writer("me.revokeToken");
  const token = state.tokens.find((t) => t.id === id && t.personId === me);
  if (!token) return refuse.notFound();
  if (token.secretId) forgetSecret(token.secretId);
  state.tokens = state.tokens.filter((t) => t.id !== id);
  logSecurity(me, "token_revoked", null);
  return { ok: true };
}

/**
 * SOLO PROTOTIPO: esegue `call` come la farebbe un tool via PAT. Il token
 * dev'essere custodito, non revocato né scaduto, e di una persona attiva;
 * altrimenti `unauthorized`, senza eseguire. Per la durata della chiamata la
 * sessione è quella del titolare, marcata `pat`: `requireReauth` risponde
 * `reauth_required` anche se il titolare si è appena riconfermato.
 */
export async function callWithToken<T>(token: string, call: () => Promise<T>): Promise<T> {
  const match = matchSecret("pat", token);
  const row = match && state.tokens.find((t) => t.secretId === match.id);
  const owner = row && accessState().people.find((p) => p.personId === row.personId);
  if (!row || isExpired(row) || owner?.status !== "active") throw new Error("unauthorized");
  row.lastUsedAt = now();
  const before = { personId: getSessionPersonId(), credential: getSessionCredential() };
  setSessionPersonId(row.personId);
  setSessionCredential("pat");
  try {
    return await call();
  } finally {
    setSessionPersonId(before.personId);
    setSessionCredential(before.credential);
  }
}
