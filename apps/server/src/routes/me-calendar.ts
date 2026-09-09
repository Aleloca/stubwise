import { calendarEvents, calendarSeries, googleAccounts, projects, type Db } from "@stubwise/db";
import {
  calendarEventPageSchema,
  calendarSeriesListSchema,
  calendarSeriesPatchSchema,
  mailItemStatusSchema,
  type CalendarEventItem,
  type MailItemStatus,
} from "@stubwise/shared";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { calendarDayUrl, calendarReproposableSql, calendarStatusCaseSql } from "./calendar-status.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * SEZIONE CALENDARIO (fase 7b), sotto `/api/me/calendar`: la superficie che
 * la fase 6 non aveva mai avuto (design §1, §4) — gli appuntamenti visti e le
 * serie ricorrenti riconosciute, con la loro configurazione.
 *
 * ⚠️ Stessa ACL della Posta (`me-mail.ts`, docblock omologo): **`user_id` è
 * SEMPRE nel WHERE**, via il JOIN su `google_accounts` filtrato per
 * `userId`. Nessun ruolo scavalca il filtro, nemmeno un admin: il calendario
 * di un utente non è un dato amministrabile. Una riga di un altro utente — o
 * un `account`/`series` che non è il suo — produce una pagina vuota o un
 * 404, mai 403 (non si conferma che l'id esiste). Design fase 7b §6,
 * "Privacy": "Un maintainer non vede il calendario di un collega, come già
 * non ne vede la posta."
 *
 * `GET /` e la CASE che deriva lo stato normalizzato sono condivisi con
 * `me-mail.ts` via `./calendar-status.js`: stesso vocabolario
 * (`mailItemStatusSchema`), stessa regola — se cambia lì, cambia qui.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// --- Cursore keyset in memoria, sulla coppia (startsAt, id) DESC -----------
// Stessa forma di `me-mail.ts`: `date` qui è sempre `calendar_events.starts_at`
// (un'unica sorgente, a differenza della pagina Posta che ne fonde tre).

interface CalendarCursor {
  date: string;
  id: string;
}

function encodeCursor(cursor: CalendarCursor): string {
  return Buffer.from(`${cursor.date}|${cursor.id}`, "utf8").toString("base64url");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string): CalendarCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) return null;
  const date = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(Date.parse(date))) return null;
  if (!UUID_PATTERN.test(id)) return null;
  return { date, id };
}

export async function meCalendarRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * "Gli appuntamenti visti" (design §4): una riga per occorrenza, stesso
   * ordinamento e la stessa forma di keyset di `GET /api/me/mail`, ma SOLO il
   * calendario — questa pagina non fonde la posta.
   */
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
        response: { 200: calendarEventPageSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { account, status, project, cursor: rawCursor, limit } = request.query;
      const cursor = rawCursor === undefined ? undefined : (decodeCursor(rawCursor) ?? undefined);
      if (rawCursor !== undefined && cursor === undefined) {
        return apiError(reply, 400, "invalid_cursor", "Invalid pagination cursor");
      }
      const items = await queryCalendarEvents(app.db, {
        userId: request.user!.id,
        limit,
        ...(account ? { account } : {}),
        ...(status ? { status } : {}),
        ...(project ? { project } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const page = items.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        items.length > limit && last ? encodeCursor({ date: last.startsAt, id: last.id }) : null;
      return { items: page, nextCursor };
    },
  );

  /**
   * "Le serie ricorrenti riconosciute" (design §4): derivate raggruppando le
   * occorrenze GIÀ tracciate per `(account_id, recurring_event_id)`, con la
   * configurazione di `calendar_series` se esiste — altrimenti i default
   * (spenta). Nessuna paginazione: il numero di serie per casella è per
   * natura piccolo (riunioni ricorrenti, non messaggi), a differenza degli
   * appuntamenti visti.
   */
  app.get(
    "/series",
    {
      preHandler: requireAuth,
      schema: {
        querystring: z.object({ account: z.uuid().optional() }),
        response: { 200: calendarSeriesListSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { account } = request.query;
      const conditions = [
        eq(googleAccounts.userId, request.user!.id),
        isNotNull(calendarEvents.recurringEventId),
      ];
      if (account) conditions.push(eq(calendarEvents.accountId, account));

      const rows = await app.db
        .select({
          accountId: calendarEvents.accountId,
          accountEmail: googleAccounts.email,
          recurringEventId: sql<string>`${calendarEvents.recurringEventId}`,
          title: sql<string | null>`(array_agg(${calendarEvents.title} order by ${calendarEvents.startsAt} desc))[1]`,
          occurrenceCount: sql<number>`count(*)::int`,
          // Tipo runtime reale: una stringa timestamp Postgres, non un Date
          // (il driver non applica la conversione delle colonne normali a
          // un'espressione SQL grezza) — vedi la normalizzazione sotto.
          nextOccurrenceAt: sql<string | null>`min(${calendarEvents.startsAt}) filter (where ${calendarEvents.startsAt} >= now() and ${calendarEvents.status} is distinct from 'cancelled')`,
          enabled: sql<boolean>`coalesce(bool_or(${calendarSeries.enabled}), false)`,
          projectId: sql<string | null>`min(${calendarSeries.projectId}::text)`,
          action: sql<string>`coalesce(min(${calendarSeries.action}), 'milestone')`,
          leadDays: sql<number>`coalesce(min(${calendarSeries.leadDays}), 2)`,
          auto: sql<boolean>`coalesce(bool_or(${calendarSeries.auto}), false)`,
        })
        .from(calendarEvents)
        .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
        .leftJoin(
          calendarSeries,
          and(
            eq(calendarSeries.accountId, calendarEvents.accountId),
            eq(calendarSeries.recurringEventId, calendarEvents.recurringEventId),
          ),
        )
        .where(and(...conditions))
        .groupBy(calendarEvents.accountId, googleAccounts.email, calendarEvents.recurringEventId)
        .orderBy(asc(sql`min(${calendarEvents.startsAt}) filter (where ${calendarEvents.startsAt} >= now()) is null`), asc(sql`min(${calendarEvents.startsAt}) filter (where ${calendarEvents.startsAt} >= now())`));

      const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => id !== null))];
      const projectNames =
        projectIds.length === 0
          ? new Map<string, string>()
          : new Map(
              (
                await app.db
                  .select({ id: projects.id, name: projects.name })
                  .from(projects)
                  .where(sql`${projects.id} in ${projectIds}`)
              ).map((row) => [row.id, row.name]),
            );

      return {
        items: rows.map((row) => ({
          accountId: row.accountId,
          accountEmail: row.accountEmail,
          recurringEventId: row.recurringEventId,
          title: row.title,
          occurrenceCount: row.occurrenceCount,
          // Il driver non converte in Date il risultato di un'espressione SQL
          // grezza (a differenza di una colonna timestamp normale): arriva
          // come stringa Postgres (`"2026-09-10 09:00:00+00"`), da
          // rinormalizzare in ISO passando per `new Date(...)`.
          nextOccurrenceAt: row.nextOccurrenceAt ? new Date(row.nextOccurrenceAt).toISOString() : null,
          enabled: row.enabled,
          projectId: row.projectId,
          projectName: row.projectId ? (projectNames.get(row.projectId) ?? null) : null,
          action: row.action as "backlog_item" | "milestone" | "reminder",
          leadDays: row.leadDays,
          auto: row.auto,
        })),
      };
    },
  );

  /**
   * Attiva/configura una serie. `enabled: true` SENZA `projectId` è un 400:
   * "il progetto si fissa, non si ri-deduce" (design §4) — non esiste una
   * serie accesa senza un progetto scelto una volta per tutte.
   *
   * `accountId` nel BODY (non nel path, non nel querystring): identifica
   * quale casella dell'utente possiede questa serie, verificato con la
   * stessa ACL delle altre rotte prima di scrivere. Upsert su
   * `(account_id, recurring_event_id)` — la riga può non esistere ancora
   * (nessuna configurazione precedente: la serie era solo un gruppo di righe
   * in `calendar_events`, spenta per definizione).
   */
  app.put(
    "/series/:recurringEventId",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ recurringEventId: z.string().min(1) }),
        body: calendarSeriesPatchSchema,
        response: { 200: z.object({ ok: z.literal(true) }), 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { recurringEventId } = request.params;
      const { accountId, enabled, projectId, action, leadDays, auto } = request.body;

      if (enabled && !projectId) {
        return apiError(reply, 400, "project_required", "A project is required to enable a series");
      }

      const [account] = await app.db
        .select({ id: googleAccounts.id })
        .from(googleAccounts)
        .where(and(eq(googleAccounts.id, accountId), eq(googleAccounts.userId, request.user!.id)));
      if (!account) return apiError(reply, 404, "not_found", "Google account not found");

      // La serie deve esistere davvero (almeno un'occorrenza tracciata sotto
      // questo id): non si configura una serie che il poller non ha mai
      // visto — evita righe orfane digitate a mano via API.
      const [seen] = await app.db
        .select({ id: calendarEvents.id })
        .from(calendarEvents)
        .where(
          and(eq(calendarEvents.accountId, accountId), eq(calendarEvents.recurringEventId, recurringEventId)),
        )
        .limit(1);
      if (!seen) return apiError(reply, 404, "not_found", "Series not found");

      await app.db
        .insert(calendarSeries)
        .values({ accountId, recurringEventId, enabled, projectId, action, leadDays, auto })
        .onConflictDoUpdate({
          target: [calendarSeries.accountId, calendarSeries.recurringEventId],
          set: { enabled, projectId, action, leadDays, auto },
        });

      return { ok: true as const };
    },
  );

  /**
   * Spegne una serie: elimina la riga di configurazione, riportandola ai
   * default inerti (`enabled: false`) — non un flag, la rimozione stessa: una
   * serie mai configurata e una serie spenta di nuovo sono la STESSA cosa per
   * `isReadyForProposal` (`apps/worker/src/google/calendar.ts`).
   */
  app.delete(
    "/series/:recurringEventId",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ recurringEventId: z.string().min(1) }),
        querystring: z.object({ account: z.uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { recurringEventId } = request.params;
      const { account: accountId } = request.query;

      const [account] = await app.db
        .select({ id: googleAccounts.id })
        .from(googleAccounts)
        .where(and(eq(googleAccounts.id, accountId), eq(googleAccounts.userId, request.user!.id)));
      if (!account) return apiError(reply, 404, "not_found", "Google account not found");

      await app.db
        .delete(calendarSeries)
        .where(and(eq(calendarSeries.accountId, accountId), eq(calendarSeries.recurringEventId, recurringEventId)));

      return { ok: true as const };
    },
  );
}

interface ListCalendarInput {
  userId: string;
  account?: string;
  status?: MailItemStatus;
  project?: string;
  cursor?: CalendarCursor;
  limit: number;
}

async function queryCalendarEvents(db: Db, input: ListCalendarInput): Promise<CalendarEventItem[]> {
  const conditions = [eq(googleAccounts.userId, input.userId)];
  if (input.account) conditions.push(eq(calendarEvents.accountId, input.account));
  if (input.project) conditions.push(eq(calendarEvents.projectId, input.project));
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
      recurringEventId: calendarEvents.recurringEventId,
      projectId: calendarEvents.projectId,
      projectName: projects.name,
      title: calendarEvents.title,
      organizer: calendarEvents.organizer,
      startsAt: calendarEvents.startsAt,
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
      accountId: row.accountId,
      accountEmail: row.accountEmail,
      recurringEventId: row.recurringEventId,
      projectId: row.projectId,
      projectName: row.projectName,
      title: row.title,
      organizer: row.organizer,
      startsAt: row.startsAt.toISOString(),
      status: row.status as MailItemStatus,
      outcome: row.outcome,
      error,
      url: calendarDayUrl(row.accountEmail, row.startsAt),
      reproposable: row.reproposable,
    };
  });
}
