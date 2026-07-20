import {
  backlogChatMessages,
  backlogItems,
  backlogItemTickets,
  comments,
  retrieveChunksForProject,
  tickets,
  type Db,
} from "@stubwise/db";
import {
  backlogRiskSchema,
  backlogUrgencySchema,
  effortSchema,
  type BacklogIntakePayload,
} from "@stubwise/shared";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunResult } from "../agent/runner.js";
import type { BacklogDeps, BacklogJob } from "./poller.js";
import { buildIntakePrompt, buildMergePrompt } from "./prompts.js";

/**
 * INTAKE del backlog di discovery: dedup semantico + generazione della voce.
 *
 * Da un feedback (ticket deviato o idea manuale):
 *  1. risolve titolo+corpo (dal ticket o dal payload manuale);
 *  2. ne calcola l'embedding;
 *  3. cerca la voce più simile del progetto (pgvector, escluse archiviate/convertite);
 *  4. sopra `mergeThreshold` → MERGE nel documento esistente (requestCount++);
 *  5. altrimenti → NUOVA voce (retrieval RAG + run agente per titolo/documento/
 *     stime), con `similarToId` valorizzato in zona grigia (≥ similarThreshold);
 *  6. se nasce da un ticket, chiude il ticket e ci lascia un commento + link.
 *
 * FAIL-SAFE: il ticket d'origine viene chiuso SOLO dopo il successo (embedding,
 * run agente, parse, insert). Qualunque errore prima → throw: il poller riaccoda
 * (o fallisce dopo i tentativi) e il ticket RESTA aperto.
 */

/** Output JSON della PRIMA elaborazione di una voce (buildIntakePrompt). */
const intakeOutputSchema = z.object({
  title: z.string().min(1),
  document: z.string().min(1),
  effort: effortSchema,
  risk: backlogRiskSchema,
  riskNote: z.string().max(2000).optional(),
  urgency: backlogUrgencySchema,
});
type IntakeOutput = z.infer<typeof intakeOutputSchema>;

/** Output JSON del merge (buildMergePrompt): solo il documento aggiornato. */
const mergeOutputSchema = z.object({ document: z.string().min(1) });
type MergeOutput = z.infer<typeof mergeOutputSchema>;

/**
 * Estrae e parsa l'oggetto JSON dall'output dell'agente, in modo DIFENSIVO
 * (mirror di parseRefreshOutput nel server): tollera un fence ```json … ``` e un
 * pre/postambolo attorno all'oggetto (fetta tra la prima `{` e l'ultima `}`),
 * poi valida contro `schema`. Restituisce null se non parsabile/non conforme.
 */
function parseAgentJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Testo del feedback per embedding e prompt: titolo + corpo. */
function feedbackText(title: string, body: string): string {
  return `${title}\n\n${body}`;
}

/** Il ticket d'origine, risolto quando l'intake nasce da un ticket. */
interface OriginTicket {
  id: string;
  number: number;
  title: string;
  body: string;
}

/** La voce più simile del progetto e la sua similarità (1 - distanza coseno). */
interface BestMatch {
  id: string;
  title: string;
  document: string;
  similarity: number;
}

/**
 * Voce più simile del progetto: query pgvector diretta (`<=>`) escluse le voci
 * `archived`/`converted` (un feedback su un'idea scartata deve poterne ricreare
 * una nuova) e quelle senza embedding. Il vettore è param-bindato come literal
 * `[...]::vector` (injection-safe, come in docs-retrieval.ts). Null se nessuna
 * voce candidata.
 */
async function findBestMatch(
  db: Db,
  projectId: string,
  vec: number[],
): Promise<BestMatch | null> {
  const literal = `[${vec.join(",")}]`;
  const [row] = await db
    .select({
      id: backlogItems.id,
      title: backlogItems.title,
      document: backlogItems.document,
      distance: sql<number>`(${backlogItems.embedding} <=> ${literal}::vector)`,
    })
    .from(backlogItems)
    .where(
      and(
        eq(backlogItems.projectId, projectId),
        notInArray(backlogItems.status, ["archived", "converted"]),
        sql`${backlogItems.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${backlogItems.embedding} <=> ${literal}::vector`)
    .limit(1);
  if (!row) return null;
  return { id: row.id, title: row.title, document: row.document, similarity: 1 - row.distance };
}

/** Testo utile da un run: throw se exit ≠ 0 (runner.run RISOLVE anche su
 * exit non-zero → niente output da un run crashato). */
function outputOrThrow(result: AgentRunResult, phase: string): string {
  if (result.exitCode !== 0) {
    throw new Error(`intake: agente (${phase}) uscito con exit ${result.exitCode}`);
  }
  return result.output;
}

/**
 * MERGE: integra il nuovo feedback nel documento della voce esistente. L'embedding
 * della voce NON si ricalcola di proposito: resta rappresentativo del NUCLEO
 * dell'idea (il primo feedback che l'ha originata), così il dedup successivo
 * continua ad ancorarsi a quel nucleo invece di derivare a ogni merge. Il
 * documento e il requestCount cambiano, l'embedding no.
 */
async function mergeIntoItem(
  deps: BacklogDeps,
  item: BestMatch,
  input: { title: string; body: string },
  ticket: OriginTicket | null,
): Promise<void> {
  const result = await deps.runner.run({
    cwd: deps.workDir,
    prompt: buildMergePrompt(item.document, feedbackText(input.title, input.body)),
    ...(deps.model !== undefined ? { model: deps.model } : {}),
    permissionMode: "plan",
    maxTurns: 3,
    timeoutMs: deps.agentTimeoutMs,
  });
  const parsed: MergeOutput | null = parseAgentJson(outputOrThrow(result, "merge"), mergeOutputSchema);
  if (!parsed) throw new Error("intake: output del merge non parsabile");

  await deps.db.transaction(async (tx) => {
    await tx
      .update(backlogItems)
      .set({ document: parsed.document, requestCount: sql`${backlogItems.requestCount} + 1` })
      .where(eq(backlogItems.id, item.id));
    // Messaggio di sistema nella chat della voce: traccia l'integrazione.
    await tx.insert(backlogChatMessages).values({
      itemId: item.id,
      role: "system",
      content: ticket
        ? `Nuovo feedback integrato dal ticket #${ticket.number}.`
        : "Nuovo feedback integrato (idea proposta manualmente).",
    });
    if (ticket) await closeOriginTicket(tx, ticket, item.id, item.title);
  });
}

/**
 * NUOVA voce: retrieval RAG + run agente (titolo/documento/stime), insert con
 * embedding e metadati DIRETTI (le stime iniziali sono i valori di partenza, non
 * `suggested`). `similarToId` valorizzato se il best match è in zona grigia
 * (≥ similarThreshold ma < mergeThreshold).
 */
async function createNewItem(
  deps: BacklogDeps,
  projectId: string,
  input: { title: string; body: string },
  vec: number[],
  best: BestMatch | null,
  ticket: OriginTicket | null,
): Promise<void> {
  const chunks = await retrieveChunksForProject(
    deps.db,
    deps.embeddingClient,
    projectId,
    feedbackText(input.title, input.body),
    { logger: deps.logger },
  );
  const result = await deps.runner.run({
    cwd: deps.workDir,
    prompt: buildIntakePrompt(
      {
        title: input.title,
        body: input.body,
        ...(ticket ? { ticketNumber: ticket.number } : {}),
      },
      chunks,
    ),
    ...(deps.model !== undefined ? { model: deps.model } : {}),
    permissionMode: "plan",
    maxTurns: 3,
    timeoutMs: deps.agentTimeoutMs,
  });
  const parsed: IntakeOutput | null = parseAgentJson(
    outputOrThrow(result, "intake"),
    intakeOutputSchema,
  );
  if (!parsed) throw new Error("intake: output della generazione non parsabile");

  const similarToId = best && best.similarity >= deps.similarThreshold ? best.id : null;

  await deps.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(backlogItems)
      .values({
        projectId,
        title: parsed.title,
        document: parsed.document,
        effort: parsed.effort,
        risk: parsed.risk,
        riskNote: parsed.riskNote ?? null,
        urgency: parsed.urgency,
        embedding: vec,
        source: ticket ? "ticket" : "manual",
        similarToId,
      })
      .returning({ id: backlogItems.id, title: backlogItems.title });
    const item = inserted!;
    if (ticket) await closeOriginTicket(tx, ticket, item.id, item.title);
  });
}

/**
 * Chiude il ticket d'origine e lo collega alla voce. Coerente col percorso di
 * chiusura del triage (comment + status update, NESSUN ticket_event: non esiste
 * un kind adatto per "spostato nel backlog" e il triage stesso, quando chiude un
 * duplicato, usa solo il commento). Il link è idempotente
 * (`onConflictDoNothing`): un merge che ri-linka lo stesso ticket non esplode.
 */
async function closeOriginTicket(
  tx: Db,
  ticket: OriginTicket,
  itemId: string,
  itemTitle: string,
): Promise<void> {
  await tx
    .insert(backlogItemTickets)
    .values({ itemId, ticketId: ticket.id, role: "origin" })
    .onConflictDoNothing();
  await tx.insert(comments).values({
    ticketId: ticket.id,
    authorType: "ai",
    body: `Spostato nel backlog di discovery: "${itemTitle}".`,
  });
  await tx.update(tickets).set({ status: "closed" }).where(eq(tickets.id, ticket.id));
}

/**
 * Esegue l'intake di un job del backlog (già reclamato). Su qualunque errore
 * lancia: il poller riaccoda (tentativi residui) o fallisce, e il ticket resta
 * aperto (fail-safe). Un ticket già chiuso/inesistente è un no-op (done).
 */
export async function runIntake(
  deps: BacklogDeps,
  job: BacklogJob,
  payload: BacklogIntakePayload,
): Promise<void> {
  const { db } = deps;
  const projectId = job.projectId;

  // 1. Risolvi input: da ticket o manuale.
  let input: { title: string; body: string };
  let ticket: OriginTicket | null = null;
  if ("ticketId" in payload) {
    const [row] = await db
      .select({
        id: tickets.id,
        number: tickets.number,
        title: tickets.title,
        body: tickets.body,
        status: tickets.status,
      })
      .from(tickets)
      .where(eq(tickets.id, payload.ticketId));
    // Ticket inesistente o già in stato terminale: niente da deviare, no-op.
    if (!row || row.status === "closed" || row.status === "done") {
      deps.logger.warn(
        { jobId: job.id, ticketId: payload.ticketId },
        "[backlog] intake: ticket inesistente o già chiuso, no-op",
      );
      return;
    }
    ticket = { id: row.id, number: row.number, title: row.title, body: row.body };
    input = { title: row.title, body: row.body };
  } else {
    input = { title: payload.title, body: payload.body };
  }

  // 2. Embedding di titolo+corpo. Un fallimento lancia → retry.
  const [vec] = await deps.embeddingClient.embed([feedbackText(input.title, input.body)]);
  if (!vec) throw new Error("intake: embedding, nessun vettore restituito");

  // 3. Voce più simile del progetto.
  const best = await findBestMatch(db, projectId, vec);

  // 4/5. Merge sopra soglia, altrimenti nuova voce.
  if (best && best.similarity >= deps.mergeThreshold) {
    await mergeIntoItem(deps, best, input, ticket);
  } else {
    await createNewItem(deps, projectId, input, vec, best, ticket);
  }
}
