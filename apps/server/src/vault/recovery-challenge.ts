/**
 * Prove di possesso della cassaforte: del kit di recupero (design «Kit di
 * recupero»; fix della review del Task 7) e della propria chiave di persona
 * (review finale). Senza la prima, «usare il kit» sarebbe solo «full admin
 * con secondo fattore fresco»; senza la seconda, un login rubato (anche di un
 * full admin) confermerebbe una chiave fantoccio, condividerebbe con un
 * complice o ruoterebbe il kit senza avere nessuna chiave della cassaforte.
 *
 * Il server genera un segreto casuale di 32 byte, lo cifra con la stessa
 * primitiva dei client — per la chiave PUBBLICA di recupero
 * (`wrapRecoveryChallenge`) o per la pubblica della chiave CONFERMATA di chi
 * chiede (`wrapActorChallenge`, AAD distinto) — e ne tiene solo l'hash
 * SHA-256, legato a chi l'ha chiesto, alla sua sessione e (per la chiave di
 * persona) a QUELLA chiave, per 5 minuti. Solo chi ha la privata può
 * rimandare il segreto (`proof`). Le due specie stanno nella stessa tabella
 * (`kind`) e non si scambiano: una prova vale solo per la sua specie. Kit e
 * chiave privata non arrivano mai al server; il segreto sì, ma vale una volta.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { vaultPersonKeys, vaultRecoveryChallenges, vaultSettings, type Db } from "@stubwise/db";
import type {
  VaultActorChallengeResponse,
  VaultActorProof,
  VaultRecoveryChallengeResponse,
  VaultRecoveryProof,
} from "@stubwise/shared";
import { wrapActorChallenge, wrapRecoveryChallenge } from "@stubwise/vault-crypto";
import type { SessionUser } from "../auth/session.js";
import { currentPersonKey } from "./readers.js";

/** Quanto vale una sfida: 5 minuti. */
export const RECOVERY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

type Asker = Pick<SessionUser, "id" | "sessionId">;

function hashSecret(secret: Uint8Array): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Salva una sfida (solo l'hash del segreto) e pota le scadute (niente job). */
async function storeChallenge(
  db: Db,
  values: { id: string; userId: string; sessionId: string; secret: Uint8Array; expiresAt: Date } & (
    | { kind: "recovery" }
    | { kind: "actor"; personKeyId: string }
  ),
): Promise<void> {
  await db.delete(vaultRecoveryChallenges).where(lt(vaultRecoveryChallenges.expiresAt, sql`now()`));
  await db.insert(vaultRecoveryChallenges).values({
    id: values.id,
    userId: values.userId,
    sessionId: values.sessionId,
    secretHash: hashSecret(values.secret),
    expiresAt: values.expiresAt,
    kind: values.kind,
    personKeyId: values.kind === "actor" ? values.personKeyId : null,
  });
}

/**
 * Crea una sfida del kit per `user` nella sua sessione. `null` = cassaforte
 * non attiva.
 */
export async function createRecoveryChallenge(db: Db, user: Asker): Promise<VaultRecoveryChallengeResponse | null> {
  const [settings] = await db.select({ recoveryPublicKey: vaultSettings.recoveryPublicKey }).from(vaultSettings);
  if (!settings || user.sessionId === undefined) return null;
  const challengeId = randomUUID();
  const secret = randomBytes(32);
  const wrapped = await wrapRecoveryChallenge(secret, settings.recoveryPublicKey, challengeId);
  const expiresAt = new Date(Date.now() + RECOVERY_CHALLENGE_TTL_MS);
  await storeChallenge(db, { id: challengeId, userId: user.id, sessionId: user.sessionId, secret, expiresAt, kind: "recovery" });
  return { challengeId, wrapped, expiresAt: expiresAt.toISOString() };
}

/**
 * Crea una sfida per la chiave CONFERMATA di `user`, nella sua sessione.
 * `vault_not_active` = cassaforte non attiva; `no_confirmed_key` = la persona
 * non ha una chiave confermata (in attesa, rifiutata o assente): non ha
 * niente da provare, e nessuna delle azioni che la prova sblocca le spetta.
 */
export async function createActorChallenge(
  db: Db,
  user: Asker,
): Promise<
  | { ok: true; value: VaultActorChallengeResponse }
  | { ok: false; error: "vault_not_active" | "no_confirmed_key" }
> {
  const [settings] = await db.select({ id: vaultSettings.id }).from(vaultSettings);
  if (!settings || user.sessionId === undefined) return { ok: false, error: "vault_not_active" };
  const key = await currentPersonKey(db, user.id);
  if (!key || key.status !== "confirmed") return { ok: false, error: "no_confirmed_key" };
  const challengeId = randomUUID();
  const secret = randomBytes(32);
  const wrapped = await wrapActorChallenge(secret, key.publicKey, challengeId, key.id);
  const expiresAt = new Date(Date.now() + RECOVERY_CHALLENGE_TTL_MS);
  await storeChallenge(db, {
    id: challengeId,
    userId: user.id,
    sessionId: user.sessionId,
    secret,
    expiresAt,
    kind: "actor",
    personKeyId: key.id,
  });
  return { ok: true, value: { challengeId, personKeyId: key.id, wrapped, expiresAt: expiresAt.toISOString() } };
}

/** Le condizioni comuni di una prova valida: chi, quale sessione, segreto, non usata, non scaduta. */
function proofConditions(user: Asker & { sessionId: string }, proof: { challengeId: string }, secret: Buffer) {
  return [
    eq(vaultRecoveryChallenges.id, proof.challengeId),
    eq(vaultRecoveryChallenges.userId, user.id),
    eq(vaultRecoveryChallenges.sessionId, user.sessionId),
    eq(vaultRecoveryChallenges.secretHash, hashSecret(secret)),
    isNull(vaultRecoveryChallenges.usedAt),
    gt(vaultRecoveryChallenges.expiresAt, sql`now()`),
  ];
}

function secretOf(proof: { proof: string }): Buffer | null {
  const secret = Buffer.from(proof.proof, "base64url");
  return secret.length === 32 ? secret : null;
}

/**
 * La prova del kit vale: sfida del kit di `user`, della SUA sessione, non
 * scaduta, non usata, e il segreto rimandato ha l'hash salvato. Con `consume`
 * la sfida si segna usata nello stesso UPDATE (uso singolo anche con due
 * richieste in parallelo).
 */
export async function checkRecoveryProof(
  db: Db,
  user: Asker,
  proof: VaultRecoveryProof,
  consume: boolean,
): Promise<boolean> {
  if (user.sessionId === undefined) return false;
  const secret = secretOf(proof);
  if (!secret) return false;
  const where = and(
    ...proofConditions({ ...user, sessionId: user.sessionId }, proof, secret),
    eq(vaultRecoveryChallenges.kind, "recovery"),
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

/**
 * La prova della propria chiave vale — e si CONSUMA, sempre (una sfida per
 * azione): sfida di persona di `user`, della SUA sessione, non scaduta, non
 * usata, col segreto giusto, e per la chiave che è ANCORA la sua chiave
 * confermata (una chiave ricreata o rifiutata nel frattempo non prova nulla).
 */
export async function consumeActorProof(db: Db, user: Asker, proof: VaultActorProof): Promise<boolean> {
  if (user.sessionId === undefined) return false;
  const secret = secretOf(proof);
  if (!secret) return false;
  const rows = await db
    .update(vaultRecoveryChallenges)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        ...proofConditions({ ...user, sessionId: user.sessionId }, proof, secret),
        eq(vaultRecoveryChallenges.kind, "actor"),
        sql`exists (
          select 1 from ${vaultPersonKeys} ac_k
          where ac_k.id = ${vaultRecoveryChallenges.personKeyId}
            and ac_k.user_id = ${user.id}::uuid
            and ac_k.status = 'confirmed'
        )`,
      ),
    )
    .returning({ id: vaultRecoveryChallenges.id });
  return rows.length === 1;
}
