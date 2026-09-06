import {
  backlogChatMessages,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  comments,
  retrieveChunksForProject,
  tickets,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import {
  backlogRiskSchema,
  backlogUrgencySchema,
  effortSchema,
  type BacklogIntakePayload,
  type Language,
} from "@stubwise/shared";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { outputOrThrow, parseAgentJson } from "../agent/text.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { getContentLanguage } from "../settings.js";
import type { BacklogDeps, BacklogJob } from "./poller.js";
import { buildIntakePrompt, buildMergePrompt } from "./prompts.js";
import { loadProjectAiProviderId, resolveBacklogProvider } from "./provider.js";

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
 *
 * NON-IDEMPOTENZA del retry (accettata, nessun marker di completamento): se il
 * worker crasha DOPO il commit della transazione ma PRIMA che il poller marchi il
 * job `done`, il retry ri-esegue l'intake da capo. Per un intake DA TICKET il
 * rientro è naturale (il ticket è ormai `closed` → no-op); per un intake MANUALE
 * il retry rifà l'embedding, trova la voce appena creata con similarità 1.0 e ci
 * fa MERGE sopra (requestCount gonfiato di 1, documento "integrato" con lo stesso
 * feedback). Esito benigno — nessun duplicato, solo un contatore ottimista — e la
 * finestra è minuscola: non vale un marker di completamento dedicato.
 */

/** Output JSON della PRIMA elaborazione di una voce (buildIntakePrompt). I cap
 * (title 300 come createBacklogItemSchema, document 50k) respingono un output
 * degenere/iniettato prima che finisca in DB: schema violato → parse null →
 * throw → retry. */
const intakeOutputSchema = z.object({
  title: z.string().min(1).max(300),
  document: z.string().min(1).max(50_000),
  effort: effortSchema,
  risk: backlogRiskSchema,
  riskNote: z.string().max(2000).optional(),
  urgency: backlogUrgencySchema,
});
type IntakeOutput = z.infer<typeof intakeOutputSchema>;

/** Output JSON del merge (buildMergePrompt): solo il documento aggiornato. */
const mergeOutputSchema = z.object({ document: z.string().min(1) });
type MergeOutput = z.infer<typeof mergeOutputSchema>;

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

/**
 * MERGE: integra il nuovo feedback nel documento della voce esistente. L'embedding
 * della voce NON si ricalcola di proposito: resta rappresentativo del NUCLEO
 * dell'idea (il primo feedback che l'ha originata), così il dedup successivo
 * continua ad ancorarsi a quel nucleo invece di derivare a ogni merge. Il
 * documento e il requestCount cambiano, l'embedding no.
 */
async function mergeIntoItem(
  deps: BacklogDeps,
  jobId: string,
  item: BestMatch,
  input: { title: string; body: string },
  ticket: OriginTicket | null,
  lang: Language,
  provider: ResolvedProvider | undefined,
): Promise<void> {
  const result = await deps.runner.run({
    cwd: deps.workDir,
    prompt: buildMergePrompt(item.document, feedbackText(input.title, input.body)),
    ...(deps.model !== undefined ? { model: deps.model } : {}),
    permissionMode: "default",
    maxTurns: 3,
    timeoutMs: deps.agentTimeoutMs,
    ...(provider !== undefined ? { provider } : {}),
  });
  const parsed: MergeOutput | null = parseAgentJson(mergeOutputSchema, outputOrThrow(result, "intake (merge)"));
  if (!parsed) throw new Error("intake: output del merge non parsabile");

  await deps.db.transaction(async (tx) => {
    await tx
      .update(backlogItems)
      .set({ document: parsed.document, requestCount: sql`${backlogItems.requestCount} + 1` })
      .where(eq(backlogItems.id, item.id));
    // Messaggio di sistema nella chat della voce: traccia l'integrazione.
    // Testo utente → i18n (lingua dei contenuti d'istanza, come i commenti AI).
    await tx.insert(backlogChatMessages).values({
      itemId: item.id,
      role: "system",
      content: ticket
        ? t(lang, "backlog.mergedFromTicket", { number: ticket.number })
        : t(lang, "backlog.mergedManual"),
    });
    if (ticket) await closeOriginTicket(tx, ticket, item.id, item.title, lang);
    // Auto-merge: il job punta alla voce CANONICA in cui il feedback è confluito
    // (lo stesso id usato per il link del ticket), così jobId → itemId è coerente.
    await tx.update(backlogJobs).set({ resultItemId: item.id }).where(eq(backlogJobs.id, jobId));
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
  jobId: string,
  projectId: string,
  input: { title: string; body: string },
  vec: number[],
  best: BestMatch | null,
  ticket: OriginTicket | null,
  lang: Language,
  provider: ResolvedProvider | undefined,
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
    permissionMode: "default",
    maxTurns: 3,
    timeoutMs: deps.agentTimeoutMs,
    ...(provider !== undefined ? { provider } : {}),
  });
  const parsed: IntakeOutput | null = parseAgentJson(
    intakeOutputSchema,
    outputOrThrow(result, "intake"),
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
    if (ticket) await closeOriginTicket(tx, ticket, item.id, item.title, lang);
    // Collega il job alla voce appena creata (jobId → itemId), nella stessa
    // transazione dell'insert: item e link committano insieme (atomicità).
    await tx.update(backlogJobs).set({ resultItemId: item.id }).where(eq(backlogJobs.id, jobId));
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
  lang: Language,
): Promise<void> {
  await tx
    .insert(backlogItemTickets)
    .values({ itemId, ticketId: ticket.id, role: "origin" })
    .onConflictDoNothing();
  // Commento AI nella lingua dei contenuti d'istanza (come i commenti del triage).
  await tx.insert(comments).values({
    ticketId: ticket.id,
    authorType: "ai",
    body: t(lang, "comment.backlogIntake", { title: itemTitle }),
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

  // Lingua dei contenuti generati (commento di chiusura, messaggi system),
  // risolta UNA volta per job come nel triage.
  const lang = await getContentLanguage(db);

  // Provider AI del run (pinned del progetto o chain[0]); undefined = auth del
  // container (comportamento storico). Risolto una volta per job.
  const aiProviderId = await loadProjectAiProviderId(db, projectId);
  const provider = await resolveBacklogProvider(deps, aiProviderId);

  // 2. Embedding di titolo+corpo. Un fallimento lancia → retry.
  const [vec] = await deps.embeddingClient.embed([feedbackText(input.title, input.body)]);
  if (!vec) throw new Error("intake: embedding, nessun vettore restituito");

  // 3. Voce più simile del progetto.
  const best = await findBestMatch(db, projectId, vec);

  // 4/5. Merge sopra soglia, altrimenti nuova voce.
  if (best && best.similarity >= deps.mergeThreshold) {
    await mergeIntoItem(deps, job.id, best, input, ticket, lang, provider);
  } else {
    await createNewItem(deps, job.id, projectId, input, vec, best, ticket, lang, provider);
  }
}
