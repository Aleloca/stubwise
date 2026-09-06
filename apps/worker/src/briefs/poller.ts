import { projectBriefs, projects, type Db } from "@stubwise/db";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { AgentRunner } from "../agent/runner.js";
import { runAgentText } from "../agent/text.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";
import { getContentLanguage } from "../settings.js";
import { collectBriefInput, type BriefPeriod } from "./input.js";
import { buildBriefPrompt, parseBriefOutput } from "./prompt.js";

/**
 * POLLER DEL BRIEF SETTIMANALE (fase 5).
 *
 * Task SEPARATO dal loop dei job, sul modello del daily report e del pulse: un
 * `setInterval` proprio, `now` iniettabile, best-effort per progetto,
 * `intervalMinutes ≤ 0` = spento (ed è il rollback innocuo della feature —
 * `BRIEF_POLL_MINUTES=0` e nessun brief nasce più, senza toccare schema né
 * immagini).
 *
 * COSA FA UN TICK, in ordine:
 *  1. **recovery degli orfani**: un brief `running` la cui `last_activity_at` è
 *     più vecchia di `staleMinutes` è di un worker morto a metà generazione;
 *     torna `queued` (o `failed` se ha esaurito i tentativi). Gira SEMPRE, anche
 *     fuori dalla finestra: altrimenti un orfano del lunedì resterebbe fermo una
 *     settimana intera. È la lezione di `doc_generations` e dei `plugin_jobs`.
 *  2. **accodamento** dei brief della settimana appena chiusa, ma SOLO dentro la
 *     finestra ({@link isInBriefWindow}) e solo per i progetti con
 *     `weekly_brief_enabled`. L'insert è `onConflictDoNothing` sull'unique
 *     `(project_id, period_start)`: due tick concorrenti non fanno due brief.
 *  3. **generazione** di tutti i brief `queued`, dentro o fuori dalla finestra.
 *     Fuori dalla finestra la fase 2 non accoda nulla, ma la 3 gira lo stesso:
 *     è così che la rigenerazione manuale (`POST /briefs/generate`, Task 12)
 *     parte al tick successivo invece di aspettare lunedì.
 *
 * IL CLAIM È GUARDATO (`queued → running` con il `WHERE` sullo stato): due
 * processi che vedono la stessa riga si serializzano sul lock e il secondo non
 * trova più `queued`. È lo stesso schema del `parkForPlanApproval` e della
 * cadenza del pulse.
 *
 * PROVIDER ASSENTE ≠ FALLIMENTO. Come per il report giornaliero, un'istanza
 * senza credenziali AI non deve accumulare righe `failed`: il brief si chiude
 * `done` con `summary` NULL. Un run che invece parte e va male (exit ≠ 0,
 * output vuoto, timeout, spawn) è un fallimento vero e vale un tentativo.
 */

/** Tentativi massimi prima di dichiarare `failed` un brief. */
export const BRIEF_MAX_ATTEMPTS = 3;

/**
 * Minuti dopo i quali un brief `running` è considerato ORFANO. Non è una env:
 * un run del brief è UN run di solo testo, e il suo tetto vero è
 * `agentTimeoutMs`; mezz'ora è già il doppio abbondante del caso peggiore, e un
 * valore configurabile in più sarebbe una manopola che nessuno saprebbe girare.
 */
export const DEFAULT_BRIEF_STALE_MINUTES = 30;

/** Turni massimi del run: il brief è un solo testo, non un'indagine. */
const BRIEF_MAX_TURNS = 3;

/** Log del poller: minimale come gli altri task del worker (console). */
export interface BriefLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultLogger: BriefLogger = {
  info: (msg) => console.error(`[stubwise-worker] ${msg}`),
  error: (msg) => console.error(`[stubwise-worker] ${msg}`),
};

/** La finestra settimanale d'invio: un giorno e un'ora, in un fuso. */
export interface BriefWindow {
  /** Fuso IANA. È `PULSE_TIMEZONE`: l'istanza ne ha UNO solo. */
  timezone: string;
  /** Giorno ISO, 1 = lunedì … 7 = domenica. */
  weekday: number;
  /** Ora locale d'inizio della finestra, 0..23. La finestra è `[hour, hour+1)`. */
  hour: number;
}

/**
 * Parti locali di un istante. `en-US`/`en-CA` come locale sono un DATO INTERNO
 * (i nomi dei giorni si confrontano con una tabella, la data si parsa): il
 * locale di default del processo cambierebbe entrambi. `hourCycle: "h23"` è
 * l'unica forma che garantisce `00` a mezzanotte.
 */
function localParts(now: Date, timezone: string): { hour: number; weekday: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hourText = parts.find((p) => p.type === "hour")?.value ?? "";
  const weekdayText = parts.find((p) => p.type === "weekday")?.value ?? "";
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hour = Number.parseInt(hourText, 10) % 24;
  return {
    hour: Number.isNaN(hour) ? -1 : hour,
    weekday: ISO_WEEKDAY[weekdayText] ?? -1,
    date,
  };
}

/** Nomi brevi `en-US` → giorno ISO (1 = lunedì, 7 = domenica). */
const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * `now` cade nella finestra d'invio settimanale?
 *
 * @throws RangeError se il fuso non è valido — come `isInSendWindow` del pulse,
 *   e per la stessa ragione: un fuso sbagliato manderebbe i brief nel giorno
 *   sbagliato per sempre, in silenzio. La config lo valida all'avvio (è la
 *   stessa `PULSE_TIMEZONE`), questo è il secondo muro.
 */
export function isInBriefWindow(now: Date, window: BriefWindow): boolean {
  const { hour, weekday } = localParts(now, window.timezone);
  return weekday === window.weekday && hour === window.hour;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Il PERIODO del brief: i sette giorni di calendario che finiscono IERI, nel
 * fuso dell'istanza.
 *
 * Non "la settimana ISO" e non "da lunedì a domenica": il periodo si aggancia al
 * giorno d'invio, così chi sposta `BRIEF_WEEKDAY` al venerdì ottiene la
 * settimana venerdì→giovedì senza altre configurazioni. Ieri e non oggi perché
 * il giorno in corso è incompleto — e perché il report giornaliero di oggi non
 * esiste ancora: racconterebbe una giornata che nessuno ha ancora riassunto.
 */
export function previousWeekPeriod(now: Date, timezone: string): BriefPeriod {
  const today = localParts(now, timezone).date;
  // Aritmetica sui giorni di calendario a mezzanotte UTC: qui la data è già
  // stata portata nel fuso giusto, quindi non c'è più nessun fuso in gioco.
  const end = new Date(`${today}T00:00:00.000Z`).getTime() - DAY_MS;
  const start = end - 6 * DAY_MS;
  return {
    periodStart: new Date(start).toISOString().slice(0, 10),
    periodEnd: new Date(end).toISOString().slice(0, 10),
  };
}

export interface BriefPollerDeps {
  db: Db;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare i segreti dei provider AI. */
  encryptionKey: Buffer;
  /** PUBLIC_URL dell'istanza (senza slash finale), per il link della notifica. */
  publicUrl: string;
  window: BriefWindow;
  /** Timeout complessivo del run del brief. */
  agentTimeoutMs: number;
  /** Modello del run (omesso = default del CLI). */
  model?: string;
  /** Minuti dopo i quali un `running` è considerato orfano. */
  staleMinutes: number;
  /** "adesso" iniettabile: finestra e periodo si testano solo così. */
  now?: () => Date;
  logger?: BriefLogger;
  /** Risolutore di UN provider AI per id (iniettabile nei test). */
  loadProviderByIdFn?: typeof loadProviderById;
  /** Caricatore della catena di provider AI (iniettabile nei test). */
  loadProviderChainFn?: typeof loadProviderChain;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Il provider AI del progetto: pinnato (SOLO quello) oppure `chain[0]`.
 * `undefined` = nessuna credenziale utilizzabile → brief `done` senza testo.
 * Identico a quello del report giornaliero, e per la stessa ragione.
 */
async function resolveProvider(
  deps: BriefPollerDeps,
  aiProviderId: string | null,
): Promise<ResolvedProvider | undefined> {
  if (aiProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    return (await loadById(deps.db, deps.encryptionKey, aiProviderId)) ?? undefined;
  }
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  return chain[0];
}

/** Un brief da generare, con quel che serve senza tornare a interrogare. */
interface ClaimableBrief {
  id: string;
  projectId: string;
  projectName: string;
  aiProviderId: string | null;
  periodStart: string;
  periodEnd: string;
  attempts: number;
}

/**
 * (1) RECOVERY DEGLI ORFANI. Best-effort e in due UPDATE distinti, perché le
 * due sorti sono diverse: chi ha ancora tentativi torna in coda, chi li ha
 * finiti muore. Un crash del worker fra i due lascia una riga `queued` con
 * `attempts` al massimo, che il claim scarta comunque: nessuno stato inerte.
 */
async function recoverStaleBriefs(deps: BriefPollerDeps, now: Date, logger: BriefLogger): Promise<void> {
  const cutoff = new Date(now.getTime() - deps.staleMinutes * 60_000);
  try {
    await deps.db
      .update(projectBriefs)
      .set({ status: "failed", error: "worker crash o tick interrotto durante la generazione" })
      .where(
        and(
          eq(projectBriefs.status, "running"),
          lt(projectBriefs.lastActivityAt, cutoff),
          sql`${projectBriefs.attempts} >= ${BRIEF_MAX_ATTEMPTS}`,
        ),
      );
    await deps.db
      .update(projectBriefs)
      .set({ status: "queued" })
      .where(
        and(
          eq(projectBriefs.status, "running"),
          lt(projectBriefs.lastActivityAt, cutoff),
          sql`${projectBriefs.attempts} < ${BRIEF_MAX_ATTEMPTS}`,
        ),
      );
  } catch (err) {
    logger.error(`brief: recovery degli orfani fallita: ${errText(err)}`);
  }
}

/**
 * (2) ACCODAMENTO della settimana appena chiusa per ogni progetto abilitato.
 * L'unique `(project_id, period_start)` + `onConflictDoNothing` è il gate di
 * idempotenza: un brief già esistente (in qualunque stato) non viene rifatto,
 * e uno `failed` NON si riaccoda da solo — per quello c'è la rigenerazione
 * manuale, che è una decisione umana.
 */
async function enqueueDueBriefs(deps: BriefPollerDeps, now: Date, logger: BriefLogger): Promise<void> {
  const period = previousWeekPeriod(now, deps.window.timezone);
  try {
    const enabled = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.weeklyBriefEnabled, true));
    for (const project of enabled) {
      await deps.db
        .insert(projectBriefs)
        .values({
          projectId: project.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          status: "queued",
        })
        .onConflictDoNothing();
    }
  } catch (err) {
    logger.error(`brief: accodamento della settimana ${period.periodStart} fallito: ${errText(err)}`);
  }
}

/**
 * Claim GUARDATO di un brief: `queued → running`, `attempts + 1`, heartbeat.
 * Ritorna false se qualcun altro l'ha preso nel frattempo o se i tentativi sono
 * esauriti.
 */
async function claimBrief(deps: BriefPollerDeps, briefId: string, now: Date): Promise<boolean> {
  const claimed = await deps.db
    .update(projectBriefs)
    .set({
      status: "running",
      attempts: sql`${projectBriefs.attempts} + 1`,
      lastActivityAt: now,
      error: null,
    })
    .where(
      and(
        eq(projectBriefs.id, briefId),
        eq(projectBriefs.status, "queued"),
        sql`${projectBriefs.attempts} < ${BRIEF_MAX_ATTEMPTS}`,
      ),
    )
    .returning({ id: projectBriefs.id });
  return claimed.length > 0;
}

/** Esito di un tentativo di generazione, per decidere come chiudere la riga. */
type GenerationOutcome =
  | { ok: true; summary: string | null; sections: Record<string, string> | null }
  | { ok: false; error: string };

/**
 * Genera UN brief: input → prompt → run → parse. Non tocca il database se non
 * per leggere: la scrittura dell'esito è del chiamante, che sa anche contare i
 * tentativi.
 */
async function generateBrief(deps: BriefPollerDeps, brief: ClaimableBrief): Promise<GenerationOutcome> {
  const provider = await resolveProvider(deps, brief.aiProviderId);
  if (!provider) {
    // Istanza senza credenziali: il brief esiste, semplicemente non ha testo.
    // Come il report giornaliero, NON è un fallimento da ritentare.
    return { ok: true, summary: null, sections: null };
  }

  const lang = await getContentLanguage(deps.db);
  const input = await collectBriefInput(
    deps.db,
    brief.projectId,
    { periodStart: brief.periodStart, periodEnd: brief.periodEnd },
    brief.projectName,
  );

  let raw: string | null;
  try {
    raw = await runAgentText(deps.runner, {
      prompt: buildBriefPrompt(lang, input),
      timeoutMs: deps.agentTimeoutMs,
      maxTurns: BRIEF_MAX_TURNS,
      provider,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
    });
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  if (raw === null) return { ok: false, error: "il run dell'agente non ha prodotto testo" };

  const parsed = parseBriefOutput(lang, raw);
  if (parsed === null) return { ok: false, error: "output dell'agente vuoto" };
  return { ok: true, summary: parsed.summary, sections: parsed.sections };
}

/** Chiude la riga dopo un tentativo fallito: in coda, o `failed` se esaurita. */
async function failBrief(deps: BriefPollerDeps, brief: ClaimableBrief, now: Date, error: string): Promise<void> {
  // `attempts` in riga è quello PRIMA del claim: il claim l'ha già incrementato.
  const spent = brief.attempts + 1 >= BRIEF_MAX_ATTEMPTS;
  await deps.db
    .update(projectBriefs)
    .set({
      status: spent ? "failed" : "queued",
      error,
      lastActivityAt: now,
      ...(spent ? { finishedAt: now } : {}),
    })
    .where(eq(projectBriefs.id, brief.id));
}

/**
 * Esegue UN tick. Non lancia mai: ogni brief è isolato in try/catch e l'intero
 * giro a sua volta, come tutti i poller del worker.
 *
 * @returns quanti brief sono stati portati a `done` in questo tick.
 */
export async function pollBriefsOnce(deps: BriefPollerDeps): Promise<number> {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now?.() ?? new Date();

  await recoverStaleBriefs(deps, now, logger);

  // La finestra è il filtro più economico e vale per tutti i progetti insieme;
  // un fuso invalido sfuggito alla config è rumoroso, non silenzioso, e NON
  // impedisce di lavorare i brief già in coda.
  let inWindow = false;
  try {
    inWindow = isInBriefWindow(now, deps.window);
  } catch (err) {
    logger.error(`brief: finestra settimanale non calcolabile: ${errText(err)}`);
  }
  if (inWindow) await enqueueDueBriefs(deps, now, logger);

  let queued: ClaimableBrief[];
  try {
    queued = await deps.db
      .select({
        id: projectBriefs.id,
        projectId: projectBriefs.projectId,
        projectName: projects.name,
        aiProviderId: projects.aiProviderId,
        periodStart: projectBriefs.periodStart,
        periodEnd: projectBriefs.periodEnd,
        attempts: projectBriefs.attempts,
      })
      .from(projectBriefs)
      .innerJoin(projects, eq(projects.id, projectBriefs.projectId))
      .where(
        and(
          eq(projectBriefs.status, "queued"),
          sql`${projectBriefs.attempts} < ${BRIEF_MAX_ATTEMPTS}`,
        ),
      );
  } catch (err) {
    logger.error(`brief: selezione dei brief in coda fallita: ${errText(err)}`);
    return 0;
  }

  let done = 0;
  for (const brief of queued) {
    try {
      if (!(await claimBrief(deps, brief.id, now))) continue;
      const outcome = await generateBrief(deps, brief);
      if (!outcome.ok) {
        await failBrief(deps, brief, now, outcome.error);
        logger.error(`brief: generazione del progetto ${brief.projectId} fallita: ${outcome.error}`);
        continue;
      }
      await deps.db
        .update(projectBriefs)
        .set({
          status: "done",
          summary: outcome.summary,
          sections: outcome.sections,
          error: null,
          lastActivityAt: now,
          finishedAt: now,
        })
        .where(eq(projectBriefs.id, brief.id));
      done++;
    } catch (err) {
      // Best-effort: un brief che esplode non ferma gli altri. La riga resta
      // `running` e il recovery degli orfani la riprende al tick giusto.
      logger.error(`brief: progetto ${brief.projectId} saltato: ${errText(err)}`);
    }
  }
  return done;
}

export interface StartBriefPollerOptions extends BriefPollerDeps {
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio `setInterval`. `intervalMinutes ≤ 0` non avvia
 * NIENTE — nessun timer, nessuna query — ed è il rollback documentato della
 * feature. Lo stop avviene sull'AbortSignal del worker; la funzione tornata è
 * uno stop idempotente.
 */
export function startBriefPoller(opts: StartBriefPollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  const { intervalMinutes, signal, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Un giro può durare più dell'intervallo (un run dell'agente per progetto):
    // niente sovrapposizioni.
    if (running) return;
    running = true;
    try {
      await pollBriefsOnce(deps);
    } catch (err) {
      // Difesa finale: pollBriefsOnce già non lancia.
      console.error(`[stubwise-worker] brief: tick fallito: ${errText(err)}`);
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
