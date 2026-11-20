import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  docPageCodes,
  emailBodies,
  emailMessages,
  emailProposals,
  googleAccounts,
  meetingNotes,
  productDocJobs,
  productPages,
  projectDecisions,
  projects,
  releases,
  tickets,
  type Db,
} from "@stubwise/db";
import { aiBudgetState, writeClaudeFacts } from "@stubwise/notifications";
import { productBlockSchema, type ProductBlock, type ProductFact } from "@stubwise/shared";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { NATIVE_TOOLS } from "../agent/native-tools.js";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
import { textFromRun } from "../agent/text.js";
import type { ProjectSerializer } from "../handler.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { limitTextOfRun, runWithProviders, type SelectDeps } from "../providers/select.js";
import { buildProductDocPrompt, parseProductFacts, type PromptPage, type PromptSource } from "./prompt.js";

/**
 * Area 11, F5 — il lavoro di Claude sulla doc di prodotto, dalle fonti (la
 * coda `product_doc_jobs`, riempita dai trigger della 0210).
 *
 * - Un lavoro si prende sotto il serializer per progetto. Con la coda del
 *   progetto in pausa, il budget del mese finito o la quota dell'account
 *   finita si ferma `held` col motivo, e si riprova quando torna.
 * - Le fonti si leggono dal DB, mai da un client: il testo di una email (della
 *   casella del suo titolare) SOLO se il messaggio è ammesso e ha una proposta
 *   per questo progetto (N-2 = a), il documento della riunione, la decisione,
 *   la task chiusa, il rilascio.
 * - Il modello riceve la fonte come contenuto NON fidato e le pagine coi loro
 *   id, e risponde coi FATTI (`prompt.ts`). Poi, per pagina, lo scrittore
 *   condiviso (`writeClaudeFacts`) applica la regola e ricontrolla: una sezione
 *   presa da una persona fa aspettare il lavoro (`section_busy`).
 * - Fail-open e mai silenzioso: un fatto scartato, una pagina sparita o un
 *   fatto senza effetto finiscono nel log del lavoro.
 * - Questo modulo non nomina niente che scriva nel registro decisioni.
 */

export type Log = { info?: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };

export interface ProductDocJobDeps {
  db: Db;
  runner: AgentRunner;
  select?: SelectDeps;
  log: Log;
  /** Solo nei test. */
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  model?: string;
}

type JobRow = typeof productDocJobs.$inferSelect;

/** Quante volte un lavoro si riprova per un errore del modello prima di fallire. */
export const PRODUCT_DOC_MAX_ATTEMPTS = 3;

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** La fonte di un lavoro, letta dal DB, col suo titolare; null = non c'è più, o non è leggibile per questo progetto. */
export async function readProductSource(db: Db, job: Pick<JobRow, "projectId" | "sourceKind" | "sourceId">): Promise<(PromptSource & { ownerId: string | null }) | null> {
  switch (job.sourceKind) {
    case "email": {
      // N-2 = a: solo un messaggio AMMESSO, con una proposta per QUESTO progetto. Il titolare è chi ha la casella.
      const [m] = await db
        .select({ subject: emailMessages.subject, excerpt: emailMessages.textExcerpt, receivedAt: emailMessages.receivedAt, admitted: emailMessages.admitted, ownerId: googleAccounts.userId, body: emailBodies.bodyText })
        .from(emailMessages)
        .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
        .innerJoin(emailProposals, and(eq(emailProposals.emailMessageId, emailMessages.id), eq(emailProposals.projectId, job.projectId)))
        .leftJoin(emailBodies, eq(emailBodies.emailMessageId, emailMessages.id))
        .where(eq(emailMessages.id, job.sourceId));
      if (!m || !m.admitted) return null;
      return { kind: "email", title: m.subject ?? "", text: m.body ?? m.excerpt ?? "", at: m.receivedAt.toISOString(), ownerId: m.ownerId };
    }
    case "meeting": {
      const [n] = await db
        .select({ title: meetingNotes.docTitle, event: meetingNotes.eventTitle, summary: meetingNotes.summary, at: meetingNotes.eventStartsAt, status: meetingNotes.docStatus, projectId: meetingNotes.projectId, ownerId: googleAccounts.userId })
        .from(meetingNotes)
        .innerJoin(emailMessages, eq(emailMessages.id, meetingNotes.sourceMessageId))
        .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
        .where(eq(meetingNotes.id, job.sourceId));
      if (!n || n.status !== "ready" || n.projectId !== job.projectId) return null;
      return { kind: "meeting", title: n.title ?? n.event ?? "", text: n.summary ?? "", at: n.at?.toISOString() ?? null, ownerId: n.ownerId };
    }
    case "decision": {
      const [d] = await db
        .select({ title: projectDecisions.title, decision: projectDecisions.decision, context: projectDecisions.context, at: projectDecisions.decidedAt, by: projectDecisions.decidedByUserId, projectId: projectDecisions.projectId })
        .from(projectDecisions)
        .where(eq(projectDecisions.id, job.sourceId));
      if (!d || d.projectId !== job.projectId) return null;
      return { kind: "decision", title: d.title, text: [d.decision, d.context].filter(Boolean).join("\n\n"), at: d.at.toISOString(), ownerId: d.by };
    }
    case "task": {
      const [t] = await db.select({ title: tickets.title, body: tickets.body, number: tickets.number, projectId: tickets.projectId, code: projects.code }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, job.sourceId));
      if (!t || t.projectId !== job.projectId) return null;
      return { kind: "task", title: `${t.code}-${t.number} ${t.title}`, text: t.body ?? "", at: null, ownerId: null };
    }
    case "release": {
      const [r] = await db.select({ title: releases.title, code: releases.code, at: releases.mergedAt, projectId: releases.projectId }).from(releases).where(eq(releases.id, job.sourceId));
      if (!r || r.projectId !== job.projectId) return null;
      return { kind: "release", title: `${r.code} ${r.title}`, text: r.title, at: r.at.toISOString(), ownerId: null };
    }
  }
}

/** Le pagine del progetto, coi codici e il `rev_seq` di adesso (il «dopo» dello scrittore). */
async function projectPages(db: Db, projectId: string): Promise<(PromptPage & { revSeq: number })[]> {
  const rows = await db
    .select({ id: productPages.id, title: productPages.title, blocks: productPages.blocks, revSeq: productPages.revSeq, number: docPageCodes.number, projectCode: projects.code })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .leftJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(eq(productPages.projectId, projectId))
    .orderBy(asc(productPages.order));
  return rows.map((r) => ({ id: r.id, code: r.number === null ? r.projectCode : `${r.projectCode}-D${r.number}`, title: r.title, blocks: readBlocks(r.blocks), revSeq: r.revSeq }));
}

const hold = (db: Db, id: string, reason: "limit" | "budget" | "section_busy" | "paused") =>
  db.update(productDocJobs).set({ status: "held", heldReason: reason, finishedAt: new Date() }).where(eq(productDocJobs.id, id));
const finish = (db: Db, id: string, status: "done" | "failed", error: string | null = null) =>
  db.update(productDocJobs).set({ status, heldReason: null, error, finishedAt: new Date() }).where(eq(productDocJobs.id, id));

export type ProductDocJobOutcome = "done" | "held" | "failed" | "retry";

/** UN lavoro (già preso, `running`). */
export async function runProductDocJob(deps: ProductDocJobDeps, job: JobRow): Promise<ProductDocJobOutcome> {
  const { db, log } = deps;
  const [p] = await db.select({ pausedAt: projects.queuePausedAt }).from(projects).where(eq(projects.id, job.projectId));
  if (!p) return finish(db, job.id, "done", "project_gone").then(() => "done");
  if (p.pausedAt) return hold(db, job.id, "paused").then(() => "held");
  if ((await aiBudgetState(db, deps.monthlyCostUsdFn)).exhausted) return hold(db, job.id, "budget").then(() => "held");

  const source = await readProductSource(db, job);
  if (!source) {
    log.warn({ jobId: job.id, source: job.sourceKind }, "doc di prodotto: la fonte non c'è più o non è leggibile per il progetto");
    return finish(db, job.id, "done", "source_unavailable").then(() => "done");
  }
  const pages = await projectPages(db, job.projectId);
  if (pages.length === 0) return finish(db, job.id, "done", "no_pages").then(() => "done");

  const prompt = buildProductDocPrompt(source, pages);
  const cwd = await mkdtemp(join(tmpdir(), "stubwise-product-doc-"));
  let text: string | null = null;
  try {
    const attempt = (provider: ResolvedProvider | undefined) =>
      deps.runner.run({
        cwd,
        prompt,
        usage: { operation: "product_doc_update", projectId: job.projectId },
        ...(deps.model ? { model: deps.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        // Claude non esegue niente: nessuno strumento, un turno.
        builtinTools: NATIVE_TOOLS.text,
        permissionMode: "default",
        maxTurns: 1,
        timeoutMs: 180_000,
      });
    let result: AgentRunResult;
    if (deps.select) {
      const out = await runWithProviders(deps.select, { projectId: job.projectId, workClass: "background" }, attempt, limitTextOfRun);
      if (out.kind === "legacy_limited" || out.kind === "unavailable") return hold(db, job.id, "limit").then(() => "held");
      result = out.value;
    } else {
      result = await attempt(undefined);
    }
    text = textFromRun(result);
  } catch (error) {
    log.warn({ err: error, jobId: job.id }, "doc di prodotto: il modello non ha risposto");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  if (text === null) {
    if (job.attempts >= PRODUCT_DOC_MAX_ATTEMPTS) return finish(db, job.id, "failed", "no_answer").then(() => "failed");
    await db.update(productDocJobs).set({ status: "queued" }).where(eq(productDocJobs.id, job.id));
    return "retry";
  }
  const parsed = parseProductFacts(text, new Set(pages.map((pg) => pg.id)));
  if (parsed.invalid) {
    log.warn({ jobId: job.id }, "doc di prodotto: la risposta non è un oggetto JSON con i fatti");
    return finish(db, job.id, "failed", "invalid_answer").then(() => "failed");
  }
  if (parsed.discarded > 0) log.warn({ jobId: job.id, discarded: parsed.discarded }, "doc di prodotto: fatti fuori schema scartati");

  const byPage = new Map<string, ProductFact[]>();
  for (const f of parsed.facts) byPage.set(f.pageId, [...(byPage.get(f.pageId) ?? []), f]);
  for (const [pageId, facts] of byPage) {
    const page = pages.find((pg) => pg.id === pageId)!;
    const written = await writeClaudeFacts(db, { projectId: job.projectId, pageId, facts, source: { kind: job.sourceKind, id: job.sourceId }, ownerId: source.ownerId, arrivedSeq: page.revSeq });
    if (written.kind === "section_busy") {
      // Una persona scrive in quella sezione: il lavoro aspetta e riprova (come `productPending`).
      log.info?.({ jobId: job.id, pageId, sectionId: written.sectionId }, "doc di prodotto: una sezione è presa da una persona, si riprova");
      return hold(db, job.id, "section_busy").then(() => "held");
    }
    if (written.kind === "page_gone") {
      log.warn({ jobId: job.id, pageId }, "doc di prodotto: la pagina non c'è più");
      continue;
    }
    for (const o of written.outcomes) if (o.kind === "none") log.warn({ jobId: job.id, pageId, factId: o.factId, why: o.why }, "doc di prodotto: un fatto senza effetto");
  }
  return finish(db, job.id, "done").then(() => "done");
}

/** Prende il lavoro più vecchio in coda (`FOR UPDATE SKIP LOCKED`). */
export async function claimProductDocJob(db: Db): Promise<JobRow | null> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.select().from(productDocJobs).where(eq(productDocJobs.status, "queued")).orderBy(asc(productDocJobs.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    const [claimed] = await tx
      .update(productDocJobs)
      .set({ status: "running", attempts: sql`${productDocJobs.attempts} + 1`, startedAt: new Date(), heldReason: null })
      .where(eq(productDocJobs.id, row.id))
      .returning();
    return claimed ?? null;
  });
}

/**
 * I lavori fermi tornano in coda per riprovare: `section_busy` dopo 30 s (la
 * presa scade a 15 s), gli altri motivi dopo 5 minuti (al prossimo tentativo,
 * se il motivo c'è ancora, si fermano di nuovo). Un `running` di un worker
 * morto torna in coda dopo 15 minuti.
 */
export async function requeueProductDocJobs(db: Db, now = new Date()): Promise<void> {
  await db
    .update(productDocJobs)
    .set({ status: "queued", heldReason: null })
    .where(
      sql`(${productDocJobs.status} = 'held' and ${productDocJobs.heldReason} = 'section_busy' and ${productDocJobs.finishedAt} < ${new Date(now.getTime() - 30_000).toISOString()}::timestamptz)
        or (${productDocJobs.status} = 'held' and ${productDocJobs.heldReason} <> 'section_busy' and ${productDocJobs.finishedAt} < ${new Date(now.getTime() - 300_000).toISOString()}::timestamptz)`,
    );
  await db
    .update(productDocJobs)
    .set({ status: "queued" })
    .where(and(eq(productDocJobs.status, "running"), lt(productDocJobs.startedAt, new Date(now.getTime() - 15 * 60_000))));
}

/** Un giro: le soste da riprovare, poi un lavoro, sotto il serializer del suo progetto. */
export async function pollProductDocsOnce(deps: ProductDocJobDeps & { serializer: ProjectSerializer }): Promise<ProductDocJobOutcome | null> {
  await requeueProductDocJobs(deps.db);
  const job = await claimProductDocJob(deps.db);
  if (!job) return null;
  try {
    return await deps.serializer.run(job.projectId, () => runProductDocJob(deps, job));
  } catch (error) {
    deps.log.warn({ err: error, jobId: job.id }, "doc di prodotto: lavoro non riuscito");
    // Un errore inatteso si riprova (fino al tetto dei tentativi), poi fallisce.
    await (job.attempts >= PRODUCT_DOC_MAX_ATTEMPTS ? finish(deps.db, job.id, "failed", "error") : deps.db.update(productDocJobs).set({ status: "queued" }).where(eq(productDocJobs.id, job.id))).catch(() => undefined);
    return "failed";
  }
}

export function startProductDocsPoller(opts: ProductDocJobDeps & { serializer: ProjectSerializer; intervalSeconds: number; signal: AbortSignal }): () => void {
  if (opts.intervalSeconds <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void pollProductDocsOnce(opts).finally(() => {
      running = false;
    });
  }, opts.intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
