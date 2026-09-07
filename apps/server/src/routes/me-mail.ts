import {
  calendarEvents,
  emailMessages,
  googleAccounts,
  notifications,
  projects,
  type Db,
} from "@stubwise/db";
import {
  mailItemStatusSchema,
  mailPageSchema,
  mailReproposeResultSchema,
  mailSourceSchema,
  mailSummarySchema,
  type MailItem,
  type MailItemStatus,
} from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * PAGINA POSTA (fase 6, Task 12), sotto `/api/me/mail`: i messaggi Gmail e gli
 * eventi di calendario TRATTATI dal poller — non la posta grezza, quella non
 * lascia mai `email_messages`/`calendar_events` se è fuori dal perimetro di
 * routing di nessun progetto.
 *
 * ⚠️ Come `/api/me/google` (vedi il docblock di `me-google.ts`): **`user_id` è
 * SEMPRE nel WHERE**, via il JOIN su `google_accounts` filtrato per
 * `userId`. Nessun ruolo scavalca il filtro, nemmeno un admin: la posta di un
 * utente non è un dato amministrabile. Una riga di un altro utente — o un
 * `account`/`project` che non è il suo — produce una pagina vuota o un 404,
 * mai 403 (non si conferma che l'id esiste).
 *
 * ## Lista UNIFICATA, non due liste
 *
 * `GET /` fonde `email_messages` e `calendar_events` in UNA lista ordinata per
 * data, con un campo `source` a distinguerle — è la lettura più fedele del
 * design (§5, "Pagina Posta": *"elenco di messaggi ed eventi trattati"*, non
 * due elenchi separati). La fusione è in MEMORIA (una query per sorgente,
 * come `buildProjectTimeline` in `@stubwise/notifications`): niente UNION SQL,
 * che costringerebbe le due tabelle — colonne, filtri e stato diversi — a una
 * forma comune fatta di `null`.
 *
 * Paginazione: **keyset in memoria** sulla coppia `(date, id)` DESC (`date` è
 * `receivedAt` per la posta, `startsAt` per il calendario). Ogni sorgente
 * fornisce `limit + 1` righe già filtrate dal cursore (ordinamento e
 * confronto SQL sulla propria colonna): è la proprietà standard del k-way
 * merge — le prime `limit` righe della fusione non possono mai richiedere più
 * di `limit + 1` righe da una singola sorgente, quindi il pool basta a
 * produrre una pagina corretta e a sapere se ce n'è un'altra.
 *
 * ## Stato NORMALIZZATO del calendario
 *
 * `email_messages.status` è già nel vocabolario di {@link mailItemStatusSchema}.
 * `calendar_events` non ha una colonna gemella (la sua `status` è quella di
 * GOOGLE): {@link CALENDAR_STATUS_CASE_SQL} la deriva da `status`/`outcome`/
 * `proposal_notification_id` con la STESSA regola di `isReadyForProposal`
 * (`apps/worker/src/google/calendar.ts`) e di `outcome.type` scritto da
 * `google-proposal.ts` — se quelle regole cambiano, questa CASE va aggiornata
 * insieme (non c'è un test di parità automatico: i tre punti sono commentati
 * l'uno sull'altro apposta).
 */

const sourceParamsSchema = z.object({ source: mailSourceSchema, id: z.uuid() });

/** Quante righe per pagina se il chiamante non lo dice, e il tetto massimo — come `/api/inbox`. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// --- Cursore keyset in memoria, sulla coppia (date, id) DESC ---------------

interface MailCursor {
  date: string;
  id: string;
}

function encodeCursor(cursor: MailCursor): string {
  return Buffer.from(`${cursor.date}|${cursor.id}`, "utf8").toString("base64url");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string): MailCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) return null;
  const date = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(Date.parse(date))) return null;
  if (!UUID_PATTERN.test(id)) return null;
  return { date, id };
}

// --- Stato normalizzato del calendario, in SQL ------------------------------

/**
 * La stessa regola espressa due volte (nella proiezione e nel filtro
 * `status`): Postgres non permette di riferire un alias di SELECT nel WHERE
 * della stessa query, quindi la CASE si ripete. Restituisce una NUOVA
 * espressione a ogni chiamata (il builder `sql` non è riusabile fra due punti
 * della stessa query).
 */
function calendarStatusCaseSql() {
  return sql<string>`case
    when ${calendarEvents.status} = 'cancelled' then 'cancelled'
    when ${calendarEvents.outcome} is null and ${calendarEvents.proposalNotificationId} is null then 'new'
    when ${calendarEvents.outcome} is null then 'proposed'
    when ${calendarEvents.outcome}->>'type' = 'failed' then 'failed'
    when ${calendarEvents.outcome}->>'type' = 'ignored' then 'ignored'
    when ${calendarEvents.outcome}->>'type' = 'cancelled' then 'cancelled'
    else 'actioned'
  end`;
}

/**
 * Riproponibile: SOLO `failed`/`ignored`, come `isReadyForProposal` per il
 * resto del cancello. `coalesce(..., false)`: `outcome->>'type' in (...)` è
 * SQL a tre valori — con `outcome` `NULL` (nessuna azione ancora presa) il
 * confronto vale `NULL`, non `false`, e senza il coalesce lo schema di
 * risposta (`reproposable: z.boolean()`) rifiuterebbe la riga.
 */
function calendarReproposableSql() {
  return sql<boolean>`coalesce(${calendarEvents.outcome}->>'type' in ('failed', 'ignored'), false)`;
}

// --- Link al thread Gmail / alla giornata del calendario --------------------
//
// Duplicati (non importati) da `apps/worker/src/google/proposal.ts`: il
// server non dipende dal worker, e sono funzioni pure di poche righe — vedi
// la stessa scelta in `services/google-proposal.ts` (`gmailThreadUrl`).

function gmailThreadUrl(mailboxEmail: string, threadId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailboxEmail)}/#all/${threadId}`;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function calendarDayUrl(mailboxEmail: string, startsAt: Date): string {
  const [year, month, day] = isoDay(startsAt).split("-");
  return `https://calendar.google.com/calendar/u/${encodeURIComponent(mailboxEmail)}/r/day/${year}/${Number(month)}/${Number(day)}`;
}

// --- Lettura ----------------------------------------------------------------

interface ListMailInput {
  userId: string;
  account?: string;
  status?: MailItemStatus;
  project?: string;
  cursor?: MailCursor;
  limit: number;
}

async function queryEmailCandidates(db: Db, input: ListMailInput): Promise<MailItem[]> {
  // `status: "cancelled"` non esiste MAI sulla posta (fuori dal CHECK della
  // colonna): la query tornerebbe comunque vuota, ma si evita di lanciarla.
  if (input.status === "cancelled") return [];
  const conditions = [eq(googleAccounts.userId, input.userId)];
  if (input.account) conditions.push(eq(emailMessages.accountId, input.account));
  if (input.project) conditions.push(eq(emailMessages.projectId, input.project));
  if (input.status) conditions.push(eq(emailMessages.status, input.status));
  if (input.cursor) {
    conditions.push(
      sql`(${emailMessages.receivedAt}, ${emailMessages.id}) < (${input.cursor.date}::timestamptz, ${input.cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select({
      id: emailMessages.id,
      accountId: emailMessages.accountId,
      accountEmail: googleAccounts.email,
      projectId: emailMessages.projectId,
      projectName: projects.name,
      title: emailMessages.subject,
      from: emailMessages.fromAddress,
      threadId: emailMessages.threadId,
      date: emailMessages.receivedAt,
      status: emailMessages.status,
      signal: emailMessages.signal,
      outcome: emailMessages.outcome,
      error: emailMessages.error,
    })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .leftJoin(projects, eq(projects.id, emailMessages.projectId))
    .where(and(...conditions))
    .orderBy(desc(emailMessages.receivedAt), desc(emailMessages.id))
    .limit(input.limit + 1);

  return rows.map((row) => ({
    id: row.id,
    source: "email",
    accountId: row.accountId,
    accountEmail: row.accountEmail,
    projectId: row.projectId,
    projectName: row.projectName,
    title: row.title,
    from: row.from,
    date: row.date.toISOString(),
    status: row.status,
    signal: row.signal,
    outcome: row.outcome,
    error: row.error,
    url: gmailThreadUrl(row.accountEmail, row.threadId),
    reproposable: row.status === "failed" || row.status === "ignored",
  }));
}

async function queryCalendarCandidates(db: Db, input: ListMailInput): Promise<MailItem[]> {
  const conditions = [eq(googleAccounts.userId, input.userId)];
  if (input.account) conditions.push(eq(calendarEvents.accountId, input.account));
  if (input.project) conditions.push(eq(calendarEvents.projectId, input.project));
  // Il segnale è un concetto SOLO della posta (nessuna AI sul calendario):
  // un filtro `status` valido per il calendario resta lo status normalizzato,
  // mai `signal` (che il calendario non ha).
  if (input.status) conditions.push(sql`${calendarStatusCaseSql()} = ${input.status}`);
  if (input.cursor) {
    conditions.push(
      sql`(${calendarEvents.startsAt}, ${calendarEvents.id}) < (${input.cursor.date}::timestamptz, ${input.cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select({
      id: calendarEvents.id,
      accountId: calendarEvents.accountId,
      accountEmail: googleAccounts.email,
      projectId: calendarEvents.projectId,
      projectName: projects.name,
      title: calendarEvents.title,
      from: calendarEvents.organizer,
      date: calendarEvents.startsAt,
      status: calendarStatusCaseSql().as("normalized_status"),
      outcome: calendarEvents.outcome,
      reproposable: calendarReproposableSql().as("reproposable"),
    })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .leftJoin(projects, eq(projects.id, calendarEvents.projectId))
    .where(and(...conditions))
    .orderBy(desc(calendarEvents.startsAt), desc(calendarEvents.id))
    .limit(input.limit + 1);

  return rows.map((row) => {
    const outcome = row.outcome;
    const error =
      outcome && typeof outcome === "object" && typeof (outcome as Record<string, unknown>).error === "string"
        ? ((outcome as Record<string, unknown>).error as string)
        : null;
    return {
      id: row.id,
      source: "calendar",
      accountId: row.accountId,
      accountEmail: row.accountEmail,
      projectId: row.projectId,
      projectName: row.projectName,
      title: row.title,
      from: row.from,
      date: row.date.toISOString(),
      status: row.status as MailItemStatus,
      signal: null,
      outcome: row.outcome,
      error,
      url: calendarDayUrl(row.accountEmail, row.date),
      reproposable: row.reproposable,
    };
  });
}

/** Fonde due pool GIÀ ordinati desc (date, id) e ne restituisce la pagina + il prossimo cursore. */
function mergePages(
  a: MailItem[],
  b: MailItem[],
  limit: number,
): { items: MailItem[]; nextCursor: string | null } {
  const merged = [...a, ...b].sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? 1 : -1;
    return x.id < y.id ? 1 : -1;
  });
  const page = merged.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    merged.length > limit && last ? encodeCursor({ date: last.date, id: last.id }) : null;
  return { items: page, nextCursor };
}

export async function meMailRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: z.object({
          account: z.uuid().optional(),
          status: mailItemStatusSchema.optional(),
          project: z.uuid().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        }),
        response: { 200: mailPageSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { account, status, project, cursor: rawCursor, limit } = request.query;
      const cursor = rawCursor === undefined ? undefined : (decodeCursor(rawCursor) ?? undefined);
      if (rawCursor !== undefined && cursor === undefined) {
        return apiError(reply, 400, "invalid_cursor", "Invalid pagination cursor");
      }
      const input: ListMailInput = {
        userId: request.user!.id,
        limit,
        ...(account ? { account } : {}),
        ...(status ? { status } : {}),
        ...(project ? { project } : {}),
        ...(cursor ? { cursor } : {}),
      };
      const [emailCandidates, calendarCandidates] = await Promise.all([
        queryEmailCandidates(app.db, input),
        queryCalendarCandidates(app.db, input),
      ]);
      return mergePages(emailCandidates, calendarCandidates, limit);
    },
  );

  /**
   * Contatori per il badge di nav e l'intestazione: `openProposals` sulle
   * NOTIFICHE (`google.proposal` ancora `open` di questo utente — l'audience
   * `mailbox_owner` garantisce che sia l'unico destinatario), `failed`/
   * `ignored` sulle RIGHE (posta + calendario, stato normalizzato).
   */
  app.get(
    "/summary",
    {
      preHandler: requireAuth,
      schema: {
        response: { 200: mailSummarySchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const [[openRow], [emailFailedRow], [emailIgnoredRow], [calFailedRow], [calIgnoredRow]] =
        await Promise.all([
          app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, userId),
                eq(notifications.kind, "google.proposal"),
                eq(notifications.status, "open"),
              ),
            ),
          app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(emailMessages)
            .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
            .where(and(eq(googleAccounts.userId, userId), eq(emailMessages.status, "failed"))),
          app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(emailMessages)
            .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
            .where(and(eq(googleAccounts.userId, userId), eq(emailMessages.status, "ignored"))),
          app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(calendarEvents)
            .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
            .where(
              and(eq(googleAccounts.userId, userId), sql`${calendarEvents.outcome}->>'type' = 'failed'`),
            ),
          app.db
            .select({ count: sql<number>`count(*)::int` })
            .from(calendarEvents)
            .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
            .where(
              and(eq(googleAccounts.userId, userId), sql`${calendarEvents.outcome}->>'type' = 'ignored'`),
            ),
        ]);
      return {
        openProposals: openRow?.count ?? 0,
        failed: (emailFailedRow?.count ?? 0) + (calFailedRow?.count ?? 0),
        ignored: (emailIgnoredRow?.count ?? 0) + (calIgnoredRow?.count ?? 0),
      };
    },
  );

  /**
   * Riproponi una riga `failed`/`ignored`: NON pubblica una nuova proposta da
   * qui (competerebbe col poller sulla stessa riga), resetta solo lo stato
   * perché il PROSSIMO tick del poller la riprenda — vedi la nota del Task 11
   * nel prompt di questo task. La notifica vecchia (se esisteva) resta
   * `handled` per sempre: non si riapre mai una notifica chiusa, nasce una
   * proposta nuova.
   *
   * Due rotte per sorgente (`/email/:id` e `/calendar/:id`) invece di
   * un'unica `/:id` con prefisso o campo `source` nel body: l'id da solo non
   * basta a distinguere le due tabelle (sono UUID indipendenti, una
   * collisione fra le due non è impossibile), e un campo nel body per una
   * mutazione così piccola aggiungerebbe un modo di sbagliare (mandare l'id
   * giusto col `source` sbagliato) che il path elimina per costruzione.
   */
  app.post(
    "/:source/:id/repropose",
    {
      preHandler: requireAuth,
      schema: {
        params: sourceParamsSchema,
        response: { 200: mailReproposeResultSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { source, id } = request.params;
      const userId = request.user!.id;

      if (source === "email") {
        const [row] = await app.db
          .select({ id: emailMessages.id, status: emailMessages.status })
          .from(emailMessages)
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(and(eq(emailMessages.id, id), eq(googleAccounts.userId, userId)));
        if (!row) return apiError(reply, 404, "not_found", "Message not found");
        if (row.status !== "failed" && row.status !== "ignored") {
          return apiError(reply, 409, "not_reproposable", "This message cannot be reproposed");
        }
        await app.db
          .update(emailMessages)
          .set({ status: "new", error: null })
          .where(eq(emailMessages.id, id));
        return { ok: true as const };
      }

      const [row] = await app.db
        .select({
          id: calendarEvents.id,
          status: calendarStatusCaseSql().as("normalized_status"),
        })
        .from(calendarEvents)
        .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
        .where(and(eq(calendarEvents.id, id), eq(googleAccounts.userId, userId)));
      if (!row) return apiError(reply, 404, "not_found", "Event not found");
      if (row.status !== "failed" && row.status !== "ignored") {
        return apiError(reply, 409, "not_reproposable", "This event cannot be reproposed");
      }
      await app.db
        .update(calendarEvents)
        .set({ outcome: null, proposalNotificationId: null })
        .where(eq(calendarEvents.id, id));
      return { ok: true as const };
    },
  );
}
