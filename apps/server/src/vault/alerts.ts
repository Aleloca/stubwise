import { users, type Db } from "@stubwise/db";
import { userIsFullAdmin, type DbOrTx, type SecurityAlertSubject } from "@stubwise/notifications";
import { and, ne } from "drizzle-orm";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";

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
