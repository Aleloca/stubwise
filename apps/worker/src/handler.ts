import { tickets, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "./agent/runner.js";
import type { MirrorManager } from "./git/mirrors.js";
import { runFix, type FixDeps } from "./pipeline/fix.js";
import { runTriage } from "./pipeline/triage.js";
import { failJob, type AiJob } from "./queue.js";

/**
 * Wiring della pipeline per runWorker: handler(job) = triage → (se "fixing")
 * fix. Il job arriva già reclamato (`triaging`); triage e fix lo chiudono o
 * lo fanno avanzare da soli (vedi runTriage/runFix).
 *
 * SERIALIZZAZIONE PER PROGETTO: runWorker gira con concurrency 2, ma due job
 * dello STESSO progetto non devono mai sovrapporsi — l'ensureMirror del
 * secondo farebbe `fetch --prune` nel mirror condiviso e cancellerebbe il
 * branch stubwise/* non ancora pushato del primo (limite documentato in
 * mirrors.ts). Qui ogni esecuzione viene accodata a una catena di promise
 * per projectId (in-process: l'assunzione di deployment è un singolo
 * processo worker, come per i lock di MirrorManager); job di progetti
 * diversi restano paralleli perché hanno catene indipendenti.
 */
export interface HandlerDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: MirrorManager;
  /** Chiave AES-256 per decifrare le credenziali dei progetti. */
  encryptionKey: Buffer;
  /** Iniettabile nei test (provider finto, niente HTTP). */
  getProviderFn?: FixDeps["getProviderFn"];
  /** Override delle opzioni di triage (model/maxTurns/timeoutMs). */
  triage?: { model?: string; maxTurns?: number; timeoutMs?: number };
  /** Override delle opzioni di fix (modelli, due fasi, timeout, allowedTools). */
  fix?: {
    model?: string;
    twoPhase?: boolean;
    planModel?: string;
    executeModel?: string;
    planTimeoutMs?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
  };
}

async function processJob(deps: HandlerDeps, job: AiJob): Promise<void> {
  // Il triage non tocca il repo: il suo cwd è una tmpdir vuota e innocua,
  // creata per-job e rimossa comunque vada.
  const workDir = await mkdtemp(join(tmpdir(), "stubwise-triage-"));
  try {
    const outcome = await runTriage(
      { db: deps.db, runner: deps.runner, workDir, ...deps.triage },
      job,
    );
    if (outcome !== "fixing") return;
    await runFix(
      {
        db: deps.db,
        runner: deps.runner,
        mirrors: deps.mirrors,
        encryptionKey: deps.encryptionKey,
        ...(deps.getProviderFn ? { getProviderFn: deps.getProviderFn } : {}),
        ...deps.fix,
      },
      job,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Crea l'handler per runWorker, con la serializzazione per progetto. */
export function createHandler(deps: HandlerDeps): (job: AiJob) => Promise<void> {
  /** Catena di promise per projectId: stessa meccanica di withRepoLock. */
  const chains = new Map<string, Promise<void>>();

  return async function handler(job: AiJob): Promise<void> {
    const [row] = await deps.db
      .select({ projectId: tickets.projectId })
      .from(tickets)
      .where(eq(tickets.id, job.ticketId));
    if (!row) {
      await failJob(deps.db, job.id, {
        log: `[stubwise] ticket ${job.ticketId} non trovato`,
        error: "ticket del job non trovato",
      });
      return;
    }

    // Sezione SINCRONA (niente await tra get e set): due handler concorrenti
    // sullo stesso progetto vedono e allungano la stessa catena.
    const prev = chains.get(row.projectId) ?? Promise.resolve();
    const run = prev.then(() => processJob(deps, job));
    // La catena memorizzata non rigetta mai: un job fallito non blocca i
    // successivi dello stesso progetto.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(row.projectId, tail);
    void tail.then(() => {
      if (chains.get(row.projectId) === tail) chains.delete(row.projectId);
    });
    return run;
  };
}
