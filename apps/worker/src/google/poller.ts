import {
  calendarEvents as calendarEventsTable,
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  instanceSettings,
  notifications,
  projectEmailRoutes,
  projects,
  type Db,
} from "@stubwise/db";
import {
  extractText,
  getMessageFull,
  getMessageMetadata,
  GoogleApiError,
  listEvents,
  listHistory,
  listMessages,
  refreshAccessToken,
  type GmailMessage,
  type GoogleCalendarEvent,
} from "@stubwise/google";
import {
  loadGoogleAccountCredentials,
  type GoogleAccountCredentials,
} from "@stubwise/google/credentials";
import type { Language } from "@stubwise/i18n";
import { admit, matchRoutes, type AdmissionConfig, type EmailRoute } from "@stubwise/notifications";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import type { AgentRunner } from "../agent/runner.js";
import type { loadProviderChain } from "../providers/chain.js";
import { getContentLanguage } from "../settings.js";
import {
  buildMilestoneProposal,
  CALENDAR_CANCELLED_OUTCOME,
  CALENDAR_MAX_PAGES,
  CALENDAR_PAGE_SIZE,
  CALENDAR_WINDOW_DAYS,
  calendarWindow,
  computeFingerprint,
  duplicateOutcome,
  isCancelled,
  isSyncTokenExpired,
  normalizeStatus,
  routeEvent,
} from "./calendar.js";
import {
  classifyNewMessages,
  DEFAULT_CLASSIFY_MAX_PER_TICK,
  type ClassifyBatchStats,
} from "./classify.js";
import {
  buildCalendarProposalEvent,
  buildEmailProposalEvent,
  DEFAULT_PROPOSE_MAX_PER_TICK,
  publishProposal,
  type PublishFn,
} from "./proposal.js";
import {
  buildEmailMessageInsert,
  disabledReasonFor,
  errText,
  GMAIL_MAX_SYNC_ATTEMPTS,
  GMAIL_RESYNC_MAX_MESSAGES,
  GMAIL_RESYNC_QUERY,
  isFromMailbox,
  isHistoryExpired,
  maxHistoryId,
  messageToRouting,
  nextSyncDelayMs,
  SYNC_BACKOFF_BASE_SECONDS,
  SYNC_BACKOFF_MAX_EXPONENT,
  TERMINAL_EMAIL_PROPOSAL_STATUSES,
  type GoogleDisabledReason,
} from "./sync.js";

/**
 * POLLER DELLE CASELLE GOOGLE (fase 6): task SEPARATO dal loop dei job, sul
 * proprio intervallo (`GMAIL_POLL_MINUTES`, default 5, 0 = spento).
 *
 * ## Il tick, in tre fasi
 *
 * Il giro di UNA casella è diviso in fasi indipendenti, ognuna con il suo
 * innesto, dentro {@link runAccountTick}:
 *
 *  1. **Gmail**: sincronizzazione incrementale e ingestione dei soli messaggi
 *     in perimetro → {@link syncGmail}.
 *  2. **Classificazione**: i messaggi `new` di questa casella passano dal
 *     modello e diventano proposte → {@link classifyNewMessages}.
 *  3. **Calendar**: gli eventi del calendario `primary` in perimetro
 *     diventano righe candidate a una proposta di milestone →
 *     {@link syncCalendar}. Qui NON c'è nessun run del modello.
 *
 * Le tre fasi condividono UN access token e UNA riga di credenziali
 * ({@link AccountContext}), ottenuti una volta sola all'inizio del giro: è la
 * ragione per cui il refresh sta in `runAccountTick` e non dentro `syncGmail`.
 * Condividono anche il gestore d'errore: un `invalid_grant` sollevato dalla
 * fase 3 disabilita la casella esattamente come uno della fase 1.
 *
 * ## DUE cursori, e due scritture separate — non un `applySuccess` unico
 *
 * Gmail e Calendar hanno punti di ripartenza distinti (`gmail_history_id` e
 * `calendar_sync_token`) e possono fallire uno senza l'altro. Se ci fosse una
 * sola scrittura finale, un guasto del calendario — che DEVE salire fino a
 * {@link applyFailure}, perché è un verdetto su quella casella esattamente
 * come un guasto di Gmail — porterebbe via con sé anche il cursore che la fase
 * 1 si era appena guadagnata, e il tick dopo riscaricherebbe gli stessi
 * messaggi. Da qui la forma attuale:
 *
 *  - {@link applyGmailCursor} scrive il SOLO `gmail_history_id`, subito dopo
 *    la fase 1, prima che qualunque fase successiva possa lanciare;
 *  - {@link applyCalendarCursor} scrive il SOLO `calendar_sync_token`, subito
 *    dopo la fase 3;
 *  - {@link applySuccess} non tocca più nessun cursore: chiude il giro
 *    (`last_sync_at`, `sync_attempts = 0`, `next_sync_at`) e gira solo se
 *    NESSUNA fase ha lanciato.
 *
 * Il successo parziale — Gmail andato, Calendar no — è quindi rappresentabile:
 * cursore della posta avanzato, cursore del calendario fermo, casella in
 * backoff. È la ragione della divisione, non un dettaglio d'implementazione.
 *
 * ## Perché il claim pre-schedula
 *
 * {@link claimDueAccounts} è un UPDATE unico che seleziona le caselle dovute e
 * nello STESSO atto sposta `next_sync_at` avanti (l'intervallo, o il backoff se
 * la casella ha già tentativi falliti alle spalle). `FOR UPDATE SKIP LOCKED`
 * rende disgiunti due worker; lo spostamento anticipato fa sì che un worker che
 * muore a metà giro non lasci una casella ri-claimabile all'istante da tutti
 * quelli che restano. Il valore definitivo lo scrive poi l'esito: `now +
 * intervallo` se il giro è andato, il backoff se è andato male. È lo schema del
 * `deliveries-poller`.
 *
 * ## Errori: due reazioni, e sceglierne una sbagliata costa
 *
 * FATALE (`isFatalGoogleError`: consenso revocato, scope mancante) →
 * `disabled_at` + motivo, **nessun retry**, `sync_attempts` non toccato: quel
 * risultato non cambia ritentando, e l'utente deve ricollegare la casella.
 * TRANSITORIO (rete, 429, 5xx, history scaduta) → `sync_attempts + 1` e
 * `next_sync_at` dal `Retry-After` o dal backoff; al tentativo
 * {@link GMAIL_MAX_SYNC_ATTEMPTS} la casella si spegne con `sync_failed`.
 *
 * BEST-EFFORT come gli altri poller: ogni casella in try/catch isolato, il tick
 * a sua volta; non fa MAI crashare il worker. Si ferma sull'AbortSignal.
 */

/** Quante caselle al massimo un tick reclama. */
export const DEFAULT_ACCOUNT_BATCH = 10;

/** Log del poller: stesso contratto minimale degli altri task del worker. */
export interface GoogleLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultLogger: GoogleLogger = {
  info: (msg) => console.error(`[stubwise-worker] ${msg}`),
  warn: (msg) => console.error(`[stubwise-worker] ${msg}`),
  error: (msg) => console.error(`[stubwise-worker] ${msg}`),
};

/**
 * Le funzioni di Google che il poller usa, iniettabili in blocco.
 *
 * I test finti stanno QUI e non su `fetch`: l'HTTP (URL, header, mappatura
 * degli errori) è già coperto dai test di `@stubwise/google`, e rifarlo a
 * questo livello vorrebbe dire testare due volte la stessa cosa e nessuna volta
 * la logica del tick.
 */
export interface GmailClient {
  refreshAccessToken: typeof refreshAccessToken;
  listHistory: typeof listHistory;
  listMessages: typeof listMessages;
  getMessageMetadata: typeof getMessageMetadata;
  getMessageFull: typeof getMessageFull;
}

const realGmailClient: GmailClient = {
  refreshAccessToken,
  listHistory,
  listMessages,
  getMessageMetadata,
  getMessageFull,
};

/** La parte Calendar del client Google, iniettabile come {@link GmailClient}. */
export interface CalendarClient {
  listEvents: typeof listEvents;
}

const realCalendarClient: CalendarClient = { listEvents };

/** Caricamento delle credenziali di una casella (default: quello di `@stubwise/google`). */
export type LoadCredentialsFn = typeof loadGoogleAccountCredentials;

export interface GooglePollerDeps {
  db: Db;
  /** La stessa `ENCRYPTION_KEY` del server: decifra refresh token e client secret. */
  encryptionKey: Buffer;
  logger?: GoogleLogger;
  /** Client Google iniettabile nei test. Default: rete vera. */
  gmail?: GmailClient;
  /** Client Calendar iniettabile nei test. Default: rete vera. */
  calendar?: CalendarClient;
  /**
   * Lingua dei contenuti dell'istanza: la fase 3 la usa per il nome della
   * milestone proposta. Assente = letta una volta per casella dalle
   * impostazioni (`getContentLanguage`).
   */
  lang?: Language;
  /** Caricamento credenziali iniettabile nei test. Default: `loadGoogleAccountCredentials`. */
  loadCredentials?: LoadCredentialsFn;
  /** Cadenza nominale della sincronizzazione: è il `next_sync_at` di un giro riuscito. */
  intervalMinutes: number;
  /** Giorni di conservazione dei messaggi in stato terminale. ≤ 0 = nessuna potatura. */
  retentionDays: number;
  /**
   * Messaggi che la FASE 2 (classificazione) manda al modello in un tick —
   * `GMAIL_MAX_PER_TICK`. Assente = {@link DEFAULT_CLASSIFY_MAX_PER_TICK};
   * `0` spegne la sola classificazione (l'ingestione continua).
   */
  classifyMaxPerTick?: number;
  /**
   * Runner dell'agente per la classificazione. ASSENTE = fase 2 SPENTA: il
   * tick ingerisce e basta, i messaggi restano `new`. È così che i test del
   * Task 7 continuano a valere senza conoscere la fase 2.
   */
  runner?: AgentRunner;
  /** Modello della classificazione (`GMAIL_MODEL`); omesso = default del CLI. */
  gmailModel?: string;
  /**
   * Fase 6b: tetto sul FAN-OUT di un messaggio (`GMAIL_MAX_PROJECTS_PER_MESSAGE`),
   * passato alla classificazione. Assente = il default di `classify.ts`
   * ({@link GMAIL_MAX_PROJECTS_PER_MESSAGE} lì).
   */
  maxProjectsPerMessage?: number;
  /** Caricatore della catena di provider AI (iniettabile nei test). */
  loadProviderChainFn?: typeof loadProviderChain;
  /**
   * Proposte pubblicate in un tick per casella (fase 4 del giro). Assente =
   * {@link DEFAULT_PROPOSE_MAX_PER_TICK}; `0` spegne la sola pubblicazione —
   * le righe restano `classified`/candidate e vengono proposte al giro dopo.
   */
  proposeMaxPerTick?: number;
  /** Publish iniettabile nei test. Default: `publishNotification`. */
  publish?: PublishFn;
  /** Caselle reclamate per tick. Default {@link DEFAULT_ACCOUNT_BATCH}. */
  accountBatch?: number;
  /** Stop cooperativo: interrompe il giro fra una casella e l'altra. */
  signal?: AbortSignal;
  /** Orologio iniettabile: solo per il `received_at` di ripiego. */
  now?: () => Date;
}

/** Riga di `google_accounts` come il claim la restituisce. */
type ClaimedAccount = typeof googleAccounts.$inferSelect;

/** Cosa ha prodotto un tick: serve al log di riepilogo e ai test. */
export interface GoogleTickStats {
  /** Caselle reclamate. */
  accounts: number;
  /** Messaggi nuovi scritti in `email_messages`. */
  ingested: number;
  /** Caselle che il giro ha disabilitato. */
  disabled: number;
  /** Righe cancellate dalla retention. */
  pruned: number;
  /** Messaggi che la fase 2 ha trasformato in proposte (`classified`). */
  classified: number;
  /** Messaggi che la fase 2 ha chiuso senza proposta (`ignored`). */
  ignoredMessages: number;
  /** Messaggi che la fase 2 non è riuscita a classificare (`failed`). */
  failedMessages: number;
  /** Righe di `calendar_events` scritte o aggiornate dalla fase 3. */
  calendarEvents: number;
  /** Righe che la fase 3 ha reso CANDIDATE a una proposta di milestone. */
  calendarReady: number;
  /** Righe chiuse perché l'appuntamento è stato cancellato su Google. */
  calendarCancelled: number;
  /** Proposte pubblicate (posta + calendario): card nate in una inbox. */
  proposed: number;
}

/** Cosa ha prodotto la fase 3 nel giro di una casella. */
interface CalendarPhaseStats {
  events: number;
  ready: number;
  cancelled: number;
}

/** Contesto condiviso dalle tre fasi del giro di una casella. */
interface AccountContext {
  credentials: GoogleAccountCredentials;
  accessToken: string;
  /** Le regole di TUTTI i progetti, caricate una volta per tick. */
  routes: EmailRoute[];
  /**
   * Configurazione dell'AMMISSIONE (fase 6c), caricata una volta per tick
   * accanto a `routes` — vedi {@link loadAdmissionConfig}. Usata dal
   * pre-filtro sui metadati in {@link syncGmail}, prima ancora di scaricare
   * il corpo; `routes` qui sopra resta usata ANCHE da sola per
   * l'attribuzione (`matchRoutes`) dopo il download e per il routing del
   * calendario, che non ha ammissione.
   */
  admission: AdmissionConfig;
}

/**
 * Reclama le caselle DOVUTE e, nello stesso UPDATE, sposta avanti
 * `next_sync_at` (vedi "Perché il claim pre-schedula" nel docblock del modulo).
 *
 * Il `WHERE` della subquery ricalca esattamente l'indice PARZIALE
 * `google_accounts_due_idx` (`disabled_at is null and proposals_enabled`,
 * ordinato per `next_sync_at`): una casella disabilitata o con le proposte
 * spente non viene mai pescata, e il claim resta un index scan.
 */
export async function claimDueAccounts(
  db: Db,
  limit: number,
  intervalMinutes: number,
): Promise<ClaimedAccount[]> {
  const intervalSeconds = Math.max(1, Math.round(intervalMinutes * 60));
  return db
    .update(googleAccounts)
    .set({
      // `greatest`: una casella che sta già accumulando errori non torna a
      // essere interrogata ogni 5 minuti solo perché un worker l'ha reclamata.
      nextSyncAt: sql`now() + make_interval(secs => greatest(
        ${intervalSeconds},
        ${SYNC_BACKOFF_BASE_SECONDS} * power(2, least(${googleAccounts.syncAttempts}, ${SYNC_BACKOFF_MAX_EXPONENT}))
      ))`,
    })
    .where(
      sql`${googleAccounts.id} IN (
        SELECT id FROM google_accounts
        WHERE disabled_at IS NULL AND proposals_enabled AND next_sync_at <= now()
        ORDER BY next_sync_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/** Tutte le regole di tutti i progetti: una query per tick, non una per messaggio. */
export async function loadAllRoutes(db: Db): Promise<EmailRoute[]> {
  return db
    .select({
      projectId: projectEmailRoutes.projectId,
      kind: projectEmailRoutes.kind,
      value: projectEmailRoutes.value,
    })
    .from(projectEmailRoutes);
}

/**
 * TUTTI i domini di TUTTI i `google_workspaces` REGISTRATI — non solo quelli
 * delle caselle attive in questo tick.
 *
 * Deriva apposta dai `GoogleAccountCredentials` caricati per casella non
 * basterebbe: un Workspace registrato in Impostazioni → Google ma senza
 * ancora nessuna casella collegata (l'admin lo registra, nessuno ha ancora
 * fatto l'OAuth) avrebbe comunque i suoi domini nel perimetro
 * dell'ammissione — vedi il docblock di {@link AdmissionConfig.workspaceDomains}
 * in `@stubwise/notifications`: "TUTTI i Workspace registrati", non "con
 * casella collegata". Una query dedicata (per tick, non per casella) è
 * l'unico modo di coprire anche quel caso.
 */
export async function loadAllWorkspaceDomains(db: Db): Promise<string[]> {
  const rows = await db.select({ domains: googleWorkspaces.domains }).from(googleWorkspaces);
  return rows.flatMap((row) => row.domains);
}

/**
 * Configurazione D'ISTANZA dell'ammissione (fase 6c, `instance_settings`
 * singleton id=1), letta una volta per tick — stesso pattern di
 * `getContentLanguage` in `../settings.js`. Default difensivo se la riga
 * manca (DB ripristinato senza seed): identico a `loadMailAdmission` in
 * `apps/server/src/routes/settings.ts`, che serve la stessa configurazione
 * alla UI — le due letture non devono divergere sui default.
 */
async function loadInstanceAdmissionSettings(
  db: Db,
): Promise<Pick<AdmissionConfig, "admitWorkspaceDomains" | "denyLabels" | "denyAutomated">> {
  const [row] = await db
    .select({
      admitWorkspaceDomains: instanceSettings.emailAdmitWorkspaceDomains,
      denyLabels: instanceSettings.emailAdmissionDenyLabels,
      denyAutomated: instanceSettings.emailAdmissionDenyAutomated,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return {
    admitWorkspaceDomains: row?.admitWorkspaceDomains ?? true,
    denyLabels: row?.denyLabels ?? ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"],
    denyAutomated: row?.denyAutomated ?? true,
  };
}

/**
 * La {@link AdmissionConfig} completa per il tick: configurazione
 * d'istanza + domini Workspace + `routes` (RIUSATE, non ricaricate —
 * `routes` è già la stessa variabile che {@link loadAllRoutes} produce e che
 * `matchRoutes` usa per l'attribuzione dopo il download).
 *
 * Due query indipendenti (`instance_settings`, `google_workspaces`), lanciate
 * in parallelo: nessuna delle due dipende dall'altra, e sono comunque una
 * frazione del costo di un giro che poi scarica messaggi per più caselle.
 */
export async function loadAdmissionConfig(db: Db, routes: EmailRoute[]): Promise<AdmissionConfig> {
  const [settings, workspaceDomains] = await Promise.all([
    loadInstanceAdmissionSettings(db),
    loadAllWorkspaceDomains(db),
  ]);
  return { ...settings, workspaceDomains, routes };
}

/** Chiude una casella: `disabled_at` + motivo, e da lì il claim non la vede più. */
async function disableAccount(
  db: Db,
  accountId: string,
  reason: GoogleDisabledReason,
): Promise<void> {
  await db
    .update(googleAccounts)
    .set({ disabledAt: sql`now()`, disabledReason: reason })
    .where(eq(googleAccounts.id, accountId));
}

/**
 * Applica l'esito NEGATIVO di un giro. Ritorna `true` se la casella è stata
 * disabilitata (per il conteggio del tick).
 *
 * Il ramo fatale non tocca `sync_attempts` di proposito: quel contatore misura
 * i fallimenti RITENTABILI, e sporcarlo con un esito definitivo renderebbe
 * illeggibile la storia della casella dopo un ricollegamento.
 */
async function applyFailure(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  error: unknown,
): Promise<boolean> {
  const db = deps.db;
  const logger = deps.logger ?? defaultLogger;
  const fatal = disabledReasonFor(error);
  if (fatal) {
    await disableAccount(db, account.id, fatal);
    logger.warn(
      `google: casella ${account.email} disabilitata (${fatal}): ${errText(error)}`,
    );
    return true;
  }

  const attempts = account.syncAttempts + 1;
  if (attempts >= GMAIL_MAX_SYNC_ATTEMPTS) {
    await db
      .update(googleAccounts)
      .set({ syncAttempts: attempts, disabledAt: sql`now()`, disabledReason: "sync_failed" })
      .where(eq(googleAccounts.id, account.id));
    logger.warn(
      `google: casella ${account.email} disabilitata dopo ${attempts} tentativi (sync_failed): ${errText(error)}`,
    );
    return true;
  }

  const delayMs = nextSyncDelayMs(account.syncAttempts, error);
  await db
    .update(googleAccounts)
    .set({
      syncAttempts: attempts,
      nextSyncAt: sql`now() + make_interval(secs => ${Math.max(1, Math.round(delayMs / 1000))})`,
    })
    .where(eq(googleAccounts.id, account.id));
  logger.warn(
    `google: sincronizzazione di ${account.email} fallita (tentativo ${attempts}, ritento fra ${Math.round(delayMs / 1000)}s): ${errText(error)}`,
  );
  return false;
}

/**
 * Salva il cursore della FASE 1, e nient'altro.
 *
 * Si chiama subito dopo Gmail e prima delle fasi che possono lanciare (vedi
 * "DUE cursori" nel docblock del modulo): quello che la posta si è guadagnato
 * non deve poter essere annullato da un guasto del calendario.
 *
 * Il cursore si tocca in due casi e in nessun altro: c'è un `historyId` nuovo
 * (lo si scrive), oppure il resync ha appena dimostrato che quello vecchio è
 * SCADUTO e non ne ha prodotto uno nuovo (lo si azzera). Il secondo caso non è
 * cosmetico: lasciando lì un cursore che Gmail rifiuta, OGNI tick successivo
 * pagherebbe un 404 prima di ricadere sulla query — per sempre. Quando non c'è
 * niente da scrivere non parte nemmeno l'UPDATE.
 */
async function applyGmailCursor(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  cursor: { historyId: string | null; clearCursor: boolean },
): Promise<void> {
  if (!cursor.historyId && !cursor.clearCursor) return;
  await deps.db
    .update(googleAccounts)
    .set({ gmailHistoryId: cursor.historyId ?? null })
    .where(eq(googleAccounts.id, account.id));
}

/**
 * Salva il cursore della FASE 3, e nient'altro.
 *
 * `null` = questo giro non ha prodotto un punto di ripartenza (tetto di pagine
 * raggiunto, o una pagina finale senza `nextSyncToken`): il cursore resta
 * com'era e il giro dopo rilegge. L'azzeramento del token SCADUTO non passa da
 * qui ma da {@link collectCalendarEvents}, che lo fa appena scopre il 410 —
 * vedi il commento lì.
 */
async function applyCalendarCursor(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  syncToken: string | null,
): Promise<void> {
  if (!syncToken) return;
  await deps.db
    .update(googleAccounts)
    .set({ calendarSyncToken: syncToken })
    .where(eq(googleAccounts.id, account.id));
}

/**
 * Chiude un giro RIUSCITO: contatore azzerato, prossimo giro all'intervallo.
 *
 * NON tocca nessun cursore — li hanno già scritti le rispettive fasi — e gira
 * solo se nessuna di loro ha lanciato.
 */
async function applySuccess(deps: GooglePollerDeps, account: ClaimedAccount): Promise<void> {
  const intervalSeconds = Math.max(1, Math.round(deps.intervalMinutes * 60));
  await deps.db
    .update(googleAccounts)
    .set({
      lastSyncAt: sql`now()`,
      syncAttempts: 0,
      nextSyncAt: sql`now() + make_interval(secs => ${intervalSeconds})`,
    })
    .where(eq(googleAccounts.id, account.id));
}

/** Id dei messaggi da guardare in questo giro, più il cursore da salvare a fine ciclo. */
interface MessageBatch {
  ids: string[];
  historyId: string | null;
  /** Il giro è passato dal resync per query (primo giro o history scaduta). */
  resynced: boolean;
  /**
   * Il lotto NON copre tutta la history disponibile: `ids` è stato tagliato a
   * {@link GMAIL_RESYNC_MAX_MESSAGES}, o resta almeno una pagina non letta.
   * `historyId` (lo stato "adesso" della casella) non è quindi un cursore
   * sicuro — vedi il commento su `historyId` in fondo a {@link syncGmail}.
   */
  truncated: boolean;
}

/**
 * Cosa è arrivato dopo l'ultimo giro.
 *
 * Incrementale se c'è un cursore, per query (`newer_than:7d -from:me`) al primo
 * giro o quando la history è scaduta. Il fallback NON è un errore: è la
 * reazione giusta a «il tuo punto di ripartenza è troppo vecchio», e il
 * contatore dei tentativi non lo vede nemmeno.
 *
 * ⚠️ `messages.list` NON restituisce un `historyId` (verificato sulla firma di
 * `@stubwise/google`, non assunto): dopo un resync il cursore lo ricava
 * {@link syncGmail} dal messaggio più recente che ha letto, e se non ne ha
 * letto nessuno il cursore stantio viene azzerato (vedi `applySuccess`).
 */
async function collectMessageIds(
  deps: GooglePollerDeps,
  ctx: AccountContext,
  account: ClaimedAccount,
): Promise<MessageBatch> {
  const gmail = deps.gmail ?? realGmailClient;
  const logger = deps.logger ?? defaultLogger;

  if (account.gmailHistoryId) {
    try {
      const ids: string[] = [];
      let pageToken: string | null = null;
      let historyId: string | null = null;
      do {
        const page = await gmail.listHistory({
          accessToken: ctx.accessToken,
          startHistoryId: account.gmailHistoryId,
          pageToken,
        });
        ids.push(...page.addedMessageIds);
        historyId = page.historyId ?? historyId;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < GMAIL_RESYNC_MAX_MESSAGES);
      // Troncato quando resta almeno una pagina di history NON letta (il loop
      // si è fermato per il tetto, non perché la history fosse finita — in tal
      // caso `pageToken` è ancora valorizzato) o quando l'ultima pagina letta
      // ha da sola superato il tetto: in entrambi i casi `ids.slice(...)` sotto
      // lascia fuori messaggi che questo giro non vedrà.
      const truncated = pageToken !== null || ids.length > GMAIL_RESYNC_MAX_MESSAGES;
      return { ids: ids.slice(0, GMAIL_RESYNC_MAX_MESSAGES), historyId, resynced: false, truncated };
    } catch (err) {
      if (!isHistoryExpired(err)) throw err;
      logger.info(
        `google: history scaduta per ${account.email}, resync con "${GMAIL_RESYNC_QUERY}"`,
      );
    }
  }

  const ids: string[] = [];
  let pageToken: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof listMessages>> = await gmail.listMessages({
      accessToken: ctx.accessToken,
      q: GMAIL_RESYNC_QUERY,
      pageToken,
      maxResults: GMAIL_RESYNC_MAX_MESSAGES,
    });
    ids.push(...page.messageIds);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < GMAIL_RESYNC_MAX_MESSAGES);
  // `messages.list` non dà mai un `historyId` (vedi sopra): il cursore finale
  // sarà comunque `seenHistoryId`, calcolato dai messaggi letti in `syncGmail`
  // — `truncated` non cambia quella scelta qui. Lo si calcola comunque, per
  // non lasciare un campo silenziosamente falso quando in futuro qualcosa ne
  // dipendesse.
  const truncated = pageToken !== null || ids.length > GMAIL_RESYNC_MAX_MESSAGES;
  return { ids: ids.slice(0, GMAIL_RESYNC_MAX_MESSAGES), historyId: null, resynced: true, truncated };
}

/** Gli id che questa casella ha già in `email_messages`: non si riscaricano. */
async function filterAlreadyIngested(db: Db, accountId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const known = await db
    .select({ gmailMessageId: emailMessages.gmailMessageId })
    .from(emailMessages)
    .where(and(eq(emailMessages.accountId, accountId), inArray(emailMessages.gmailMessageId, ids)));
  const seen = new Set(known.map((row) => row.gmailMessageId));
  return ids.filter((id) => !seen.has(id));
}

/**
 * FASE 1 del giro: dai messaggi nuovi alle righe in perimetro. Ritorna quante
 * righe sono state scritte.
 *
 * L'ordine dei tre filtri è la spesa del tick, e non è negoziabile:
 *  1. **già ingerito** — nessuna chiamata a Google;
 *  2. **`format=metadata`** — header ed etichette, non il corpo;
 *  3. **ammissione sui soli metadati** (fase 6c, `admit`) — fuori perimetro
 *     qui significa nessun `messages.get full` e nessuna riga scritta. Una
 *     casella rumorosa costa quindi una `metadata` per messaggio, non un
 *     corpo per messaggio. Non è più `matchRoutes.inScope`: un messaggio può
 *     essere ammesso (dominio Workspace, o una regola di progetto) senza che
 *     nessuna regola di progetto combaci — vedi `matchRoutes` più sotto.
 *
 * `matchRoutes` dopo il download resta l'ATTRIBUZIONE (di quale progetto
 * parla), invariata: non decide più se scaricare, ma risolve `scope_project_ids`
 * — che ora può tornare vuoto su un messaggio comunque ammesso — e può
 * risolvere un progetto che sui soli metadati era ambiguo, perché una keyword
 * del corpo aggiunge un match.
 */
async function syncGmail(
  deps: GooglePollerDeps,
  ctx: AccountContext,
  account: ClaimedAccount,
): Promise<{ ingested: number; historyId: string | null; clearCursor: boolean }> {
  const gmail = deps.gmail ?? realGmailClient;
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date());

  const batch = await collectMessageIds(deps, ctx, account);
  const ids = await filterAlreadyIngested(deps.db, account.id, batch.ids);

  let ingested = 0;
  // Cursore di ripiego dopo un resync: `messages.list` non ne dà uno, i
  // messaggi sì. È il modo documentato da Google di ripartire in incrementale
  // dopo una sincronizzazione completa. È anche il cursore che vince ogni
  // volta che il lotto non è stato processato per intero (vedi `historyId`
  // qui sotto).
  let seenHistoryId: string | null = null;
  let aborted = false;
  for (const id of ids) {
    if (deps.signal?.aborted) {
      aborted = true;
      break;
    }

    let metadata: GmailMessage;
    try {
      metadata = await gmail.getMessageMetadata({ accessToken: ctx.accessToken, id });
    } catch (err) {
      // Un messaggio sparito fra l'elenco e la lettura (cancellato dall'utente)
      // non è un guasto della casella: si salta. Tutto il resto — quota,
      // credenziali, rete — riguarda il giro intero e sale al gestore d'errore.
      if (err instanceof GoogleApiError && err.status === 404) {
        logger.info(`google: messaggio ${id} non più disponibile su ${account.email}`);
        continue;
      }
      throw err;
    }

    // La posta in USCITA non è una richiesta ricevuta. Il resync per query la
    // esclude già con `-from:me`; il percorso incrementale no, e questa riga è
    // l'unica difesa che vale per entrambi.
    seenHistoryId = maxHistoryId(seenHistoryId, metadata.historyId);

    if (isFromMailbox(metadata, ctx.credentials.email)) continue;

    const admission = admit(messageToRouting(metadata), ctx.admission);
    if (!admission.admitted) continue;

    const full = await gmail.getMessageFull({ accessToken: ctx.accessToken, id });
    const text = full.payload ? extractText(full.payload) : "";
    const resolved = matchRoutes(messageToRouting(full, text), ctx.routes);

    const inserted = await deps.db
      .insert(emailMessages)
      .values(
        buildEmailMessageInsert({
          accountId: account.id,
          message: full,
          text,
          projectId: resolved.projectId,
          candidateProjectIds: resolved.candidateProjectIds,
          scopeProjectIds: resolved.scopeProjectIds,
          now: now(),
        }),
      )
      // L'unique `(account_id, gmail_message_id)` è l'idempotenza del poller:
      // rileggere la stessa history due volte non duplica niente.
      .onConflictDoNothing()
      .returning({ id: emailMessages.id });
    if (inserted.length > 0) ingested += 1;
  }

  // `batch.historyId` — lo stato "adesso" della casella secondo l'ultima
  // pagina di `history.list` — è un cursore sicuro SOLO se questo giro ha
  // visto l'intera history senza troncamenti (`batch.truncated`) né
  // interruzioni (`aborted`): altrimenti supererebbe messaggi che il tick non
  // ha processato, e quei messaggi non comparirebbero mai più in nessuna
  // history futura (sono "prima" del cursore salvato). In quel caso si scrive
  // `seenHistoryId` — il max fra i messaggi EFFETTIVAMENTE letti — e il tick
  // dopo riparte da lì, rileggendo (senza duplicare, `onConflictDoNothing`
  // sopra) ciò che non era stato ancora processato.
  const complete = !batch.truncated && !aborted;
  const historyId = complete ? (batch.historyId ?? seenHistoryId) : seenHistoryId;
  return { ingested, historyId, clearCursor: batch.resynced && historyId === null };
}

/** Cosa ha prodotto il giro di UNA casella (null = giro saltato). */
interface AccountTickResult {
  ingested: number;
  classify: ClassifyBatchStats;
  calendar: CalendarPhaseStats;
  proposed: number;
}

/**
 * FASE 2 del giro: i messaggi `new` di questa casella diventano proposte.
 *
 * ⚠️ **Non lascia MAI salire un'eccezione**, ed è una scelta con due ragioni
 * distinte. La prima: il gestore d'errore del chiamante legge ogni eccezione
 * come un verdetto sulla CASELLA (backoff, e dopo abbastanza tentativi
 * `sync_failed`), mentre qui i guasti possibili — il CLI, il provider AI, una
 * riga malformata — non dicono niente su Gmail. La seconda: se l'eccezione
 * salisse, `applySuccess` non girerebbe e il cursore appena guadagnato dalla
 * fase 1 andrebbe perso, facendo riscaricare gli stessi messaggi al giro dopo.
 *
 * `classifyEmail` chiude già ogni messaggio su uno stato; questo catch copre
 * ciò che sta INTORNO ai messaggi (la query dei pendenti, la catena di
 * provider, la lingua).
 */
async function runClassifyPhase(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
): Promise<ClassifyBatchStats> {
  const logger = deps.logger ?? defaultLogger;
  const empty: ClassifyBatchStats = { classified: 0, ignored: 0, failed: 0 };
  // Nessun runner = fase 2 spenta (vedi GooglePollerDeps.runner).
  if (!deps.runner) return empty;
  try {
    return await classifyNewMessages(
      {
        db: deps.db,
        runner: deps.runner,
        encryptionKey: deps.encryptionKey,
        maxPerTick: deps.classifyMaxPerTick ?? DEFAULT_CLASSIFY_MAX_PER_TICK,
        ...(deps.gmailModel !== undefined ? { model: deps.gmailModel } : {}),
        ...(deps.maxProjectsPerMessage !== undefined
          ? { maxProjectsPerMessage: deps.maxProjectsPerMessage }
          : {}),
        ...(deps.loadProviderChainFn !== undefined
          ? { loadProviderChainFn: deps.loadProviderChainFn }
          : {}),
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      },
      account.id,
    );
  } catch (err) {
    logger.error(
      `google: classificazione della posta di ${account.email} interrotta: ${errText(err)}`,
    );
    return empty;
  }
}

/** Una pagina dopo l'altra, fino all'ultima o al tetto. */
async function drainCalendarPages(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  base: { accessToken: string; syncToken?: string; timeMin?: Date; timeMax?: Date; showDeleted: boolean },
): Promise<{ events: GoogleCalendarEvent[]; syncToken: string | null }> {
  const calendar = deps.calendar ?? realCalendarClient;
  const logger = deps.logger ?? defaultLogger;
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < CALENDAR_MAX_PAGES; page += 1) {
    const result = await calendar.listEvents({
      ...base,
      pageToken,
      maxResults: CALENDAR_PAGE_SIZE,
    });
    events.push(...result.events);
    pageToken = result.nextPageToken;
    // `nextSyncToken` arriva SOLO sull'ultima pagina: se il ciclo si ferma
    // prima, non c'è nessun punto di ripartenza da salvare — ed è giusto così,
    // salvarne uno a metà elenco perderebbe gli eventi non ancora letti.
    if (!pageToken) return { events, syncToken: result.nextSyncToken };
  }

  logger.warn(
    `google: calendario di ${account.email} oltre ${CALENDAR_MAX_PAGES} pagine, cursore non avanzato`,
  );
  return { events, syncToken: null };
}

/**
 * Cosa è cambiato sul calendario `primary` dopo l'ultimo giro.
 *
 * Incrementale se c'è un `calendar_sync_token`, per finestra (da adesso a
 * {@link CALENDAR_WINDOW_DAYS} giorni) al primo giro o quando il token è
 * scaduto. Come per Gmail, il fallback NON è un errore e non conta un
 * tentativo.
 *
 * ⚠️ Il token scaduto si AZZERA subito, prima del resync, e non a fine giro
 * come fa Gmail con `clearCursor`. La differenza è voluta: qui il resync che
 * segue può lanciare (rete, quota), e se il 410 fosse ancora "da smaltire" il
 * tick successivo pagherebbe di nuovo un 410 prima di ricadere sulla finestra
 * — ogni volta, finché la casella non ha un giro perfetto. Azzerandolo appena
 * si sa che è morto, quel costo si paga una volta sola.
 *
 * `showDeleted` è acceso in ENTRAMBI i percorsi. In incrementale è così che
 * arrivano gli eventi `cancelled`, che servono a chiudere le righe già viste —
 * l'unica ragione per cui esiste. Il resync per finestra lo era rimasto
 * spento fino a quando non si è visto il caso vero: un 410 non capita mai da
 * solo, capita DOPO un giro incrementale che aveva già tracciato righe (magari
 * candidate a una proposta), e un appuntamento cancellato fra quell'ultimo
 * giro riuscito e il 410 non comparirebbe più in NESSUN resync — la riga
 * resterebbe aperta per sempre, candidata a una proposta di un appuntamento
 * che non esiste più. Al primo giro in assoluto (nessuna riga tracciata)
 * `showDeleted: true` costa solo qualche evento cancellato in più nella
 * risposta, scartato subito da {@link closeCancelledEvents} perché non trova
 * niente da chiudere — rumore innocuo, non un errore.
 */
async function collectCalendarEvents(
  deps: GooglePollerDeps,
  ctx: AccountContext,
  account: ClaimedAccount,
): Promise<{ events: GoogleCalendarEvent[]; syncToken: string | null }> {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date());

  if (account.calendarSyncToken) {
    try {
      return await drainCalendarPages(deps, account, {
        accessToken: ctx.accessToken,
        syncToken: account.calendarSyncToken,
        showDeleted: true,
      });
    } catch (err) {
      if (!isSyncTokenExpired(err)) throw err;
      logger.info(
        `google: syncToken del calendario scaduto per ${account.email}, resync su ${CALENDAR_WINDOW_DAYS} giorni`,
      );
      await deps.db
        .update(googleAccounts)
        .set({ calendarSyncToken: null })
        .where(eq(googleAccounts.id, account.id));
    }
  }

  const { timeMin, timeMax } = calendarWindow(now());
  return drainCalendarPages(deps, account, {
    accessToken: ctx.accessToken,
    timeMin,
    timeMax,
    showDeleted: true,
  });
}

/**
 * Chiude le righe degli appuntamenti CANCELLATI, e non fa nient'altro.
 *
 * Un evento cancellato che non abbiamo mai visto non produce nessuna riga: la
 * `where` semplicemente non trova niente. E un `outcome` già scritto non viene
 * sovrascritto (`coalesce`): se la fase D aveva già eseguito la proposta, il
 * suo esito — la milestone creata — è la storia di quella riga e cancellare
 * l'appuntamento dopo non la riscrive.
 */
async function closeCancelledEvents(
  db: Db,
  accountId: string,
  googleEventIds: string[],
): Promise<number> {
  if (googleEventIds.length === 0) return 0;
  const closed = await db
    .update(calendarEventsTable)
    .set({
      status: "cancelled",
      outcome: sql`coalesce(${calendarEventsTable.outcome}, ${JSON.stringify(CALENDAR_CANCELLED_OUTCOME)}::jsonb)`,
    })
    .where(
      and(
        eq(calendarEventsTable.accountId, accountId),
        inArray(calendarEventsTable.googleEventId, googleEventIds),
      ),
    )
    .returning({ id: calendarEventsTable.id });
  return closed.length;
}

/**
 * FASE 3 del giro: dal calendario `primary` alle righe di `calendar_events`.
 *
 * ⚠️ **Lascia salire le proprie eccezioni**, al contrario di
 * {@link runClassifyPhase}. Non è un'incoerenza: la fase 2 fallisce per colpa
 * del CLI o del provider AI, che non dicono niente sulla casella; la fase 3
 * fallisce per colpa di Google — token, permessi, quota, rete — ed è
 * esattamente il tipo di verdetto che `applyFailure` sa trattare (backoff,
 * fatale, `sync_failed`). Il cursore di Gmail è già al sicuro: l'ha scritto
 * {@link applyGmailCursor} prima che questa fase partisse.
 *
 * ## Cosa NON diventa una riga
 *
 * Un evento fuori perimetro, uno senza data d'inizio e uno senza titolo non
 * producono nulla. Gli ultimi due perché {@link buildMilestoneProposal}
 * tornerebbe `null` e la riga nascerebbe già incapace di diventare una
 * proposta: scriverla vorrebbe dire riempire la tabella di appuntamenti che
 * nessuno vedrà mai.
 *
 * ## Cosa NON si tocca su una riga che esiste già
 *
 * `proposal_notification_id` e `outcome` non vengono mai sovrascritti da qui:
 * sono la storia della fase D. `project_id` si aggiorna solo finché la riga è
 * ancora aperta — dopo, cambiare progetto a una proposta già pubblicata
 * significherebbe farla puntare altrove sotto le dita di chi la sta leggendo.
 */
async function syncCalendar(
  deps: GooglePollerDeps,
  ctx: AccountContext,
  account: ClaimedAccount,
): Promise<{ syncToken: string | null; stats: CalendarPhaseStats }> {
  const stats: CalendarPhaseStats = { events: 0, ready: 0, cancelled: 0 };
  const { events, syncToken } = await collectCalendarEvents(deps, ctx, account);
  if (events.length === 0) return { syncToken, stats };

  stats.cancelled = await closeCancelledEvents(
    deps.db,
    account.id,
    events.filter(isCancelled).map((event) => event.id),
  );

  const lang = deps.lang ?? (await getContentLanguage(deps.db));

  // Un evento può comparire più volte in un resync paginato: vince l'ultima
  // versione letta, che è anche la più recente. `startsAt` viaggia a parte
  // perché qui è garantito non nullo e il tipo di Google non lo sa.
  const live = new Map<string, { event: GoogleCalendarEvent; startsAt: Date; fingerprint: string }>();
  for (const event of events) {
    if (isCancelled(event)) continue;
    const startsAt = event.startsAt;
    if (!startsAt) continue;
    if (!buildMilestoneProposal(lang, event)) continue;
    if (!routeEvent(event, ctx.routes).inScope) continue;
    live.set(event.id, { event, startsAt, fingerprint: computeFingerprint(event.title, startsAt) });
  }
  if (live.size === 0) return { syncToken, stats };

  const ids = [...live.keys()];
  const fingerprints = [...live.values()].map((entry) => entry.fingerprint);

  // Due letture per tutto il lotto, non due per evento: quello che serve è
  // "questa riga esiste già?" e "questo appuntamento è già tracciato sotto un
  // altro id?", e sono entrambe una `in (…)`.
  const known = await deps.db
    .select({
      googleEventId: calendarEventsTable.googleEventId,
      proposalNotificationId: calendarEventsTable.proposalNotificationId,
      outcome: calendarEventsTable.outcome,
    })
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.accountId, account.id),
        inArray(calendarEventsTable.googleEventId, ids),
      ),
    );
  const byEventId = new Map(known.map((row) => [row.googleEventId, row]));

  const sameFingerprint = await deps.db
    .select({
      googleEventId: calendarEventsTable.googleEventId,
      fingerprint: calendarEventsTable.fingerprint,
    })
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.accountId, account.id),
        inArray(calendarEventsTable.fingerprint, fingerprints),
      ),
    );
  const ownerOfFingerprint = new Map<string, string>();
  for (const row of sameFingerprint) {
    if (!ownerOfFingerprint.has(row.fingerprint)) {
      ownerOfFingerprint.set(row.fingerprint, row.googleEventId);
    }
  }

  for (const { event, startsAt, fingerprint } of live.values()) {
    if (deps.signal?.aborted) break;
    const resolved = routeEvent(event, ctx.routes);
    const fresh = {
      title: event.title.trim(),
      startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      attendees: event.attendees,
      organizer: event.organizer,
      status: normalizeStatus(event.status),
      fingerprint,
    };

    const existing = byEventId.get(event.id);
    if (existing) {
      const stillOpen = existing.proposalNotificationId === null && existing.outcome === null;
      await deps.db
        .update(calendarEventsTable)
        .set(stillOpen ? { ...fresh, projectId: resolved.projectId } : fresh)
        .where(
          and(
            eq(calendarEventsTable.accountId, account.id),
            eq(calendarEventsTable.googleEventId, event.id),
          ),
        );
      stats.events += 1;
      continue;
    }

    // Stesso giorno e stesso titolo sotto un altro id: è l'appuntamento che
    // stiamo già seguendo, ricreato. Si scrive la riga (tracciabilità) con un
    // esito che la esclude dalle candidate.
    const owner = ownerOfFingerprint.get(fingerprint);
    const duplicate = owner !== undefined && owner !== event.id;
    const inserted = await deps.db
      .insert(calendarEventsTable)
      .values({
        accountId: account.id,
        googleEventId: event.id,
        projectId: resolved.projectId,
        outcome: duplicate ? duplicateOutcome(owner) : null,
        ...fresh,
      })
      // L'unique `(account_id, google_event_id)` è l'idempotenza della fase 3.
      .onConflictDoNothing()
      .returning({ id: calendarEventsTable.id });
    if (inserted.length === 0) continue;

    stats.events += 1;
    if (!duplicate && resolved.projectId !== null) stats.ready += 1;
    // Un secondo evento con la stessa impronta nello STESSO lotto è già un
    // duplicato di questo: senza questa riga se ne proporrebbero due.
    if (!ownerOfFingerprint.has(fingerprint)) ownerOfFingerprint.set(fingerprint, event.id);
  }

  return { syncToken, stats };
}

/**
 * Nomi dei progetti nominati dalle righe del lotto, in UNA query.
 *
 * Fase 6b: per la posta gli id vengono dai FIGLI (`email_proposals.project_id`,
 * uno certo per riga), non più dal solo `email_messages.project_id` — il
 * fan-out ha già risolto quale progetto ciascuna proposta riguarda, quindi
 * qui non servono più i `candidateProjectIds` del padre (erano le opzioni
 * «Riguarda …» di `choose_project`, non più generate).
 */
async function projectNamesOf(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, unique));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/**
 * FASE 4 del giro: le righe già trattate diventano PROPOSTE in inbox.
 *
 * È la fase che rende visibile tutto il resto: senza di lei un messaggio
 * classificato e un appuntamento in perimetro restano righe che nessuno vede.
 * Sta QUI, in coda alle altre, e non dentro la classificazione o dentro
 * `syncCalendar`, per una ragione precisa: pesca dallo STATO del database, non
 * da ciò che questo tick ha appena prodotto. Così una riga rimasta indietro —
 * perché il tick precedente si era interrotto, perché la publish era fallita,
 * perché il tetto per tick l'aveva tagliata fuori — viene ripresa da sola al
 * giro dopo, senza nessun recovery dedicato.
 *
 * ⚠️ **Non lascia MAI salire un'eccezione**, per le stesse due ragioni di
 * {@link runClassifyPhase}: il gestore d'errore del chiamante leggerebbe il
 * guasto come un verdetto sulla CASELLA (backoff, poi `sync_failed`) mentre
 * qui i guasti possibili non dicono niente su Google, e `applySuccess` non
 * girerebbe, facendo perdere i cursori appena guadagnati.
 *
 * `publishProposal` è già atomica riga per riga (notifica + chiusura della riga
 * nella stessa transazione): un errore su un messaggio non compromette quelli
 * già proposti, e quello fallito resta esattamente dov'era.
 *
 * Fase 6b: la selezione per la posta è un JOIN fra i FIGLI `classified` senza
 * notifica (`email_proposals`) e il loro padre (`email_messages`, per
 * mittente/oggetto/thread/data — comuni a tutti i figli dello stesso
 * messaggio), filtrato per casella. Il tetto per tick conta **proposte**
 * (righe `email_proposals`), non messaggi: un messaggio con tre figli vale
 * tre verso il tetto, non uno — senza questo, il tetto sul FAN-OUT
 * (`GMAIL_MAX_PROJECTS_PER_MESSAGE`) potrebbe comunque far pubblicare più
 * card di quante il tetto per tick intendesse.
 */
async function runProposePhase(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
): Promise<number> {
  const logger = deps.logger ?? defaultLogger;
  const limit = Math.trunc(deps.proposeMaxPerTick ?? DEFAULT_PROPOSE_MAX_PER_TICK);
  if (limit <= 0) return 0;

  try {
    const lang = deps.lang ?? (await getContentLanguage(deps.db));
    let published = 0;

    // --- Posta: le proposte FIGLIE classificate e non ancora proposte, dal
    // padre più vecchio. Un JOIN e non due query separate: il padre porta
    // mittente/oggetto/thread/data, comuni a ogni figlio dello stesso
    // messaggio, e non li ripetiamo su `email_proposals`.
    const proposalRows = await deps.db
      .select({
        proposalId: emailProposals.id,
        proposalProjectId: emailProposals.projectId,
        proposalClassification: emailProposals.classification,
        messageId: emailMessages.id,
        threadId: emailMessages.threadId,
        fromAddress: emailMessages.fromAddress,
        fromName: emailMessages.fromName,
        subject: emailMessages.subject,
        receivedAt: emailMessages.receivedAt,
      })
      .from(emailProposals)
      .innerJoin(emailMessages, eq(emailProposals.emailMessageId, emailMessages.id))
      .where(
        and(
          eq(emailMessages.accountId, account.id),
          eq(emailProposals.status, "classified"),
          isNull(emailProposals.proposalNotificationId),
        ),
      )
      .orderBy(asc(emailMessages.receivedAt), asc(emailProposals.id))
      .limit(limit);

    // --- Calendario: la `where` è, alla lettera, il contratto documentato su
    // `isReadyForProposal` (che `buildCalendarProposalEvent` riapplica).
    const events = await deps.db
      .select({
        id: calendarEventsTable.id,
        title: calendarEventsTable.title,
        startsAt: calendarEventsTable.startsAt,
        organizer: calendarEventsTable.organizer,
        status: calendarEventsTable.status,
        projectId: calendarEventsTable.projectId,
        proposalNotificationId: calendarEventsTable.proposalNotificationId,
        outcome: calendarEventsTable.outcome,
      })
      .from(calendarEventsTable)
      .where(
        and(
          eq(calendarEventsTable.accountId, account.id),
          sql`${calendarEventsTable.status} is distinct from 'cancelled'`,
          isNotNull(calendarEventsTable.projectId),
          isNull(calendarEventsTable.proposalNotificationId),
          isNull(calendarEventsTable.outcome),
        ),
      )
      .orderBy(asc(calendarEventsTable.startsAt), asc(calendarEventsTable.id))
      .limit(limit);

    if (proposalRows.length === 0 && events.length === 0) return 0;

    // Una query sola per i nomi di TUTTI i progetti nominati dal lotto: il
    // progetto CERTO di ciascun figlio più quello di ciascun evento di
    // calendario. Niente più candidati: `choose_project` non si genera più
    // (vedi il docblock di `buildEmailProposalEvent`).
    const projectNames = await projectNamesOf(deps.db, [
      ...proposalRows.map((row) => row.proposalProjectId),
      ...events.map((event) => event.projectId),
    ]);

    for (const row of proposalRows) {
      if (deps.signal?.aborted) return published;
      const event = buildEmailProposalEvent({
        lang,
        message: {
          threadId: row.threadId,
          fromAddress: row.fromAddress,
          fromName: row.fromName,
          subject: row.subject,
          receivedAt: row.receivedAt,
        },
        proposal: { projectId: row.proposalProjectId, classification: row.proposalClassification },
        mailboxEmail: account.email,
        projectNames,
      });
      if (!event) {
        // Niente da proporre da una classificazione che non regge più (o un
        // nome di progetto che non si risolve più): il FIGLIO resta
        // `classified` e verrebbe ripescato a ogni tick per sempre. `ignored`
        // lo chiude senza inventare una proposta — il PADRE non si tocca qui.
        await deps.db
          .update(emailProposals)
          .set({ status: "ignored" })
          .where(eq(emailProposals.id, row.proposalId));
        continue;
      }
      const result = await publishProposal(deps.db, {
        event,
        source: "email",
        rowId: row.proposalId,
        mailboxOwnerUserId: account.userId,
        projectId: row.proposalProjectId,
        ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
      });
      if (result.ok) published += 1;
      else if (result.reason !== "not_claimable") {
        logger.warn(
          `google: proposta non pubblicata per il messaggio ${row.messageId} ` +
            `(progetto ${row.proposalProjectId}, ${result.reason})`,
        );
      }
    }

    for (const row of events) {
      if (deps.signal?.aborted) return published;
      const event = buildCalendarProposalEvent({
        lang,
        event: row,
        mailboxEmail: account.email,
        projectNames,
      });
      if (!event) continue;
      const result = await publishProposal(deps.db, {
        event,
        source: "calendar",
        rowId: row.id,
        mailboxOwnerUserId: account.userId,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
      });
      if (result.ok) published += 1;
      else if (result.reason !== "not_claimable") {
        logger.warn(
          `google: proposta non pubblicata per l'evento ${row.id} (${result.reason})`,
        );
      }
    }

    return published;
  } catch (err) {
    logger.error(
      `google: pubblicazione delle proposte di ${account.email} interrotta: ${errText(err)}`,
    );
    return 0;
  }
}

/**
 * Il giro di UNA casella: credenziali → access token → le fasi.
 *
 * L'ORDINE delle scritture qui dentro è la parte che si sbaglia: il cursore di
 * Gmail si salva SUBITO dopo la fase 1, perché la fase 3 può lanciare e le sue
 * eccezioni devono arrivare fino ad `applyFailure` senza portarsi via il
 * lavoro già fatto. Vedi "DUE cursori" nel docblock del modulo.
 */
async function runAccountTick(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  routes: EmailRoute[],
  admission: AdmissionConfig,
): Promise<AccountTickResult | null> {
  const logger = deps.logger ?? defaultLogger;
  const load = deps.loadCredentials ?? loadGoogleAccountCredentials;
  const gmail = deps.gmail ?? realGmailClient;

  const credentials = await load(deps.db, deps.encryptionKey, account.id);
  if (!credentials) {
    // Workspace senza client secret, o payload cifrato illeggibile con la
    // chiave corrente: è configurazione, non un verdetto di Google. La casella
    // NON si disabilita (l'admin può ancora rimediare) e non si conta un
    // tentativo: si salta questo giro, il claim ha già schedulato il prossimo.
    logger.warn(`google: credenziali non utilizzabili per la casella ${account.email}, salto`);
    return null;
  }

  const tokens = await gmail.refreshAccessToken({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
  });
  const ctx: AccountContext = { credentials, accessToken: tokens.accessToken, routes, admission };

  // Fase 1 — Gmail, e il suo cursore messo al sicuro prima di tutto il resto.
  const gmailResult = await syncGmail(deps, ctx, account);
  await applyGmailCursor(deps, account, gmailResult);

  // Fase 2 — classificazione dei messaggi `new` (compresi quelli rimasti
  // indietro dai giri precedenti, non solo quelli appena ingeriti).
  const classify = await runClassifyPhase(deps, account);

  // Fase 3 — calendario `primary` → righe candidate a una proposta di
  // milestone. Se lancia, il chiamante mette la casella in backoff e il
  // cursore del calendario resta dov'era: la posta ha già il suo.
  const calendar = await syncCalendar(deps, ctx, account);
  await applyCalendarCursor(deps, account, calendar.syncToken);

  // Fase 4 — le righe pronte (di questo giro e di quelli prima) diventano
  // proposte in inbox. Dopo i cursori: non parla con Google, e un suo guasto
  // non deve poter costare una risincronizzazione.
  const proposed = await runProposePhase(deps, account);

  return { ingested: gmailResult.ingested, classify, calendar: calendar.stats, proposed };
}

/**
 * RETENTION: i messaggi VECCHI la cui storia è DAVVERO chiusa.
 *
 * Fase 6b: `email_messages.status` (il padre) non racconta più da solo
 * l'esito di un messaggio. Dalla classificazione in poi il lavoro vive sui
 * FIGLI (`email_proposals`, uno per progetto in `scopeProjectIds`): il padre
 * resta `classified` (o, per righe legacy pre-6b senza figlio equivalente,
 * `proposed`/`actioned`) MENTRE i suoi figli vengono pubblicati, confermati,
 * ignorati o falliscono indipendentemente l'uno dall'altro — vedi
 * `classify.ts` (scrittura sui figli) e `google-proposal.ts`
 * (`markSourceOutcome`/`markSourceFailed`, che scrivono SOLO sul figlio).
 * Un messaggio è quindi potabile solo quando TUTTE e tre le condizioni
 * valgono:
 *
 *  1. **è stato almeno classificato** (`status <> 'new'`): un messaggio
 *     ancora `new` non è mai stato nemmeno guardato — e per costruzione non
 *     ha figli finché resta tale — indipendentemente da quanto sia vecchio;
 *  2. **ogni figlio è TERMINALE** ({@link TERMINAL_EMAIL_PROPOSAL_STATUSES}):
 *     un `NOT EXISTS` su un figlio non-terminale, vero anche quando il
 *     messaggio non ha (o non ha più) nessun figlio — nessuna proposta valida
 *     dalla classificazione, un crash prima di scriverne una, o l'ultimo
 *     progetto del perimetro cancellato: l'insieme vuoto soddisfa banalmente
 *     "tutti terminali", ed è la stessa logica di prima (nessun figlio da
 *     aspettare) ora espressa sui figli invece che sullo stato del padre;
 *  3. **nessun figlio ha una notifica ancora APERTA** (`status <> 'handled'`,
 *     stesso significato di "aperta" del pulse — vedi
 *     `ne(notifications.status, "handled")` in `pulse/poller.ts`). È DIFESA
 *     IN PROFONDITÀ e non un controllo ridondante per costruzione: un figlio
 *     TERMINALE ha, per l'ordine con cui `dispatchAction` in
 *     `google-proposal.ts` chiama `propagateHandled` (claim: chiude la
 *     notifica) PRIMA di scrivere lo stato terminale sul figlio, sempre già
 *     la sua notifica chiusa — ma questa condizione non si fida di
 *     quell'ordine, lo riverifica riga per riga.
 *
 * La soglia resta su `updated_at` DEL PADRE, e non su `received_at`: è la
 * colonna che `markSourceOutcome`/`markSourceFailed` toccano a ogni chiusura
 * di UN figlio (mai nient'altro del padre, vedi il loro docblock), quindi
 * misura "da quando la storia si è chiusa per l'ultima volta", non "da
 * quando l'email è arrivata" — altrimenti un messaggio vecchio appena
 * trattato sparirebbe il giorno dopo, portandosi via la tracciabilità di ciò
 * che si è appena fatto.
 *
 * La CASCATA sui figli (`email_proposals.email_message_id` con `ON DELETE
 * CASCADE`, Task 1) fa il resto da sola: nessuna azione applicativa in più
 * qui per portarli via col padre.
 *
 * `retentionDays ≤ 0` = nessuna potatura (i messaggi restano per sempre).
 */
export async function pruneOldEmails(db: Db, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  // Condizione 2: un figlio di QUESTO messaggio ancora non terminale.
  const openChild = db
    .select({ id: emailProposals.id })
    .from(emailProposals)
    .where(
      and(
        eq(emailProposals.emailMessageId, emailMessages.id),
        notInArray(emailProposals.status, [...TERMINAL_EMAIL_PROPOSAL_STATUSES]),
      ),
    );

  // Condizione 3: un figlio di QUESTO messaggio la cui notifica è ancora
  // aperta. L'INNER JOIN già filtra su `proposalNotificationId IS NOT NULL`
  // (una FK nulla non produce nessuna riga di join): niente `isNotNull`
  // esplicito in più.
  const openNotifiedChild = db
    .select({ id: emailProposals.id })
    .from(emailProposals)
    .innerJoin(notifications, eq(notifications.id, emailProposals.proposalNotificationId))
    .where(
      and(eq(emailProposals.emailMessageId, emailMessages.id), ne(notifications.status, "handled")),
    );

  const deleted = await db
    .delete(emailMessages)
    .where(
      and(
        ne(emailMessages.status, "new"),
        sql`${emailMessages.updatedAt} < now() - make_interval(days => ${Math.round(retentionDays)})`,
        notExists(openChild),
        notExists(openNotifiedChild),
      ),
    )
    .returning({ id: emailMessages.id });
  return deleted.length;
}

/**
 * Esegue UN giro: potatura, claim, e poi una casella alla volta in SEQUENZA.
 *
 * Le caselle non vanno in parallelo: ogni giro è una raffica di chiamate a
 * Google sulla stessa quota di progetto, e parallelizzarle è il modo più rapido
 * per trasformare un tick tranquillo in un 429 per tutti. NON lancia mai.
 */
export async function pollGoogleOnce(deps: GooglePollerDeps): Promise<GoogleTickStats> {
  const logger = deps.logger ?? defaultLogger;
  const stats: GoogleTickStats = {
    accounts: 0,
    ingested: 0,
    disabled: 0,
    pruned: 0,
    classified: 0,
    ignoredMessages: 0,
    failedMessages: 0,
    calendarEvents: 0,
    calendarReady: 0,
    calendarCancelled: 0,
    proposed: 0,
  };

  // La potatura gira SEMPRE, anche quando nessuna casella è dovuta: è
  // manutenzione della tabella, non parte del giro di una casella.
  try {
    stats.pruned = await pruneOldEmails(deps.db, deps.retentionDays);
  } catch (err) {
    logger.error(`google: potatura dei messaggi fallita: ${errText(err)}`);
  }

  let accounts: ClaimedAccount[];
  try {
    accounts = await claimDueAccounts(
      deps.db,
      deps.accountBatch ?? DEFAULT_ACCOUNT_BATCH,
      deps.intervalMinutes,
    );
  } catch (err) {
    logger.error(`google: claim delle caselle fallito: ${errText(err)}`);
    return stats;
  }
  stats.accounts = accounts.length;
  if (accounts.length === 0) return stats;

  let routes: EmailRoute[];
  try {
    routes = await loadAllRoutes(deps.db);
  } catch (err) {
    logger.error(`google: lettura delle regole di routing fallita: ${errText(err)}`);
    return stats;
  }

  let admission: AdmissionConfig;
  try {
    admission = await loadAdmissionConfig(deps.db, routes);
  } catch (err) {
    logger.error(`google: lettura della configurazione di ammissione fallita: ${errText(err)}`);
    return stats;
  }

  for (const account of accounts) {
    if (deps.signal?.aborted) break;
    try {
      const result = await runAccountTick(deps, account, routes, admission);
      if (!result) continue;
      stats.ingested += result.ingested;
      stats.classified += result.classify.classified;
      stats.ignoredMessages += result.classify.ignored;
      stats.failedMessages += result.classify.failed;
      stats.calendarEvents += result.calendar.events;
      stats.calendarReady += result.calendar.ready;
      stats.calendarCancelled += result.calendar.cancelled;
      stats.proposed += result.proposed;
      await applySuccess(deps, account);
    } catch (err) {
      try {
        if (await applyFailure(deps, account, err)) stats.disabled += 1;
      } catch (inner) {
        // Difesa finale: se nemmeno registrare il fallimento riesce, il claim
        // ha comunque già spostato `next_sync_at` e il tick prosegue.
        logger.error(
          `google: esito non registrato per ${account.email}: ${errText(inner)} (errore originale: ${errText(err)})`,
        );
      }
    }
  }

  return stats;
}

export interface StartGooglePollerOptions extends Omit<GooglePollerDeps, "signal"> {
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio `setInterval`. `intervalMinutes ≤ 0` non avvia
 * NIENTE — nessun timer, nessuna query — ed è il rollback documentato della
 * feature. Guard `running` anti-rientro: un giro lento (molte caselle, molti
 * messaggi) non si sovrappone al successivo. Stop sull'AbortSignal; la funzione
 * tornata è uno stop idempotente.
 */
export function startGooglePoller(opts: StartGooglePollerOptions): () => void {
  const logger = opts.logger ?? defaultLogger;
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  const { signal, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const stats = await pollGoogleOnce({ ...deps, signal });
      if (stats.accounts > 0 || stats.ingested > 0 || stats.pruned > 0) {
        logger.info(
          `google: tick ${stats.accounts} casella/e, ${stats.ingested} messaggi ingeriti, ` +
            `${stats.classified} classificati, ${stats.ignoredMessages} ignorati, ` +
            `${stats.failedMessages} falliti, ${stats.calendarEvents} eventi ` +
            `(${stats.calendarReady} da proporre, ${stats.calendarCancelled} cancellati), ` +
            `${stats.proposed} proposte pubblicate, ` +
            `${stats.disabled} disabilitate, ${stats.pruned} potati`,
        );
      }
    } catch (err) {
      // Difesa finale: pollGoogleOnce già non lancia.
      logger.error(`google: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMinutes * 60_000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
