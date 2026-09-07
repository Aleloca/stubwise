import { emailMessages, googleAccounts, projectEmailRoutes, type Db } from "@stubwise/db";
import {
  extractText,
  getMessageFull,
  getMessageMetadata,
  GoogleApiError,
  listHistory,
  listMessages,
  refreshAccessToken,
  type GmailMessage,
} from "@stubwise/google";
import {
  loadGoogleAccountCredentials,
  type GoogleAccountCredentials,
} from "@stubwise/google/credentials";
import { matchRoutes, type EmailRoute } from "@stubwise/notifications";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AgentRunner } from "../agent/runner.js";
import type { loadProviderChain } from "../providers/chain.js";
import {
  classifyNewMessages,
  DEFAULT_CLASSIFY_MAX_PER_TICK,
  type ClassifyBatchStats,
} from "./classify.js";
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
  TERMINAL_EMAIL_STATUSES,
  type GoogleDisabledReason,
} from "./sync.js";

/**
 * POLLER DELLE CASELLE GOOGLE (fase 6): task SEPARATO dal loop dei job, sul
 * proprio intervallo (`GMAIL_POLL_MINUTES`, default 5, 0 = spento).
 *
 * ## Il tick, in tre fasi — e una non è ancora qui
 *
 * Il giro di UNA casella è diviso in fasi indipendenti, ognuna con il suo
 * innesto, dentro {@link runAccountTick}:
 *
 *  1. **Gmail** (questo task): sincronizzazione incrementale e ingestione dei
 *     soli messaggi in perimetro → {@link syncGmail}.
 *  2. **Classificazione** (Task 8): i messaggi `new` di questa casella passano
 *     dal modello e diventano proposte → {@link classifyNewMessages}.
 *  3. **Calendar** (Task 9): eventi del calendario `primary` → proposte di
 *     milestone. Stesso punto d'innesto, subito dopo.
 *
 * Le tre fasi condividono UN access token e UNA riga di credenziali
 * ({@link AccountContext}), ottenuti una volta sola all'inizio del giro: è la
 * ragione per cui il refresh sta in `runAccountTick` e non dentro `syncGmail`.
 * Condividono anche il gestore d'errore: un `invalid_grant` sollevato dalla
 * fase 3 disabilita la casella esattamente come uno della fase 1.
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

/** Caricamento delle credenziali di una casella (default: quello di `@stubwise/google`). */
export type LoadCredentialsFn = typeof loadGoogleAccountCredentials;

export interface GooglePollerDeps {
  db: Db;
  /** La stessa `ENCRYPTION_KEY` del server: decifra refresh token e client secret. */
  encryptionKey: Buffer;
  logger?: GoogleLogger;
  /** Client Google iniettabile nei test. Default: rete vera. */
  gmail?: GmailClient;
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
  /** Caricatore della catena di provider AI (iniettabile nei test). */
  loadProviderChainFn?: typeof loadProviderChain;
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
}

/** Contesto condiviso dalle tre fasi del giro di una casella. */
interface AccountContext {
  credentials: GoogleAccountCredentials;
  accessToken: string;
  /** Le regole di TUTTI i progetti, caricate una volta per tick. */
  routes: EmailRoute[];
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
 * Chiude un giro RIUSCITO: cursore nuovo, contatore azzerato, prossimo giro
 * all'intervallo.
 *
 * Il cursore si tocca in due casi e in nessun altro: c'è un `historyId` nuovo
 * (lo si scrive), oppure il resync ha appena dimostrato che quello vecchio è
 * SCADUTO e non ne ha prodotto uno nuovo (lo si azzera). Il secondo caso non è
 * cosmetico: lasciando lì un cursore che Gmail rifiuta, OGNI tick successivo
 * pagherebbe un 404 prima di ricadere sulla query — per sempre.
 */
async function applySuccess(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  cursor: { historyId: string | null; clearCursor: boolean },
): Promise<void> {
  const intervalSeconds = Math.max(1, Math.round(deps.intervalMinutes * 60));
  await deps.db
    .update(googleAccounts)
    .set({
      ...(cursor.historyId
        ? { gmailHistoryId: cursor.historyId }
        : cursor.clearCursor
          ? { gmailHistoryId: null }
          : {}),
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
      return { ids: ids.slice(0, GMAIL_RESYNC_MAX_MESSAGES), historyId, resynced: false };
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
  return { ids: ids.slice(0, GMAIL_RESYNC_MAX_MESSAGES), historyId: null, resynced: true };
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
 *  3. **routing sui soli metadati** — fuori perimetro qui significa nessun
 *     `messages.get full` e nessuna riga scritta. Una casella rumorosa costa
 *     quindi una `metadata` per messaggio, non un corpo per messaggio.
 *
 * Il secondo `matchRoutes` — quello col testo — non decide più se scaricare
 * (il corpo è già in mano) ma può risolvere un progetto che sui soli metadati
 * era ambiguo, perché una keyword del corpo aggiunge un match.
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
  // dopo una sincronizzazione completa.
  let seenHistoryId: string | null = null;
  for (const id of ids) {
    if (deps.signal?.aborted) break;

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

    const preFilter = matchRoutes(messageToRouting(metadata), ctx.routes);
    if (!preFilter.inScope) continue;

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
          now: now(),
        }),
      )
      // L'unique `(account_id, gmail_message_id)` è l'idempotenza del poller:
      // rileggere la stessa history due volte non duplica niente.
      .onConflictDoNothing()
      .returning({ id: emailMessages.id });
    if (inserted.length > 0) ingested += 1;
  }

  const historyId = batch.historyId ?? seenHistoryId;
  return { ingested, historyId, clearCursor: batch.resynced && historyId === null };
}

/** Cosa ha prodotto il giro di UNA casella (null = giro saltato). */
interface AccountTickResult {
  ingested: number;
  historyId: string | null;
  clearCursor: boolean;
  classify: ClassifyBatchStats;
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

/**
 * Il giro di UNA casella: credenziali → access token → le fasi.
 *
 * ⚠️ **Punto d'innesto della fase 3.** La fase mancante va QUI, dopo la
 * classificazione e dentro lo stesso try del chiamante, così condivide `ctx`
 * (credenziali + access token già ottenuti) e il gestore d'errore (un fatale
 * sollevato da lei disabilita la casella come uno di Gmail):
 *
 *  - **Task 9** — sincronizzazione del calendario `primary` da
 *    `ctx.credentials.calendarSyncToken`, con lo stesso pre-filtro di routing.
 *
 * La fase 3, a differenza della 2, PARLA con Google: le sue eccezioni devono
 * salire fino a `applyFailure` (è il punto del gestore condiviso), quindi non
 * va avvolta in un catch come {@link runClassifyPhase}. Non tocca però il
 * cursore di Gmail: `applySuccess` resta l'ultima cosa che il chiamante fa.
 */
async function runAccountTick(
  deps: GooglePollerDeps,
  account: ClaimedAccount,
  routes: EmailRoute[],
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
  const ctx: AccountContext = { credentials, accessToken: tokens.accessToken, routes };

  // Fase 1 — Gmail.
  const gmailResult = await syncGmail(deps, ctx, account);

  // Fase 2 — classificazione dei messaggi `new` (compresi quelli rimasti
  // indietro dai giri precedenti, non solo quelli appena ingeriti).
  const classify = await runClassifyPhase(deps, account);

  // Task 9: qui va la FASE 3 (calendario `primary` → proposte di milestone).

  return { ...gmailResult, classify };
}

/**
 * RETENTION: i messaggi in stato terminale più vecchi di `retentionDays`.
 *
 * La soglia è su `updated_at` e non su `received_at` di proposito: conta da
 * quando la storia si è CHIUSA (proposta eseguita, ignorata, fallita), non da
 * quando l'email è arrivata — altrimenti un messaggio vecchio appena trattato
 * sparirebbe il giorno dopo, portandosi via la tracciabilità di ciò che si è
 * appena fatto. Gli stati non terminali non si toccano mai: `proposed` è una
 * card ancora aperta nella inbox di qualcuno.
 *
 * `retentionDays ≤ 0` = nessuna potatura (i messaggi restano per sempre).
 */
export async function pruneOldEmails(db: Db, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const deleted = await db
    .delete(emailMessages)
    .where(
      and(
        inArray(emailMessages.status, [...TERMINAL_EMAIL_STATUSES]),
        sql`${emailMessages.updatedAt} < now() - make_interval(days => ${Math.round(retentionDays)})`,
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

  for (const account of accounts) {
    if (deps.signal?.aborted) break;
    try {
      const result = await runAccountTick(deps, account, routes);
      if (!result) continue;
      stats.ingested += result.ingested;
      stats.classified += result.classify.classified;
      stats.ignoredMessages += result.classify.ignored;
      stats.failedMessages += result.classify.failed;
      await applySuccess(deps, account, result);
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
            `${stats.failedMessages} falliti, ${stats.disabled} disabilitate, ${stats.pruned} potati`,
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
