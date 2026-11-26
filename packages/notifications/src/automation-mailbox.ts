import { googleAccounts, type Db } from "@stubwise/db";
import { googleOauthScopes } from "@stubwise/shared";
import { asc, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Lo scope con cui una casella manda posta (area 6, F3: `gmail.modify`; lo
 * stesso di `GMAIL_MODIFY_SCOPE` di `@stubwise/google`, che questo package non
 * importa: un test del server li tiene uguali).
 */
export const MAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Gli scope con cui una casella si legge: `gmail.modify` o, per una casella di prima, `gmail.readonly`. */
export const MAIL_READ_SCOPES: readonly string[] = [MAIL_SEND_SCOPE, "https://www.googleapis.com/auth/gmail.readonly"];

/** Gli scope dell'area che la casella non ha concesso (come `missingGoogleScopes`). */
const missingScopes = (granted: readonly string[]) => googleOauthScopes.filter((s) => s !== "openid" && s !== "email" && !granted.includes(s));

/**
 * La casella di un'automazione, vista per il proprietario (area 7, F2): la
 * sola regola, letta dalle rotte (accendere e pubblicare, il contesto della
 * prova) e dall'esecutore (la casella persa a metà, F2-4). I motivi sono quelli
 * di `OwnerMailbox` del motore condiviso (`automations/email.ts`).
 *
 * - `chosen` non nullo: la casella scelta all'accensione; deve essere ANCORA
 *   del proprietario (`chosen_gone` se no: `mailbox_owner`, nessuna automazione
 *   scrive dalla casella di un altro), non disabilitata (`expired`) e con lo
 *   scope d'invio (`no_scope`).
 * - `chosen` nullo: la prima casella utilizzabile del proprietario, per la
 *   prova di una bozza; `none` se non ne ha, altrimenti il motivo della prima.
 */
export type AutomationMailbox =
  | { ok: true; accountId: string; address: string }
  | { ok: false; reason: "chosen_gone" | "none" | "expired" | "no_scope" | "no_read_scope"; missingScopes?: string[] };

/**
 * `need`: cosa ci fa l'automazione (review del renderer, F2). Mandare vuole
 * `gmail.modify` (`no_scope`); ascoltare soltanto basta la lettura
 * (`no_read_scope` se manca anche quella). Di default: mandare.
 */
export async function automationMailboxOf(db: Db | Tx, ownerId: string, chosen: string | null, need: { send: boolean } = { send: true }): Promise<AutomationMailbox> {
  const t = db as Db;
  const rows = await t
    .select({ id: googleAccounts.id, userId: googleAccounts.userId, email: googleAccounts.email, scopes: googleAccounts.scopes, disabledAt: googleAccounts.disabledAt })
    .from(googleAccounts)
    .where(chosen ? eq(googleAccounts.id, chosen) : eq(googleAccounts.userId, ownerId))
    .orderBy(asc(googleAccounts.connectedAt));
  const judge = (r: (typeof rows)[number]): AutomationMailbox => {
    if (r.disabledAt) return { ok: false, reason: "expired" };
    if (need.send && !r.scopes.includes(MAIL_SEND_SCOPE)) return { ok: false, reason: "no_scope", missingScopes: missingScopes(r.scopes) };
    if (!need.send && !MAIL_READ_SCOPES.some((x) => r.scopes.includes(x))) return { ok: false, reason: "no_read_scope", missingScopes: missingScopes(r.scopes) };
    return { ok: true, accountId: r.id, address: r.email };
  };
  if (chosen) {
    const r = rows[0];
    if (!r || r.userId !== ownerId) return { ok: false, reason: "chosen_gone" };
    return judge(r);
  }
  if (rows.length === 0) return { ok: false, reason: "none" };
  const verdicts = rows.map(judge);
  return verdicts.find((v) => v.ok) ?? verdicts[0]!;
}
