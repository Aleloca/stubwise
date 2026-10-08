// apps/worker/src/sessions/owners.ts
import { eq } from "drizzle-orm";
import { googleAccounts, repositories, tickets, type Db } from "@stubwise/db";
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

/**
 * Voce di backlog: UNA sessione per voce, non per job né per processo. Deep
 * dive, stima, merge dell'intake e ogni turno della chat di analisi ci
 * scrivono dentro; un turno di chat fermo su `ask_user` riparte con un job
 * nuovo (e un processo nuovo) ma nella STESSA sessione, perché la chiave è la
 * voce. Nessun segreto: deep dive e chat lavorano su un worktree senza `.env`
 * materializzati, stima e intake su una dir vuota.
 */
export async function backlogItemSession(
  db: Db,
  item: { id: string; projectId: string; title: string },
  label: AgentSegmentLabel,
): Promise<AgentRunSession | undefined> {
  try {
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `backlog_item:${item.id}`,
      kind: "backlog_item",
      title: item.title,
      projectId: item.projectId,
      backlogItemId: item.id,
    });
    return sessionId ? { sessionId, label } : undefined;
  } catch (error) {
    warn(`sessione backlog_item:${item.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

/** Job di backlog che non ha (ancora) una voce: l'intake che ne crea una nuova. */
export async function backlogJobSession(
  db: Db,
  job: { id: string; projectId: string },
  label: AgentSegmentLabel,
): Promise<AgentRunSession | undefined> {
  try {
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `backlog_job:${job.id}`,
      kind: "backlog_job",
      title: label === "intake" ? "Intake" : "Backlog",
      projectId: job.projectId,
      backlogJobId: job.id,
    });
    return sessionId ? { sessionId, label } : undefined;
  } catch (error) {
    warn(`sessione backlog_job:${job.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * Classificazione di un messaggio di posta. La sessione la vede SOLO il
 * proprietario della casella (`mailbox_owner`, spec §5.6): se la casella non
 * si risolve NON si crea — mai una sessione di posta senza proprietario, che
 * il CHECK `agent_sessions_email_owner_chk` rifiuterebbe comunque (questa è
 * la prima difesa, quella la seconda). Nessun segreto: il run gira su una dir
 * temporanea vuota. `emailMessageId` è la FK (CASCADE) da cui il server legge
 * l'oggetto e con cui la sessione — che contiene il testo dell'email — sparisce
 * quando il messaggio viene potato o cancellato da Gmail.
 */
export async function emailMessageSession(
  db: Db,
  message: { id: string; accountId: string; subject: string | null },
): Promise<AgentRunSession | undefined> {
  try {
    const [account] = await db
      .select({ userId: googleAccounts.userId })
      .from(googleAccounts)
      .where(eq(googleAccounts.id, message.accountId));
    if (!account) return undefined;
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `email_message:${message.id}`,
      kind: "email_message",
      title: message.subject ?? "(senza oggetto)",
      mailboxOwnerUserId: account.userId,
      emailMessageId: message.id,
    });
    return sessionId ? { sessionId, label: "email_classify" } : undefined;
  } catch (error) {
    warn(`sessione email_message:${message.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

/** Progetto e nome del repository: `doc_generations` ha solo `repository_id` (preflight M8). */
async function repositoryContext(
  db: Db,
  repositoryId: string,
): Promise<{ projectId: string | null; name: string }> {
  const [repo] = await db
    .select({ projectId: repositories.projectId, name: repositories.name })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return { projectId: repo?.projectId ?? null, name: repo?.name ?? "repository" };
}

/**
 * Generazione Docs: UNA sessione per generazione, condivisa da tutti i nodi
 * (orientamento, explore, synthesize, product), anche quando girano in
 * parallelo — ognuno è un segmento suo, e la sessione resta viva finché
 * almeno uno è aperto. Label sempre `docs`, che in v1 NON è interattiva
 * (design §12 H3): si guarda e basta. Nessun segreto: il worktree della
 * generazione non ha `.env` materializzati.
 */
export async function docGenerationSession(
  db: Db,
  generation: { id: string; repositoryId: string },
): Promise<AgentRunSession | undefined> {
  try {
    const repo = await repositoryContext(db, generation.repositoryId);
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `doc_generation:${generation.id}`,
      kind: "doc_generation",
      title: `Docs · ${repo.name}`,
      projectId: repo.projectId,
      docGenerationId: generation.id,
    });
    return sessionId ? { sessionId, label: "docs" } : undefined;
  } catch (error) {
    warn(`sessione doc_generation:${generation.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * Aggiornamento automatico dei Docs dopo un push: lavora su un job, non su una
 * generazione (può non averne una corrente), quindi ha una sessione SUA,
 * `doc_update:<jobId>`, di kind `doc_generation` ma senza `doc_generation_id`.
 */
export async function docUpdateSession(
  db: Db,
  job: { id: string; repositoryId: string },
): Promise<AgentRunSession | undefined> {
  try {
    const repo = await repositoryContext(db, job.repositoryId);
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `doc_update:${job.id}`,
      kind: "doc_generation",
      title: `Docs · ${repo.name} (aggiornamento)`,
      projectId: repo.projectId,
    });
    return sessionId ? { sessionId, label: "docs" } : undefined;
  } catch (error) {
    warn(`sessione doc_update:${job.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

/** Brief settimanale: una sessione per riga `project_briefs` (i tentativi ci rientrano). */
export async function projectBriefSession(
  db: Db,
  brief: { id: string; projectId: string },
): Promise<AgentRunSession | undefined> {
  try {
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `project_brief:${brief.id}`,
      kind: "project_brief",
      title: "Brief settimanale",
      projectId: brief.projectId,
    });
    return sessionId ? { sessionId, label: "brief" } : undefined;
  } catch (error) {
    warn(`sessione project_brief:${brief.id}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * Report giornaliero di un progetto: una sessione per (progetto, giorno), che
 * raccoglie le descrizioni dei commit e il riassunto. Il rollup per
 * sviluppatore (`rollupDevSummaries`) resta senza sessione: non è lavoro di
 * un progetto.
 */
export async function dailyReportSession(
  db: Db,
  project: { id: string; name: string },
  day: string,
): Promise<AgentRunSession | undefined> {
  try {
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `daily_report:${project.id}:${day}`,
      kind: "daily_report",
      title: `Report ${day} · ${project.name}`,
      projectId: project.id,
    });
    return sessionId ? { sessionId, label: "daily_report" } : undefined;
  } catch (error) {
    warn(`sessione daily_report:${project.id}:${day}: creazione fallita: ${describeError(error)}`);
    return undefined;
  }
}
