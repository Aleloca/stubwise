import { automationRules, comments, tickets, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { EFFORT_LABELS } from "@stubwise/shared";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunUsage,
} from "../agent/runner.js";
import {
  appendLog,
  completeJob,
  failJob,
  holdJob,
  markFixing,
  recordAgentRun,
  type AiJob,
} from "../queue.js";
import { getContentLanguage } from "../settings.js";
import { notify, ticketUrl, type NotifyDeps } from "./notify.js";
import { buildTriagePrompt, parseTriageDecision, type TriageDecision } from "./prompts.js";

/**
 * Default difensivo del gate quando manca la riga automation_rules del tipo
 * (non dovrebbe accadere: la migrazione seeda tutti e 4 i tipi). Conservativo
 * ma non bloccante: auto-fix attivo fino a effort medio, come per i bug.
 */
const DEFAULT_AUTOMATION_RULE = { autoFix: true, maxEffort: 3 } as const;

/**
 * Fase 1 della pipeline: il triage. Economica (model haiku, pochi turni),
 * decide se vale la pena spendere quota sul fix: `fix` fa avanzare il job a
 * `fixing`, `skip` chiude il job con un commento AI sul ticket, `duplicate`
 * chiude il ticket come duplicato di uno recente.
 *
 * Il triage NON tocca il repository: ragiona solo su ticket + lista dei
 * ticket recenti. Per questo `workDir` è una directory vuota e innocua
 * (es. una tmpdir), non un worktree: anche se il modello provasse a leggere
 * o scrivere file, non troverebbe niente.
 */
/** Timeout di default del triage (2'). Esportato per l'invariante di staleness
 * verificata all'avvio del worker (vedi index.ts). Il triage può ritentare
 * una volta, quindi nel caso pessimo vale ~2× questo valore. */
export const DEFAULT_TRIAGE_TIMEOUT_MS = 120_000;

export interface TriageDeps extends NotifyDeps {
  db: Db;
  runner: AgentRunner;
  /** Modello per il triage (default "haiku": è la fase economica). */
  model?: string;
  /** Turni agentici massimi (default 10: il triage non deve esplorare). */
  maxTurns?: number;
  /** Timeout complessivo (default 120s). */
  timeoutMs?: number;
  /** Directory innocua (vuota) usata come cwd dell'agente. */
  workDir: string;
}

export type TriageOutcome = "fixing" | "held" | "skipped" | "closed_duplicate" | "failed";

/** Quanti ticket recenti del progetto mostrare al modello per i duplicati. */
const RECENT_TICKETS_LIMIT = 30;

/** Tetto per gli output dell'agente accodati al log del job. */
const LOG_OUTPUT_MAX_CHARS = 4000;

function truncateForLog(output: string): string {
  return output.length > LOG_OUTPUT_MAX_CHARS
    ? `${output.slice(0, LOG_OUTPUT_MAX_CHARS)}\n[output troncato]`
    : output;
}

type Ticket = typeof tickets.$inferSelect;

/**
 * Esegue il triage del job (già reclamato come `triaging`). Restituisce
 * l'esito; il job viene SEMPRE chiuso o fatto avanzare qui dentro, tranne
 * quando la ownership è persa (markFixing/completeJob false): in quel caso
 * non si sovrascrive nulla — il job è di un altro worker — e si restituisce
 * "failed" per dire al chiamante di fermarsi.
 */
export async function runTriage(deps: TriageDeps, job: AiJob): Promise<TriageOutcome> {
  const { db, runner, workDir } = deps;
  const model = deps.model ?? "haiku";
  const maxTurns = deps.maxTurns ?? 10;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS;

  // Lingua dei contenuti generati (prompt che chiede il `reason` nella lingua
  // d'istanza + commenti AI held/skip/duplicate), risolta UNA VOLTA per job.
  const lang = await getContentLanguage(db);

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, job.ticketId));
  if (!ticket) {
    // Impossibile finché vale la FK (il job cade in cascata col ticket), ma
    // se succede il job va chiuso, non lasciato appeso.
    await failJob(db, job.id, {
      log: `[triage] ticket ${job.ticketId} non trovato`,
      error: "ticket del job non trovato",
    });
    return "failed";
  }

  // Contesto per le notifiche di QUESTA fase (best-effort, post-commit).
  const notifyDeps: NotifyDeps = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    ...(deps.projectName !== undefined ? { projectName: deps.projectName } : {}),
    ...(deps.dispatch !== undefined ? { dispatch: deps.dispatch } : {}),
  };
  const url = ticketUrl(deps.publicUrl, ticket.id);
  const projectName = deps.projectName ?? "";
  /** Notifica job.failed best-effort dopo il failJob (stato già committato). */
  const notifyFailed = (error: string): Promise<void> =>
    notify(notifyDeps, db, {
      kind: "job.failed",
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      projectName,
      error,
      ticketUrl: url,
    });

  const recentTickets = await db
    .select({ number: tickets.number, title: tickets.title, status: tickets.status })
    .from(tickets)
    .where(and(eq(tickets.projectId, ticket.projectId), ne(tickets.id, ticket.id)))
    .orderBy(desc(tickets.createdAt))
    .limit(RECENT_TICKETS_LIMIT);

  await appendLog(db, job.id, `[triage] avviato per il ticket #${ticket.number} (model ${model})`);

  const prompt = buildTriagePrompt({ ticket, recentTickets }, lang);

  // Un solo retry: se il modello non emette un JSON valido (o indica un
  // duplicato inesistente) si riprova una volta con lo stesso prompt, poi
  // il job fallisce con entrambi gli output nel log.
  const invalidOutputs: { output: string; exitCode: number }[] = [];
  let decision: TriageDecision | null = null;
  let duplicateOf: Ticket | null = null;
  // Consumi dell'ULTIMO run riuscito: il triage può ritentare una volta, e
  // registriamo i consumi del tentativo che è effettivamente arrivato a un
  // output (l'ultimo). I timeout/spawn falliti tornano prima e non producono
  // usage, quindi non c'è nulla da registrare in quei casi.
  let lastUsage: AgentRunUsage | undefined;

  // Gli output invalidi dei tentativi precedenti vanno SEMPRE nel log di
  // fallimento, anche quando è il retry a esplodere (timeout/spawn): sono
  // l'unico indizio per capire perché il primo tentativo non è bastato.
  // L'exit code accanto al tentativo distingue "il modello ha divagato"
  // (exit 0) da "il CLI è morto male" (exit non-zero).
  const renderInvalidOutputs = (): string =>
    invalidOutputs
      .map(
        (attempt, i) =>
          `[triage] output non valido (tentativo ${i + 1}, exit ${attempt.exitCode}):\n${truncateForLog(attempt.output)}`,
      )
      .join("\n");
  const invalidOutputsPrefix = (): string =>
    invalidOutputs.length > 0 ? `${renderInvalidOutputs()}\n` : "";

  for (let attempt = 1; attempt <= 2 && !decision; attempt++) {
    if (attempt > 1) {
      await appendLog(db, job.id, "[triage] output non valido, ritento una volta");
    }

    let output: string;
    let exitCode: number;
    try {
      const result = await runner.run({ cwd: workDir, prompt, model, maxTurns, timeoutMs });
      output = result.output;
      exitCode = result.exitCode;
      lastUsage = result.usage;
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        const message = `triage interrotto per timeout dopo ${err.timeoutMs}ms`;
        await failJob(db, job.id, {
          log: `${invalidOutputsPrefix()}[triage] output parziale prima del timeout:\n${truncateForLog(err.partialOutput)}`,
          error: message,
        });
        await notifyFailed(message);
        return "failed";
      }
      if (err instanceof AgentRunError) {
        await failJob(db, job.id, {
          log: `${invalidOutputsPrefix()}[triage] agente non eseguibile: ${err.message}`,
          error: err.message,
        });
        await notifyFailed(err.message);
        return "failed";
      }
      throw err;
    }

    const parsed = parseTriageDecision(output);
    if (!parsed) {
      invalidOutputs.push({ output, exitCode });
      continue;
    }

    if (parsed.decision === "duplicate") {
      // Il numero indicato deve esistere nel progetto e non essere il
      // ticket stesso: altrimenti il modello ha allucinato, è output
      // invalido come un JSON malformato (stesso percorso di retry).
      // La lookup è volutamente su TUTTO il progetto, non ristretta alla
      // lista dei recenti mostrata nel prompt: un duplicato vero resta
      // valido anche se più vecchio dei 30 ticket elencati.
      const [target] = await db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.projectId, ticket.projectId),
            eq(tickets.number, parsed.of),
            ne(tickets.id, ticket.id),
          ),
        );
      if (!target) {
        invalidOutputs.push({ output, exitCode });
        continue;
      }
      duplicateOf = target;
    }

    decision = parsed;
  }

  // Consumi del triage (best-effort): registrati dell'ultimo run riuscito,
  // qualunque sia poi l'esito della decisione. Non fa mai fallire il job.
  await recordAgentRun(db, { jobId: job.id, phase: "triage", usage: lastUsage });

  if (!decision) {
    await failJob(db, job.id, { log: renderInvalidOutputs(), error: "triage output non valido" });
    await notifyFailed("triage output non valido");
    return "failed";
  }

  // SEMPRE, prima di agire sulla decisione: il triage ha (ri)validato il tipo
  // e stimato l'effort, e questi vanno salvati sul ticket a prescindere
  // dall'esito (fix/skip/duplicate). Il tipo può cambiare rispetto a quello in
  // ingresso (un "bug" riclassificato "feature"), ed è il tipo riclassificato
  // a guidare il gate di automazione qui sotto.
  await db
    .update(tickets)
    .set({ type: decision.type, effort: decision.effort })
    .where(eq(tickets.id, ticket.id));

  switch (decision.decision) {
    case "fix": {
      await appendLog(db, job.id, "[triage] decisione: fix");

      // Gate di automazione: per il tipo riclassificato, l'auto-fix parte solo
      // se la regola lo consente E l'effort è entro la soglia. L'avvio manuale
      // (manualTrigger) scavalca il gate: un umano ha già deciso di lanciare.
      const [rule] = await db
        .select({ autoFix: automationRules.autoFix, maxEffort: automationRules.maxEffort })
        .from(automationRules)
        .where(eq(automationRules.type, decision.type));
      const effectiveRule = rule ?? DEFAULT_AUTOMATION_RULE;
      const allowAuto = effectiveRule.autoFix && decision.effort <= effectiveRule.maxEffort;

      if (job.manualTrigger || allowAuto) {
        const owned = await markFixing(db, job.id);
        if (!owned) {
          // Ownership persa (job requeued e reclamato altrove): non si tocca
          // più nulla, l'altro worker procede. Solo una riga di log (append,
          // non sovrascrive) per spiegare cosa è successo.
          await appendLog(db, job.id, "[triage] ownership persa, mi fermo senza toccare il job");
          return "failed";
        }
        return "fixing";
      }

      // HOLD: il gate non consente l'auto-fix. Il job resta in attesa di un
      // avvio manuale; il ticket torna "triaged" (triagiato ma non in fix) e
      // un commento AI spiega il perché. Il commento sta in transazione con la
      // chiusura del ticket; holdJob è il commit point separato (come gli
      // altri esiti): se la ownership è persa il commento resta, accettabile.
      const effortLabel = EFFORT_LABELS[decision.effort] ?? String(decision.effort);
      await db.transaction(async (tx) => {
        await tx.insert(comments).values({
          ticketId: ticket.id,
          authorType: "ai",
          body: t(lang, "comment.triageHeld", {
            type: decision.type,
            effortLabel,
            effort: decision.effort,
            threshold: effectiveRule.maxEffort,
          }),
        });
        await tx.update(tickets).set({ status: "triaged" }).where(eq(tickets.id, ticket.id));
      });
      const held = await holdJob(db, job.id, {
        log: `[triage] decisione: fix, ma automazione in attesa (tipo=${decision.type}, effort=${decision.effort}/5, soglia=${effectiveRule.maxEffort}, auto-fix=${effectiveRule.autoFix})`,
      });
      if (!held) {
        await appendLog(db, job.id, "[triage] ownership persa dopo il hold");
      }
      // Notifica job.held best-effort, DOPO holdJob (stato committato). Il tipo
      // è quello riclassificato dal triage.
      await notify(notifyDeps, db, {
        kind: "job.held",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName,
        type: decision.type,
        effort: decision.effort,
        ticketUrl: url,
      });
      return "held";
    }

    case "skip": {
      // Commento AI in transazione (qui è una scrittura sola, ma tiene la
      // forma uniforme col caso duplicate); completeJob è il commit point
      // separato: se restituisce false (ownership persa) il commento resta,
      // accettabile — è informazione vera comunque.
      await db.transaction(async (tx) => {
        await tx.insert(comments).values({
          ticketId: ticket.id,
          authorType: "ai",
          body: t(lang, "comment.triageSkip", { reason: decision.reason }),
        });
      });
      const closed = await completeJob(db, job.id, {
        status: "skipped",
        log: `[triage] decisione: skip — ${decision.reason}`,
      });
      if (!closed) {
        await appendLog(db, job.id, "[triage] ownership persa dopo il commento di skip");
      }
      return "skipped";
    }

    case "duplicate": {
      // duplicateOf è sempre valorizzato qui (validato nel loop sopra).
      const target = duplicateOf as Ticket;
      // Commento + chiusura del ticket nella stessa transazione: o il
      // ticket risulta chiuso CON la spiegazione, o niente.
      await db.transaction(async (tx) => {
        await tx.insert(comments).values({
          ticketId: ticket.id,
          authorType: "ai",
          body: t(lang, "comment.triageDuplicate", { number: target.number, title: target.title }),
        });
        await tx.update(tickets).set({ status: "closed" }).where(eq(tickets.id, ticket.id));
      });
      const closed = await completeJob(db, job.id, {
        status: "skipped",
        log: `[triage] decisione: duplicato di #${target.number}, ticket chiuso`,
      });
      if (!closed) {
        await appendLog(db, job.id, "[triage] ownership persa dopo la chiusura del duplicato");
      }
      return "closed_duplicate";
    }
  }
}
