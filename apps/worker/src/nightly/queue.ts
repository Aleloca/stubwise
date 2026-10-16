import { docPagePendingCommits, nightlyItems, type Db, type NightlyPhase } from "@stubwise/db";
import { and, asc, count, eq, sql } from "drizzle-orm";

/**
 * Coda durevole del giro notturno (Piano B, Task B2): `nightly_items`, unique
 * `(repository_id, phase, key)`. Ogni fase del giro la consuma, e nessuno stato
 * del giro vive solo in memoria: un riavvio riprende da qui.
 *
 * Ciclo di vita di un elemento: `pending` finché non è chiuso. Il claim NON
 * cambia lo stato, scrive solo `claimed_at` (la lease): un elemento reclamato da
 * meno di {@link NIGHTLY_ITEM_LEASE_MS} non si reclama di nuovo, dopo sì (un
 * worker morto a metà non lo perde). Chiusure: `completeItem` → `done`;
 * `releaseItem` (quota o configurazione) → libero, nessun fallimento contato;
 * `failItem` → resta `pending`, conta al più UN fallimento per notte, e alla
 * terza notte diversa → `escalated` (non si riprova più da solo).
 *
 * `completeItem`/`releaseItem`/`failItem` NON verificano chi possiede il claim:
 * il giro è uno alla volta e la lease di 60′ limita la finestra in cui due
 * esecutori potrebbero chiudere lo stesso elemento.
 */

export type { NightlyPhase };
export type NightlyItem = typeof nightlyItems.$inferSelect;

/** Lease del claim: più lunga di ogni run singolo del giro. */
export const NIGHTLY_ITEM_LEASE_MS = 60 * 60_000;

/** Notti di fallimento (diverse) dopo cui un elemento va `escalated`. */
const ESCALATION_NIGHTS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La lease di una riga è viva (orologio del DB, come `claimNext`). */
const leaseLive = sql<boolean>`(${nightlyItems.claimedAt} IS NOT NULL AND ${nightlyItems.claimedAt} >= now() - ${NIGHTLY_ITEM_LEASE_MS} * interval '1 millisecond')`;

export interface NewNightlyItem {
  repositoryId: string;
  projectId: string;
  phase: NightlyPhase;
  key: string;
  payload?: Record<string, unknown>;
}

/**
 * Accoda gli elementi, `ON CONFLICT DO NOTHING` sulla chiave: rieseguire la
 * pianificazione non duplica. Restituisce quante righe NUOVE ha inserito.
 */
export async function enqueueItems(db: Db, items: NewNightlyItem[], night: string): Promise<number> {
  if (items.length === 0) return 0;
  const inserted = await db
    .insert(nightlyItems)
    .values(
      items.map((i) => ({
        repositoryId: i.repositoryId,
        projectId: i.projectId,
        phase: i.phase,
        key: i.key,
        payload: i.payload ?? {},
        night,
      }))
    )
    .onConflictDoNothing()
    .returning({ id: nightlyItems.id });
  return inserted.length;
}

export interface TargetItem {
  repositoryId: string;
  projectId: string;
  phase: "page_update" | "page_create";
  /** La pagina (`pageId`) o l'area (`areaKey`): la chiave è `<target>@<toSha>`. */
  target: string;
  toSha: string;
  payload: Record<string, unknown>;
}

/**
 * `page_update`/`page_create`, chiave `<target>@<toSha>` (D1). Per ogni
 * elemento, in una transazione:
 * - se la chiave esatta esiste già (qualunque stato) non si fa nulla
 *   (idempotenza: rieseguire la stessa pianificazione);
 * - se c'è un `pending` dello stesso repository e fase con chiave che inizia
 *   per `<target>@` (`starts_with`, non `LIKE`: il target non è un pattern) lo
 *   si RIALLINEA al bersaglio nuovo — `key`, `payload`, `night` — conservando
 *   `failed_nights`/`last_failed_night`: le 3 notti contano per la pagina, non
 *   per il bersaglio;
 * - altrimenti si inserisce (`ON CONFLICT DO NOTHING`).
 * Un `done`/`escalated` di un bersaglio vecchio non si tocca (storia), e un
 * `pending` con la lease VIVA (in lavorazione) nemmeno: niente riallineamento
 * né seconda riga, ci pensa la pianificazione successiva.
 * Restituisce quante righe ha inserito o riallineato.
 */
export async function upsertTargetItems(db: Db, items: TargetItem[], night: string): Promise<number> {
  let touched = 0;
  for (const item of items) {
    const key = `${item.target}@${item.toSha}`;
    const changed = await db.transaction(async (tx) => {
      const sameRepoPhase = and(
        eq(nightlyItems.repositoryId, item.repositoryId),
        eq(nightlyItems.phase, item.phase)
      );
      const [exact] = await tx
        .select({ id: nightlyItems.id })
        .from(nightlyItems)
        .where(and(sameRepoPhase, eq(nightlyItems.key, key)));
      if (exact) return 0;
      const [previous] = await tx
        .select({ id: nightlyItems.id, leased: leaseLive })
        .from(nightlyItems)
        .where(
          and(
            sameRepoPhase,
            eq(nightlyItems.status, "pending"),
            sql`starts_with(${nightlyItems.key}, ${`${item.target}@`})`
          )
        )
        .orderBy(asc(nightlyItems.createdAt))
        .limit(1)
        .for("update");
      // Un pending con la lease VIVA è in lavorazione: non gli si cambiano
      // chiave e payload sotto i piedi, e non se ne crea un secondo per lo
      // stesso bersaglio. Lo riallinea la pianificazione successiva.
      if (previous?.leased) return 0;
      if (previous) {
        await tx
          .update(nightlyItems)
          .set({ key, payload: item.payload, night, updatedAt: sql`now()` })
          .where(eq(nightlyItems.id, previous.id));
        return 1;
      }
      const inserted = await tx
        .insert(nightlyItems)
        .values({
          repositoryId: item.repositoryId,
          projectId: item.projectId,
          phase: item.phase,
          key,
          payload: item.payload,
          night,
        })
        .onConflictDoNothing()
        .returning({ id: nightlyItems.id });
      return inserted.length;
    });
    touched += changed;
  }
  return touched;
}

/**
 * Reclama il `pending` più vecchio di repository e fase con la lease
 * (`FOR UPDATE SKIP LOCKED`: due claim concorrenti non prendono la stessa
 * riga, e il `claimed_at` scritto impedisce al claim successivo di riprenderla
 * finché la lease non scade). Orologio: SOLO quello del DB (`now()`), sia per
 * scrivere `claimed_at` sia per confrontarlo — mai un `now` del processo
 * mescolato a quello di Postgres. Lo stato resta `pending`.
 */
export async function claimNext(
  db: Db,
  repositoryId: string,
  phase: NightlyPhase,
  opts: { notFailedOn?: string } = {}
): Promise<NightlyItem | null> {
  // `notFailedOn`: salta gli elementi già falliti in quella notte. Un `failItem`
  // libera la lease, e senza questo filtro il giro (o una sua ripresa nella
  // stessa notte) riprenderebbe subito lo stesso elemento: il fallimento conta
  // una volta per notte, quindi un secondo tentativo costerebbe un run senza
  // cambiare nulla.
  const notFailed =
    opts.notFailedOn === undefined
      ? sql``
      : sql`AND (last_failed_night IS NULL OR last_failed_night <> ${opts.notFailedOn}::date)`;
  const [row] = await db
    .update(nightlyItems)
    .set({ claimedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      sql`${nightlyItems.id} = (
        SELECT id FROM nightly_items
        WHERE status = 'pending'
          AND repository_id = ${repositoryId}
          AND phase = ${phase}
          AND (claimed_at IS NULL OR claimed_at < now() - ${NIGHTLY_ITEM_LEASE_MS} * interval '1 millisecond')
          ${notFailed}
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`
    )
    .returning();
  return row ?? null;
}

/** Chiude l'elemento: `done`, lease liberata. */
export async function completeItem(db: Db, id: string): Promise<void> {
  await db
    .update(nightlyItems)
    .set({ status: "done", claimedAt: null, updatedAt: sql`now()` })
    .where(eq(nightlyItems.id, id));
}

/** Quota o configurazione: libera la lease e basta, nessun fallimento contato. */
export async function releaseItem(db: Db, id: string): Promise<void> {
  await db
    .update(nightlyItems)
    .set({ claimedAt: null, updatedAt: sql`now()` })
    .where(eq(nightlyItems.id, id));
}

/**
 * Un fallimento: l'elemento resta `pending` (lease liberata, `last_error`
 * scritto), e `failed_nights` cresce solo se `night` è diversa da
 * `last_failed_night` (due fallimenti nella stessa notte contano uno). Alla
 * terza notte diversa → `escalated`, e ritorna `"escalated"`.
 *
 * Un `page_update` che passa a `escalated` scrive, nella STESSA transazione, le
 * righe `doc_page_pending_commits` dei commit del payload (D31): un
 * `insert … select` su `commit_summaries` e `doc_pages`, così una pagina o un
 * riassunto spariti non fanno fallire l'escalation (semplicemente non danno
 * righe), `ON CONFLICT DO NOTHING` (più escalation della stessa pagina sono
 * un'unione). Un elemento già chiuso non cambia (ritorna lo stato che ha).
 */
export async function failItem(db: Db, id: string, error: string, night: string): Promise<"retry" | "escalated"> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(nightlyItems).where(eq(nightlyItems.id, id)).for("update");
    if (!item) return "retry";
    if (item.status !== "pending") return item.status === "escalated" ? "escalated" : "retry";

    const failedNights = item.lastFailedNight === night ? item.failedNights : item.failedNights + 1;
    const escalated = failedNights >= ESCALATION_NIGHTS;
    await tx
      .update(nightlyItems)
      .set({
        status: escalated ? "escalated" : "pending",
        failedNights,
        lastFailedNight: night,
        lastError: error,
        claimedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(nightlyItems.id, id));

    if (escalated && item.phase === "page_update") {
      const pageId = item.payload.pageId;
      const commits = Array.isArray(item.payload.commits)
        ? item.payload.commits.filter((c): c is string => typeof c === "string")
        : [];
      if (typeof pageId === "string" && UUID_RE.test(pageId) && commits.length > 0) {
        await tx.execute(sql`
          INSERT INTO ${docPagePendingCommits} (page_id, repository_id, sha)
          SELECT p.id, cs.repository_id, cs.sha
          FROM commit_summaries cs
          JOIN doc_pages p ON p.id = ${pageId}::uuid AND p.repository_id = cs.repository_id
          WHERE cs.repository_id = ${item.repositoryId}
            AND cs.sha IN (${sql.join(
              commits.map((c) => sql`${c}`),
              sql`, `
            )})
          ON CONFLICT DO NOTHING
        `);
      }
    }
    return escalated ? "escalated" : "retry";
  });
}

/** Elementi `pending` del repository (di una fase, se data). */
export async function pendingCount(db: Db, repositoryId: string, phase?: NightlyPhase): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(nightlyItems)
    .where(
      and(
        eq(nightlyItems.repositoryId, repositoryId),
        eq(nightlyItems.status, "pending"),
        phase === undefined ? undefined : eq(nightlyItems.phase, phase)
      )
    );
  return row?.n ?? 0;
}
