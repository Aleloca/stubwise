import { notificationDeliveries, notifications, projects, users, type Db } from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import {
  publishNotification,
  type ProjectPulseEvent,
  type PulseProposal,
  type PulseUrgency,
} from "@stubwise/notifications";
import { and, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isProjectIdle, listCandidates, type PulseCandidate } from "./signals.js";

/**
 * PULSE PROATTIVO: il poller che fa esistere i pulse.
 *
 * Task SEPARATO dal loop dei job (stesso impianto di `../reports/daily-report-poller.ts`
 * e degli altri poller): un `setInterval` proprio, `now` iniettabile, best-effort
 * per progetto, `intervalMinutes ≤ 0` = spento. A differenza degli altri NON usa
 * il serializer per-progetto e non tocca i mirror: qui non gira nessun agente e
 * non si scrive su disco — è tutto SQL, e il tick di un progetto vivo costa una
 * query sola.
 *
 * COSA FA, in ordine, e perché quest'ordine:
 *  1. **la finestra oraria** ({@link isInSendWindow}). È il filtro più economico
 *     — nessuna query — e l'unico che vale per tutti i progetti insieme: fuori
 *     dalla finestra il tick esce prima di guardare il database. È anche ciò che
 *     rende il pulse uno "standup" e non un allarme: arriva in un'ora d'ufficio
 *     scelta dall'istanza, non appena un progetto smette di lavorare.
 *  2. i progetti con `pulse_enabled AND backlog_enabled`. Il secondo non è
 *     ridondante: senza backlog non ci sono voci da proporre, e il toggle del
 *     pulse da solo non deve poter accendere un ping vuoto.
 *  3. la **cadenza** letta (`pulse_last_sent_at`), che è solo un pre-filtro: chi
 *     decide davvero è l'UPDATE guardato del punto 6.
 *  4. i **segnali** ({@link isProjectIdle}): se il progetto sta lavorando — o sta
 *     aspettando una decisione umana — il pulse tace.
 *  5. i **candidati** ({@link listCandidates}) e il {@link rankCandidates}: senza
 *     voci proponibili non c'è niente da dire, e si esce senza consumare la
 *     cadenza (un ping mancato per backlog vuoto non deve far aspettare tre
 *     giorni al progetto che nel frattempo si riempie).
 *  6. la **transazione**: UPDATE guardato della cadenza → chiusura dei pulse
 *     precedenti → `publishNotification`. Le tre cose stanno insieme perché
 *     nessuna ha senso senza le altre: un `pulse_last_sent_at` avanzato senza
 *     notifica salterebbe un giro; una notifica senza `pulse_last_sent_at`
 *     avanzato la rimanderebbe al tick dopo.
 *
 * IL PULSE NON GUARDA SE C'È GIÀ UN PULSE APERTO, ed è deliberato. Un pulse
 * chiuso "a vuoto" (il "Procedi" del server claima le copie PRIMA di convertire:
 * se il convert esplode per un errore infrastrutturale il pulse resta chiuso
 * senza che sia successo nulla) torna così da solo al giro di cadenza
 * successivo, senza nessun meccanismo di recovery dedicato.
 */

/** Log del poller: minimale, come gli altri task del worker (console). */
export interface PulseLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultLogger: PulseLogger = {
  info: (msg) => console.error(`[stubwise-worker] ${msg}`),
  error: (msg) => console.error(`[stubwise-worker] ${msg}`),
};

/** Finestra d'invio dell'istanza: un'ora locale, in un fuso, in certi giorni. */
export interface SendWindow {
  /** Fuso IANA (es. `Europe/Rome`). Già validato dalla config. */
  timezone: string;
  /** Ora locale d'inizio della finestra, 0..23. La finestra è `[hour, hour+1)`. */
  hour: number;
  /** Se true il pulse tace il sabato e la domenica. */
  weekdaysOnly: boolean;
}

/** Al massimo tre proposte: una lista più lunga smette di essere una proposta. */
export const MAX_PROPOSALS = 3;

/**
 * Formattatore dell'ora e del giorno LOCALI. `Intl` è l'unico posto del sistema
 * che sa dei fusi (tutto il resto è UTC), e `hourCycle: "h23"` è l'unica forma
 * che garantisce `00` a mezzanotte: `hour12: false` su alcune versioni di ICU
 * rende `24`, che romperebbe la finestra dell'ora 0.
 *
 * Il locale è fissato a `en-US` perché i nomi dei giorni sono un DATO INTERNO
 * (si confrontano con `Sat`/`Sun`), non un testo mostrato: il locale di default
 * del processo cambierebbe quei nomi.
 */
function localParts(now: Date, timezone: string): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hourText = parts.find((p) => p.type === "hour")?.value ?? "";
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  // `% 24` neutralizza il `24` della mezzanotte delle ICU vecchie.
  const hour = Number.parseInt(hourText, 10) % 24;
  return { hour: Number.isNaN(hour) ? -1 : hour, weekday };
}

/** Giorni in cui il pulse tace quando `weekdaysOnly` è acceso. */
const WEEKEND = new Set(["Sat", "Sun"]);

/**
 * `now` cade nella finestra d'invio? La finestra è l'ORA locale intera
 * `[hour, hour+1)`: un tick ogni 15 minuti la incontra quattro volte, e
 * l'UPDATE guardato della cadenza fa sì che solo il primo mandi qualcosa.
 *
 * Fuori da qui il pulse non esiste: è così che nascono le quiet hours, senza
 * nessuna configurazione in più.
 *
 * @throws RangeError se il fuso non è valido. Non degrada su UTC di proposito:
 *   un fuso sbagliato in produzione manderebbe i pulse all'ora sbagliata per
 *   sempre, in silenzio. La config lo valida all'avvio, questo è il secondo muro.
 */
export function isInSendWindow(now: Date, window: SendWindow): boolean {
  const { hour, weekday } = localParts(now, window.timezone);
  if (window.weekdaysOnly && WEEKEND.has(weekday)) return false;
  return hour === window.hour;
}

/** Peso dell'urgenza nell'ordinamento: più basso = più su. */
const URGENCY_RANK: Record<PulseUrgency, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Urgenza assente = `medium`: una voce senza stima non è né urgente né ultima. */
const DEFAULT_URGENCY_RANK = URGENCY_RANK.medium;

/** Effort assente = 3, il centro della scala 1–5 (stessa logica dell'urgenza). */
const DEFAULT_EFFORT = 3;

/**
 * ORDINE DELLE PROPOSTE, deterministico e senza AI: chi guarda la notifica deve
 * poter capire *perché* quelle tre e in quell'ordine, e la stessa lista di voci
 * deve produrre sempre lo stesso pulse.
 *
 * I criteri, in ordine di precedenza:
 *  1. **urgenza** — è l'unica dimensione che dice "questo conta di più";
 *  2. **effort crescente** — a parità di urgenza si propone ciò che si può
 *     davvero finire: il pulse serve a rimettere in moto un progetto fermo,
 *     non a farlo ripartire da un lavoro di due settimane;
 *  3. **`ready`** — qualcuno ha già detto a mano "questa è pronta";
 *  4. **analisi tecnica presente** — il deep dive l'ha già istruita, quindi la
 *     pianificazione parte da più avanti;
 *  5. **`createdAt` crescente** — a parità di tutto vince la più vecchia, così
 *     una voce non resta in fondo alla lista per sempre.
 *
 * Non muta l'array in ingresso.
 */
export function rankCandidates(items: PulseCandidate[]): PulseCandidate[] {
  return [...items].sort((a, b) => {
    const urgency =
      (a.urgency ? URGENCY_RANK[a.urgency] : DEFAULT_URGENCY_RANK) -
      (b.urgency ? URGENCY_RANK[b.urgency] : DEFAULT_URGENCY_RANK);
    if (urgency !== 0) return urgency;

    const effort = (a.effort ?? DEFAULT_EFFORT) - (b.effort ?? DEFAULT_EFFORT);
    if (effort !== 0) return effort;

    const ready = Number(b.status === "ready") - Number(a.status === "ready");
    if (ready !== 0) return ready;

    const analysis = Number(b.hasAnalysis) - Number(a.hasAnalysis);
    if (analysis !== 0) return analysis;

    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * DA QUANTI GIORNI il progetto è fermo, e perché si misura così.
 *
 * La base è `ai_jobs.last_activity_at` — il heartbeat che il worker tocca a ogni
 * transizione e a ogni riga di log — sull'ultimo job di un ticket del progetto.
 * Delle tre candidate valutate è l'unica COERENTE con la frase che l'utente
 * legge: il pulse dice "nessun LAVORO in corso da N giorni", e il lavoro di
 * Stubwise sono i job dell'AI. `tickets.updated_at` conterebbe anche una
 * modifica di titolo o un cambio di assegnatario (attività umana, non lavoro);
 * `backlog_items.updated_at` conterebbe l'intake di un feedback arrivato dal
 * widget, cioè l'esatto contrario (una voce NUOVA da proporre farebbe risultare
 * il progetto "attivo"). E la si ha già in mano: è lo stesso join su `tickets`
 * che i segnali fanno comunque, non una query in più.
 *
 * Vale **0** quando nessun job è mai girato (progetto nuovo: non è "fermo da N
 * giorni", semplicemente non ha ancora cominciato) e quando la data è nel futuro
 * (orologi sfasati). Il catalogo i18n rende `idleDays` nella forma
 * `giorni di fermo: N` proprio perché 0 e 1 devono restare leggibili.
 */
export function idleDaysFrom(now: Date, lastActivityAt: Date | null): number {
  if (!lastActivityAt) return 0;
  const ms = now.getTime() - lastActivityAt.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/** Etichette dell'urgenza nel contesto dell'opzione (testo per un umano). */
const URGENCY_LABEL: Record<PulseUrgency, string> = {
  urgent: "urgente",
  high: "alta",
  medium: "media",
  low: "bassa",
};

/**
 * Il CONTESTO di una proposta: quel poco che spiega perché sta lì e in quella
 * posizione — le stesse dimensioni su cui il ranking l'ha ordinata.
 *
 * I pezzi mancanti si omettono invece di scrivere "urgenza —": una voce appena
 * nata non ha ancora né urgenza né effort, e tre trattini non dicono niente.
 * Senza nessun pezzo il contesto non c'è (il campo è opzionale).
 */
function proposalContext(candidate: PulseCandidate): string | undefined {
  const parts: string[] = [];
  if (candidate.urgency) parts.push(`urgenza ${URGENCY_LABEL[candidate.urgency]}`);
  if (candidate.effort !== null) parts.push(`effort ${candidate.effort}`);
  if (candidate.hasAnalysis) parts.push("analisi pronta");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export interface BuildPulseEventArgs {
  /** UUID di QUESTO pulse: l'ancora con cui il server ritrova tutte le copie. */
  pulseId: string;
  projectId: string;
  projectName: string;
  /** PUBLIC_URL dell'istanza (senza slash finale); vuoto = solo il path. */
  publicUrl: string;
  idleDays: number;
  /** Le proposte GIÀ ordinate e tagliate: l'ordine qui è l'ordine mostrato. */
  proposals: PulseCandidate[];
}

/**
 * Compone l'evento `project.pulse` nella forma della DOMANDA della fase 1, che è
 * ciò che permette a `QuestionPanel`, ai blocchi Slack e alla modal di
 * funzionare sul pulse senza una riga di codice in più.
 *
 * ⚠️ **`options[i]` DEVE descrivere `proposals[i]`**. L'indice che l'utente
 * clicca viaggia su `options` (è la lista che le superfici disegnano) e agisce su
 * `proposals` (è la lista che `proceedWithProposal` indicizza per trovare la
 * voce da convertire). Le due liste nascono qui, dallo stesso array e nello
 * stesso ordine, ed è l'unico punto in cui l'invariante può rompersi: un
 * disallineamento non darebbe nessun errore, farebbe partire la voce sbagliata.
 */
export function buildPulseEvent(args: BuildPulseEventArgs): ProjectPulseEvent {
  const base = args.publicUrl.replace(/\/+$/, "");
  const proposals: PulseProposal[] = args.proposals.map((candidate) => ({
    backlogItemId: candidate.id,
    title: candidate.title,
    urgency: candidate.urgency,
    effort: candidate.effort,
    hasAnalysis: candidate.hasAnalysis,
  }));

  return {
    kind: "project.pulse",
    pulseId: args.pulseId,
    projectName: args.projectName,
    // La pagina backlog FILTRATA sul progetto: `/backlog` è una lista globale,
    // il progetto è un parametro di ricerca (vedi `apps/web/src/routes/backlog`).
    projectUrl: `${base}/backlog?projectId=${args.projectId}`,
    idleDays: args.idleDays,
    // `giorni di fermo: N` e non "da N giorni": il testo non ha regole di
    // plurale (lo compone il worker, non il catalogo i18n), e "da 1 giorni"
    // sarebbe sbagliato esattamente quando il pulse è più tempestivo. È la stessa
    // convenzione della chiave `notify.pulse`.
    question: `Nessun lavoro in corso su ${args.projectName} (giorni di fermo: ${args.idleDays}). Da quale proposta partiamo?`,
    options: args.proposals.map((candidate) => {
      const consequence = proposalContext(candidate);
      return { label: candidate.title, ...(consequence ? { consequence } : {}) };
    }),
    // La prima del ranking è la consigliata: marcata nella UI, mai preselezionata.
    recommendedIndex: 0,
    allowFreeText: false,
    proposals,
  };
}

/** Durata della finestra d'invio: `[hour, hour+1)`, cioè un'ora. */
const SEND_WINDOW_MS = 60 * 60 * 1000;

/**
 * L'istante PRIMA del quale l'ultimo pulse deve essere caduto perché ne parta
 * uno nuovo: `now - everyDays` **più la durata della finestra**.
 *
 * L'ora di tolleranza non è un arrotondamento a caso: senza di essa la cadenza
 * sarebbe "ogni N × 24 ore al secondo", mentre il pulse può nascere solo dentro
 * una finestra di un'ora. Un pulse mandato alle 9:50 renderebbe "troppo presto"
 * ogni tick della finestra di N giorni dopo che cade prima delle 9:50 — cioè,
 * con un poller da 15', quasi tutta la finestra — e il ping slitterebbe al
 * giorno successivo. Con la tolleranza la cadenza si legge come è pensata:
 * *ogni N giorni, nella finestra del mattino*.
 *
 * Non apre la porta a due pulse nella stessa finestra: l'ultimo inviato sarebbe
 * `now` stesso, che non è mai < `now - N giorni + 1 ora` per N ≥ 1.
 */
function cadenceCutoff(now: Date, everyDays: number): Date {
  return new Date(now.getTime() - everyDays * 24 * 60 * 60 * 1000 + SEND_WINDOW_MS);
}

/** Firma della publish iniettabile (default: `publishNotification`). */
export type PublishFn = typeof publishNotification;

export interface PulsePollerDeps {
  db: Db;
  /** PUBLIC_URL dell'istanza, per il link al backlog nel payload. */
  publicUrl: string;
  sendWindow: SendWindow;
  /** Orologio iniettabile: finestra oraria e cadenza si testano solo così. */
  now?: () => Date;
  /** Publish iniettabile nei test. Default: `publishNotification`. */
  publish?: PublishFn;
  logger?: PulseLogger;
}

/** Progetto abilitato al pulse, con quel che serve a decidere se mandarlo. */
interface PulseProject {
  id: string;
  name: string;
  pulseEveryDays: number;
  pulseLastSentAt: Date | null;
}

/**
 * Esegue UN tick. Non lancia mai: ogni progetto è in try/catch isolato e
 * l'intero giro a sua volta, come tutti i poller del worker.
 *
 * @returns quanti pulse sono stati pubblicati (raggiungendo almeno una persona).
 */
export async function pollPulseOnce(deps: PulsePollerDeps): Promise<number> {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now?.() ?? new Date();

  // (1) Fuori finestra: si esce senza toccare il database. È il caso normale —
  // 23 ore su 24 — e deve costare zero.
  try {
    if (!isInSendWindow(now, deps.sendWindow)) return 0;
  } catch (err) {
    // Fuso invalido sfuggito alla config: rumoroso, non silenzioso.
    logger.error(`pulse: finestra oraria non calcolabile: ${errText(err)}`);
    return 0;
  }

  let enabled: PulseProject[];
  try {
    enabled = await deps.db
      .select({
        id: projects.id,
        name: projects.name,
        pulseEveryDays: projects.pulseEveryDays,
        pulseLastSentAt: projects.pulseLastSentAt,
      })
      .from(projects)
      .where(and(eq(projects.pulseEnabled, true), eq(projects.backlogEnabled, true)));
  } catch (err) {
    logger.error(`pulse: selezione dei progetti abilitati fallita: ${errText(err)}`);
    return 0;
  }

  let published = 0;
  for (const project of enabled) {
    try {
      if (await sendPulseForProject(deps, logger, project, now)) published++;
    } catch (err) {
      // Best-effort: un progetto che esplode non ferma gli altri.
      logger.error(`pulse: progetto ${project.id} saltato: ${errText(err)}`);
    }
  }
  return published;
}

/**
 * Il pulse di UN progetto. Ritorna true se una notifica è stata pubblicata (cioè
 * se ha raggiunto almeno una persona).
 */
async function sendPulseForProject(
  deps: PulsePollerDeps,
  logger: PulseLogger,
  project: PulseProject,
  now: Date,
): Promise<boolean> {
  // (3) Cadenza, pre-filtro. Il valore letto qui può essere vecchio di
  // millisecondi: a decidere è l'UPDATE guardato più sotto. Serve solo a non
  // pagare segnali e candidati per un progetto che ha appena ricevuto un pulse.
  const cutoff = cadenceCutoff(now, project.pulseEveryDays);
  if (project.pulseLastSentAt && project.pulseLastSentAt >= cutoff) return false;

  // (4) Segnali.
  const idleness = await isProjectIdle(deps.db, project.id);
  if (!idleness.idle) {
    logger.info(`pulse: progetto ${project.id} non fermo (${idleness.blocker ?? "assente"})`);
    return false;
  }

  // (5) Candidati e ranking. Zero proposte = niente ping, e la cadenza resta
  // intatta: un backlog vuoto oggi non deve far aspettare N giorni al progetto
  // che domani si riempie.
  const ranked = rankCandidates(await listCandidates(deps.db, project.id)).slice(0, MAX_PROPOSALS);
  if (ranked.length === 0) {
    logger.info(`pulse: progetto ${project.id} senza voci proponibili`);
    return false;
  }

  const pulseId = randomUUID();
  const idleDays = idleDaysFrom(now, idleness.lastJobActivityAt);
  const event = buildPulseEvent({
    pulseId,
    projectId: project.id,
    projectName: project.name,
    publicUrl: deps.publicUrl,
    idleDays,
    proposals: ranked,
  });
  const publish = deps.publish ?? publishNotification;

  // (6) La transazione: cadenza, sostituzione e pubblicazione insieme.
  const sent = await deps.db.transaction(async (tx) => {
    // UPDATE GUARDATO: il `WHERE` ripete la condizione di cadenza. Due tick
    // concorrenti (due worker, o un tick lento sovrapposto al successivo) si
    // serializzano sul lock di riga e il secondo RIVALUTA il `WHERE` sulla
    // versione aggiornata → nessuna riga → ha perso, ed esce senza pubblicare.
    // È qui, e solo qui, che si decide chi manda il pulse.
    const claimed = await tx
      .update(projects)
      .set({ pulseLastSentAt: now })
      .where(
        and(
          eq(projects.id, project.id),
          or(isNull(projects.pulseLastSentAt), lt(projects.pulseLastSentAt, cutoff)),
        ),
      )
      .returning({ id: projects.id });
    if (claimed.length === 0) return null;

    // SOSTITUZIONE: il pulse precedente dello stesso progetto è superato — le sue
    // proposte possono non essere nemmeno più le stesse. Si chiude senza attore
    // (`handled_by_user_id` null: non l'ha deciso nessuno, l'ha sostituito il
    // sistema). Anche le copie `snoozed`: un pulse rinviato che riemergesse dopo
    // essere stato sostituito sarebbe un invito a scegliere da una lista vecchia.
    const superseded = await tx
      .update(notifications)
      .set({ status: "handled", handledAt: now, handledByUserId: null, snoozedUntil: null })
      .where(
        and(
          eq(notifications.projectId, project.id),
          eq(notifications.kind, "project.pulse"),
          ne(notifications.status, "handled"),
        ),
      )
      .returning({ id: notifications.id, userId: notifications.userId });
    await enqueueReplacedNotes(tx, superseded);

    const { published } = await publish(tx, event, { projectId: project.id });
    return published;
  });

  if (sent === null) {
    logger.info(`pulse: progetto ${project.id} già servito da un altro tick`);
    return false;
  }
  logger.info(
    `pulse: progetto ${project.id} — ${ranked.length} proposte, ${sent} destinatari, fermo da ${idleDays} giorni (pulse ${pulseId})`,
  );
  return sent > 0;
}

/** Transazione o db: `publishNotification` accetta entrambi, e anche noi. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Accoda la riscrittura dei DM Slack dei pulse sostituiti: senza di essa un
 * messaggio superato resterebbe su Slack coi suoi bottoni, che promettono
 * un'azione ormai impossibile (la notifica è chiusa: il "Procedi" risponderebbe
 * `already_handled`).
 *
 * Stessa forma delle consegne accodate dal server (`slack_update` +
 * `{ note }` già localizzata per il destinatario): il poller dell'outbox le
 * consuma senza sapere chi le ha scritte, e chiude `skipped` quelle di chi non
 * ha un DM da aggiornare.
 */
async function enqueueReplacedNotes(
  tx: Tx,
  superseded: { id: string; userId: string }[],
): Promise<void> {
  if (superseded.length === 0) return;
  const langs = await tx
    .select({ id: users.id, language: users.language })
    .from(users)
    .where(inArray(users.id, [...new Set(superseded.map((row) => row.userId))]));
  const byUser = new Map<string, Language>(langs.map((row) => [row.id, row.language]));

  await tx.insert(notificationDeliveries).values(
    superseded.map((row) => ({
      notificationId: row.id,
      channel: "slack_update" as const,
      event: { note: t(byUser.get(row.userId) ?? "en", "notify.inbox.notePulseReplaced") },
    })),
  );
}

/** Messaggio d'errore leggibile (mirror degli altri poller). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StartPulsePollerOptions extends PulsePollerDeps {
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio `setInterval`, separato dal loop dei job. Lo
 * stop avviene sull'AbortSignal del worker. Ritorna una funzione di stop
 * idempotente. `intervalMinutes ≤ 0` = disabilitato.
 *
 * L'intervallo di default (15') è più corto della finestra (un'ora) di proposito:
 * la finestra deve essere incontrata anche se un tick salta.
 */
export function startPulsePoller(opts: StartPulsePollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  const { intervalMinutes, signal, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo.
    if (running) return;
    running = true;
    try {
      await pollPulseOnce(deps);
    } catch (err) {
      // Difesa finale (pollPulseOnce già non lancia): mai propagare.
      (deps.logger ?? defaultLogger).error(`pulse: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMinutes * 60_000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
