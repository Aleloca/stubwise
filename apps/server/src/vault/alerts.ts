import { users, type Db } from "@stubwise/db";
import { userIsFullAdmin, type DbOrTx } from "@stubwise/notifications";
import { and, ne } from "drizzle-orm";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";

/**
 * Avvisi di sicurezza della cassaforte (`security.alert`). Non contengono
 * MAI campi di credenziali: solo il soggetto e, dove serve, chi ha agito. Il
 * link d'apertura resta Impostazioni → Sicurezza (la UI della cassaforte non
 * ha una pagina propria da cui derivarlo).
 */

/** Alla persona: la sua chiave della cassaforte è stata creata. */
export async function publishVaultKeyCreated(db: DbOrTx, userId: string): Promise<void> {
  await publishSecurityAlert(db, userId, "vault_key_created", null);
}

/**
 * La chiave di recupero è stata usata: un avviso a OGNI ALTRO full admin (non
 * a chi l'ha usata), con l'email di chi ha agito. Il predicato «full admin»
 * è `userIsFullAdmin`, l'unica copia. Non lancia mai.
 */
export async function publishVaultRecoveryUsed(
  db: DbOrTx,
  actor: { id: string; email: string },
): Promise<void> {
  try {
    const admins = await (db as Db)
      .select({ id: users.id })
      .from(users)
      .where(and(userIsFullAdmin(users.id), ne(users.id, actor.id)));
    for (const admin of admins) {
      await publishSecurityAlert(db, admin.id, "vault_recovery_used", actor.email);
    }
  } catch {
    // un avviso mancato non fa fallire l'azione che lo genera
  }
}
