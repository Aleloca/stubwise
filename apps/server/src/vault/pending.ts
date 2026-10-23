/**
 * Accessi in attesa: elenco, conferma, rifiuto e conferma col kit di
 * recupero (design `docs/plans/2026-10-23-cassaforte-credenziali-design.md`,
 * «Lettori che arrivano dopo, e la conferma», «Kit di recupero»).
 *
 * Una persona è IN ATTESA su una credenziale se ne è lettrice effettiva e la
 * sua chiave viva è `pending`, o `confirmed` ma senza la copia di quella
 * credenziale. Il passaggio non è mai automatico: lo fa una persona.
 *
 * Chi può passare UNA credenziale (regola per credenziale):
 *  - via normale: chi la apre ADESSO (`readableNowCondition`: lettore
 *    effettivo, chiave confermata, copia presente) e ha `credentials.share`
 *    nel suo progetto — un full admin li ha tutti, quindi basta che abbia la
 *    copia. Mai per la PROPRIA chiave: confermarsi da sé è proprio ciò che un
 *    login rubato vorrebbe fare;
 *  - col kit di recupero: un full admin con riconferma recente, per qualunque
 *    credenziale in attesa di chiunque, anche sé stesso (è l'unica uscita di
 *    un'istanza con un solo admin che ha perso le passkey). Il possesso del
 *    kit lo PROVA una sfida (`recovery-challenge.ts`: un segreto cifrato per
 *    la chiave pubblica di recupero, che solo il kit apre), verificata dalle
 *    rotte prima di arrivare qui; in più la via è solo dei full admin, finisce
 *    nel registro di sicurezza e avvisa gli altri full admin. Il kit non
 *    arriva mai al server.
 *
 * Chi può confermare la CHIAVE (`pending` → `confirmed`, con `confirmed_at` e
 * `confirmed_by`, su cui si regge la regola V1 di `routes/vault.ts`): solo
 * chi le passa ALMENO una credenziale, nella stessa conferma — nemmeno un
 * full admin conferma «a vuoto» (review finale: una chiave confermata senza
 * copie riceverebbe poi ogni password nuova o cambiata). Una chiave che non
 * ha niente da ricevere resta in attesa finché una credenziale non la
 * raggiunge (allora compare nell'elenco di quella credenziale). Chi può
 * RIFIUTARLA (solo se `pending`): un full admin, o chi potrebbe passarle
 * almeno una credenziale per la via normale.
 *
 * Per la via normale, conferma e rifiuto vogliono anche la prova che chi
 * agisce ha APERTO la sua chiave confermata (`consumeActorProof` di
 * `recovery-challenge.ts`), verificata dalle rotte prima di arrivare qui:
 * senza, un login rubato confermerebbe una chiave fantoccio con copie
 * spazzatura che il server non può verificare.
 *
 * Ordine dei lock: `vault_settings` in condivisione, la chiave della persona,
 * poi le credenziali (per id) in esclusiva — la stessa precedenza di
 * `credentials-service.ts` e di `POST /api/vault/keys`, così una ricreazione
 * della chiave o un cambio di password in parallelo non lasciano copie per
 * una chiave superata o per una chiave della credenziale vecchia.
 */
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  credentialKeyCopies,
  credentials,
  RECOVERY_RECIPIENT_ID,
  users,
  vaultPersonKeySeals,
  vaultPersonKeys,
  vaultSettings,
  type Db,
} from "@stubwise/db";
import type { VaultConfirmCopy, VaultConfirmResponse, VaultPendingPerson } from "@stubwise/shared";
import { projectPermissionsByProject } from "@stubwise/notifications";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { publishVaultRecoveryUsed } from "./alerts.js";
import { currentPersonKey, effectiveReaderCondition, readableNowCondition } from "./readers.js";
import { keyVersionSql } from "./sharing.js";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Chi agisce: id, email e se è full admin (`instance.full_admin`). */
export interface VaultActor {
  id: string;
  email: string;
  fullAdmin: boolean;
}

/** Da quale copia il client ricava la chiave da ricifrare. */
type Source = { kind: "person"; actorId: string } | { kind: "recovery" };

interface Candidate {
  personKeyId: string;
  userId: string;
  email: string;
  status: "pending" | "confirmed";
  createdAt: Date;
  device: string | null;
  publicKey: string;
  credentialId: string;
  projectId: string;
  service: string;
  label: string | null;
  keyVersion: string;
  wrappedKey: string;
}

/**
 * Le coppie (chiave in attesa, credenziale) che `source` può passare, con la
 * copia da cui partire. Per la via normale filtra anche il permesso
 * `credentials.share` nel progetto e salta la chiave di chi guarda.
 */
async function candidates(
  db: DbOrTx,
  source: Source,
  filter: { personKeyId?: string; credentialIds?: string[] } = {},
): Promise<Candidate[]> {
  let sourceRecipient: string;
  const conditions: (SQL | undefined)[] = [];
  if (source.kind === "person") {
    const own = await currentPersonKey(db, source.actorId);
    if (!own || own.status !== "confirmed") return [];
    sourceRecipient = own.id;
    conditions.push(
      ne(vaultPersonKeys.userId, source.actorId),
      readableNowCondition(credentials.id, sql`${source.actorId}::uuid`),
    );
  } else {
    sourceRecipient = RECOVERY_RECIPIENT_ID;
  }
  if (filter.personKeyId !== undefined) conditions.push(eq(vaultPersonKeys.id, filter.personKeyId));
  if (filter.credentialIds !== undefined) {
    if (filter.credentialIds.length === 0) return [];
    conditions.push(inArray(credentials.id, filter.credentialIds));
  }
  const rows = await db
    .select({
      personKeyId: vaultPersonKeys.id,
      userId: users.id,
      email: users.email,
      status: vaultPersonKeys.status,
      createdAt: vaultPersonKeys.createdAt,
      device: vaultPersonKeys.device,
      publicKey: vaultPersonKeys.publicKey,
      credentialId: credentials.id,
      projectId: credentials.projectId,
      service: credentials.service,
      label: credentials.label,
      keyVersion: keyVersionSql,
      wrappedKey: credentialKeyCopies.wrappedKey,
    })
    .from(vaultPersonKeys)
    .innerJoin(users, eq(users.id, vaultPersonKeys.userId))
    .innerJoin(credentials, effectiveReaderCondition(credentials.id, vaultPersonKeys.userId))
    .innerJoin(
      credentialKeyCopies,
      and(eq(credentialKeyCopies.credentialId, credentials.id), eq(credentialKeyCopies.recipientId, sourceRecipient)),
    )
    .where(
      and(
        inArray(vaultPersonKeys.status, ["pending", "confirmed"]),
        sql`(${vaultPersonKeys.status} = 'pending' or not exists (
          select 1 from ${credentialKeyCopies} pd_c
          where pd_c.credential_id = ${credentials.id} and pd_c.recipient_id = ${vaultPersonKeys.id}::text
        ))`,
        ...conditions,
      ),
    )
    .orderBy(asc(users.email), asc(credentials.service), asc(credentials.id));
  const typed = rows as Candidate[];
  if (source.kind === "recovery") return typed;
  const permissions = await projectPermissionsByProject(
    db,
    source.actorId,
    typed.map((row) => row.projectId),
  );
  return typed.filter((row) => permissions.get(row.projectId)?.has("credentials.share") === true);
}

/** Le persone in attesa raggruppate, nella forma della risposta. */
function group(rows: Candidate[]): VaultPendingPerson[] {
  const byKey = new Map<string, VaultPendingPerson>();
  for (const row of rows) {
    let person = byKey.get(row.personKeyId);
    if (!person) {
      person = {
        user: { id: row.userId, email: row.email },
        personKey: {
          id: row.personKeyId,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          device: row.device,
          fingerprintSource: row.publicKey,
        },
        credentials: [],
      };
      byKey.set(row.personKeyId, person);
    }
    person.credentials.push({
      id: row.credentialId,
      projectId: row.projectId,
      service: row.service,
      label: row.label,
      wrappedKey: row.wrappedKey,
      keyVersion: row.keyVersion,
    });
  }
  return [...byKey.values()];
}

/** Gli accessi che `actorId` può confermare per la via normale. */
export async function listPending(db: Db, actorId: string): Promise<VaultPendingPerson[]> {
  return group(await candidates(db, { kind: "person", actorId }));
}

/** Tutti gli accessi in attesa, con la copia di recupero (solo full admin con riconferma). */
export async function listPendingForRecovery(db: Db): Promise<VaultPendingPerson[]> {
  return group(await candidates(db, { kind: "recovery" }));
}

/** Blocca `vault_settings` (condiviso) e la chiave VIVA della persona (esclusivo). */
async function lockKey(
  tx: DbOrTx,
  personKeyId: string,
): Promise<
  | { ok: true; key: { id: string; userId: string; status: "pending" | "confirmed" } }
  | { ok: false; error: "vault_not_active" | "not_found" }
> {
  const [settings] = await tx.select({ id: vaultSettings.id }).from(vaultSettings).for("share");
  if (!settings) return { ok: false, error: "vault_not_active" };
  const [key] = await tx
    .select({ id: vaultPersonKeys.id, userId: vaultPersonKeys.userId, status: vaultPersonKeys.status })
    .from(vaultPersonKeys)
    .where(and(eq(vaultPersonKeys.id, personKeyId), inArray(vaultPersonKeys.status, ["pending", "confirmed"])))
    .for("update");
  if (!key) return { ok: false, error: "not_found" };
  return { ok: true, key: key as { id: string; userId: string; status: "pending" | "confirmed" } };
}

export type ConfirmError = "vault_not_active" | "not_found" | "own_key" | "nothing_to_confirm" | "forbidden";

/**
 * Conferma la chiave `personKeyId` e salva le copie che chi conferma poteva
 * dare (le altre tornano in `skipped` col motivo). `viaRecovery`: le copie
 * vengono dal kit di recupero (la rotta l'ha già riservata ai full admin con
 * riconferma); si registra l'evento di sicurezza e si avvisano gli altri full
 * admin. Chi non passa nessuna credenziale — chiunque sia, per qualunque via —
 * non conferma nulla (`nothing_to_confirm`, nessuna scrittura).
 */
export async function confirmPersonKey(
  db: Db,
  actor: VaultActor,
  personKeyId: string,
  copies: VaultConfirmCopy[],
  viaRecovery: boolean,
): Promise<{ ok: true; value: VaultConfirmResponse } | { ok: false; error: ConfirmError }> {
  // Difesa in profondità: la rotta di recupero è già solo dei full admin.
  if (viaRecovery && !actor.fullAdmin) return { ok: false, error: "forbidden" };
  const outcome = await db.transaction(async (tx) => {
    const locked = await lockKey(tx, personKeyId);
    if (!locked.ok) return locked;
    const { key } = locked;
    if (!viaRecovery && key.userId === actor.id) return { ok: false, error: "own_key" } as const;

    const ids = [...new Set(copies.map((c) => c.credentialId))].sort();
    if (ids.length > 0) {
      await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(inArray(credentials.id, ids))
        .orderBy(asc(credentials.id))
        .for("update");
    }
    const allowed = new Map(
      (
        await candidates(tx, viaRecovery ? { kind: "recovery" } : { kind: "person", actorId: actor.id }, {
          personKeyId,
          credentialIds: ids,
        })
      ).map((row) => [row.credentialId, row.keyVersion]),
    );

    const saved: VaultConfirmCopy[] = [];
    const skipped: VaultConfirmResponse["skipped"] = [];
    const seen = new Set<string>();
    for (const copy of copies) {
      const version = allowed.get(copy.credentialId);
      if (seen.has(copy.credentialId)) skipped.push({ credentialId: copy.credentialId, reason: "duplicate" });
      else if (version === undefined) skipped.push({ credentialId: copy.credentialId, reason: "not_allowed" });
      else if (version !== copy.keyVersion) skipped.push({ credentialId: copy.credentialId, reason: "key_changed" });
      else saved.push(copy);
      seen.add(copy.credentialId);
    }
    if (saved.length === 0) return { ok: false, error: "nothing_to_confirm" } as const;

    let status = key.status;
    if (key.status === "pending") {
      await tx
        .update(vaultPersonKeys)
        .set({ status: "confirmed", confirmedAt: sql`now()`, confirmedByUserId: actor.id })
        .where(eq(vaultPersonKeys.id, key.id));
      status = "confirmed";
    }
    if (saved.length > 0) {
      await tx
        .insert(credentialKeyCopies)
        .values(saved.map((c) => ({ credentialId: c.credentialId, recipientId: key.id, wrappedKey: c.wrappedKey })))
        .onConflictDoNothing();
    }
    if (viaRecovery) {
      // Nel registro di chi ha agito e, se è un'altra, della persona confermata.
      const actorRef = { id: actor.id, email: actor.email };
      await recordSecurityEvent(tx, { kind: "vault_recovery_used", user: actorRef, actor: actorRef });
      if (key.userId !== actor.id) {
        const [person] = await tx.select({ email: users.email }).from(users).where(eq(users.id, key.userId));
        await recordSecurityEvent(tx, {
          kind: "vault_recovery_used",
          user: { id: key.userId, email: person!.email },
          actor: actorRef,
        });
      }
    }
    return {
      ok: true,
      value: { personKeyId: key.id, status, saved: saved.map((c) => c.credentialId), skipped },
    } as const;
  });
  if (outcome.ok && viaRecovery) {
    await publishVaultRecoveryUsed(db, { id: actor.id, email: actor.email });
  }
  return outcome;
}

/**
 * Rifiuta una chiave `pending`: diventa `rejected`, non riceve nulla (copie e
 * sigilli via) e la persona dovrà ricrearla. Possono un full admin o chi
 * potrebbe passarle almeno una credenziale per la via normale; mai la
 * propria.
 */
export async function rejectPersonKey(
  db: Db,
  actor: VaultActor,
  personKeyId: string,
): Promise<{ ok: true } | { ok: false; error: "vault_not_active" | "not_found" | "own_key" | "not_pending" | "forbidden" }> {
  return db.transaction(async (tx) => {
    const locked = await lockKey(tx, personKeyId);
    if (!locked.ok) return locked;
    const { key } = locked;
    if (key.userId === actor.id) return { ok: false, error: "own_key" } as const;
    if (key.status !== "pending") return { ok: false, error: "not_pending" } as const;
    if (!actor.fullAdmin && (await candidates(tx, { kind: "person", actorId: actor.id }, { personKeyId })).length === 0) {
      return { ok: false, error: "forbidden" } as const;
    }
    await tx.update(vaultPersonKeys).set({ status: "rejected" }).where(eq(vaultPersonKeys.id, key.id));
    await tx.delete(credentialKeyCopies).where(eq(credentialKeyCopies.recipientId, key.id));
    await tx.delete(vaultPersonKeySeals).where(eq(vaultPersonKeySeals.personKeyId, key.id));
    return { ok: true } as const;
  });
}
