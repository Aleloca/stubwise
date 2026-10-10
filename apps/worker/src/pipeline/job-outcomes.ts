import {
  automationRules,
  comments,
  instanceSettings,
  recordTicketStatusChange,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { eq } from "drizzle-orm";
import type { AgentRunCancelledError, AgentRunner } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { appendLog, getJobLog, holdJob, writeFailureSummary } from "../queue.js";
import { aiJobSession, sessionOption } from "../sessions/owners.js";
import { generateFailureSummary } from "../summaries/failure-summary.js";
import { notify, type NotifyDeps } from "./notify.js";

/**
 * Esiti di un job che scrive codice — il fix e la correzione post-PR — che
 * devono restare IDENTICI fra le due pipeline: i tetti di spesa (pre-check e
 * percorso budget-held) e il fallimento notificato col riassunto «in breve».
 * Estratti da `runFix` senza cambiarne il comportamento.
 */

/**
 * Timeout di un run di riassunto «in breve» — del piano, del fallimento, della
 * correzione. Corto di proposito: è un run di solo testo, senza tool e senza
 * working tree, e sta DENTRO la finestra del job che lo chiede. Tenerlo breve
 * significa che un provider lento allunga quel job di due minuti al massimo,
 * invece di trattenerlo fino alla soglia di staleness.
 */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;

/** Contesto comune agli esiti di UN job. */
export interface JobOutcomeContext {
  db: Db;
  jobId: string;
  ticket: { id: string; number: number; title: string };
  projectName: string;
  lang: Language;
  /** URL del ticket per le notifiche (vedi ticketUrl). */
  url: string;
  notifyDeps: NotifyDeps;
  notifyRefs: { projectId: string; ticketId: string; jobId: string };
  /** Per il riassunto del fallimento. */
  runner: AgentRunner;
  provider?: ResolvedProvider;
  summariesEnabled?: boolean;
  summaryModel?: string;
  summaryTimeoutMs: number;
  /** Prefisso delle righe di log del job: `[fix]` o `[correction]`. */
  logPrefix: string;
  /**
   * Valori dei .env materializzati in TUTTI i repo del run, letti al momento
   * del fallimento (vuoto prima della materializzazione). Il riassunto legge il
   * log del job, che dopo la materializzazione può contenere output di
   * install/test: la sua sessione li oscura come ogni altro segmento (§5.5).
   */
  worktreeSecrets?: () => readonly string[];
}

/**
 * Notifica job.failed best-effort dopo il failJob (lo stato è già
 * committato), poi — SEMPRE DOPO, mai prima — il riassunto "in breve" del
 * fallimento (fase 7, Task 9): best-effort quanto la notifica, e capace di
 * girare per decine di secondi senza mai ritardarla, perché la notifica è
 * già stata pubblicata quando il run del riassunto comincia. Vedi il
 * docblock di `summaries/failure-summary.ts` per il perché del
 * disaccoppiamento dalla forma di `plan_summary`/`pr_summary`.
 */
export async function notifyJobFailed(ctx: JobOutcomeContext, error: string): Promise<void> {
  await notify(
    ctx.notifyDeps,
    ctx.db,
    {
      kind: "job.failed",
      ticketNumber: ctx.ticket.number,
      ticketTitle: ctx.ticket.title,
      projectName: ctx.projectName,
      error,
      ticketUrl: ctx.url,
    },
    ctx.notifyRefs,
  );
  try {
    const log = await getJobLog(ctx.db, ctx.jobId);
    const summary = await generateFailureSummary(
      {
        runner: ctx.runner,
        timeoutMs: ctx.summaryTimeoutMs,
        ...(ctx.summaryModel !== undefined ? { model: ctx.summaryModel } : {}),
        ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
        ...(ctx.summariesEnabled !== undefined ? { enabled: ctx.summariesEnabled } : {}),
        // Sessione del job (fix o correzione): solo col runner in streaming.
        ...(ctx.summariesEnabled !== false
          ? await sessionOption(ctx.runner, () =>
              aiJobSession(
                ctx.db,
                { id: ctx.jobId, ticketId: ctx.ticket.id },
                "failure_summary",
                [...(ctx.worktreeSecrets?.() ?? [])],
              ),
            )
          : {}),
      },
      { lang: ctx.lang, ticketTitle: ctx.ticket.title, error, log },
    );
    if (summary) await writeFailureSummary(ctx.db, ctx.jobId, summary);
  } catch {
    // Best-effort: un riassunto (o la sua scrittura) che fallisce non deve
    // mai propagare da qui — il fallimento è già registrato e notificato.
  }
}

/**
 * Percorso budget-held (Task 6): il job ha sforato un tetto di spesa e va
 * messo in pausa, NON fallito. Riusa la transizione holdJob (status-guarded),
 * lascia un commento AI che spiega lo sforamento e notifica job.budget_held.
 * Modellato sul gate auto-fix del triage (commento + holdJob + notify). Le
 * cifre nel commento sono arrotondate a 4 decimali per leggibilità; lo scope
 * è tradotto con le chiavi notify.scope* condivise con la notifica.
 *
 * Restituisce l'esito di `holdJob`: `false` = ownership persa (il job non era
 * più attivo). Il commento e la notifica partono comunque, come prima. */
export async function holdForBudget(
  ctx: JobOutcomeContext,
  scope: "ticket" | "monthly",
  limitUsd: number,
  spentUsd: number,
  /** Il template del commento: la correzione di una PR passa il suo (E5), il fix quello di sempre. */
  commentKey: "comment.budgetHeld" | "comment.correctionBudgetHeld" = "comment.budgetHeld",
): Promise<boolean> {
  const fmtUsd = (n: number): string => n.toFixed(4);
  const scopeLabel = t(ctx.lang, scope === "monthly" ? "notify.scopeMonthly" : "notify.scopeTicket");
  await ctx.db.transaction(async (tx) => {
    await tx.insert(comments).values({
      ticketId: ctx.ticket.id,
      authorType: "ai",
      body: t(ctx.lang, commentKey, {
        scope: scopeLabel,
        limit: fmtUsd(limitUsd),
        spent: fmtUsd(spentUsd),
      }),
    });
  });
  const held = await holdJob(ctx.db, ctx.jobId, {
    log: `${ctx.logPrefix} budget di costo superato (${scope}): spesi $${fmtUsd(spentUsd)} sul limite di $${fmtUsd(limitUsd)} → job in pausa (held), avvio manuale per forzare`,
    // "budget": tetto di spesa superato, decisione umana (il resume poller
    // dei limiti NON lo riaccoda).
    heldReason: "budget",
  });
  if (!held) {
    await appendLog(ctx.db, ctx.jobId, `${ctx.logPrefix} ownership persa dopo il hold per budget`);
  }
  await notify(
    ctx.notifyDeps,
    ctx.db,
    {
      kind: "job.budget_held",
      ticketNumber: ctx.ticket.number,
      ticketTitle: ctx.ticket.title,
      projectName: ctx.projectName,
      scope,
      limitUsd,
      spentUsd,
      ticketUrl: ctx.url,
    },
    ctx.notifyRefs,
  );
  return held;
}

/** Esito del pre-check dei tetti di spesa. */
export type BudgetCheck =
  | { kind: "held"; scope: "ticket" | "monthly"; limitUsd: number; spentUsd: number }
  | {
      kind: "ok";
      /** Tetto per ticket del tipo, per il check in-loop del self-repair. */
      maxCostUsd: number | null;
      /** Costo storico del ticket, base del check in-loop. */
      ticketCostBaseline: number;
    };

/**
 * Configurazione dei tetti di spesa (Task 6), caricata SOLO se il job non è
 * avviato manualmente: un avvio a mano (`manualTrigger`) scavalca entrambi i
 * controlli (un umano ha già deciso di spendere) e restituisce `ok` con
 * `maxCostUsd: null`/`ticketCostBaseline: 0`. `maxCostUsd` serve anche al check
 * in-loop del self-repair; `ticketCostBaseline` è il costo storico del ticket
 * (run già registrati), la base a cui il chiamante aggiunge la stima dei costi
 * del run corrente prima di ogni riparazione. I valori numeric di Postgres
 * arrivano come stringa: Number() li converte.
 */
export async function checkBudgetsBeforeRun(
  db: Db,
  input: {
    ticketId: string;
    ticketType: (typeof tickets.$inferSelect)["type"];
    manualTrigger: boolean;
    ticketCostUsdFn: (db: Db, ticketId: string) => Promise<number>;
    monthlyCostUsdFn: (db: Db) => Promise<number>;
  },
): Promise<BudgetCheck> {
  if (input.manualTrigger) return { kind: "ok", maxCostUsd: null, ticketCostBaseline: 0 };
  const [budgetRule] = await db
    .select({ maxCostUsd: automationRules.maxCostUsd })
    .from(automationRules)
    .where(eq(automationRules.type, input.ticketType));
  const maxCostUsd =
    budgetRule?.maxCostUsd != null && budgetRule.maxCostUsd !== ""
      ? Number(budgetRule.maxCostUsd)
      : null;
  const [settings] = await db
    .select({ monthlyBudgetUsd: instanceSettings.monthlyBudgetUsd })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  const monthlyBudgetUsd =
    settings?.monthlyBudgetUsd != null && settings.monthlyBudgetUsd !== ""
      ? Number(settings.monthlyBudgetUsd)
      : null;

  // PRE-FIX CHECK: prima di toccare il repo. Mensile prima del ticket: un
  // tetto d'istanza sforato blocca a prescindere dal singolo ticket.
  const monthlySpent = await input.monthlyCostUsdFn(db);
  if (monthlyBudgetUsd != null && monthlySpent >= monthlyBudgetUsd) {
    return { kind: "held", scope: "monthly", limitUsd: monthlyBudgetUsd, spentUsd: monthlySpent };
  }
  const ticketSpent = await input.ticketCostUsdFn(db, input.ticketId);
  if (maxCostUsd != null && ticketSpent >= maxCostUsd) {
    return { kind: "held", scope: "ticket", limitUsd: maxCostUsd, spentUsd: ticketSpent };
  }
  return { kind: "ok", maxCostUsd, ticketCostBaseline: ticketSpent };
}

/**
 * Esito di un run ANNULLATO da un maintainer («Ferma» senza testo e nessuna
 * istruzione entro il tetto della pausa, `AgentRunCancelledError`): STESSO
 * esito per il fix e la correzione. In UNA transazione: il ticket torna allo
 * stato che aveva PRIMA del run (se qualcosa lo ha spostato nel frattempo, con
 * l'audit della transizione — actorId null, come ogni transizione della
 * pipeline) e un commento di SISTEMA da template dice chi l'ha fermato e che
 * il tempo è scaduto. Mai testo dell'AI, mai una notifica `job.failed`: non è
 * un fallimento. Chiamato solo DOPO che il job è stato chiuso `skipped` da
 * questo processo (ownership): a ownership persa il job è di chi lo ha preso.
 */
export async function recordAgentStopExpired(
  db: Db,
  input: {
    ticketId: string;
    /** Lo stato del ticket letto all'inizio del run. */
    statusBefore: (typeof tickets.$inferSelect)["status"];
    lang: Language;
    error: AgentRunCancelledError;
  },
): Promise<void> {
  const who =
    input.error.stoppedByUserId === null
      ? undefined
      : (
          await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, input.error.stoppedByUserId))
        )[0]?.email;
  const minutes = Math.round(input.error.pauseBudgetMs / 60_000);
  const body =
    who !== undefined
      ? t(input.lang, "comment.agentStopExpired", { who, minutes })
      : t(input.lang, "comment.agentStopExpiredGeneric", { minutes });
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, input.ticketId))
      .for("update");
    if (current && current.status !== input.statusBefore) {
      await tx.update(tickets).set({ status: input.statusBefore }).where(eq(tickets.id, input.ticketId));
      await recordTicketStatusChange(tx, {
        ticketId: input.ticketId,
        from: current.status,
        to: input.statusBefore,
        actorId: null,
      });
    }
    await tx.insert(comments).values({ ticketId: input.ticketId, authorType: "system", body });
  });
}

