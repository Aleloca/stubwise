/**
 * CHI LEGGE una credenziale della cassaforte, e a chi va cifrata la sua
 * chiave (design `docs/plans/2026-10-23-cassaforte-credenziali-design.md`,
 * «Permessi e accesso», «Lettori che arrivano dopo», «Revoca»).
 *
 * Un LETTORE EFFETTIVO è, in quel momento:
 *  - un full admin (`instance.full_admin`, membro implicito di ogni
 *    progetto), oppure
 *  - un membro del progetto della credenziale (riga in `project_members`)
 *    invitato direttamente, o il cui ruolo di progetto è invitato.
 * La membership si rilegge a OGNI chiamata: un invito a una persona uscita
 * dal progetto, o a un ruolo che non ha più, resta in tabella ma non vale
 * (la revoca si applica a lettura, `docs/invariants/permissions.md`). Avere
 * una copia della chiave in DB non basta: serve essere lettori ADESSO
 * (Review Focus 1).
 *
 * La regola SQL vive in UN posto ({@link effectiveReaderCondition}); le
 * funzioni qui sotto la compongono. Le tabelle della cassaforte le legge solo
 * il server (`apps/server/src/vault`).
 */
import { and, asc, eq, inArray, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  credentialKeyCopies,
  credentials,
  RECOVERY_RECIPIENT_ID,
  users,
  vaultPersonKeys,
  vaultSettings,
  type Db,
  type VaultPersonKeyStatus,
} from "@stubwise/db";
import { userIsFullAdmin } from "@stubwise/notifications";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * La cassaforte non è ancora stata attivata (nessuna riga in
 * `vault_settings`, quindi nessuna chiave di recupero): non si può cifrare
 * nulla. Le rotte la traducono in 409 `vault_not_active`.
 */
export class VaultNotActiveError extends Error {
  readonly code = "vault_not_active" as const;
  constructor() {
    super("vault_not_active");
    this.name = "VaultNotActiveError";
  }
}

/** Stati di una chiave di persona VIVA (al più una per utente, indice unico parziale). */
const LIVE_KEY_STATUSES: VaultPersonKeyStatus[] = ["pending", "confirmed"];

/**
 * Condizione SQL: `userId` è lettore effettivo di `credentialId` (vedi il
 * docblock del modulo). Le tabelle interne sono aliasate (`er_*`), così le
 * colonne esterne passate come argomenti restano quelle esterne. Non verifica
 * che la credenziale esista: per un full admin è vera comunque.
 */
function effectiveReaderCondition(credentialId: AnyColumn | SQL, userId: AnyColumn | SQL): SQL {
  return sql`(${userIsFullAdmin(userId)} or exists (
    select 1 from ${credentials} er_c
    inner join project_members er_pm
      on er_pm.project_id = er_c.project_id and er_pm.user_id = ${userId}
    inner join credential_readers er_r
      on er_r.credential_id = er_c.id
      and (er_r.user_id = ${userId} or er_r.role_id = er_pm.role_id)
    where er_c.id = ${credentialId}
  ))`;
}

/**
 * I lettori effettivi della credenziale: full admin ∪ invitati diretti ∪
 * membri con un ruolo invitato, gli ultimi due solo se membri del progetto.
 * Credenziale inesistente → nessuno.
 */
export async function effectiveReaderUserIds(db: DbOrTx, credentialId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`exists (select 1 from ${credentials} where ${credentials.id} = ${credentialId})`,
        effectiveReaderCondition(sql`${credentialId}::uuid`, users.id),
      ),
    );
  return rows.map((row) => row.id);
}

/** La chiave di persona viva (`pending` o `confirmed`) dell'utente, se c'è. */
export async function currentPersonKey(
  db: DbOrTx,
  userId: string,
): Promise<{ id: string; publicKey: string; status: VaultPersonKeyStatus } | null> {
  const [row] = await db
    .select({ id: vaultPersonKeys.id, publicKey: vaultPersonKeys.publicKey, status: vaultPersonKeys.status })
    .from(vaultPersonKeys)
    .where(and(eq(vaultPersonKeys.userId, userId), inArray(vaultPersonKeys.status, LIVE_KEY_STATUSES)));
  return row ?? null;
}

/** Una persona con la sua chiave viva, come la vedono creazione, conferma e condivisione. */
export interface VaultPerson {
  userId: string;
  email: string;
  personKeyId: string;
  publicKey: string;
  status: VaultPersonKeyStatus;
}

/** Le persone fra `userIds` con una chiave viva in uno degli `statuses`, per email. */
async function peopleWithKey(
  db: DbOrTx,
  userIds: string[],
  statuses: VaultPersonKeyStatus[],
): Promise<VaultPerson[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      userId: users.id,
      email: users.email,
      personKeyId: vaultPersonKeys.id,
      publicKey: vaultPersonKeys.publicKey,
      status: vaultPersonKeys.status,
    })
    .from(users)
    .innerJoin(vaultPersonKeys, eq(vaultPersonKeys.userId, users.id))
    .where(and(inArray(users.id, userIds), inArray(vaultPersonKeys.status, statuses)))
    .orderBy(asc(users.email));
}

/**
 * I destinatari che una creazione o un cambio di password DEVE coprire: i
 * lettori effettivi con chiave `confirmed`, più la chiave di recupero. Chi ha
 * la chiave `pending` (o nessuna) resta in attesa di una conferma.
 *
 * Per una credenziale NUOVA (`{ projectId, creatorUserId }`) i lettori sono il
 * creatore (che ne diventa lettore diretto) e i full admin; `projectId` non
 * cambia l'insieme, ma resta nella firma perché è il progetto della richiesta.
 *
 * Cassaforte non attivata → lancia {@link VaultNotActiveError} (scelta: un
 * errore tipato invece di un risultato a variante, perché nessun chiamante
 * può proseguire senza chiave di recupero; le rotte lo mappano a 409).
 */
export async function recipientsFor(
  db: DbOrTx,
  target: string | { projectId: string; creatorUserId: string },
): Promise<{ people: VaultPerson[]; recoveryPublicKey: string }> {
  const [settings] = await db
    .select({ recoveryPublicKey: vaultSettings.recoveryPublicKey })
    .from(vaultSettings)
    .where(eq(vaultSettings.id, 1));
  if (!settings) throw new VaultNotActiveError();

  let readerIds: string[];
  if (typeof target === "string") {
    readerIds = await effectiveReaderUserIds(db, target);
  } else {
    const admins = await db.select({ id: users.id }).from(users).where(userIsFullAdmin(users.id));
    readerIds = [...new Set([target.creatorUserId, ...admins.map((row) => row.id)])];
  }
  return {
    people: await peopleWithKey(db, readerIds, ["confirmed"]),
    recoveryPublicKey: settings.recoveryPublicKey,
  };
}

/**
 * `userId` può aprire la credenziale ADESSO: è lettore effettivo, la sua
 * chiave viva è `confirmed` e c'è la copia della chiave per quella chiave.
 */
export async function canReadNow(db: DbOrTx, userId: string, credentialId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(vaultPersonKeys)
    .innerJoin(
      credentialKeyCopies,
      and(
        eq(credentialKeyCopies.credentialId, credentialId),
        eq(credentialKeyCopies.recipientId, sql`${vaultPersonKeys.id}::text`),
      ),
    )
    .where(
      and(
        eq(vaultPersonKeys.userId, userId),
        eq(vaultPersonKeys.status, "confirmed"),
        effectiveReaderCondition(sql`${credentialId}::uuid`, vaultPersonKeys.userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * I lettori effettivi in ATTESA: con la chiave `pending`, o `confirmed` ma
 * senza la copia della chiave per questa credenziale. Chi non ha ancora una
 * chiave non compare: prima deve crearla.
 */
export async function pendingFor(db: DbOrTx, credentialId: string): Promise<VaultPerson[]> {
  const people = await peopleWithKey(db, await effectiveReaderUserIds(db, credentialId), LIVE_KEY_STATUSES);
  if (people.length === 0) return [];
  const copies = await db
    .select({ recipientId: credentialKeyCopies.recipientId })
    .from(credentialKeyCopies)
    .where(eq(credentialKeyCopies.credentialId, credentialId));
  const withCopy = new Set(copies.map((row) => row.recipientId));
  return people.filter((p) => p.status === "pending" || !withCopy.has(p.personKeyId));
}

/**
 * Cancella, nelle credenziali del progetto, le copie della chiave che non
 * appartengono più alla chiave viva di un lettore effettivo: revoche arrivate
 * da fuori dalla cassaforte (ruolo cambiato, uscita dal progetto, admin
 * declassato) e chiavi superate o rifiutate. La copia `recovery` non si tocca
 * mai. Restituisce quante copie ha cancellato.
 */
export async function purgeStaleCopies(db: DbOrTx, projectId: string): Promise<number> {
  const deleted = await db
    .delete(credentialKeyCopies)
    .where(
      and(
        ne(credentialKeyCopies.recipientId, RECOVERY_RECIPIENT_ID),
        inArray(
          credentialKeyCopies.credentialId,
          db.select({ id: credentials.id }).from(credentials).where(eq(credentials.projectId, projectId)),
        ),
        sql`not exists (
          select 1 from ${vaultPersonKeys}
          where ${vaultPersonKeys.id}::text = ${credentialKeyCopies.recipientId}
            and ${vaultPersonKeys.status} in ('pending', 'confirmed')
            and ${effectiveReaderCondition(credentialKeyCopies.credentialId, vaultPersonKeys.userId)}
        )`,
      ),
    )
    .returning({ credentialId: credentialKeyCopies.credentialId });
  return deleted.length;
}
