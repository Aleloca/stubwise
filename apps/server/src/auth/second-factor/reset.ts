import { and, eq, isNotNull } from "drizzle-orm";
import { personalAccessTokens, sessions, userBackupCodes, userPasskeys, users, userTotp, type Db } from "@stubwise/db";
import { publishSecurityAlert } from "./alerts.js";
import { recordSecurityEvent } from "./security-events.js";
import { personObject, recordChange } from "../../services/change-log.js";

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
/**
 * La persona ha un secondo fattore da azzerare: un'app CONFERMATA o una
 * passkey (area 9, F1). La stessa domanda per la rotta del reset (409
 * `no_second_factor`) e per la pagina della persona (`actions.resetSecondFactor`).
 */
export async function hasSecondFactor(db: Pick<Db, "select">, userId: string): Promise<boolean> {
  const [totp] = await db.select({ userId: userTotp.userId }).from(userTotp).where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
  if (totp) return true;
  const [passkey] = await db.select({ userId: userPasskeys.userId }).from(userPasskeys).where(eq(userPasskeys.userId, userId)).limit(1);
  return passkey !== undefined;
}

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
    // La riconferma dal desktop non sopravvive all'azzeramento (i token restano).
    await tx
      .update(personalAccessTokens)
      .set({ secondFactorAt: null })
      .where(eq(personalAccessTokens.userId, target.id));
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
    // Area 9, F2: la voce del registro; lo script di recupero (senza id) è il sistema.
    await recordChange(tx, {
      type: "person.second_factor_reset",
      actor: actor.id ? { id: actor.id, email: actor.email } : "system",
      projectId: null,
      data: { object: personObject(target) },
    });
    await publishSecurityAlert(tx, target.id, "second_factor_reset", actor.email);
  });
}
