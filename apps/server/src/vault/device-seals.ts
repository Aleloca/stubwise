import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  personalAccessTokens,
  vaultDevicePairings,
  vaultDeviceSeals,
  vaultPersonKeys,
  vaultSettings,
  type Db,
  type VaultDeviceSealRevokedReason,
} from "@stubwise/db";
import type {
  VaultDevicePairingBody,
  VaultDevicePairingLookupResponse,
  VaultDevicePairingResponse,
  VaultDeviceSealBody,
  VaultDeviceSealItem,
  VaultDeviceSealMine,
} from "@stubwise/shared";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";
import type { SessionUser } from "../auth/session.js";
import { currentPersonKey } from "./readers.js";
import { consumeActorProof } from "./recovery-challenge.js";

/**
 * Il sigillo del dispositivo: la cassaforte dal desktop, lato server (lotto
 * 10, `docs/plans/2026-11-24-cassaforte-desktop-design.md` §6 e §8).
 *
 * - L'associazione la chiede il main COL SUO PAT desktop
 *   ({@link createPairing}); il browser la legge per `state`
 *   ({@link lookupPairing}) e la completa con la passkey e la prova della
 *   propria chiave ({@link createSeal}). PAT e pubblica del Mac li prende il
 *   server dall'associazione, mai dal corpo.
 * - Il server non apre MAI il sigillo: è una busta opaca come le altre.
 * - Un sigillo vale a LETTURA solo se non è revocato, se è legato al PAT che
 *   chiede e se la sua chiave di persona è ANCORA quella confermata della
 *   persona ({@link liveSealCondition}): una chiave ricreata o rifiutata, un PAT
 *   sparito (cascata) lo spengono senza riscrivere la riga.
 * - Togliere un Mac toglie il SOLO sigillo (D-5): il PAT desktop resta.
 */

/** Dieci minuti: il tempo di passare dalla finestra del Mac al browser e confrontare l'impronta. */
export const PAIRING_TTL_MS = 10 * 60_000;

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Actor = Pick<SessionUser, "id" | "email" | "sessionId" | "patId">;

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** La condizione di un sigillo VIVO: non revocato e con la chiave di persona confermata (quella attuale). La usa anche `device-access.ts`. */
export function liveSealCondition() {
  return and(
    isNull(vaultDeviceSeals.revokedAt),
    sql`exists (
      select 1 from ${vaultPersonKeys} ds_k
      where ds_k.id = ${vaultDeviceSeals.personKeyId}
        and ds_k.user_id = ${vaultDeviceSeals.userId}
        and ds_k.status = 'confirmed'
    )`,
  );
}

async function vaultActive(db: DbOrTx): Promise<boolean> {
  const [settings] = await db.select({ id: vaultSettings.id }).from(vaultSettings);
  return settings !== undefined;
}

/**
 * Il main chiede di associare il Mac (PAT desktop, già verificato dalla
 * rotta). Una nuova associazione dallo stesso PAT annulla quelle non usate.
 */
export async function createPairing(
  db: Db,
  user: Actor & { patId: string },
  body: VaultDevicePairingBody,
): Promise<{ ok: true; value: VaultDevicePairingResponse } | { ok: false; error: "vault_not_active" }> {
  if (!(await vaultActive(db))) return { ok: false, error: "vault_not_active" };
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  const row = await db.transaction(async (tx) => {
    await tx
      .delete(vaultDevicePairings)
      .where(and(eq(vaultDevicePairings.patId, user.patId), isNull(vaultDevicePairings.usedAt)));
    const [created] = await tx
      .insert(vaultDevicePairings)
      .values({
        userId: user.id,
        patId: user.patId,
        stateHash: hashState(state),
        devicePublicKey: body.devicePublicKey,
        deviceName: body.deviceName,
        expiresAt,
      })
      .returning({ id: vaultDevicePairings.id });
    return created!;
  });
  return { ok: true, value: { state, deviceId: row.id, expiresAt: expiresAt.toISOString() } };
}

/** Le condizioni di un'associazione usabile: di chi chiede, non usata, non scaduta (il PAT c'è: cascata). */
function usablePairing(userId: string, state: string) {
  return and(
    eq(vaultDevicePairings.stateHash, hashState(state)),
    eq(vaultDevicePairings.userId, userId),
    isNull(vaultDevicePairings.usedAt),
    gt(vaultDevicePairings.expiresAt, sql`now()`),
  );
}

/** Il browser legge l'associazione: `null` se non è sua, scaduta, usata o inesistente (stessa risposta). */
export async function lookupPairing(
  db: Db,
  userId: string,
  state: string,
): Promise<VaultDevicePairingLookupResponse | null> {
  const [row] = await db
    .select({
      deviceId: vaultDevicePairings.id,
      deviceName: vaultDevicePairings.deviceName,
      devicePublicKey: vaultDevicePairings.devicePublicKey,
      expiresAt: vaultDevicePairings.expiresAt,
    })
    .from(vaultDevicePairings)
    .where(usablePairing(userId, state));
  return row ? { ...row, expiresAt: row.expiresAt.toISOString() } : null;
}

export type CreateSealError = "vault_key_not_confirmed" | "vault_proof_invalid" | "pairing_invalid";

/**
 * Il browser sigilla (sessione con riconferma, già verificata dalla rotta).
 * In ordine: la chiave di chi sigilla è CONFERMATA; la prova della propria
 * chiave vale (si consuma); poi, in UNA transazione, l'associazione (sua, non
 * usata, non scaduta, dello stesso `deviceId`, con un PAT desktop della STESSA
 * persona) si consuma, il sigillo vivo di quel PAT diventa `replaced`, il
 * nuovo si scrive legato alla chiave confermata attuale. Ogni rifiuto: niente
 * scritto (la prova, se valida, resta consumata: una per azione).
 */
export async function createSeal(
  db: Db,
  user: Actor,
  body: VaultDeviceSealBody,
): Promise<{ ok: true; value: { id: string; deviceName: string; createdAt: string } } | { ok: false; error: CreateSealError }> {
  const key = await currentPersonKey(db, user.id);
  if (!key || key.status !== "confirmed") return { ok: false, error: "vault_key_not_confirmed" };
  if (!(await consumeActorProof(db, user, body.actorProof))) return { ok: false, error: "vault_proof_invalid" };
  const outcome = await db.transaction(async (tx) => {
    const [pairing] = await tx
      .select({
        id: vaultDevicePairings.id,
        patId: vaultDevicePairings.patId,
        devicePublicKey: vaultDevicePairings.devicePublicKey,
        deviceName: vaultDevicePairings.deviceName,
      })
      .from(vaultDevicePairings)
      .innerJoin(personalAccessTokens, eq(personalAccessTokens.id, vaultDevicePairings.patId))
      .where(
        and(
          usablePairing(user.id, body.pairingState),
          eq(personalAccessTokens.userId, user.id),
          eq(personalAccessTokens.kind, "desktop"),
        ),
      )
      .for("update", { of: vaultDevicePairings });
    if (!pairing || pairing.id !== body.deviceId) return null;
    // La chiave si blocca: una ricreazione in parallelo non la rende
    // `superseded` fra il controllo e il sigillo.
    const [locked] = await tx
      .select({ id: vaultPersonKeys.id })
      .from(vaultPersonKeys)
      .where(and(eq(vaultPersonKeys.id, key.id), eq(vaultPersonKeys.status, "confirmed")))
      .for("update");
    if (!locked) return null;
    await tx
      .update(vaultDevicePairings)
      .set({ usedAt: sql`now()` })
      .where(eq(vaultDevicePairings.id, pairing.id));
    await tx
      .update(vaultDeviceSeals)
      .set({ revokedAt: sql`now()`, revokedReason: "replaced" })
      .where(and(eq(vaultDeviceSeals.patId, pairing.patId), isNull(vaultDeviceSeals.revokedAt)));
    const [created] = await tx
      .insert(vaultDeviceSeals)
      .values({
        id: pairing.id,
        userId: user.id,
        personKeyId: key.id,
        patId: pairing.patId,
        devicePublicKey: pairing.devicePublicKey,
        seal: body.seal,
        deviceName: pairing.deviceName,
      })
      .returning({ id: vaultDeviceSeals.id, deviceName: vaultDeviceSeals.deviceName, createdAt: vaultDeviceSeals.createdAt });
    await recordSecurityEvent(tx, { kind: "vault_device_sealed", user, detail: created!.deviceName });
    return created!;
  });
  if (!outcome) return { ok: false, error: "pairing_invalid" };
  await publishSecurityAlert(db, user.id, "vault_device_sealed", null);
  return { ok: true, value: { ...outcome, createdAt: outcome.createdAt.toISOString() } };
}

/**
 * Il main scarica il SUO sigillo: quello vivo legato al PAT che chiede, con
 * la chiave di persona confermata attuale. Aggiorna `last_used_at`.
 */
export async function mineSeal(db: Db, user: { id: string; patId: string }): Promise<VaultDeviceSealMine | null> {
  const [row] = await db
    .update(vaultDeviceSeals)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(vaultDeviceSeals.patId, user.patId), eq(vaultDeviceSeals.userId, user.id), liveSealCondition()))
    .returning({
      id: vaultDeviceSeals.id,
      deviceName: vaultDeviceSeals.deviceName,
      personKeyId: vaultDeviceSeals.personKeyId,
      seal: vaultDeviceSeals.seal,
    });
  if (!row) return null;
  const [key] = await db
    .select({ publicKey: vaultPersonKeys.publicKey })
    .from(vaultPersonKeys)
    .where(eq(vaultPersonKeys.id, row.personKeyId));
  return { ...row, personPublicKey: key!.publicKey };
}

/** I Mac vivi di una persona, per l'elenco. */
export async function listSeals(db: Db, userId: string): Promise<VaultDeviceSealItem[]> {
  const rows = await db
    .select({
      id: vaultDeviceSeals.id,
      deviceName: vaultDeviceSeals.deviceName,
      devicePublicKey: vaultDeviceSeals.devicePublicKey,
      createdAt: vaultDeviceSeals.createdAt,
      lastUsedAt: vaultDeviceSeals.lastUsedAt,
    })
    .from(vaultDeviceSeals)
    .where(and(eq(vaultDeviceSeals.userId, userId), liveSealCondition()))
    .orderBy(vaultDeviceSeals.createdAt);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/**
 * Revoca un sigillo vivo di `ownerId` (per `id`, o quello legato a `patId`):
 * il SOLO sigillo, il PAT resta (D-5). Registro (con l'attore se è un
 * altro) e avviso alla persona. `false` se non c'era niente da revocare.
 */
export async function revokeSeal(
  db: Db,
  owner: { id: string; email: string },
  target: { id: string } | { patId: string },
  reason: Exclude<VaultDeviceSealRevokedReason, "replaced">,
  actor: { id: string; email: string } | null,
): Promise<boolean> {
  const which = "id" in target ? eq(vaultDeviceSeals.id, target.id) : eq(vaultDeviceSeals.patId, target.patId);
  const revoked = await db.transaction(async (tx) => {
    const rows = await tx
      .update(vaultDeviceSeals)
      .set({ revokedAt: sql`now()`, revokedReason: reason })
      .where(and(which, eq(vaultDeviceSeals.userId, owner.id), isNull(vaultDeviceSeals.revokedAt)))
      .returning({ deviceName: vaultDeviceSeals.deviceName });
    if (rows.length === 0) return false;
    await recordSecurityEvent(tx, {
      kind: "vault_device_seal_revoked",
      user: owner,
      actor,
      detail: `${reason}: ${rows[0]!.deviceName}`,
    });
    return true;
  });
  if (revoked) await publishSecurityAlert(db, owner.id, "vault_device_seal_revoked", actor?.email ?? null);
  return revoked;
}
