import { mkdtemp, rm } from "node:fs/promises";
import { budgetBypassHolds } from "./budget-bypass.js";
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
  productFirstVersions,
  productPageUpdates,
  productPages,
  productWireframes,
  projectDecisions,
  projects,
  releases,
  ticketEvents,
  tickets,
  type Db,
} from "@stubwise/db";
import { aiBudgetState, failFirstVersion, projectPermissionsByProject, writeClaudeFacts } from "@stubwise/notifications";
import { productBlockSchema, productFactSchema, productSearchText, type ProductBlock, type ProductFact } from "@stubwise/shared";
import { and, asc, desc, eq, lt, ne, sql } from "drizzle-orm";
import { NATIVE_TOOLS } from "../agent/native-tools.js";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
import { textFromRun } from "../agent/text.js";
import type { ProjectSerializer } from "../handler.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { limitTextOfRun, runWithProviders, type SelectDeps } from "../providers/select.js";
import { runFirstVersionJob } from "./first-version.js";
import { notifyWireframe, runWireframeJob } from "./wireframe.js";
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
 * - Revisione di F5: un lavoro ripreso (una sosta, un errore, un worker
 *   morto) NON richiama il modello: i fatti stanno sulla riga (`facts`), e le
 *   pagine già scritte (`pages_done`, segnate nella transazione dello
 *   scrittore) non si riscrivono. Il claim salta i progetti in pausa, i
 *   lavori che aspettano (`not_before`) e i progetti che hanno già avuto
 *   {@link PRODUCT_DOC_HOURLY_MAX} risposte nell'ultima ora (il freno alle
 *   ondate); un giro prende più progetti senza aspettare un serializer
 *   occupato. `attempts` conta solo gli errori. Il prompt porta al più le
 *   pagine più vicine alla fonte ({@link selectPromptPages}).
 * - Il titolare (per conto di chi Claude agisce) è chi ha la casella, chi ha
 *   registrato la decisione, chi ha CHIUSO la task, chi ha fatto il merge del
 *   rilascio (decisione del maintainer, 21 nov 2026); non noto vale come
 *   senza permesso (lo scrittore fa una domanda).
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
/** Il freno alle ondate: al più tante risposte del modello per progetto nell'ultima ora. */
export const PRODUCT_DOC_HOURLY_MAX = 20;
/** Quante pagine, e quanto testo, entrano al più nel prompt. */
export const PROMPT_PAGES_MAX = 12;
export const PROMPT_PAGES_CHARS = 48_000;
/** Quanti progetti al più per giro. */
const JOBS_PER_TICK = 3;
/** L'attesa prima di riprovare dopo un errore. */
const RETRY_DELAY_MS = 60_000;

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** La fonte di un lavoro, letta dal DB, col suo titolare; null = non c'è più, o non è leggibile per questo progetto. */
export async function readProductSource(db: Db, job: Pick<JobRow, "projectId" | "sourceKind" | "sourceId">): Promise<(PromptSource & { ownerId: string | null }) | null> {
  switch (job.sourceKind) {
    // La prima versione e le bozze hanno il loro lavoro (`first-version.ts`, `wireframe.ts`): qui non arrivano.
    case "first_version":
    case "wireframe":
    // Un aggiornamento chiesto a mano si legge dalla sua fonte vera (`runProductDocJob`).
    case "page_update":
      return null;
    case "email": {
      // N-2 = a: solo un messaggio AMMESSO, con una proposta per QUESTO progetto. Il titolare è chi ha la casella.
      const [m] = await db
        .select({ subject: emailMessages.subject, excerpt: emailMessages.textExcerpt, receivedAt: emailMessages.receivedAt, admitted: emailMessages.admitted, ownerId: googleAccounts.userId, body: emailBodies.bodyText })
        .from(emailMessages)
        .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
        // Una proposta scartata («Non fare nulla») non alimenta la doc.
        .innerJoin(emailProposals, and(eq(emailProposals.emailMessageId, emailMessages.id), eq(emailProposals.projectId, job.projectId), ne(emailProposals.status, "ignored")))
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
      // Il titolare è chi l'ha CHIUSA: l'ultimo cambio di stato (null = di sistema, o una persona eliminata).
      const [closed] = await db
        .select({ actorId: ticketEvents.actorId })
        .from(ticketEvents)
        .where(and(eq(ticketEvents.ticketId, job.sourceId), eq(ticketEvents.kind, "status_changed")))
        .orderBy(desc(ticketEvents.createdAt))
        .limit(1);
      return { kind: "task", title: `${t.code}-${t.number} ${t.title}`, text: t.body ?? "", at: null, ownerId: closed?.actorId ?? null };
    }
    case "release": {
      const [r] = await db.select({ title: releases.title, code: releases.code, at: releases.mergedAt, projectId: releases.projectId, by: releases.mergedBy }).from(releases).where(eq(releases.id, job.sourceId));
      if (!r || r.projectId !== job.projectId) return null;
      // Il titolare è chi ha fatto il merge (null = da fuori Stubwise: senza permesso).
      return { kind: "release", title: `${r.code} ${r.title}`, text: r.title, at: r.at.toISOString(), ownerId: r.by };
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

/**
 * Una sosta. `last_held_reason` tiene budget e pausa fino a `finish` (revisione,
 * M3): sono le soste che la card dice (`waited`) e le più gravi della riga
 * «riprende quando…»; un limite o una sezione presa dopo non le cancella.
 */
const hold = (db: Db, id: string, reason: "limit" | "budget" | "section_busy" | "paused") =>
  db
    .update(productDocJobs)
    .set({
      status: "held",
      heldReason: reason,
      lastHeldReason:
        reason === "limit" || reason === "section_busy"
          ? sql`case when ${productDocJobs.lastHeldReason} in ('budget', 'paused') then ${productDocJobs.lastHeldReason} else ${reason} end`
          : reason,
      finishedAt: new Date(),
    })
    .where(eq(productDocJobs.id, id));
/**
 * La sosta di una prima versione (revisione, M3): rilegge `stop_requested` con la
 * riga bloccata, nello stesso giro della sosta. Uno «Stop» arrivato mentre il
 * lavoro girava trova il lavoro `running` e segna solo lo stop: senza questa
 * rilettura il lavoro andrebbe `held` e la prima versione resterebbe «Stopping…»
 * fino al giro dopo. Stesso ordine dei lock di `stopFirstVersion` (prima la
 * prima versione, poi il lavoro): o la sosta vede lo stop, o lo «Stop» vede il
 * lavoro `held` e lo chiude da sé.
 */
const holdFirstVersion = (db: Db, id: string, firstVersionId: string, reason: "limit" | "budget"): Promise<"held" | "stopped"> =>
  db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [fv] = await tx.select({ stopRequested: productFirstVersions.stopRequested }).from(productFirstVersions).where(eq(productFirstVersions.id, firstVersionId)).for("update");
    if (fv?.stopRequested) return "stopped";
    await hold(tx, id, reason);
    return "held";
  });
const finish = (db: Db, id: string, status: "done" | "failed", error: string | null = null) =>
  db.update(productDocJobs).set({ status, heldReason: null, lastHeldReason: null, error, finishedAt: new Date() }).where(eq(productDocJobs.id, id));
/** Un errore: un tentativo in più, e si riprova dopo un'attesa; al tetto, fallisce. */
const retryOrFail = async (db: Db, job: Pick<JobRow, "id" | "attempts">, error: string): Promise<ProductDocJobOutcome> => {
  if (job.attempts + 1 >= PRODUCT_DOC_MAX_ATTEMPTS) {
    await db.update(productDocJobs).set({ attempts: job.attempts + 1 }).where(eq(productDocJobs.id, job.id));
    await finish(db, job.id, "failed", error);
    return "failed";
  }
  await db.update(productDocJobs).set({ status: "queued", attempts: job.attempts + 1, notBefore: new Date(Date.now() + RETRY_DELAY_MS) }).where(eq(productDocJobs.id, job.id));
  return "retry";
};

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);

/**
 * Le pagine che entrano nel prompt (revisione di F5, 8): le più vicine alla
 * fonte per parole in comune (titolo e testo), poi nell'ordine dell'albero,
 * fino a {@link PROMPT_PAGES_MAX} pagine e {@link PROMPT_PAGES_CHARS} caratteri;
 * almeno una. Un fatto su una pagina fuori da qui si scarta (`parseProductFacts`).
 */
export function selectPromptPages<P extends PromptPage>(source: PromptSource, pages: readonly P[]): P[] {
  const wanted = words(`${source.title}\n${source.text}`);
  const scored = pages.map((page, i) => {
    const text = productSearchText(page.title, page.blocks);
    let score = 0;
    for (const w of words(text)) if (wanted.has(w)) score += 1;
    return { page, i, score, size: Math.min(text.length, 8_000) + page.title.length };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out: P[] = [];
  let chars = 0;
  for (const s of scored) {
    if (out.length >= PROMPT_PAGES_MAX || (out.length > 0 && chars + s.size > PROMPT_PAGES_CHARS)) break;
    out.push(s.page);
    chars += s.size;
  }
  return out;
}

export type ProductDocJobOutcome = "done" | "held" | "failed" | "retry";

/** Il motivo di un lavoro della doc chiuso perché il progetto ha il modulo Docs spento. */
export const DOCS_MODULE_OFF = "docs_module_off";

/** UN lavoro (già preso, `running`). */
export async function runProductDocJob(deps: ProductDocJobDeps, job: JobRow): Promise<ProductDocJobOutcome> {
  const { db } = deps;
  const [p] = await db
    .select({ pausedAt: projects.queuePausedAt, docsOn: sql<boolean>`'docs' = any(${projects.modules})` })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  if (!p) return finish(db, job.id, "done", "project_gone").then(() => "done");
  // Il modulo Docs spento (revisione del lotto 1): il lavoro si chiude senza modello, col motivo. Una
  // prima versione finisce interrotta, una bozza di schermata fallita; `doc_auto_update` non si tocca.
  if (!p.docsOn) {
    if (job.sourceKind === "first_version") await failFirstVersion(db, job.sourceId, DOCS_MODULE_OFF);
    if (job.sourceKind === "wireframe") {
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [w] = await tx
          .update(productWireframes)
          .set({ status: "failed", error: DOCS_MODULE_OFF, updatedAt: new Date() })
          .where(and(eq(productWireframes.id, job.sourceId), eq(productWireframes.status, "drawing")))
          .returning({ id: productWireframes.id, pageId: productWireframes.pageId });
        if (w) await notifyWireframe(tx, w.pageId, w.id, "failed");
      });
    }
    return finish(db, job.id, "done", DOCS_MODULE_OFF).then(() => "done");
  }
  // La prima versione, le bozze e un aggiornamento chiesto a mano sono gesti di chi li ha chiesti: la pausa della coda non li ferma (P41, P48 del prototipo).
  const gesture = job.sourceKind === "first_version" || job.sourceKind === "wireframe" || job.sourceKind === "page_update";
  if (p.pausedAt && !gesture) return hold(db, job.id, "paused").then(() => "held");
  // Una bozza non aspetta: col budget o la quota finiti è `failed` col motivo (lo guarda lei, `wireframe.ts`).
  if (job.sourceKind === "wireframe") {
    return runWireframeJob(deps, job, {
      finish: (status, error = null) => finish(db, job.id, status, error).then(() => undefined),
      retryOrFail: (error) => retryOrFail(db, job, error),
    });
  }
  // La prima versione guarda il budget da sé, SOLO davanti al modello (revisione, I1): uno «Stop»
  // e le pagine di una bozza già pronta non costano, e col budget finito non devono aspettare.
  if (job.sourceKind === "first_version") {
    return runFirstVersionJob(deps, job, {
      finish: (status, error = null) => finish(db, job.id, status, error).then(() => undefined),
      hold: (reason) => holdFirstVersion(db, job.id, job.sourceId, reason),
      retryOrFail: (error) => retryOrFail(db, job, error),
    });
  }
  if (!(await budgetBypassHolds(db, job)) && (await aiBudgetState(db, deps.monthlyCostUsdFn)).exhausted) return hold(db, job.id, "budget").then(() => "held");

  // F6, Task 4: un aggiornamento chiesto a mano (`updateProductPage`) legge la
  // SUA fonte per UNA pagina, e chi l'ha chiesto non si aspetta da sé.
  if (job.sourceKind === "page_update") {
    const [u] = await db.select().from(productPageUpdates).where(eq(productPageUpdates.id, job.sourceId));
    if (!u) return finish(db, job.id, "done", "update_gone").then(() => "done");
    // Chi ha chiesto si ricontrolla qui, a ogni partenza (review di F6, M4): un
    // lavoro fermo può ripartire dopo ore, e la revoca vale a lettura.
    const refusal = await requesterRefusal(db, job.projectId, u);
    if (refusal !== null) {
      await db.update(productPageUpdates).set({ finishedAt: new Date() }).where(eq(productPageUpdates.id, u.id));
      return finish(db, job.id, "done", refusal).then(() => "done");
    }
    const out = await runSourceJob(deps, job, { kind: u.sourceKind, id: u.sourceId }, u.pageId, u.requestedBy);
    if (out === "done" || out === "failed") await db.update(productPageUpdates).set({ finishedAt: new Date() }).where(eq(productPageUpdates.id, u.id));
    return out;
  }
  return runSourceJob(deps, job, { kind: job.sourceKind as SourceRef["kind"], id: job.sourceId }, null, null);
}

/**
 * Perché chi ha chiesto un aggiornamento non può più (o null): `docs.edit` nel
 * progetto, e la fonte sua da aprire (`mailbox_owner`: la casella è sua, per
 * un'email o per la nota della riunione). Le stesse regole di
 * `requestProductPageUpdate` del server, rilette quando il lavoro parte.
 */
async function requesterRefusal(db: Db, projectId: string, u: typeof productPageUpdates.$inferSelect): Promise<string | null> {
  if (u.requestedBy === null) return "requester_gone";
  const perms = (await projectPermissionsByProject(db, u.requestedBy, [projectId])).get(projectId);
  if (perms?.has("docs.edit") !== true) return "requester_no_permission";
  const [owner] =
    u.sourceKind === "email"
      ? await db.select({ userId: googleAccounts.userId }).from(emailMessages).innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId)).where(eq(emailMessages.id, u.sourceId))
      : await db
          .select({ userId: googleAccounts.userId })
          .from(meetingNotes)
          .innerJoin(emailMessages, eq(emailMessages.id, meetingNotes.sourceMessageId))
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(eq(meetingNotes.id, u.sourceId));
  return owner?.userId === u.requestedBy ? null : "requester_cannot_open_source";
}

/** Una fonte che il modello legge (non la prima versione né una bozza, che hanno il loro lavoro). */
type SourceRef = { kind: Exclude<JobRow["sourceKind"], "first_version" | "wireframe" | "page_update">; id: string };

/** Il lavoro su UNA fonte (`ref`): tutte le pagine del progetto, o la sola `onlyPageId` (un aggiornamento chiesto a mano). */
async function runSourceJob(
  deps: ProductDocJobDeps,
  job: JobRow,
  ref: SourceRef,
  onlyPageId: string | null,
  requesterId: string | null,
): Promise<ProductDocJobOutcome> {
  const { db, log } = deps;
  const source = await readProductSource(db, { projectId: job.projectId, sourceKind: ref.kind, sourceId: ref.id });
  if (!source) {
    log.warn({ jobId: job.id, source: job.sourceKind }, "doc di prodotto: la fonte non c'è più o non è leggibile per il progetto");
    return finish(db, job.id, "done", "source_unavailable").then(() => "done");
  }
  const pages = (await projectPages(db, job.projectId)).filter((pg) => onlyPageId === null || pg.id === onlyPageId);
  if (pages.length === 0) return finish(db, job.id, "done", "no_pages").then(() => "done");

  // I fatti: già calcolati (un lavoro ripreso), o dal modello UNA volta.
  let facts: ProductFact[];
  if (Array.isArray(job.facts)) {
    facts = job.facts.flatMap((raw) => {
      const parsed = productFactSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  } else {
    const promptPages = selectPromptPages(source, pages);
    const prompt = buildProductDocPrompt(source, promptPages);
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
    if (text === null) return retryOrFail(db, job, "no_answer");
    const parsed = parseProductFacts(text, new Set(promptPages.map((pg) => pg.id)));
    if (parsed.invalid) {
      log.warn({ jobId: job.id }, "doc di prodotto: la risposta non è un oggetto JSON con i fatti");
      return finish(db, job.id, "failed", "invalid_answer").then(() => "failed");
    }
    if (parsed.discarded > 0) log.warn({ jobId: job.id, discarded: parsed.discarded }, "doc di prodotto: fatti fuori schema scartati");
    facts = parsed.facts;
    // Una volta sola: la ripresa riparte da qui, senza richiamare il modello.
    await db.update(productDocJobs).set({ facts: facts as unknown[], answeredAt: new Date() }).where(eq(productDocJobs.id, job.id));
  }

  const done = new Set(job.pagesDone);
  const markDone = (pageId: string) => (tx: Db) =>
    tx.update(productDocJobs).set({ pagesDone: sql`array_append(${productDocJobs.pagesDone}, ${pageId}::uuid)` }).where(eq(productDocJobs.id, job.id)).then(() => undefined);
  const byPage = new Map<string, ProductFact[]>();
  for (const f of facts) byPage.set(f.pageId, [...(byPage.get(f.pageId) ?? []), f]);
  for (const [pageId, pageFacts] of byPage) {
    // Già scritta da questo lavoro: non si riscrive (un insert duplicherebbe, un replace aprirebbe domande spurie).
    if (done.has(pageId)) continue;
    const page = pages.find((pg) => pg.id === pageId);
    if (!page) {
      log.warn({ jobId: job.id, pageId }, "doc di prodotto: la pagina non c'è più");
      await markDone(pageId)(db);
      continue;
    }
    const written = await writeClaudeFacts(db, {
      projectId: job.projectId,
      pageId,
      facts: pageFacts,
      source: ref,
      ownerId: source.ownerId,
      arrivedSeq: page.revSeq,
      onWritten: markDone(pageId),
      requesterId,
      // L'ultima sosta del lavoro, se è una che la card dice (budget o pausa; il limite e la sezione presa no).
      waited: job.lastHeldReason === "budget" || job.lastHeldReason === "paused" ? job.lastHeldReason : null,
    });
    if (written.kind === "section_busy") {
      // Una persona scrive in quella sezione: il lavoro aspetta e riprova (come `productPending`), senza modello.
      log.info?.({ jobId: job.id, pageId, sectionId: written.sectionId }, "doc di prodotto: una sezione è presa da una persona, si riprova");
      return hold(db, job.id, "section_busy").then(() => "held");
    }
    if (written.kind === "page_gone") {
      log.warn({ jobId: job.id, pageId }, "doc di prodotto: la pagina non c'è più");
      await markDone(pageId)(db);
      continue;
    }
    for (const o of written.outcomes) if (o.kind === "none") log.warn({ jobId: job.id, pageId, factId: o.factId, why: o.why }, "doc di prodotto: un fatto senza effetto");
  }
  return finish(db, job.id, "done").then(() => "done");
}

/**
 * Prende il lavoro in coda più vecchio (`FOR UPDATE SKIP LOCKED`), saltando
 * i progetti in pausa, quelli in `exclude` (un lavoro della doc già in corso),
 * i lavori che aspettano (`not_before`) e i progetti col freno alle ondate.
 * Il claim NON conta un tentativo (`attempts` conta solo gli errori).
 */
export async function claimProductDocJob(db: Db, exclude: readonly string[] = [], opts: { onlyBypass?: boolean } = {}): Promise<JobRow | null> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const excluded = exclude.length > 0 ? sql`and not (j.project_id = any(${`{${exclude.join(",")}}`}::uuid[]))` : sql``;
    const bypassOnly = opts.onlyBypass ? sql`and j.budget_bypass` : sql``;
    const picked = await tx.execute<{ id: string }>(sql`
      select j.id from product_doc_jobs j
      join projects p on p.id = j.project_id
      where j.status = 'queued' and (p.queue_paused_at is null or j.source_kind in ('first_version', 'wireframe', 'page_update'))
        and (j.not_before is null or j.not_before <= now())
        and (select count(*) from product_doc_jobs h where h.project_id = j.project_id and h.answered_at > now() - interval '1 hour') < ${PRODUCT_DOC_HOURLY_MAX}
        ${excluded}
        ${bypassOnly}
      order by j.created_at
      limit 1
      for update of j skip locked`);
    const id = (picked as unknown as { id: string }[])[0]?.id;
    if (!id) return null;
    const [claimed] = await tx
      .update(productDocJobs)
      .set({ status: "running", startedAt: new Date(), heldReason: null, notBefore: null })
      .where(eq(productDocJobs.id, id))
      .returning();
    return claimed ?? null;
  });
}

/**
 * I lavori fermi tornano in coda per riprovare: `section_busy` dopo 30 s (la
 * presa scade a 15 s), `limit` e `budget` dopo 5 minuti (al prossimo
 * tentativo, se il motivo c'è ancora, si fermano di nuovo), `paused` SOLO
 * quando il progetto non è più in pausa. Un `running` di un worker morto
 * torna in coda dopo 15 minuti.
 */
export async function requeueProductDocJobs(db: Db, now = new Date()): Promise<void> {
  await db
    .update(productDocJobs)
    .set({ status: "queued", heldReason: null })
    .where(
      sql`(${productDocJobs.status} = 'held' and ${productDocJobs.heldReason} = 'section_busy' and ${productDocJobs.finishedAt} < ${new Date(now.getTime() - 30_000).toISOString()}::timestamptz)
        or (${productDocJobs.status} = 'held' and ${productDocJobs.heldReason} in ('limit', 'budget') and ${productDocJobs.finishedAt} < ${new Date(now.getTime() - 300_000).toISOString()}::timestamptz)
        or (${productDocJobs.status} = 'held' and ${productDocJobs.heldReason} = 'paused' and exists (select 1 from projects p where p.id = ${productDocJobs.projectId} and p.queue_paused_at is null))`,
    );
  await db
    .update(productDocJobs)
    .set({ status: "queued" })
    .where(and(eq(productDocJobs.status, "running"), lt(productDocJobs.startedAt, new Date(now.getTime() - 15 * 60_000))));
}

/**
 * Un giro: le soste da riprovare, poi fino a {@link JOBS_PER_TICK} lavori di
 * progetti DIVERSI, ognuno sotto il serializer del suo progetto. Non li
 * aspetta: restituisce le loro promise (i test le aspettano). Un progetto in
 * `inFlight` (un suo lavoro gira) si salta, così un fix lungo su un progetto
 * non ferma la doc degli altri. Col budget del mese finito prende solo i
 * lavori chiesti da chi lo scavalca (`budget_bypass`, D-7.1).
 */
export async function pollProductDocsOnce(deps: ProductDocJobDeps & { serializer: ProjectSerializer; inFlight?: Set<string> }): Promise<Promise<ProductDocJobOutcome>[]> {
  await requeueProductDocJobs(deps.db);
  // Col budget finito si prendono SOLO i lavori chiesti da chi lo scavalca
  // (`budget_bypass`, D-7.1); gli altri restano in coda.
  const onlyBypass = (await aiBudgetState(deps.db, deps.monthlyCostUsdFn)).exhausted;
  const inFlight = deps.inFlight ?? new Set<string>();
  const started: Promise<ProductDocJobOutcome>[] = [];
  for (let i = 0; i < JOBS_PER_TICK; i++) {
    const job = await claimProductDocJob(deps.db, [...inFlight], { onlyBypass });
    if (!job) break;
    inFlight.add(job.projectId);
    started.push(
      deps.serializer
        .run(job.projectId, () => runProductDocJob(deps, job))
        .catch(async (error: unknown) => {
          deps.log.warn({ err: error, jobId: job.id }, "doc di prodotto: lavoro non riuscito");
          // Un errore inatteso si riprova (fino al tetto dei tentativi), poi fallisce.
          return retryOrFail(deps.db, job, "error").catch(() => "failed" as const);
        })
        .finally(() => inFlight.delete(job.projectId)),
    );
  }
  return started;
}

export function startProductDocsPoller(opts: ProductDocJobDeps & { serializer: ProjectSerializer; intervalSeconds: number; signal: AbortSignal }): () => void {
  if (opts.intervalSeconds <= 0) return () => {};
  let claiming = false;
  // I progetti con un lavoro della doc in corso: un giro non li riprende, e non li aspetta.
  const inFlight = new Set<string>();
  const timer = setInterval(() => {
    if (claiming) return;
    claiming = true;
    void pollProductDocsOnce({ ...opts, inFlight }).finally(() => {
      claiming = false;
    });
  }, opts.intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
