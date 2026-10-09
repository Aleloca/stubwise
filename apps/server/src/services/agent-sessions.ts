import { and, desc, eq, gt, inArray, isNull, lt, not, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agentQuestions,
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  aiJobs,
  backlogItems,
  backlogJobs,
  backlogQuestions,
  docGenerations,
  emailMessages,
  prReviews,
  projects,
  repositories,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { actorAllows, stateAllows } from "@stubwise/notifications";
import {
  AGENT_SESSION_INPUT_CHANNEL,
  describeAgentActivity,
  type AgentSessionDetail,
  type AgentSessionEvent,
  type AgentSessionInput,
  type AgentSessionListQuery,
  type AgentSessionOutcome,
  type AgentSessionQuestion,
  type AgentSessionState,
  type AgentSessionSummary,
  type AiJobStatus,
  type BacklogJobStatus,
  type DocGenerationStatus,
  type Language,
} from "@stubwise/shared";
import { getContentLanguage } from "../settings.js";
import type { Actor } from "./jobs.js";

/**
 * Lettura delle sessioni degli agenti (design 2026-10-08 §8). Stato, esito,
 * ultima azione, canWrite, domande e nome di chi è intervenuto si DERIVANO a
 * lettura: niente di tutto ciò è scritto dal worker in una forma che invecchi.
 */

export const LIVE_HEARTBEAT_SECONDS = 90;
const RECENT_LIMIT = 50;
const MAX_INPUTS = 100;
const WINDOW_DAYS = 14;

/**
 * Visibilità: una sessione di posta la vede SOLO il proprietario della
 * casella, nessun ramo per ruolo (invariante mailbox_owner).
 */
export function visibleTo(viewer: Actor): SQL {
  return or(
    isNull(agentSessions.mailboxOwnerUserId),
    eq(agentSessions.mailboxOwnerUserId, viewer.id),
  )!;
}

export interface SessionDerivationInput {
  live: boolean;
  aiJobStatus: AiJobStatus | null;
  prReviewStatus: "running" | "completed" | "failed" | null;
  docGenerationStatus: DocGenerationStatus | null;
  backlogJobStatus: BacklogJobStatus | null;
  openBacklogQuestion: boolean;
  lastSegmentEnd: Record<string, unknown> | null;
}

/** Regola UNICA dello stato (design §8.2); l'ordine dei casi è la precedenza. */
export function deriveAgentSessionState(i: SessionDerivationInput): AgentSessionState {
  if (i.live) return "working";
  if (i.aiJobStatus === "awaiting_input" || i.openBacklogQuestion) return "waiting_input";
  if (i.aiJobStatus === "awaiting_plan_approval") return "awaiting_approval";
  if (i.aiJobStatus === "held" || i.docGenerationStatus === "paused") return "held";
  if (
    i.aiJobStatus === "triaging" ||
    i.aiJobStatus === "fixing" ||
    i.prReviewStatus === "running" ||
    i.docGenerationStatus === "running" ||
    i.backlogJobStatus === "running"
  ) {
    return "working";
  }
  if (
    i.aiJobStatus === "queued" ||
    i.docGenerationStatus === "pending" ||
    i.backlogJobStatus === "queued"
  ) {
    return "queued";
  }
  return "ended";
}

/** Esito derivato, mai scritto (design §8.2). `null` = non si sa. */
export function deriveAgentSessionOutcome(
  state: AgentSessionState,
  i: SessionDerivationInput,
): AgentSessionOutcome | null {
  if (state !== "ended") return null;
  if (i.aiJobStatus !== null) {
    if (
      i.aiJobStatus === "pr_opened" ||
      i.aiJobStatus === "pr_merged" ||
      i.aiJobStatus === "pr_closed"
    ) {
      return "completed";
    }
    if (i.aiJobStatus === "failed") return "failed";
    if (i.aiJobStatus === "skipped") return "skipped";
    return null;
  }
  if (i.prReviewStatus !== null) {
    return i.prReviewStatus === "completed"
      ? "completed"
      : i.prReviewStatus === "failed"
        ? "failed"
        : null;
  }
  if (i.docGenerationStatus !== null) {
    return i.docGenerationStatus === "succeeded"
      ? "completed"
      : i.docGenerationStatus === "failed"
        ? "failed"
        : null;
  }
  if (i.backlogJobStatus !== null) {
    return i.backlogJobStatus === "done"
      ? "completed"
      : i.backlogJobStatus === "failed"
        ? "failed"
        : null;
  }
  const end = i.lastSegmentEnd;
  if (end === null) return null;
  if (end["timedOut"] === true) return "failed";
  return end["exitCode"] === 0 ? "completed" : "failed";
}

/** Regola di Task 6: almeno un segmento aperto E heartbeat fresco. */
const liveSql = sql<boolean>`(cardinality(${agentSessions.liveSegmentIds}) > 0 and ${agentSessions.heartbeatAt} > now() - make_interval(secs => ${LIVE_HEARTBEAT_SECONDS}::int))`;

/**
 * `active_segment_*` può ancora nominare un segmento CHIUSO mentre un altro
 * gira (la fine di un segmento toglie solo sé stesso): il segmento attivo vale
 * solo se è fra quelli aperti.
 */
const activeSegmentOpenSql = sql<boolean>`coalesce(${agentSessions.activeSegmentId} = any(${agentSessions.liveSegmentIds}), false)`;

const openBacklogQuestionSql = sql<boolean>`(${agentSessions.backlogItemId} is not null and exists (
  select 1 from ${backlogQuestions}
  where ${backlogQuestions.backlogItemId} = ${agentSessions.backlogItemId}
    and ${backlogQuestions.answeredAt} is null and ${backlogQuestions.dismissedAt} is null))`;

/**
 * Le due sottoquery correlate qui sotto girano per OGNI riga di elenco e
 * dettaglio: le servono gli indici PARZIALI della 0086
 * (`agent_session_events_activity_idx`, `agent_session_events_segment_end_idx`).
 * I predicati sul tipo sono gli stessi letterali di quegli indici: chi li
 * cambia qui li cambia anche lì, o il planner torna a scorrere la sessione.
 */
const lastToolEvent = sql<{ type: string; data: Record<string, unknown> } | null>`(
  select json_build_object('type', e.type, 'data', e.data)
  from ${agentSessionEvents} e
  where e.session_id = ${agentSessions.id} and e.type in ('tool_use', 'assistant_text')
  order by e.id desc limit 1)`;

const lastSegmentEndSql = sql<Record<string, unknown> | null>`(
  select e.data from ${agentSessionEvents} e
  where e.session_id = ${agentSessions.id} and e.type = 'segment_end'
  order by e.id desc limit 1)`;

/**
 * Sovrainsieme SQL degli stati diversi da `ended` di `deriveAgentSessionState`:
 * una sessione che lo soddisfa PUÒ essere non finita, una che non lo soddisfa
 * è certamente `ended`. Deve restare d'accordo con quella funzione: chi
 * aggiunge uno stato «non finito» là lo aggiunge anche qui, o la sessione
 * finisce sotto il tetto delle recenti. `coalesce` perché senza riga
 * proprietaria lo stato è NULL, e `not(NULL)` escluderebbe la riga da entrambe
 * le query.
 */
const possiblyActiveSql = sql`coalesce((
  cardinality(${agentSessions.liveSegmentIds}) > 0
  or ${aiJobs.status} in ('queued', 'triaging', 'fixing', 'awaiting_input', 'awaiting_plan_approval', 'held')
  or ${prReviews.status} = 'running'
  or ${docGenerations.status} in ('pending', 'running', 'paused')
  or ${backlogJobs.status} in ('queued', 'running')
  or ${openBacklogQuestionSql}
), false)`;

/** La STESSA espressione della potatura (Task 6) e dell'indice della 0086. */
const lastActivitySql = sql`coalesce(${agentSessions.lastEventAt}, ${agentSessions.startedAt})`;

/** Repository della review e della generazione Docs: due join sulla stessa tabella. */
const reviewRepositories = alias(repositories, "review_repositories");
const docRepositories = alias(repositories, "doc_repositories");

function baseSelect(db: Db) {
  return (
    db
      .select({
        id: agentSessions.id,
        kind: agentSessions.kind,
        ownerKey: agentSessions.ownerKey,
        storedTitle: agentSessions.title,
        ticketTitle: tickets.title,
        reviewPrNumber: prReviews.prNumber,
        reviewRepositoryName: reviewRepositories.name,
        docRepositoryName: docRepositories.name,
        backlogItemTitle: backlogItems.title,
        backlogJobKind: backlogJobs.kind,
        emailMessageId: emailMessages.id,
        emailSubject: emailMessages.subject,
        projectId: agentSessions.projectId,
        projectName: projects.name,
        ticketId: agentSessions.ticketId,
        ticketNumber: tickets.number,
        startedAt: agentSessions.startedAt,
        lastEventAt: agentSessions.lastEventAt,
        live: liveSql,
        aiJobStatus: aiJobs.status,
        prReviewStatus: prReviews.status,
        docGenerationStatus: docGenerations.status,
        backlogJobStatus: backlogJobs.status,
        openBacklogQuestion: openBacklogQuestionSql,
        lastSegmentEnd: lastSegmentEndSql,
        activeSegment: agentSessions.activeSegmentLabel,
        activeSegmentOpen: activeSegmentOpenSql,
        interactive: agentSessions.activeSegmentInteractive,
        capabilities: agentSessions.capabilities,
        lastTool: lastToolEvent,
        aiJobId: agentSessions.aiJobId,
        backlogItemId: agentSessions.backlogItemId,
      })
      .from(agentSessions)
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .leftJoin(tickets, eq(tickets.id, agentSessions.ticketId))
      .leftJoin(aiJobs, eq(aiJobs.id, agentSessions.aiJobId))
      .leftJoin(prReviews, eq(prReviews.id, agentSessions.prReviewId))
      .leftJoin(docGenerations, eq(docGenerations.id, agentSessions.docGenerationId))
      .leftJoin(backlogJobs, eq(backlogJobs.id, agentSessions.backlogJobId))
      .leftJoin(backlogItems, eq(backlogItems.id, agentSessions.backlogItemId))
      .leftJoin(reviewRepositories, eq(reviewRepositories.id, prReviews.repositoryId))
      .leftJoin(docRepositories, eq(docRepositories.id, docGenerations.repositoryId))
      // Per FK (0086, CASCADE): un join sulla chiave primaria del messaggio,
      // non sulla concatenazione dell'owner_key che il planner non può usare.
      .leftJoin(emailMessages, eq(emailMessages.id, agentSessions.emailMessageId))
  );
}

type Row = Awaited<ReturnType<ReturnType<typeof baseSelect>["execute"]>>[number];

/**
 * Titolo MOSTRATO, derivato a lettura dal proprietario e nella lingua
 * dell'istanza: il ticket rinominato, la lingua cambiata e i titoli scritti
 * dal worker in una lingua sola si correggono da soli. `agent_sessions.title`
 * resta solo il ripiego quando la riga proprietaria non c'è più.
 */
function displayTitle(row: Row, lang: Language): string {
  const project = row.projectName;
  switch (row.kind) {
    case "ai_job":
      if (row.ticketNumber !== null && row.ticketTitle !== null) {
        return t(lang, "agentSession.title.aiJob", {
          number: row.ticketNumber,
          title: row.ticketTitle,
        });
      }
      break;
    case "pr_review":
      if (row.reviewPrNumber !== null && row.reviewRepositoryName !== null) {
        return t(lang, "agentSession.title.prReview", {
          repository: row.reviewRepositoryName,
          number: row.reviewPrNumber,
        });
      }
      break;
    case "backlog_item":
      if (row.backlogItemTitle !== null) return row.backlogItemTitle;
      break;
    case "backlog_job":
      if (row.backlogJobKind !== null) {
        return t(
          lang,
          row.backlogJobKind === "intake"
            ? "agentSession.title.backlogIntake"
            : "agentSession.title.backlogJob",
        );
      }
      break;
    case "doc_generation":
      if (row.docRepositoryName !== null) {
        return t(lang, "agentSession.title.docGeneration", { repository: row.docRepositoryName });
      }
      // Aggiornamento dopo un push (`doc_update:<jobId>`): il job non resta, il progetto sì.
      if (row.ownerKey.startsWith("doc_update:") && project !== null) {
        return t(lang, "agentSession.title.docUpdate", { project });
      }
      break;
    case "email_message":
      if (row.emailMessageId !== null) {
        return row.emailSubject ?? t(lang, "agentSession.title.emailNoSubject");
      }
      break;
    case "project_brief":
      if (project !== null) return t(lang, "agentSession.title.projectBrief", { project });
      break;
    case "daily_report": {
      // Chiave `daily_report:<projectId>:<giorno>`.
      const day = row.ownerKey.split(":")[2];
      if (project !== null && day)
        return t(lang, "agentSession.title.dailyReport", { day, project });
      break;
    }
  }
  return row.storedTitle;
}

function toSummary(row: Row, lang: Language): AgentSessionSummary {
  const input: SessionDerivationInput = {
    live: row.live === true,
    aiJobStatus: row.aiJobStatus ?? null,
    prReviewStatus: row.prReviewStatus ?? null,
    docGenerationStatus: row.docGenerationStatus ?? null,
    backlogJobStatus: row.backlogJobStatus ?? null,
    openBacklogQuestion: row.openBacklogQuestion === true,
    lastSegmentEnd: row.lastSegmentEnd ?? null,
  };
  const state = deriveAgentSessionState(input);
  return {
    id: row.id,
    kind: row.kind,
    title: displayTitle(row, lang),
    projectId: row.projectId,
    projectName: row.projectName ?? null,
    ticketId: row.ticketId,
    ticketNumber: row.ticketNumber ?? null,
    startedAt: row.startedAt.toISOString(),
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    state,
    activeSegment:
      input.live && row.activeSegmentOpen === true ? (row.activeSegment ?? null) : null,
    lastActivity: input.live && row.lastTool ? describeAgentActivity(row.lastTool) : null,
    aiJobId: row.aiJobId ?? null,
    outcome: deriveAgentSessionOutcome(state, input),
  };
}

/** Email degli utenti in `ids` (UNA query): la stessa proiezione degli autori dei commenti. */
async function emailsOf(db: Db, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const found = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  for (const user of found) out.set(user.id, user.email);
  return out;
}

export async function listAgentSessions(
  db: Db,
  viewer: Actor,
  filters: AgentSessionListQuery = {},
): Promise<{ live: AgentSessionSummary[]; recent: AgentSessionSummary[] }> {
  const conditions: SQL[] = [
    visibleTo(viewer),
    sql`${lastActivitySql} > now() - make_interval(days => ${WINDOW_DAYS}::int)`,
  ];
  if (filters.projectId) conditions.push(eq(agentSessions.projectId, filters.projectId));
  if (filters.ticketId) conditions.push(eq(agentSessions.ticketId, filters.ticketId));
  if (filters.aiJobId) conditions.push(eq(agentSessions.aiJobId, filters.aiJobId));
  const lang = await getContentLanguage(db);
  // Le sessioni non finite si mostrano TUTTE (spec §8.2, «Al lavoro ora»): il
  // tetto vale solo per le finite. Prima le possibilmente attive, senza limite;
  // poi le altre, al più RECENT_LIMIT.
  const activeRows = await baseSelect(db).where(and(...conditions, possiblyActiveSql));
  const restRows = await baseSelect(db)
    .where(and(...conditions, not(possiblyActiveSql)))
    .orderBy(desc(lastActivitySql))
    .limit(RECENT_LIMIT);
  const lastActivity = (s: AgentSessionSummary) => s.lastEventAt ?? s.startedAt;
  const byLastActivityDesc = (a: AgentSessionSummary, b: AgentSessionSummary) =>
    lastActivity(b).localeCompare(lastActivity(a));
  const active = activeRows.map((row) => toSummary(row, lang));
  const rest = restRows.map((row) => toSummary(row, lang));
  return {
    live: active.filter((s) => s.state !== "ended").sort(byLastActivityDesc),
    recent: [...active.filter((s) => s.state === "ended"), ...rest]
      .sort(byLastActivityDesc)
      .slice(0, RECENT_LIMIT),
  };
}

/**
 * Le domande dell'agente di un job, con `canAnswer` calcolato per chi guarda.
 * `canAnswer` applica le STESSE due funzioni che `answerQuestion` applica prima
 * di scrivere (`actorAllows`: il richiedente o un maintainer; `stateAllows`: il
 * job deve essere davvero fermo su una domanda): niente regola ricopiata qui.
 */
async function agentQuestionsOf(
  db: Db,
  viewer: Actor,
  aiJobId: string,
): Promise<AgentSessionQuestion[]> {
  const [job] = await db
    .select({ status: aiJobs.status, requestedByUserId: aiJobs.requestedByUserId })
    .from(aiJobs)
    .where(eq(aiJobs.id, aiJobId));
  const mayAnswer =
    job !== undefined &&
    actorAllows(
      { kind: "job.awaiting_input", requestedByUserId: job.requestedByUserId },
      "answer",
      viewer,
    ) &&
    stateAllows("job.awaiting_input", "answer", job.status);
  const rows = await db.select().from(agentQuestions).where(eq(agentQuestions.jobId, aiJobId));
  return rows.map((q) => ({
    id: q.id,
    source: "agent" as const,
    question: q.question,
    askedAt: q.askedAt.toISOString(),
    answered: q.answeredAt !== null,
    round: q.round,
    options: q.options,
    recommendedIndex: q.recommendedIndex ?? undefined,
    allowFreeText: q.allowFreeText,
    canAnswer: q.answeredAt === null && mayAnswer,
    ticketId: q.ticketId,
    backlogItemId: null,
  }));
}

export async function loadAgentSession(
  db: Db,
  viewer: Actor,
  id: string,
): Promise<{ detail: AgentSessionDetail; live: boolean } | null> {
  const [row] = await baseSelect(db).where(and(eq(agentSessions.id, id), visibleTo(viewer)));
  if (!row) return null;
  const summary = toSummary(row, await getContentLanguage(db));
  const live = row.live === true;
  // Si scrive solo a un segmento aperto e interattivo, e solo da maintainer.
  const writable =
    viewer.role === "admin" && live && row.activeSegmentOpen === true && row.interactive;
  const questions: AgentSessionQuestion[] = [
    ...(row.aiJobId ? await agentQuestionsOf(db, viewer, row.aiJobId) : []),
    ...(row.backlogItemId
      ? (
          await db
            .select()
            .from(backlogQuestions)
            .where(eq(backlogQuestions.backlogItemId, row.backlogItemId))
        ).map((q): AgentSessionQuestion => {
          const answered = q.answeredAt !== null || q.dismissedAt !== null;
          return {
            id: q.id,
            source: "backlog",
            question: q.question,
            askedAt: q.askedAt.toISOString(),
            answered,
            options: q.options,
            recommendedIndex: q.recommendedIndex ?? undefined,
            allowFreeText: q.allowFreeText,
            // Stessa regola della rotta di risposta: `requireAuth` e nessun
            // controllo di ruolo in `answerBacklogQuestion`, quindi basta che la
            // domanda sia ancora aperta (né risposta né «non ora»).
            canAnswer: !answered,
            ticketId: null,
            backlogItemId: q.backlogItemId,
          };
        })
      : []),
  ];
  // Interventi, consegnati o no (design §6.2): gli ultimi MAX_INPUTS, in ordine.
  const inputRows = (
    await db
      .select()
      .from(agentSessionInputs)
      .where(eq(agentSessionInputs.sessionId, id))
      .orderBy(desc(agentSessionInputs.createdAt))
      .limit(MAX_INPUTS)
  ).reverse();
  const authors = await emailsOf(
    db,
    inputRows.flatMap((r) => (r.authorUserId !== null ? [r.authorUserId] : [])),
  );
  const inputs: AgentSessionInput[] = inputRows.map((r) => ({
    id: r.id,
    text: r.text,
    status: r.status,
    reason: r.reason ?? null,
    authorUserId: r.authorUserId,
    authorName: r.authorUserId !== null ? (authors.get(r.authorUserId) ?? null) : null,
    interrupt: r.interrupt,
    createdAt: r.createdAt.toISOString(),
  }));
  return {
    live,
    detail: {
      ...summary,
      canWrite: writable,
      canInterrupt: writable && row.capabilities.some((c) => c.startsWith("interrupt_")),
      questions,
      inputs,
    },
  };
}

export async function getAgentSession(
  db: Db,
  viewer: Actor,
  id: string,
): Promise<AgentSessionDetail | null> {
  return (await loadAgentSession(db, viewer, id))?.detail ?? null;
}

export async function listAgentSessionEvents(
  db: Db,
  viewer: Actor,
  id: string,
  page: { after?: string; before?: string; limit: number },
): Promise<{ events: AgentSessionEvent[]; before: string | null } | null> {
  const [visible] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), visibleTo(viewer)));
  if (!visible) return null;
  const conditions = [eq(agentSessionEvents.sessionId, id)];
  if (page.after) conditions.push(gt(agentSessionEvents.id, BigInt(page.after)));
  if (page.before) conditions.push(lt(agentSessionEvents.id, BigInt(page.before)));
  // Con `after` si legge in avanti (riconnessione SSE); altrimenti le ultime N.
  const rows = await db
    .select()
    .from(agentSessionEvents)
    .where(and(...conditions))
    .orderBy(page.after ? agentSessionEvents.id : desc(agentSessionEvents.id))
    .limit(page.limit);
  const ordered = page.after ? rows : rows.reverse();
  // Autore degli interventi: DERIVATO qui e sovrascritto su quello che il jsonb dicesse.
  const authors = await emailsOf(
    db,
    ordered.flatMap((e) =>
      e.type === "input" && typeof e.data["authorUserId"] === "string"
        ? [e.data["authorUserId"]]
        : [],
    ),
  );
  const events = ordered.map((e) => ({
    id: e.id.toString(),
    type: e.type,
    segmentId: e.segmentId,
    at: e.createdAt.toISOString(),
    data:
      e.type === "input"
        ? {
            ...e.data,
            authorName:
              typeof e.data["authorUserId"] === "string"
                ? (authors.get(e.data["authorUserId"]) ?? null)
                : null,
          }
        : e.data,
  }));
  const before = !page.after && rows.length === page.limit ? (events[0]?.id ?? null) : null;
  return { events, before };
}

export type SendAgentMessageResult =
  | { ok: true; inputId: string }
  | {
      ok: false;
      error:
        | "forbidden"
        | "not_found"
        | "session_ended"
        | "not_interactive"
        | "interrupt_unsupported";
    };

/**
 * Intervento di un maintainer su una sessione viva (spec §6.2–6.3). Il ruolo
 * si ricontrolla qui (difesa in profondità: la rotta ha già `requireAdmin`), e
 * scrivere/interrompere lo decidono `canWrite`/`canInterrupt` di
 * {@link loadAgentSession}, la STESSA regola che il dettaglio mostra ai
 * client: nessuna copia. Una sessione che chi chiede non vede (la posta di un
 * altro) è `not_found`, mai `forbidden`: non se ne rivela l'esistenza.
 */
export async function sendAgentMessage(
  db: Db,
  input: { sessionId: string; actor: Actor; text: string; interrupt: boolean },
): Promise<SendAgentMessageResult> {
  if (input.actor.role !== "admin") return { ok: false, error: "forbidden" };
  const loaded = await loadAgentSession(db, input.actor, input.sessionId);
  if (!loaded) return { ok: false, error: "not_found" };
  // Viva = un processo con stdin aperto (Task 6/10), NON lo stato mostrato:
  // un job in install fra due segmenti è `working` ma non ha a chi scrivere.
  if (!loaded.live) return { ok: false, error: "session_ended" };
  if (!loaded.detail.canWrite) return { ok: false, error: "not_interactive" };
  if (input.interrupt && !loaded.detail.canInterrupt) {
    return { ok: false, error: "interrupt_unsupported" };
  }
  // Controllo e insert NON sono atomici, di proposito: se il segmento finisce
  // fra la lettura qui sopra e l'insert, la riga nasce `pending` e il relay del
  // worker la marca `undelivered` (`session_not_live` o `stdin_closed`), che
  // chi l'ha scritta vede. Il 202 vuol dire quindi «accettato», mai
  // «consegnato» (design §6.2, H4): non va «chiuso» con un lock, che non
  // potrebbe comunque tenere aperto lo stdin di un processo in un altro
  // servizio.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agentSessionInputs)
      .values({
        sessionId: input.sessionId,
        authorUserId: input.actor.id,
        text: input.text,
        interrupt: input.interrupt,
      })
      .returning({ id: agentSessionInputs.id });
    // Dentro la transazione: la NOTIFY parte al commit, quindi il relay del
    // worker non cerca mai un input che non esiste ancora.
    await tx.execute(
      sql`select pg_notify(${AGENT_SESSION_INPUT_CHANNEL}, ${JSON.stringify({ sessionId: input.sessionId })})`,
    );
    return { ok: true as const, inputId: row!.id };
  });
}
