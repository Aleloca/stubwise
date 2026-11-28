import { users, type Db } from "@stubwise/db";
import { userIsFullAdmin, type DbOrTx, type SecurityAlertSubject } from "@stubwise/notifications";
import { and, ne } from "drizzle-orm";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";

/**
 * Avvisi di sicurezza della cassaforte (`security.alert`). Non contengono
 * MAI campi di credenziali: solo il soggetto e, dove serve, chi ha agito. Il
 * link d'apertura resta Impostazioni → Sicurezza (la UI della cassaforte non
 * ha una pagina propria da cui derivarlo).
 */

/** Dove finisce un avviso mancato: una riga di log, mai un errore all'azione. */
export type AlertWarn = (message: string) => void;

const defaultWarn: AlertWarn = (message) => console.warn(message);

/** Alla persona: la sua chiave della cassaforte è stata creata. */
export async function publishVaultKeyCreated(db: DbOrTx, userId: string): Promise<void> {
  await publishSecurityAlert(db, userId, "vault_key_created", null);
}

/**
 * Alla persona: un sigillo della sua chiave è stato aggiunto o sostituito
 * (I7). Non lancia mai: il sigillo è già salvato (e la riga del registro con
 * lui), quindi un avviso mancato è una riga di log, non un 500.
 */
export async function publishVaultSealChanged(
  db: DbOrTx,
  userId: string,
  subject: "vault_seal_added" | "vault_seal_replaced",
  warn: AlertWarn = defaultWarn,
): Promise<void> {
  try {
    await publishSecurityAlert(db, userId, subject, null);
  } catch (error) {
    warn(`[vault] avviso ${subject} non recapitato a ${userId} (${errorText(error)})`);
  }
}

/**
 * Un avviso a OGNI ALTRO full admin (non a chi ha agito), con l'email di chi
 * ha agito. Il predicato «full admin» è `userIsFullAdmin`, l'unica copia. Non
 * lancia mai, e un avviso che fallisce per UN admin non ferma gli altri: ne
 * resta una riga nel log (`warn`).
 */
async function publishToOtherFullAdmins(
  db: DbOrTx,
  actor: { id: string; email: string },
  subject: SecurityAlertSubject,
  warn: AlertWarn,
): Promise<void> {
  let admins: { id: string }[];
  try {
    admins = await (db as Db)
      .select({ id: users.id })
      .from(users)
      .where(and(userIsFullAdmin(users.id), ne(users.id, actor.id)));
  } catch (error) {
    warn(`[vault] avviso ${subject}: lettura dei full admin fallita (${errorText(error)})`);
    return;
  }
  for (const admin of admins) {
    try {
      await publishSecurityAlert(db, admin.id, subject, actor.email);
    } catch (error) {
      warn(`[vault] avviso ${subject} non recapitato all'admin ${admin.id} (${errorText(error)})`);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * C2: una raffica di letture della stessa persona (`REVEAL_BURST`). Avviso a
 * lei (se non è stata lei, se ne accorge) e agli altri full admin, con la sua
 * email. Non lancia mai: la lettura è già avvenuta.
 */
export async function publishVaultRevealBurst(
  db: DbOrTx,
  user: { id: string; email: string },
  warn: AlertWarn = defaultWarn,
): Promise<void> {
  try {
    await recordSecurityEvent(db, { kind: "vault_reveal_burst", user });
    await publishSecurityAlert(db, user.id, "vault_reveal_burst", null);
  } catch (error) {
    warn(`[vault] avviso vault_reveal_burst non recapitato a ${user.id} (${errorText(error)})`);
  }
  await publishToOtherFullAdmins(db, user, "vault_reveal_burst", warn);
}

/** La chiave di recupero è stata usata: avviso agli altri full admin. */
export async function publishVaultRecoveryUsed(
  db: DbOrTx,
  actor: { id: string; email: string },
  warn: AlertWarn = defaultWarn,
): Promise<void> {
  await publishToOtherFullAdmins(db, actor, "vault_recovery_used", warn);
}

/** Il kit di recupero è stato rigenerato (il vecchio non vale più): avviso agli altri full admin. */
export async function publishVaultRecoveryKeyRotated(
  db: DbOrTx,
  actor: { id: string; email: string },
  warn: AlertWarn = defaultWarn,
): Promise<void> {
  await publishToOtherFullAdmins(db, actor, "vault_recovery_key_rotated", warn);
}
