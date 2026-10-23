/**
 * Prova di possesso del kit di recupero (design «Kit di recupero»; fix della
 * review del Task 7). Senza, «usare il kit» sarebbe solo «full admin con
 * secondo fattore fresco»: un login rubato potrebbe crearsi una chiave e
 * confermarsela da sé con la via di recupero.
 *
 * Il server genera un segreto casuale di 32 byte, lo cifra per la chiave
 * PUBBLICA di recupero con la stessa primitiva dei client
 * (`wrapRecoveryChallenge` di `@stubwise/vault-crypto`) e ne tiene solo
 * l'hash SHA-256, legato a chi l'ha chiesto, alla sua sessione, per 5
 * minuti. Solo chi ha la privata del kit può rimandare il segreto (`proof`).
 * Il kit non arriva mai al server; il segreto sì, ma vale una volta sola.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { vaultRecoveryChallenges, vaultSettings, type Db } from "@stubwise/db";
import type { VaultRecoveryChallengeResponse, VaultRecoveryProof } from "@stubwise/shared";
import { wrapRecoveryChallenge } from "@stubwise/vault-crypto";
import type { SessionUser } from "../auth/session.js";

/** Quanto vale una sfida: 5 minuti. */
export const RECOVERY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hashSecret(secret: Uint8Array): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Crea una sfida per `user` nella sua sessione. `null` = cassaforte non
 * attiva. Pota le sfide scadute (niente job).
 */
export async function createRecoveryChallenge(
  db: Db,
  user: Pick<SessionUser, "id" | "sessionId">,
): Promise<VaultRecoveryChallengeResponse | null> {
  const [settings] = await db.select({ recoveryPublicKey: vaultSettings.recoveryPublicKey }).from(vaultSettings);
  if (!settings || user.sessionId === undefined) return null;
  const challengeId = randomUUID();
  const secret = randomBytes(32);
  const wrapped = await wrapRecoveryChallenge(secret, settings.recoveryPublicKey, challengeId);
  const expiresAt = new Date(Date.now() + RECOVERY_CHALLENGE_TTL_MS);
  await db.delete(vaultRecoveryChallenges).where(lt(vaultRecoveryChallenges.expiresAt, sql`now()`));
  await db.insert(vaultRecoveryChallenges).values({
    id: challengeId,
    userId: user.id,
    sessionId: user.sessionId,
    secretHash: hashSecret(secret),
    expiresAt,
  });
  return { challengeId, wrapped, expiresAt: expiresAt.toISOString() };
}

/**
 * La prova vale: sfida di `user`, della SUA sessione, non scaduta, non usata,
 * e il segreto rimandato ha l'hash salvato. Con `consume` la sfida si segna
 * usata nello stesso UPDATE (uso singolo anche con due richieste in parallelo).
 */
export async function checkRecoveryProof(
  db: Db,
  user: Pick<SessionUser, "id" | "sessionId">,
  proof: VaultRecoveryProof,
  consume: boolean,
): Promise<boolean> {
  if (user.sessionId === undefined) return false;
  const secret = Buffer.from(proof.proof, "base64url");
  if (secret.length !== 32) return false;
  const where = and(
    eq(vaultRecoveryChallenges.id, proof.challengeId),
    eq(vaultRecoveryChallenges.userId, user.id),
    eq(vaultRecoveryChallenges.sessionId, user.sessionId),
    eq(vaultRecoveryChallenges.secretHash, hashSecret(secret)),
    isNull(vaultRecoveryChallenges.usedAt),
    gt(vaultRecoveryChallenges.expiresAt, sql`now()`),
  );
  const rows = consume
    ? await db
        .update(vaultRecoveryChallenges)
        .set({ usedAt: sql`now()` })
        .where(where)
        .returning({ id: vaultRecoveryChallenges.id })
    : await db.select({ id: vaultRecoveryChallenges.id }).from(vaultRecoveryChallenges).where(where);
  return rows.length === 1;
}
