import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { passwordResetTokens, users } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { z } from "zod";
import { hashServerKey } from "../routes/shared.js";

/**
 * Validità di un link di reset della password: 24 ore. Più corta dei 7 giorni
 * di un invito perché il link vale un account GIÀ esistente, con i suoi dati.
 */
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Policy della password alla CREAZIONE — setup, registrazione, reset, cambio
 * dal profilo. In un posto solo perché quattro copie del «min 8» sono quattro
 * occasioni di farle divergere. Il login non la applica (vedi `/login`).
 */
export const newPasswordSchema = z.string().min(8, "la password deve avere almeno 8 caratteri");

/**
 * Hash del token di reset come lo salva il DB: lo sha256 hex, lo stesso dei
 * PAT (`hashServerKey`). Il token in chiaro esiste solo nell'URL consegnato
 * all'admin, mai in tabella.
 */
export function hashResetToken(token: string): string {
  return hashServerKey(token);
}

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Cancella i link di reset NON usati di un utente. Li chiama chi ne emette uno
 * nuovo (in ogni momento c'è al più un link vivo) e chi cambia la password dal
 * profilo (un link emesso prima riscriverebbe una password che l'utente ha
 * appena scelto). Le righe già usate restano: sono la storia.
 */
export async function revokePendingResetTokens(db: DbOrTx, userId: string): Promise<void> {
  await db
    .delete(passwordResetTokens)
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

/**
 * Emette un link di reset per `userId`, annullando i precedenti, in UNA
 * transazione con la riga dell'utente bloccata (`FOR UPDATE`): due reset
 * concorrenti per lo stesso utente si serializzano e alla fine resta vivo un
 * solo link. Ritorna `null` se l'utente non esiste.
 */
export async function issuePasswordResetToken(
  db: Db,
  userId: string,
  createdByUserId: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!target) return null;
    await revokePendingResetTokens(tx, userId);
    await tx.insert(passwordResetTokens).values({
      userId,
      tokenHash: hashResetToken(token),
      expiresAt,
      createdByUserId,
    });
    return { token, expiresAt };
  });
}

/**
 * Il link VIVO (esiste, non usato, non scaduto) che corrisponde a `token`, con
 * l'email del suo utente; `null` in ogni altro caso, SENZA dire quale: chi
 * chiama risponde allo stesso modo a inesistente, scaduto e usato.
 */
export async function findLiveResetToken(
  db: Db,
  token: string,
): Promise<{ id: string; userId: string; email: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      email: users.email,
      expiresAt: passwordResetTokens.expiresAt,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(passwordResetTokens.userId, users.id))
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashResetToken(token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}
