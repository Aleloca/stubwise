import {
  calendarEvents,
  emailMessages,
  emailProposals,
  googleAccounts,
  notifications,
  projects,
  type Db,
} from "@stubwise/db";
import {
  extractRawBody,
  getMessageFull,
  listAttachments,
  refreshAccessToken,
  GoogleApiError,
} from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import {
  mailDetailSchema,
  mailItemStatusSchema,
  mailOriginalSchema,
  mailPageSchema,
  mailReproposeResultSchema,
  mailSummarySchema,
  type MailItem,
  type MailItemStatus,
  type MailSignal,
} from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { calendarDayUrl, calendarReproposableSql, calendarStatusCaseSql } from "./calendar-status.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Il client Google iniettabile di questo file (fase 7b, Task 7): SOLO le due
 * chiamate che servono a rileggere un messaggio — il refresh del token e il
 * messaggio completo. Stessa forma di `GmailClient`/`CalendarClient` nel
 * worker (`apps/worker/src/google/poller.ts`): un test può sostituirlo con
 * un finto senza toccare la rete, senza dover mockare `fetch`.
 */
export interface MailOriginalClient {
  refreshAccessToken: typeof refreshAccessToken;
  getMessageFull: typeof getMessageFull;
}

const defaultGoogleClient: MailOriginalClient = { refreshAccessToken, getMessageFull };

export interface MeMailRoutesOptions {
  googleClient?: MailOriginalClient;
}

/**
 * PAGINA POSTA (fase 6, Task 12; fase 6b, Task 8), sotto `/api/me/mail`: i
 * messaggi Gmail e gli eventi di calendario TRATTATI dal poller — non la
 * posta grezza, quella non lascia mai `email_messages`/`calendar_events` se è
 * fuori dal perimetro di routing di nessun progetto.
 *
 * ⚠️ Come `/api/me/google` (vedi il docblock di `me-google.ts`): **`user_id` è
 * SEMPRE nel WHERE**, via il JOIN su `google_accounts` filtrato per
 * `userId`. Nessun ruolo scavalca il filtro, nemmeno un admin: la posta di un
 * utente non è un dato amministrabile. Una riga di un altro utente — o un
 * `account`/`project` che non è il suo — produce una pagina vuota o un 404,
 * mai 403 (non si conferma che l'id esiste).
 *
 * ## Lista UNIFICATA, non tre liste
 *
 * `GET /` fonde le proposte email, gli eventi di calendario E (fase 6c, fix
 * di review Task 3) i messaggi «da smistare» in UNA lista ordinata per data,
 * con un campo `source` a distinguerle e — da questo task — un campo `kind`
 * a distinguere il RUOLO della riga (proposta normale con progetto risolto,
 * smistamento senza progetto, calendario: vedi `mailItemKindSchema` in
 * `@stubwise/shared`) — è la lettura più fedele del design (§5, "Pagina
 * Posta": *"elenco di messaggi ed eventi trattati"*, non elenchi separati).
 * La fusione è in MEMORIA (una query per sorgente, come `buildProjectTimeline`
 * in `@stubwise/notifications`): niente UNION SQL, che costringerebbe le
 * tabelle — colonne, filtri e stato diversi — a una forma comune fatta di
 * `null`.
 *
 * ## Fase 6c (fix di review, Task 3) — i messaggi «da smistare» ora compaiono
 *
 * Prima di questo task `GET /` leggeva solo `email_proposals` (il FIGLIO) per
 * il lato email: un messaggio in stato «da smistare» (fase 6c, Task 5 —
 * `classification.triage: true`, NESSUN figlio per costruzione) non
 * comparirebbe mai, mentre il contatore `openProposals` di `/summary` lo
 * conta già (è una notifica `google.proposal` come le altre). Il risultato
 * era il badge che diceva "una proposta aperta" con la lista vuota — vedi
 * {@link queryTriageCandidates} per la terza fonte che chiude il buco, e il
 * ramo `email_triage` di `POST /:source/:id/repropose` per come si riapre
 * uno smistamento chiuso con «nessuno di questi».
 *
 * ## Fase 6b — una riga per PROPOSTA, non per messaggio
 *
 * Il lato email non legge più `email_messages` da sola: legge `email_proposals`
 * (il FIGLIO, una riga per progetto nello `scopeProjectIds` del messaggio) con
 * un JOIN al padre per mittente/oggetto/thread/casella. Un messaggio con tre
 * proposte produce TRE righe — mittente e oggetto ripetuti, distinte dal
 * `projectId`/`projectName`, che per una riga email è ora SEMPRE valorizzato
 * (`email_proposals.project_id` è `NOT NULL`). `MailItem.id` è quindi
 * `email_proposals.id` per una riga email — **non più** `email_messages.id` —
 * ed è la riga che «Riproponi» chiude; il calendario resta uno a uno,
 * invariato (`calendar_events.id`). I FIGLI `classified`/`proposed`/
 * `actioned`/`ignored`/`failed` non conoscono lo stato `new` (una proposta
 * nasce già `classified`): un filtro `?status=new` sul lato email torna
 * sempre vuoto, come `cancelled` (solo del calendario).
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

/**
 * Fase 6c (fix di review, Task 3): TRE valori, non due — un terzo SOLO per
 * questa rotta (repropose), mai per `mailItemSchema.source` (che resta
 * `mailSourceSchema`, due valori). `"email_triage"` seleziona la riga PADRE
 * `email_messages` (una proposta di smistamento, {@link queryTriageCandidates}),
 * a differenza di `"email"` che seleziona il FIGLIO `email_proposals`: un
 * `id` da solo non basta a scegliere la tabella giusta (sono UUID
 * indipendenti, la collisione non è impossibile), quindi il path lo dice
 * per costruzione — vedi il docblock di `mailItemSchema` in
 * `@stubwise/shared`.
 */
const reproposeSourceSchema = z.enum(["email", "calendar", "email_triage"]);
const sourceParamsSchema = z.object({ source: reproposeSourceSchema, id: z.uuid() });

/**
 * Fase 7b (Task 6-7): il dettaglio e la rilettura esistono SOLO per la posta
 * — un evento di calendario non ha un "estratto" né un messaggio Gmail da
 * rileggere, i suoi campi sono già tutti nella riga. `"email_triage"` regge
 * lo stesso spazio di id di `sourceParamsSchema`: il PADRE, senza figli.
 */
const mailDetailSourceSchema = z.enum(["email", "email_triage"]);
const mailDetailParamsSchema = z.object({ source: mailDetailSourceSchema, id: z.uuid() });

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

// --- Link al thread Gmail -----------------------------------------------
//
// Duplicato (non importato) da `apps/worker/src/google/proposal.ts`: il
// server non dipende dal worker, ed è una funzione pura di poche righe —
// vedi la stessa scelta in `services/google-proposal.ts` (`gmailThreadUrl`).
// Lo stato normalizzato del calendario e il link alla giornata, invece, sono
// condivisi con `me-calendar.ts` via `./calendar-status.js`: qui il confine
// non è di pacchetto/deploy, e duplicarli aprirebbe la stessa deriva che il
// docblock di `calendarStatusCaseSql` mette in guardia.

function gmailThreadUrl(mailboxEmail: string, threadId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailboxEmail)}/#all/${threadId}`;
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

/**
 * Fase 6b: legge i FIGLI `email_proposals`, con un JOIN al padre
 * `email_messages` per mittente/oggetto/thread/casella e uno a `projects`
 * (INNER: `email_proposals.project_id` è `NOT NULL`, una riga qui esiste solo
 * per un progetto che esiste — il cascade della FK garantisce che non
 * sopravviva a un progetto cancellato).
 */
async function queryEmailCandidates(db: Db, input: ListMailInput): Promise<MailItem[]> {
  // `status: "cancelled"` non esiste MAI sulla posta (solo il calendario ce
  // l'ha), e `status: "new"` non esiste più per un FIGLIO (una proposta nasce
  // già `classified`, mai `new`): la query tornerebbe comunque vuota per
  // entrambi, ma si evita di lanciarla — e di forzare un cast di tipo, dato
  // che `emailProposals.status` non contempla né l'uno né l'altro.
  if (input.status === "cancelled" || input.status === "new") return [];
  const conditions = [eq(googleAccounts.userId, input.userId)];
  if (input.account) conditions.push(eq(emailMessages.accountId, input.account));
  if (input.project) conditions.push(eq(emailProposals.projectId, input.project));
  if (input.status) conditions.push(eq(emailProposals.status, input.status));
  if (input.cursor) {
    conditions.push(
      sql`(${emailMessages.receivedAt}, ${emailProposals.id}) < (${input.cursor.date}::timestamptz, ${input.cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select({
      id: emailProposals.id,
      accountId: emailMessages.accountId,
      accountEmail: googleAccounts.email,
      projectId: emailProposals.projectId,
      projectName: projects.name,
      title: emailMessages.subject,
      from: emailMessages.fromAddress,
      threadId: emailMessages.threadId,
      date: emailMessages.receivedAt,
      status: emailProposals.status,
      // Il segnale vive nella `classification` DEL FIGLIO (stesso valore per
      // ogni figlio dello stesso messaggio, scritto da `writeClassification`
      // in `apps/worker/src/google/classify.ts`): non c'è una colonna a sé,
      // com'era su `email_messages.signal` prima della fase 6b.
      signal: sql<MailSignal | null>`(${emailProposals.classification}->>'signal')`,
      outcome: emailProposals.outcome,
      error: emailProposals.error,
    })
    .from(emailProposals)
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .innerJoin(projects, eq(projects.id, emailProposals.projectId))
    .where(and(...conditions))
    .orderBy(desc(emailMessages.receivedAt), desc(emailProposals.id))
    .limit(input.limit + 1);

  return rows.map((row) => ({
    id: row.id,
    source: "email",
    kind: "proposal",
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

/**
 * Fase 6c (fix di review, Task 3): legge i PADRI `email_messages` in stato
 * «da smistare» (fase 6c, Task 5, `classify.ts`/`EmailTriageClassification`)
 * — la TERZA fonte della lista, oltre alle proposte normali
 * ({@link queryEmailCandidates}) e al calendario ({@link queryCalendarCandidates}).
 * Un padre di smistamento non ha MAI un figlio (`writeClassification` non ne
 * crea per questo ramo): `projectId`/`projectName` sono quindi SEMPRE `null`
 * — è esattamente ciò che la card chiede di risolvere — e `kind: "triage"`
 * la distingue da una proposta normale.
 *
 * Righe incluse: ATTIVE (`classification->>'triage' = 'true'` E
 * `status` `classified`/`proposed`/`failed` — prima e dopo la pubblicazione
 * della notifica, e anche su un fallimento del dispatch, es. `target_gone`
 * su `choose_project` con un progetto suggerito cancellato, che
 * `markSourceFailed` in `google-proposal.ts` scrive come `status: 'failed'`)
 * oppure CHIUSE con «nessuno di questi»
 * (`outcome->>'type' = 'triage_dismissed'` — per costruzione `status:
 * 'ignored'`, vedi il case `"ignore"` di `dispatchAction` in
 * `google-proposal.ts`, che per `source: "email_triage"` scrive SEMPRE
 * quell'esito, mai un `ignored` generico).
 *
 * ⚠️ `status: 'new'` NON compare qui anche quando `classification.triage`
 * porta ancora il marcatore STANTIO di una classificazione precedente: è il
 * caso del `choose_project` VIVO su una proposta di smistamento (fase 6c,
 * ramo 1 del case `choose_project` in `google-proposal.ts`), che riaccoda il
 * messaggio per la riclassificazione del prossimo tick SENZA cancellare
 * `classification`. Quel messaggio non è più «da smistare»: sta per
 * ridiventare una proposta normale (o tornare `ignored` se il segnale non
 * regge più) — includerlo qui mostrerebbe una card fantasma fra un tick e
 * l'altro del poller.
 */
async function queryTriageCandidates(db: Db, input: ListMailInput): Promise<MailItem[]> {
  // Una riga di smistamento non ha MAI un progetto: un filtro per progetto
  // non può mai combaciare con questa fonte.
  if (input.project) return [];
  const TRIAGE_VISIBLE_STATUSES = new Set<MailItemStatus>(["classified", "proposed", "failed", "ignored"]);
  if (input.status && !TRIAGE_VISIBLE_STATUSES.has(input.status)) return [];
  const conditions = [
    eq(googleAccounts.userId, input.userId),
    // La riga è di smistamento SE: (a) porta ancora il marcatore ed è in uno
    // stato non ancora riaccodato/chiuso ("attiva o fallita"), OPPURE (b) è
    // stata chiusa con «nessuno di questi». Le due metà sono a somma
    // esclusiva per costruzione (vedi il docblock sopra): nessuna riga può
    // soddisfarle entrambe.
    sql`(
      (${emailMessages.classification}->>'triage' = 'true' and ${emailMessages.status} in ('classified', 'proposed', 'failed'))
      or ${emailMessages.outcome}->>'type' = 'triage_dismissed'
    )`,
  ];
  if (input.account) conditions.push(eq(emailMessages.accountId, input.account));
  // Il guardrail sopra (`TRIAGE_VISIBLE_STATUSES`) ha già escluso `new` e
  // `cancelled`: qui `input.status` è per costruzione uno dei quattro valori
  // che la colonna conosce, ma TypeScript non lo deduce da un `Set.has`.
  if (input.status) {
    conditions.push(eq(emailMessages.status, input.status as "classified" | "proposed" | "failed" | "ignored"));
  }
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
    .where(and(...conditions))
    .orderBy(desc(emailMessages.receivedAt), desc(emailMessages.id))
    .limit(input.limit + 1);

  return rows.map((row) => ({
    id: row.id,
    source: "email",
    kind: "triage",
    accountId: row.accountId,
    accountEmail: row.accountEmail,
    projectId: null,
    projectName: null,
    title: row.title,
    from: row.from,
    date: row.date.toISOString(),
    status: row.status,
    signal: row.signal,
    outcome: row.outcome,
    error: row.error,
    url: gmailThreadUrl(row.accountEmail, row.threadId),
    // Riproponibile SOLO da uno smistamento CHIUSO con «nessuno di questi»
    // — non un `ignored` qualsiasi, che qui per costruzione non esiste (vedi
    // il docblock sopra), e MAI da `failed` (a differenza delle altre due
    // fonti): riproporre un dispatch fallito su una scelta specifica
    // (`choose_project`/`target_gone`) rientrerebbe dalla stessa card che ha
    // già fallito, non da questa rotta — vedi il docblock della rotta di
    // repropose più sotto.
    reproposable:
      row.status === "ignored" &&
      typeof row.outcome === "object" &&
      row.outcome !== null &&
      (row.outcome as Record<string, unknown>).type === "triage_dismissed",
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
      kind: "calendar",
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

/**
 * Fonde N pool GIÀ ordinati desc (date, id) e ne restituisce la pagina + il
 * prossimo cursore. Fase 6c (fix di review, Task 3): da DUE a TRE pool
 * (proposte, calendario, smistamento) — la proprietà di k-way merge del
 * docblock del modulo (ogni sorgente fornisce `limit + 1` righe filtrate dal
 * cursore, quindi il pool basta a produrre una pagina corretta) non dipende
 * dal numero di sorgenti, solo dal fatto che ognuna sia già ordinata e
 * filtrata: vale identica con tre pool come con due.
 */
function mergePages(
  pools: MailItem[][],
  limit: number,
): { items: MailItem[]; nextCursor: string | null } {
  const merged = pools.flat().sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? 1 : -1;
    return x.id < y.id ? 1 : -1;
  });
  const page = merged.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    merged.length > limit && last ? encodeCursor({ date: last.date, id: last.id }) : null;
  return { items: page, nextCursor };
}

// --- Dettaglio email (fase 7b, Task 6-7) ------------------------------------

interface ResolvedEmailMessage {
  accountId: string;
  accountEmail: string;
  gmailMessageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string | null;
  receivedAt: Date;
  labels: string[];
  textExcerpt: string | null;
}

/** Le colonne del PADRE che servono al dettaglio e alla rilettura, comuni a `"email"`/`"email_triage"`. */
const EMAIL_MESSAGE_COLUMNS = {
  accountId: emailMessages.accountId,
  accountEmail: googleAccounts.email,
  gmailMessageId: emailMessages.gmailMessageId,
  threadId: emailMessages.threadId,
  fromAddress: emailMessages.fromAddress,
  fromName: emailMessages.fromName,
  toAddresses: emailMessages.toAddresses,
  subject: emailMessages.subject,
  receivedAt: emailMessages.receivedAt,
  labels: emailMessages.labels,
  textExcerpt: emailMessages.textExcerpt,
};

/**
 * Il messaggio dietro `source`/`id`, con la STESSA ACL delle altre rotte
 * (`user_id` nel WHERE via il JOIN). Per `"email"` l'`id` è
 * `email_proposals.id` (il FIGLIO, fase 6b) e il contenuto viene dal PADRE
 * (`email_messages`): il testo di un'email non cambia da un figlio all'altro
 * dello stesso messaggio. Per `"email_triage"` l'`id` è già
 * `email_messages.id` — nessun figlio, per costruzione.
 */
async function resolveEmailMessage(
  db: Db,
  userId: string,
  source: z.infer<typeof mailDetailSourceSchema>,
  id: string,
): Promise<ResolvedEmailMessage | null> {
  if (source === "email") {
    const [row] = await db
      .select(EMAIL_MESSAGE_COLUMNS)
      .from(emailProposals)
      .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
      .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
      .where(and(eq(emailProposals.id, id), eq(googleAccounts.userId, userId)));
    return row ?? null;
  }
  const [row] = await db
    .select(EMAIL_MESSAGE_COLUMNS)
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(and(eq(emailMessages.id, id), eq(googleAccounts.userId, userId)));
  return row ?? null;
}

export async function meMailRoutes(
  instance: FastifyInstance,
  opts: MeMailRoutesOptions = {},
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const googleClient = opts.googleClient ?? defaultGoogleClient;

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
      const [emailCandidates, calendarCandidates, triageCandidates] = await Promise.all([
        queryEmailCandidates(app.db, input),
        queryCalendarCandidates(app.db, input),
        queryTriageCandidates(app.db, input),
      ]);
      return mergePages([emailCandidates, calendarCandidates, triageCandidates], limit);
    },
  );

  /**
   * Contatori per il badge di nav e l'intestazione: `openProposals` sulle
   * NOTIFICHE (`google.proposal` ancora `open` di questo utente — l'audience
   * `mailbox_owner` garantisce che sia l'unico destinatario), `failed`/
   * `ignored` sulle RIGHE (posta + calendario + smistamento, stato
   * normalizzato). Fase 6b: il lato email conta i FIGLI `email_proposals`,
   * non più i messaggi — un messaggio con due proposte `failed` (progetti
   * diversi) conta per due.
   *
   * Fase 6c (fix di review, Task 3): `openProposals` include GIÀ una
   * proposta di smistamento ATTIVA senza bisogno di una query in più — è una
   * notifica `google.proposal` come le altre (vedi `buildTriageProposalEvent`
   * in `apps/worker/src/google/proposal.ts`), quindi la query sopra la conta
   * per costruzione. `failed`/`ignored` invece PRIMA di questo task
   * ignoravano lo smistamento (nessuna riga per lui): due query in più,
   * simmetriche a quelle del calendario, così il totale torna a coincidere
   * ESATTAMENTE con ciò che {@link queryTriageCandidates} mostra come
   * `failed`/`ignored`.
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
      const [
        [openRow],
        [emailFailedRow],
        [emailIgnoredRow],
        [calFailedRow],
        [calIgnoredRow],
        [triageFailedRow],
        [triageIgnoredRow],
      ] = await Promise.all([
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
          .from(emailProposals)
          .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(and(eq(googleAccounts.userId, userId), eq(emailProposals.status, "failed"))),
        app.db
          .select({ count: sql<number>`count(*)::int` })
          .from(emailProposals)
          .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(and(eq(googleAccounts.userId, userId), eq(emailProposals.status, "ignored"))),
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
        app.db
          .select({ count: sql<number>`count(*)::int` })
          .from(emailMessages)
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(
            and(
              eq(googleAccounts.userId, userId),
              sql`${emailMessages.classification}->>'triage' = 'true' and ${emailMessages.status} = 'failed'`,
            ),
          ),
        app.db
          .select({ count: sql<number>`count(*)::int` })
          .from(emailMessages)
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(
            and(eq(googleAccounts.userId, userId), sql`${emailMessages.outcome}->>'type' = 'triage_dismissed'`),
          ),
      ]);
      return {
        openProposals: openRow?.count ?? 0,
        failed: (emailFailedRow?.count ?? 0) + (calFailedRow?.count ?? 0) + (triageFailedRow?.count ?? 0),
        ignored: (emailIgnoredRow?.count ?? 0) + (calIgnoredRow?.count ?? 0) + (triageIgnoredRow?.count ?? 0),
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
   * Fase 6b: per l'email `:id` è ora `email_proposals.id` (il FIGLIO), non
   * più `email_messages.id` — l'azione tocca SOLO quella riga: le eventuali
   * proposte sorelle dello stesso messaggio (altri progetti) restano
   * invariate, `status` compreso. Reset a `classified` (non `new`, che per
   * `email_proposals` non esiste: una proposta nasce già classificata) con
   * `error`/`outcome`/`proposal_notification_id` azzerati, così la condizione
   * di claim del poller (`status = 'classified' AND
   * proposal_notification_id IS NULL`, vedi il Task 5) torna vera per QUESTA
   * riga sola.
   *
   * Due rotte per sorgente (`/email/:id` e `/calendar/:id`) invece di
   * un'unica `/:id` con prefisso o campo `source` nel body: l'id da solo non
   * basta a distinguere le due tabelle (sono UUID indipendenti, una
   * collisione fra le due non è impossibile), e un campo nel body per una
   * mutazione così piccola aggiungerebbe un modo di sbagliare (mandare l'id
   * giusto col `source` sbagliato) che il path elimina per costruzione.
   *
   * Fase 6c (fix di review, Task 3) — TERZA sorgente, `source: "email_triage"`:
   * `:id` è `email_messages.id` (il PADRE della proposta di smistamento,
   * NESSUN figlio da cui distinguerlo — vedi {@link queryTriageCandidates}).
   * Riproponibile SOLO da uno smistamento CHIUSO con «nessuno di questi»
   * (`status: 'ignored'` E `outcome.type === 'triage_dismissed'`) — non un
   * `ignored` qualsiasi: qui, a differenza delle altre due sorgenti, non
   * esiste un `ignored` "generico" (vedi il docblock di
   * `queryTriageCandidates`), e riproporre un `failed` (un dispatch fallito
   * su una scelta specifica) non avrebbe senso — l'utente rivede la STESSA
   * card e sceglie di nuovo, non una nuova classificazione. Reset a
   * `classified` con `outcome`/`error`/`proposal_notification_id` azzerati —
   * verificato in `google-proposal.ts` che la chiusura per «nessuno di
   * questi» (`markSourceOutcome`, ramo `"email_triage"`) NON tocca
   * `proposal_notification_id`, che quindi resta ancora quello della
   * notifica appena chiusa: va azzerato QUI, esplicitamente, come per le
   * altre due sorgenti, perché la condizione di claim del poller (`status =
   * 'classified' AND proposal_notification_id IS NULL`, `publishProposal`)
   * torni vera e la riga sia riselezionabile al prossimo tick.
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
          .select({ id: emailProposals.id, status: emailProposals.status })
          .from(emailProposals)
          .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(and(eq(emailProposals.id, id), eq(googleAccounts.userId, userId)));
        if (!row) return apiError(reply, 404, "not_found", "Proposal not found");
        if (row.status !== "failed" && row.status !== "ignored") {
          return apiError(reply, 409, "not_reproposable", "This proposal cannot be reproposed");
        }
        await app.db
          .update(emailProposals)
          .set({ status: "classified", error: null, outcome: null, proposalNotificationId: null })
          .where(eq(emailProposals.id, id));
        return { ok: true as const };
      }

      if (source === "email_triage") {
        const [row] = await app.db
          .select({ id: emailMessages.id, status: emailMessages.status, outcome: emailMessages.outcome })
          .from(emailMessages)
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(and(eq(emailMessages.id, id), eq(googleAccounts.userId, userId)));
        if (!row) return apiError(reply, 404, "not_found", "Proposal not found");
        const dismissed =
          row.status === "ignored" &&
          typeof row.outcome === "object" &&
          row.outcome !== null &&
          (row.outcome as Record<string, unknown>).type === "triage_dismissed";
        if (!dismissed) {
          return apiError(reply, 409, "not_reproposable", "This proposal cannot be reproposed");
        }
        await app.db
          .update(emailMessages)
          .set({ status: "classified", error: null, outcome: null, proposalNotificationId: null })
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

  /**
   * Fase 7b, Task 6: il dettaglio di un'email, dall'ESTRATTO già in
   * database — nessuna chiamata a Google (design §3, punto 1). Stessa ACL
   * delle altre rotte: `user_id` nel WHERE via `resolveEmailMessage`, una
   * riga altrui dà 404, mai 403.
   */
  app.get(
    "/:source/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: mailDetailParamsSchema,
        response: { 200: mailDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { source, id } = request.params;
      const message = await resolveEmailMessage(app.db, request.user!.id, source, id);
      if (!message) return apiError(reply, 404, "not_found", "Message not found");
      return {
        id,
        source: "email" as const,
        accountId: message.accountId,
        accountEmail: message.accountEmail,
        from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
        to: message.toAddresses,
        subject: message.subject,
        receivedAt: message.receivedAt.toISOString(),
        labels: message.labels,
        textExcerpt: message.textExcerpt,
        url: gmailThreadUrl(message.accountEmail, message.threadId),
      };
    },
  );

  /**
   * Fase 7b, Task 7: il messaggio ORIGINALE, riletto da Gmail SU RICHIESTA
   * (design §3, punto 2) — non si persiste nulla di questo: è una finestra
   * su Gmail, non una copia. Stessa ACL: `resolveEmailMessage` prima di
   * qualunque chiamata di rete, così un id altrui non arriva nemmeno a
   * consumare un token.
   *
   * Errori VERI, non solo il caso felice (design §3): il messaggio è
   * `410`/`404` su Gmail (cancellato, spostato) → `message_gone`; il token è
   * scaduto/revocato (`invalid_grant`) → `token_expired`; Google
   * irraggiungibile o un altro errore del provider → `google_unavailable`.
   * In OGNI caso l'estratto resta leggibile dall'altra rotta: questa è solo
   * un supplemento.
   */
  app.get(
    "/:source/:id/original",
    {
      preHandler: requireAuth,
      schema: {
        params: mailDetailParamsSchema,
        response: {
          200: mailOriginalSchema,
          404: errorSchema,
          409: errorSchema,
          502: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { source, id } = request.params;
      const message = await resolveEmailMessage(app.db, request.user!.id, source, id);
      if (!message) return apiError(reply, 404, "not_found", "Message not found");

      const credentials = await loadGoogleAccountCredentials(app.db, app.encryptionKey, message.accountId);
      if (!credentials) {
        return apiError(reply, 409, "account_unavailable", "Google account credentials are not usable");
      }

      try {
        const tokens = await googleClient.refreshAccessToken({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          refreshToken: credentials.refreshToken,
        });
        const full = await googleClient.getMessageFull({
          accessToken: tokens.accessToken,
          id: message.gmailMessageId,
        });
        const body = full.payload ? extractRawBody(full.payload) : { text: null, html: null };
        const attachments = full.payload ? listAttachments(full.payload) : [];
        return {
          subject: full.headers.subject ?? message.subject,
          from: full.headers.from ?? message.fromAddress,
          to: full.headers.to ? full.headers.to.split(",").map((addr) => addr.trim()) : message.toAddresses,
          cc: full.headers.cc ? full.headers.cc.split(",").map((addr) => addr.trim()) : [],
          bodyText: body.text,
          bodyHtml: body.html,
          attachments,
        };
      } catch (error) {
        if (error instanceof GoogleApiError) {
          if (error.status === 404 || error.status === 410) {
            return apiError(reply, 409, "message_gone", "This message no longer exists on Gmail");
          }
          if (error.code === "invalid_grant" || error.status === 401) {
            return apiError(reply, 409, "token_expired", "The Google account needs to be reconnected");
          }
        }
        request.log.warn({ err: error, accountId: message.accountId }, "rilettura del messaggio originale fallita");
        return apiError(reply, 502, "google_unavailable", "Could not reach Google");
      }
    },
  );
}
