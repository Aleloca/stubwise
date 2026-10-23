/**
 * Credenziali della cassaforte: elenco, creazione, password, mostra/copia e
 * registro (design `docs/plans/2026-10-23-cassaforte-credenziali-design.md`,
 * «Cosa contiene una credenziale», «Permessi e accesso», «Mostrare e
 * copiare», «Inserimento via API», «Revoca»). Le rotte stanno in
 * `routes/credentials.ts`; qui le regole e le query, così le tabelle della
 * cassaforte le nomina solo `apps/server/src/vault`.
 *
 * Il server tiene solo materiale cifrato: la password arriva già cifrata
 * (anche via API) con le copie della chiave per i destinatari. Gli ELENCHI
 * non portano mai password cifrata né copie: le dà solo {@link revealCredential},
 * che scrive il registro nella stessa transazione.
 */
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  credentialAccessLog,
  credentialKeyCopies,
  credentialReaders,
  credentials,
  RECOVERY_RECIPIENT_ID,
  vaultSettings,
  type Db,
} from "@stubwise/db";
import type {
  CredentialAccess,
  CredentialAccessLogEntry,
  CredentialCreateBody,
  CredentialItem,
  CredentialKeyCopyInput,
  CredentialPasswordBody,
  CredentialRecipients,
  CredentialRevealResponse,
  CredentialUpdateBody,
  ProjectPermission,
} from "@stubwise/shared";
import type { ProjectResolver, ResourceGuard } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import {
  currentPersonKey,
  effectiveReaderCondition,
  purgeStaleCopies,
  readableNowCondition,
  recipientsFor,
  VaultNotActiveError,
} from "./readers.js";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function credentialParam(req: FastifyRequest, name: string): string | null {
  const value = (req.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** Il progetto della credenziale del parametro (`null` = non esiste → 404). */
export function fromCredential(param: string): ProjectResolver {
  return async (req, db) => {
    const id = credentialParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: credentials.projectId })
      .from(credentials)
      .where(eq(credentials.id, id));
    return row?.projectId ?? null;
  };
}

/** Gestisce le credenziali del progetto (le vede tutte, senza password). */
export function managesCredentials(permissions: ReadonlySet<ProjectPermission>): boolean {
  return permissions.has("credentials.edit") || permissions.has("credentials.share");
}

/**
 * Chi SA che la credenziale del parametro esiste («Nessun altro sa che una
 * credenziale esiste»): un lettore effettivo, chi la gestisce, chi l'ha
 * creata (la modifica anche senza permesso). Gli altri → 404.
 */
export function credentialVisible(param: string): ResourceGuard {
  return async (req, db, user, permissions) => {
    if (managesCredentials(permissions)) return true;
    const id = credentialParam(req, param);
    if (!id) return false;
    const [row] = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, id),
          sql`(${credentials.createdByUserId} = ${user.id} or ${effectiveReaderCondition(credentials.id, sql`${user.id}::uuid`)})`,
        ),
      );
    return row !== undefined;
  };
}

/** Modifica, password, eliminazione e destinatari: `credentials.edit` o chi l'ha creata. */
export async function canEditCredential(
  db: Db,
  userId: string,
  permissions: ReadonlySet<ProjectPermission>,
  credentialId: string,
): Promise<boolean> {
  if (permissions.has("credentials.edit")) return true;
  const [row] = await db
    .select({ createdByUserId: credentials.createdByUserId })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  return row !== undefined && row.createdByUserId === userId;
}

/** I destinatari come li vede il client (senza lo stato: sono tutti `confirmed`). */
export async function credentialRecipients(
  db: DbOrTx,
  target: Parameters<typeof recipientsFor>[1],
): Promise<CredentialRecipients> {
  const { people, recoveryPublicKey } = await recipientsFor(db, target);
  return {
    people: people.map(({ userId, email, personKeyId, publicKey }) => ({
      userId,
      email,
      personKeyId,
      publicKey,
    })),
    recoveryPublicKey,
  };
}

/**
 * Le copie coprono ESATTAMENTE i destinatari: una per ogni chiave di persona
 * confermata dei lettori più `recovery`, niente doppioni, niente in più — e
 * la copia `recovery` è per la chiave di recupero di ADESSO. Una chiave di
 * persona si riconosce dall'id (una chiave ricreata ha un id nuovo); quella
 * di recupero cambia restando `recovery`, quindi il client dichiara per
 * quale l'ha cifrata.
 */
function coversExactly(
  body: { copies: CredentialKeyCopyInput[]; recoveryPublicKey: string },
  recipients: CredentialRecipients,
): boolean {
  if (body.recoveryPublicKey !== recipients.recoveryPublicKey) return false;
  const { copies } = body;
  const expected = new Set([...recipients.people.map((p) => p.personKeyId), RECOVERY_RECIPIENT_ID]);
  const sent = new Set(copies.map((c) => c.recipientId));
  return (
    sent.size === copies.length &&
    sent.size === expected.size &&
    [...expected].every((id) => sent.has(id))
  );
}

/**
 * Blocca `vault_settings` in condivisione per la transazione: la
 * rigenerazione del kit di recupero (`POST /api/vault/recovery-key`) la
 * blocca in esclusiva, quindi una credenziale non può nascere (o cambiare
 * password) con la sola copia della chiave di recupero VECCHIA mentre il kit
 * si rigenera — o aspetta la rigenerazione, e allora i destinatari letti
 * subito dopo hanno già la chiave nuova (e la copia vecchia dà 409), o la
 * rigenerazione aspetta lei, e allora conta anche questa credenziale.
 * Restituisce `false` se la cassaforte non è attiva.
 */
async function shareVaultLock(tx: DbOrTx): Promise<boolean> {
  const [settings] = await tx.select({ id: vaultSettings.id }).from(vaultSettings).for("share");
  return settings !== undefined;
}

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: "vault_not_active" | "credential_exists" | "not_found" }
  | { ok: false; error: "recipients_changed"; recipients: CredentialRecipients };

const itemColumns = {
  id: credentials.id,
  projectId: credentials.projectId,
  service: credentials.service,
  label: credentials.label,
  url: credentials.url,
  username: credentials.username,
  notes: credentials.notes,
  createdByUserId: credentials.createdByUserId,
  createdAt: credentials.createdAt,
  updatedAt: credentials.updatedAt,
  updatedByUserId: credentials.updatedByUserId,
};

/**
 * Le credenziali che soddisfano `where`, con l'accesso di `user` calcolato
 * nella stessa query. `permissionsOf` dà i permessi di `user` nel progetto
 * della riga (per `manage`, `canEdit`, `canShare`).
 */
async function selectItems(
  db: DbOrTx,
  user: Pick<SessionUser, "id">,
  where: SQL | undefined,
  permissionsOf: (projectId: string) => ReadonlySet<ProjectPermission>,
): Promise<CredentialItem[]> {
  const userId = sql`${user.id}::uuid`;
  const rows = await db
    .select({
      ...itemColumns,
      isReader: sql<boolean>`${effectiveReaderCondition(credentials.id, userId)}`,
      readable: sql<boolean>`${readableNowCondition(credentials.id, userId)}`,
    })
    .from(credentials)
    .where(where)
    .orderBy(asc(credentials.service), sql`${credentials.label} asc nulls first`, asc(credentials.createdAt));
  return rows.map(({ isReader, readable, ...row }) => {
    const permissions = permissionsOf(row.projectId);
    const access: CredentialAccess = readable ? "read" : isReader ? "pending" : "manage";
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      access,
      canEdit: permissions.has("credentials.edit") || row.createdByUserId === user.id,
      canShare: permissions.has("credentials.share") && access === "read",
    };
  });
}

/**
 * Elenco di un progetto: ciò che `user` legge (o aspetta), più tutto se
 * gestisce (`credentials.edit`/`credentials.share`). Il filtro sta nella
 * WHERE. Prima pota le copie di chi non legge più (revoche arrivate da fuori
 * dalla cassaforte: è la «prima operazione sulla cassaforte del progetto»).
 */
export async function listProjectCredentials(
  db: Db,
  user: Pick<SessionUser, "id">,
  projectId: string,
  permissions: ReadonlySet<ProjectPermission>,
): Promise<CredentialItem[]> {
  await purgeStaleCopies(db, projectId);
  const visible = managesCredentials(permissions)
    ? undefined
    : effectiveReaderCondition(credentials.id, sql`${user.id}::uuid`);
  return selectItems(db, user, and(eq(credentials.projectId, projectId), visible), () => permissions);
}

/**
 * «Le mie»: quelle che `user` legge o aspetta, nei progetti che vede (filtro
 * nella WHERE: `projectFilter` è `inProjects` su `visibleProjectIds`).
 */
export async function listMyCredentials(
  db: Db,
  user: Pick<SessionUser, "id">,
  projectFilter: SQL | undefined,
  permissionsByProject: Record<string, readonly ProjectPermission[]>,
): Promise<CredentialItem[]> {
  const sets = new Map(Object.entries(permissionsByProject).map(([id, p]) => [id, new Set(p)]));
  const none = new Set<ProjectPermission>();
  return selectItems(
    db,
    user,
    and(projectFilter, effectiveReaderCondition(credentials.id, sql`${user.id}::uuid`)),
    (projectId) => sets.get(projectId) ?? none,
  );
}

/** Una credenziale come la vede `user` (dopo una scrittura riuscita). */
async function itemFor(
  db: DbOrTx,
  user: Pick<SessionUser, "id">,
  id: string,
  permissions: ReadonlySet<ProjectPermission>,
): Promise<CredentialItem> {
  const [item] = await selectItems(db, user, eq(credentials.id, id), () => permissions);
  return item!;
}

async function insertCopies(tx: DbOrTx, credentialId: string, copies: CredentialKeyCopyInput[]) {
  if (copies.length === 0) return;
  await tx.insert(credentialKeyCopies).values(
    copies.map((c) => ({ credentialId, recipientId: c.recipientId, wrappedKey: c.wrappedKey })),
  );
}

const nullable = (value: string | null | undefined) => (value ? value : null);

/**
 * Crea una credenziale (`credentials.create`, già verificato dalla rotta: chi
 * crea è membro o full admin). Chi crea ne diventa lettore DIRETTO. Tutto in
 * una transazione col lock condiviso di `vault_settings` (vedi
 * {@link shareVaultLock}); copie non esatte → `recipients_changed` e nessuna
 * riga scritta (Review Focus 2).
 */
export async function createCredential(
  db: Db,
  user: Pick<SessionUser, "id">,
  projectId: string,
  permissions: ReadonlySet<ProjectPermission>,
  body: CredentialCreateBody,
): Promise<WriteOutcome<CredentialItem>> {
  try {
    return await db.transaction(async (tx) => {
      if (!(await shareVaultLock(tx))) return { ok: false, error: "vault_not_active" } as const;
      const recipients = await credentialRecipients(tx, { projectId, creatorUserId: user.id });
      if (!coversExactly(body, recipients)) {
        return { ok: false, error: "recipients_changed", recipients } as const;
      }
      const inserted = await tx
        .insert(credentials)
        .values({
          id: body.id,
          projectId,
          service: body.service,
          label: nullable(body.label),
          url: nullable(body.url),
          username: nullable(body.username),
          notes: nullable(body.notes),
          passwordCiphertext: body.passwordCiphertext,
          createdByUserId: user.id,
          updatedByUserId: user.id,
        })
        .onConflictDoNothing({ target: credentials.id })
        .returning({ id: credentials.id });
      if (inserted.length === 0) return { ok: false, error: "credential_exists" } as const;
      await tx
        .insert(credentialReaders)
        .values({ credentialId: body.id, userId: user.id, createdByUserId: user.id });
      await insertCopies(tx, body.id, body.copies);
      return { ok: true, value: await itemFor(tx, user, body.id, permissions) } as const;
    });
  } catch (error) {
    if (error instanceof VaultNotActiveError) return { ok: false, error: "vault_not_active" };
    throw error;
  }
}

/** Modifica i campi in chiaro: gli assenti restano, `null`/vuoto li svuota. */
export async function updateCredential(
  db: Db,
  user: Pick<SessionUser, "id">,
  id: string,
  permissions: ReadonlySet<ProjectPermission>,
  body: CredentialUpdateBody,
): Promise<CredentialItem | null> {
  const set: Partial<typeof credentials.$inferInsert> = {};
  if (body.service !== undefined) set.service = body.service;
  if (body.label !== undefined) set.label = nullable(body.label);
  if (body.url !== undefined) set.url = nullable(body.url);
  if (body.username !== undefined) set.username = nullable(body.username);
  if (body.notes !== undefined) set.notes = nullable(body.notes);
  const updated = await db
    .update(credentials)
    .set({ ...set, updatedAt: sql`now()`, updatedByUserId: user.id })
    .where(eq(credentials.id, id))
    .returning({ id: credentials.id });
  if (updated.length === 0) return null;
  return itemFor(db, user, id, permissions);
}

/**
 * Sostituisce la password e TUTTE le copie della chiave (una chiave nuova,
 * cifrata dal client per i destinatari di adesso). Stesso controllo e stesso
 * lock della creazione; la riga della credenziale si blocca in esclusiva,
 * così due sostituzioni (o una condivisione) non si mescolano.
 */
export async function replacePassword(
  db: Db,
  user: Pick<SessionUser, "id">,
  id: string,
  permissions: ReadonlySet<ProjectPermission>,
  body: CredentialPasswordBody,
): Promise<WriteOutcome<CredentialItem>> {
  try {
    return await db.transaction(async (tx) => {
      if (!(await shareVaultLock(tx))) return { ok: false, error: "vault_not_active" } as const;
      const [row] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.id, id))
        .for("update");
      // recipientsFor di una credenziale che non esiste è vuoto: 404 prima.
      if (!row) return { ok: false, error: "not_found" } as const;
      const recipients = await credentialRecipients(tx, id);
      if (!coversExactly(body, recipients)) {
        return { ok: false, error: "recipients_changed", recipients } as const;
      }
      await tx
        .update(credentials)
        .set({ passwordCiphertext: body.passwordCiphertext, updatedAt: sql`now()`, updatedByUserId: user.id })
        .where(eq(credentials.id, id));
      await tx.delete(credentialKeyCopies).where(eq(credentialKeyCopies.credentialId, id));
      await insertCopies(tx, id, body.copies);
      return { ok: true, value: await itemFor(tx, user, id, permissions) } as const;
    });
  } catch (error) {
    if (error instanceof VaultNotActiveError) return { ok: false, error: "vault_not_active" };
    throw error;
  }
}

/** Elimina la credenziale (copie e inviti a cascata; il registro resta, senza FK). */
export async function deleteCredential(db: Db, id: string): Promise<boolean> {
  const deleted = await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id });
  return deleted.length > 0;
}

/**
 * Mostra o copia: la password cifrata e la copia della chiave per la chiave
 * di persona CONFERMATA di chi chiede, solo se la legge ADESSO (lettore
 * effettivo: un ruolo tolto o un'uscita dal progetto valgono subito, anche
 * con la copia ancora in DB — Review Focus 1). `null` = non la legge (la
 * rotta risponde 404, come per una risorsa invisibile). La riga del registro
 * e la lettura stanno nella stessa transazione: niente lettura senza riga. La
 * riga della credenziale si blocca in condivisione (vedi sotto).
 */
export async function revealCredential(
  db: Db,
  user: Pick<SessionUser, "id" | "email">,
  id: string,
  action: "show" | "copy",
): Promise<CredentialRevealResponse | null> {
  return db.transaction(async (tx) => {
    const [credential] = await tx
      .select({
        projectId: credentials.projectId,
        service: credentials.service,
        label: credentials.label,
        username: credentials.username,
        passwordCiphertext: credentials.passwordCiphertext,
      })
      .from(credentials)
      .where(eq(credentials.id, id))
      // In condivisione: un cambio di password in corso (`replacePassword`,
      // riga in esclusiva) finisce prima, così password cifrata e copia sono
      // della STESSA chiave — mai la password vecchia con la copia nuova.
      .for("share");
    if (!credential) return null;
    // Prima operazione sulla cassaforte del progetto: via le copie di chi non legge più.
    await purgeStaleCopies(tx, credential.projectId);
    const key = await currentPersonKey(tx, user.id);
    if (!key || key.status !== "confirmed") return null;
    const [copy] = await tx
      .select({ wrappedKey: credentialKeyCopies.wrappedKey })
      .from(credentialKeyCopies)
      .where(
        and(
          eq(credentialKeyCopies.credentialId, id),
          eq(credentialKeyCopies.recipientId, key.id),
          effectiveReaderCondition(credentialKeyCopies.credentialId, sql`${user.id}::uuid`),
        ),
      );
    if (!copy) return null;
    await tx.insert(credentialAccessLog).values({
      credentialId: id,
      projectId: credential.projectId,
      credentialSnapshot: [credential.service, credential.label, credential.username]
        .filter((part) => part)
        .join(" · "),
      userId: user.id,
      userEmail: user.email,
      action,
    });
    return { passwordCiphertext: credential.passwordCiphertext, wrappedKey: copy.wrappedKey, personKeyId: key.id };
  });
}

/** Il registro delle letture del progetto, dal più recente. */
export async function listAccessLog(
  db: Db,
  projectId: string,
  limit: number,
): Promise<CredentialAccessLogEntry[]> {
  const rows = await db
    .select({
      id: credentialAccessLog.id,
      credentialId: credentialAccessLog.credentialId,
      credentialSnapshot: credentialAccessLog.credentialSnapshot,
      userId: credentialAccessLog.userId,
      userEmail: credentialAccessLog.userEmail,
      action: credentialAccessLog.action,
      createdAt: credentialAccessLog.createdAt,
    })
    .from(credentialAccessLog)
    .where(eq(credentialAccessLog.projectId, projectId))
    .orderBy(desc(credentialAccessLog.createdAt), desc(credentialAccessLog.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
