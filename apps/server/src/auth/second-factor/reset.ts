import { eq } from "drizzle-orm";
import { sessions, userBackupCodes, userPasskeys, users, userTotp, type Db } from "@stubwise/db";
import { publishSecurityAlert } from "./alerts.js";
import { recordSecurityEvent } from "./security-events.js";

/**
 * Azzera il secondo fattore di `target` per conto di `actor`: app, passkey,
 * codici di riserva, il tetto dei tentativi e TUTTE le sessioni della persona
 * (al login successivo riconfigura). I token personali restano: come per il
 * rilascio, «i token restano» (design, «Recupero»).
 *
 * Lo usano il reset da chi gestisce gli utenti (`DELETE
 * /api/users/:id/second-factor`) e lo script di recupero
 * (`scripts/reset-second-factor.ts`, `actor.id` null). Cancellazione, riga
 * del registro e avviso stanno nella stessa transazione: nascono o non
 * nascono insieme.
 */
export async function resetSecondFactor(
  db: Db,
  target: { id: string; email: string },
  actor: { id: string | null; email: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(userTotp).where(eq(userTotp.userId, target.id));
    await tx.delete(userPasskeys).where(eq(userPasskeys.userId, target.id));
    await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, target.id));
    await tx.delete(sessions).where(eq(sessions.userId, target.id));
    // Un blocco per codici sbagliati fermerebbe anche la configurazione nuova.
    await tx
      .update(users)
      .set({
        secondFactorFailures: 0,
        secondFactorLockedUntil: null,
        secondFactorReservedAt: null,
      })
      .where(eq(users.id, target.id));
    await recordSecurityEvent(tx, { kind: "second_factor_reset", user: target, actor });
    await publishSecurityAlert(tx, target.id, "second_factor_reset", actor.email);
  });
}
