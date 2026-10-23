/**
 * Lettori di una credenziale: elenco, anteprima, condivisione e revoca
 * (design `docs/plans/2026-10-23-cassaforte-credenziali-design.md`,
 * «Permessi e accesso», «Lettori che arrivano dopo», «Revoca»).
 *
 * Condividere vuole `credentials.share` nel progetto E poter aprire la
 * credenziale ADESSO (`canReadNow`): chi condivide ricifra la chiave per i
 * nuovi lettori, quindi deve averla. Le persone del lettore nuovo con una
 * chiave GIÀ confermata ricevono la copia subito (le copie devono coprirle
 * ESATTAMENTE); le altre restano in attesa di una conferma
 * (`vault/pending.ts`). Togliere un lettore cancella SUBITO le copie di chi
 * non è più lettore effettivo.
 *
 * Ordine dei lock, lo stesso di `credentials-service.ts`: `vault_settings`
 * in condivisione, POI la riga della credenziale in esclusiva. Così una
 * sostituzione della password (`replacePassword`) e una ricreazione della
 * chiave di una persona (`POST /api/vault/keys`) non si mescolano con le
 * copie scritte qui; la `keyVersion` ripetuta dal client copre il resto (una
 * password cambiata FRA l'anteprima e la condivisione → 409).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  credentialKeyCopies,
  credentialReaders,
  credentials,
  projectMembers,
  roles,
  users,
  vaultPersonKeys,
  vaultSettings,
  type Db,
} from "@stubwise/db";
import type {
  CredentialKeyCopyInput,
  CredentialReadersResponse,
  CredentialSharePreview,
} from "@stubwise/shared";
import { userIsFullAdmin } from "@stubwise/notifications";
import { currentPersonKey, effectiveReaderUserIds, purgeStaleCopies, readableNowCondition } from "./readers.js";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * La versione della chiave di una credenziale: cambia quando cambia la
 * password (una chiave nuova per ogni password, `replacePassword`). È
 * un'impronta della password CIFRATA: non dice nulla della password.
 */
export const keyVersionSql = sql<string>`md5(${credentials.passwordCiphertext})`;

/** Il lettore da aggiungere: una persona O un ruolo di progetto. */
export type ReaderTarget = { userId: string; roleId?: undefined } | { roleId: string; userId?: undefined };

/** Lettori diretti e lettori effettivi col loro stato (`can_read` o `pending`). */
export async function readersView(db: DbOrTx, credentialId: string): Promise<CredentialReadersResponse> {
  const direct = await db
    .select({
      id: credentialReaders.id,
      userId: credentialReaders.userId,
      email: users.email,
      roleId: credentialReaders.roleId,
      roleName: roles.name,
      createdAt: credentialReaders.createdAt,
    })
    .from(credentialReaders)
    .leftJoin(users, eq(users.id, credentialReaders.userId))
    .leftJoin(roles, eq(roles.id, credentialReaders.roleId))
    .where(eq(credentialReaders.credentialId, credentialId))
    .orderBy(asc(credentialReaders.createdAt), asc(credentialReaders.id));

  const ids = await effectiveReaderUserIds(db, credentialId);
  const people =
    ids.length === 0
      ? []
      : await db
          .select({
            userId: users.id,
            email: users.email,
            fullAdmin: sql<boolean>`${userIsFullAdmin(users.id)}`,
            keyStatus: vaultPersonKeys.status,
            hasCopy: sql<boolean>`exists (
              select 1 from ${credentialKeyCopies} rv_c
              where rv_c.credential_id = ${credentialId}::uuid and rv_c.recipient_id = ${vaultPersonKeys.id}::text
            )`,
          })
          .from(users)
          .leftJoin(
            vaultPersonKeys,
            and(eq(vaultPersonKeys.userId, users.id), inArray(vaultPersonKeys.status, ["pending", "confirmed"])),
          )
          .where(inArray(users.id, ids))
          .orderBy(asc(users.email));

  return {
    readers: direct.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    people: people.map(({ userId, email, fullAdmin, keyStatus, hasCopy }) => ({
      userId,
      email,
      fullAdmin,
      keyStatus: keyStatus === "pending" || keyStatus === "confirmed" ? keyStatus : "none",
      status: keyStatus === "confirmed" && hasCopy ? "can_read" : "pending",
    })),
  };
}

export type TargetError = "not_a_member" | "invalid_role";

/**
 * Le persone del lettore nuovo, membri del progetto della credenziale: per
 * una persona, lei (se è membro); per un ruolo di progetto, i membri con quel
 * ruolo. Un invito vale solo per i membri (`readers.ts`), quindi una persona
 * fuori dal progetto non si invita.
 */
async function targetPeople(
  db: DbOrTx,
  projectId: string,
  target: ReaderTarget,
): Promise<{ ok: true; people: { userId: string; email: string }[] } | { ok: false; error: TargetError }> {
  if (target.roleId !== undefined) {
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.id, target.roleId), eq(roles.scope, "project")));
    if (!role) return { ok: false, error: "invalid_role" };
  }
  const people = await db
    .select({ userId: users.id, email: users.email })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        target.userId !== undefined
          ? eq(projectMembers.userId, target.userId)
          : eq(projectMembers.roleId, target.roleId),
      ),
    )
    .orderBy(asc(users.email));
  if (target.userId !== undefined && people.length === 0) return { ok: false, error: "not_a_member" };
  return { ok: true, people };
}

/**
 * Cosa vuole una condivisione con `target`: chi riceve subito la chiave (chiave
 * confermata, ancora senza copia di questa credenziale), chi resta in attesa,
 * e la copia di `actorId` con la versione della chiave. `null` = `actorId` non
 * la apre adesso.
 */
async function preview(
  db: DbOrTx,
  actorId: string,
  credentialId: string,
  projectId: string,
  target: ReaderTarget,
): Promise<{ ok: true; value: CredentialSharePreview } | { ok: false; error: TargetError | "not_a_reader" }> {
  const own = await ownCopy(db, actorId, credentialId);
  if (!own) return { ok: false, error: "not_a_reader" };
  const resolved = await targetPeople(db, projectId, target);
  if (!resolved.ok) return resolved;
  const ids = resolved.people.map((p) => p.userId);
  const keyed =
    ids.length === 0
      ? []
      : await db
          .select({
            userId: users.id,
            email: users.email,
            personKeyId: vaultPersonKeys.id,
            publicKey: vaultPersonKeys.publicKey,
            hasCopy: sql<boolean>`exists (
              select 1 from ${credentialKeyCopies} sp_c
              where sp_c.credential_id = ${credentialId}::uuid and sp_c.recipient_id = ${vaultPersonKeys.id}::text
            )`,
          })
          .from(users)
          .innerJoin(vaultPersonKeys, eq(vaultPersonKeys.userId, users.id))
          .where(and(inArray(users.id, ids), eq(vaultPersonKeys.status, "confirmed")))
          .orderBy(asc(users.email));
  const confirmed = new Set(keyed.map((k) => k.userId));
  return {
    ok: true,
    value: {
      people: keyed
        .filter((k) => !k.hasCopy)
        .map(({ userId, email, personKeyId, publicKey }) => ({ userId, email, personKeyId, publicKey })),
      waiting: resolved.people.filter((p) => !confirmed.has(p.userId)),
      wrappedKey: own.wrappedKey,
      keyVersion: own.keyVersion,
    },
  };
}

/**
 * La copia della chiave di `userId` per la credenziale, con la versione della
 * chiave, solo se la apre ADESSO (`readableNowCondition`).
 */
async function ownCopy(
  db: DbOrTx,
  userId: string,
  credentialId: string,
): Promise<{ wrappedKey: string; keyVersion: string } | null> {
  const key = await currentPersonKey(db, userId);
  if (!key || key.status !== "confirmed") return null;
  const [row] = await db
    .select({ wrappedKey: credentialKeyCopies.wrappedKey, keyVersion: keyVersionSql })
    .from(credentialKeyCopies)
    .innerJoin(credentials, eq(credentials.id, credentialKeyCopies.credentialId))
    .where(
      and(
        eq(credentialKeyCopies.credentialId, credentialId),
        eq(credentialKeyCopies.recipientId, key.id),
        readableNowCondition(credentials.id, sql`${userId}::uuid`),
      ),
    );
  return row ?? null;
}

/** L'anteprima di una condivisione (sola lettura, nessun lock). */
export function sharePreview(
  db: Db,
  actorId: string,
  credentialId: string,
  projectId: string,
  target: ReaderTarget,
): ReturnType<typeof preview> {
  return preview(db, actorId, credentialId, projectId, target);
}

/** Il blocco di `vault_settings` (condiviso) e della credenziale (esclusivo), in quest'ordine. */
async function lockCredential(tx: DbOrTx, credentialId: string): Promise<"ok" | "vault_not_active" | "not_found"> {
  const [settings] = await tx.select({ id: vaultSettings.id }).from(vaultSettings).for("share");
  if (!settings) return "vault_not_active";
  const [row] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .for("update");
  return row ? "ok" : "not_found";
}

export type ShareOutcome =
  | { ok: true; value: CredentialReadersResponse }
  | { ok: false; error: TargetError | "not_a_reader" | "vault_not_active" | "not_found" }
  | { ok: false; error: "recipients_changed"; preview: CredentialSharePreview };

/**
 * Aggiunge un lettore e, nella stessa transazione, le copie per le sue
 * persone con chiave confermata. Le copie devono coprire ESATTAMENTE
 * `preview.people` e la `keyVersion` dev'essere quella di adesso; altrimenti
 * 409 `recipients_changed` con l'anteprima attuale e nulla scritto. Un
 * lettore già invitato non si duplica (le copie mancanti si aggiungono
 * comunque: è lo stesso gesto).
 */
export async function shareCredential(
  db: Db,
  actorId: string,
  credentialId: string,
  projectId: string,
  target: ReaderTarget,
  body: { copies: CredentialKeyCopyInput[]; keyVersion: string },
): Promise<ShareOutcome> {
  return db.transaction(async (tx) => {
    const locked = await lockCredential(tx, credentialId);
    if (locked !== "ok") return { ok: false, error: locked };
    const current = await preview(tx, actorId, credentialId, projectId, target);
    if (!current.ok) return current;
    const expected = new Set(current.value.people.map((p) => p.personKeyId));
    const sent = new Set(body.copies.map((c) => c.recipientId));
    const exact =
      body.keyVersion === current.value.keyVersion &&
      sent.size === body.copies.length &&
      sent.size === expected.size &&
      [...expected].every((id) => sent.has(id));
    if (!exact) return { ok: false, error: "recipients_changed", preview: current.value };

    await tx
      .insert(credentialReaders)
      .values({ credentialId, userId: target.userId ?? null, roleId: target.roleId ?? null, createdByUserId: actorId })
      .onConflictDoNothing();
    if (body.copies.length > 0) {
      await tx
        .insert(credentialKeyCopies)
        .values(body.copies.map((c) => ({ credentialId, recipientId: c.recipientId, wrappedKey: c.wrappedKey })));
    }
    return { ok: true, value: await readersView(tx, credentialId) };
  });
}

/**
 * Toglie un lettore diretto (`credential_readers.id`) e cancella SUBITO le
 * copie di chi, senza quell'invito, non è più lettore effettivo (design
 * «Revoca»: quando la revoca passa dalla cassaforte, subito). Chi condivide
 * deve aprirla adesso, come per aggiungere.
 */
export async function removeReader(
  db: Db,
  actorId: string,
  credentialId: string,
  projectId: string,
  readerId: string,
): Promise<
  { ok: true; value: CredentialReadersResponse } | { ok: false; error: "not_a_reader" | "vault_not_active" | "not_found" }
> {
  return db.transaction(async (tx) => {
    const locked = await lockCredential(tx, credentialId);
    if (locked !== "ok") return { ok: false, error: locked };
    if (!(await ownCopy(tx, actorId, credentialId))) return { ok: false, error: "not_a_reader" };
    const deleted = await tx
      .delete(credentialReaders)
      .where(and(eq(credentialReaders.id, readerId), eq(credentialReaders.credentialId, credentialId)))
      .returning({ id: credentialReaders.id });
    if (deleted.length === 0) return { ok: false, error: "not_found" };
    await purgeStaleCopies(tx, projectId);
    return { ok: true, value: await readersView(tx, credentialId) };
  });
}
