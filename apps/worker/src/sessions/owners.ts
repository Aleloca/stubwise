// apps/worker/src/sessions/owners.ts
import { eq } from "drizzle-orm";
import { tickets, type Db } from "@stubwise/db";
import type { AgentSegmentLabel } from "@stubwise/shared";
import type { AgentRunner, AgentRunSession } from "../agent/runner.js";
import { ensureAgentSession } from "./store.js";

/**
 * Una funzione per proprietario: costruiscono l'owner_key, il titolo e le FK
 * in UN posto, così due call site dello stesso job non creano due sessioni.
 *
 * FAIL-OPEN: restituiscono `undefined` se la sessione non si crea, e il run
 * parte senza sessione. Una riga di log sola: quella di `ensureAgentSession`
 * (errore dell'insert) o quella del catch qui sotto (errore prima).
 *
 * CANCELLO: i call site le chiamano SOLO se il runner registra le sessioni
 * (`runnerRecordsSessions`). Con AGENT_STREAMING=false il runner è il
 * `ClaudeCliRunner` storico, che non saprebbe cosa farne: nessuna riga in
 * `agent_sessions` deve nascere per un run che nessuno registrerà.
 */

const warn = (msg: string) => console.warn(msg);
const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Il runner registra gli eventi dei run in una sessione (vedi AgentRunner.recordsSessions). */
export function runnerRecordsSessions(runner: AgentRunner): boolean {
  return runner.recordsSessions === true;
}

/**
 * Le opzioni da spargere nel run: `{ session }` se il runner registra le
 * sessioni e la sessione si è creata, altrimenti `{}` — e in quel caso `make`
 * non viene nemmeno chiamata (nessuna query, nessuna riga).
 */
export async function sessionOption(
  runner: AgentRunner,
  make: () => Promise<AgentRunSession | undefined>,
): Promise<{ session?: AgentRunSession }> {
  if (!runnerRecordsSessions(runner)) return {};
  try {
    const session = await make();
    return session ? { session } : {};
  } catch (error) {
    warn(`sessione: creazione fallita, il run parte senza: ${describeError(error)}`);
    return {};
  }
}

/** Unione dei valori d'ambiente materializzati in TUTTI i repo del run (design §5.5). */
export function envSecretsOf(
  states: ReadonlyArray<{ envProcessEnv: Record<string, string> }>,
): string[] {
  return [...new Set(states.flatMap((s) => Object.values(s.envProcessEnv)))];
}

export async function aiJobSession(
  db: Db,
  job: { id: string; ticketId: string },
  label: AgentSegmentLabel,
  secrets?: string[],
): Promise<AgentRunSession | undefined> {
  try {
    const [ticket] = await db
      .select({ number: tickets.number, title: tickets.title, projectId: tickets.projectId })
      .from(tickets)
      .where(eq(tickets.id, job.ticketId));
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `ai_job:${job.id}`,
      kind: "ai_job",
      title: ticket ? `#${ticket.number} ${ticket.title}` : "Job",
      projectId: ticket?.projectId ?? null,
      ticketId: job.ticketId,
      aiJobId: job.id,
    });
    return sessionId
      ? { sessionId, label, ...(secrets && secrets.length > 0 ? { secrets } : {}) }
      : undefined;
  } catch (error) {
    warn(`sessione ai_job:${job.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

export async function prReviewSession(
  db: Db,
  review: { id: string; projectId: string | null; prNumber: number; repositoryName: string },
  label: AgentSegmentLabel,
): Promise<AgentRunSession | undefined> {
  try {
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `pr_review:${review.id}`,
      kind: "pr_review",
      title: `${review.repositoryName} #${review.prNumber}`,
      projectId: review.projectId,
      prReviewId: review.id,
    });
    return sessionId ? { sessionId, label } : undefined;
  } catch (error) {
    warn(`sessione pr_review:${review.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}
