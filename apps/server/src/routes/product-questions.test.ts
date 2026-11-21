import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { backlogJobs, createRequestItem, productClaudeMarks, productRequestOrigins, productComments, productDocJobs, productPageRevisions, productSectionHolds, projectDecisions } from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeClaudeFacts } from "@stubwise/notifications";
import type { ProductCommentsView, ProductFact, ProductOpenQuestion, ProductPageView, ProductQuestionView, ProductRevisionView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { SERVER_CATALOG, parseArgs } from "../claude-actions/catalog.js";
import { answerProductQuestion, checkProductDocOrigin } from "../services/product-questions.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F5, Task 4 — le domande di Claude: come le legge chi guarda, la
// risposta (una sola), le domande aperte. Le domande le scrive lo scrittore
// VERO (`writeClaudeFacts`), come il worker.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let bea: U;
let vic: U;
let admin: U;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  const seeded = await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
    ada = await createUserWithSession(app, "ada-q@example.com");
  bea = await createUserWithSession(app, "bea-q@example.com");
  vic = await createUserWithSession(app, "vic-q@example.com");
  admin = { id: seeded.adminId, headers: { cookie: seeded.adminCookie } };
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, bea.id, "developer");
  await addMember(app, projectId, vic.id, "viewer");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const rich = (text: string) => ({ text, marks: [] });
const para = (id: string, text: string) => ({ id, type: "paragraph", content: rich(text) });
const h2 = (id: string, text: string) => ({ id, type: "heading", level: 2, content: rich(text) });

/** Una pagina con due frasi nella sezione A e una nella B. */
async function page() {
  const created = (await inject(ada, "POST", `/api/projects/${projectId}/product/pages`, { title: `Q ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(ada, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const top = view.blocks[0]!.id as string;
  const ids = { hA: `blk-${randomUUID()}`, a1: `blk-${randomUUID()}`, a2: `blk-${randomUUID()}`, hB: `blk-${randomUUID()}`, b1: `blk-${randomUUID()}` };
  const ops = [
    { op: "insert", afterId: top, block: h2(ids.hA, "A") },
    { op: "insert", afterId: ids.hA, block: para(ids.a1, "a uno") },
    { op: "insert", afterId: ids.a1, block: para(ids.a2, "a due") },
    { op: "insert", afterId: ids.a2, block: h2(ids.hB, "B") },
    { op: "insert", afterId: ids.hB, block: para(ids.b1, "b uno") },
  ];
  expect((await inject(ada, "POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops })).statusCode).toBe(200);
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  return { ...created, ids };
}
type Page = Awaited<ReturnType<typeof page>>;

const state = async (p: { code: string }) => (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
const textOf = async (p: { code: string }, id: string) => ((await state(p)).blocks.find((b) => b.id === id) as { content: { text: string } } | undefined)?.content.text;

async function decision() {
  const [d] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `k-${randomUUID()}`, title: "Si paga a 60 giorni", decision: "sì", decidedByUserId: ada.id } as typeof projectDecisions.$inferInsert).returning();
  await t.db.delete(productDocJobs).where(eq(productDocJobs.sourceId, d!.id));
  return d!;
}

/** Un «forse» su a1: una domanda `vague` con «Update it», «Keep it» e «Open a request». */
async function vagueQuestion(p: Page, source?: { kind: "decision" | "email"; id: string }, extra: Partial<ProductFact> = {}) {
  const src = source ?? { kind: "decision" as const, id: (await decision()).id };
  const fact: ProductFact = {
    id: `f-${randomUUID().slice(0, 6)}`,
    pageId: p.id,
    anchorId: p.ids.a1,
    change: { kind: "replace", text: rich("a UNO, forse") },
    clarity: "vague",
    options: { request: { title: "Chiarire a uno", description: "Il cliente dice forse" } },
    ...extra,
  };
  const out = await writeClaudeFacts(t.db, { projectId, pageId: p.id, facts: [fact], source: src, ownerId: ada.id, arrivedSeq: (await state(p)).seq });
  expect(out.kind).toBe("written");
  const q = (out as { outcomes: { kind: string; commentId?: string }[] }).outcomes.find((o) => o.kind === "question");
  expect(q, JSON.stringify(out)).toBeDefined();
  return q!.commentId!;
}

const questionOf = async (who: U, p: { id: string }, commentId: string): Promise<ProductQuestionView> => {
  const res = await inject(who, "GET", `/api/product-pages/${p.id}/comments`);
  expect(res.statusCode, res.body).toBe(200);
  const view = res.json() as ProductCommentsView;
  const thread = [...view.open, ...view.resolved].find((th) => th.root.id === commentId)!;
  return thread.root.question!;
};
const answer = (who: U, commentId: string, option: string) => inject(who, "POST", `/api/product-comments/${commentId}/answer`, { option });

describe("leggere una domanda", () => {
  it("la fonte vista, la frase di adesso, le risposte col consiglio per primo, «Update it» acceso", async () => {
    const p = await page();
    const d = await decision();
    const id = await vagueQuestion(p, { kind: "decision", id: d.id });
    const q = await questionOf(bea, p, id);
    expect(q).toMatchObject({
      reason: "vague",
      applyMode: "replace",
      current: { text: "a uno" },
      apply: { text: "a UNO, forse" },
      request: { title: "Chiarire a uno" },
      canAnswer: true,
      applyBlocked: null,
      answer: null,
    });
    expect(q.source).toMatchObject({ kind: "decision", canOpen: true, id: d.id, title: "Si paga a 60 giorni" });
    expect(q.options[0]).toBe(q.recommended);
    expect([...q.options].sort()).toEqual(["apply", "keep", "request"]);
    // Senza docs.edit si legge, non si risponde.
    expect((await questionOf(vic, p, id)).canAnswer).toBe(false);
  });

  it("un'email di un altro: nessun oggetto né id, per Bea E per l'admin (N-2 = a); il titolare la apre", async () => {
    const p = await page();
    const mail = await seedEmailMessage(t.db, { userId: ada.id, subject: "Pagamenti riservati" });
    const id = await vagueQuestion(p, { kind: "email", id: mail.messageId });
    expect((await questionOf(ada, p, id)).source).toMatchObject({ canOpen: true, id: mail.messageId, title: "Pagamenti riservati" });
    for (const who of [bea, admin]) {
      const res = await inject(who, "GET", `/api/product-pages/${p.id}/comments`);
      // MAI il riferimento grezzo: né l'oggetto né l'id del messaggio in tutta la risposta.
      expect(res.body).not.toContain("Pagamenti riservati");
      expect(res.body).not.toContain(mail.messageId);
      expect((await questionOf(who, p, id)).source).toMatchObject({ kind: "email", canOpen: false, id: null, title: null, ownerId: ada.id, ownerName: "ada-q" });
    }
    const open = await inject(admin, "GET", `/api/me/product-questions?pageId=${p.id}`);
    expect(open.statusCode).toBe(200);
    expect(open.body).not.toContain("Pagamenti riservati");
    expect(open.body).not.toContain(mail.messageId);
  });

  it("«Open a request» c'è quando il fatto ha una richiesta da proporre, e da /answer è 422: passa da createRequest", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    expect((await questionOf(bea, p, id)).options).toContain("request");
    const res = await answer(bea, id, "request");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "request_via_create_request" });
    expect((await t.db.select().from(productComments).where(eq(productComments.id, id)))[0]!.answer).toBeNull();
  });
});

describe("rispondere", () => {
  it("«Keep it» chiude senza revisioni; la seconda risposta è 409 already_answered con chi; senza docs.edit 403", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const seq = (await state(p)).seq;
    expect((await answer(vic, id, "keep")).statusCode).toBe(403);
    const res = await answer(bea, id, "keep");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ revisionId: null, seq: null });
    expect((await state(p)).seq).toBe(seq);
    const q = await questionOf(ada, p, id);
    expect(q).toMatchObject({ canAnswer: false, answer: { byId: bea.id, byName: "bea-q", option: "keep", revisionId: null } });
    const again = await answer(ada, id, "apply");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already_answered", byId: bea.id, byName: "bea-q" });
    expect(await textOf(p, p.ids.a1)).toBe("a uno");
  });

  it("«Update it» scrive la frase con una revisione `edit` di chi risponde, senza via né segni; la cronologia porta answerOf", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const res = await answer(bea, id, "apply");
    expect(res.statusCode, res.body).toBe(200);
    const { revisionId } = res.json() as { revisionId: string };
    expect(await textOf(p, p.ids.a1)).toBe("a UNO, forse");
    const [rev] = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.id, revisionId));
    expect(rev).toMatchObject({ kind: "edit", actorId: bea.id, via: null, sourceKind: null });
    expect(await t.db.select().from(productClaudeMarks).where(eq(productClaudeMarks.pageId, p.id))).toEqual([]);
    const history = (await inject(ada, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[];
    expect(history.find((r) => r.id === revisionId)).toMatchObject({ answerOf: id });
    expect(history.filter((r) => r.id !== revisionId).every((r) => r.answerOf === null)).toBe(true);
    expect(await questionOf(ada, p, id)).toMatchObject({ answer: { option: "apply", revisionId } });
    // La domanda si è chiusa: «Resolve» e «Reopen» non la toccano.
    expect((await inject(bea, "POST", `/api/product-comments/${id}/reopen`)).statusCode).toBe(422);
  });

  it("toccata da una persona dopo la domanda: «Update it» spento (chi), 409 changed_after; «Keep it» resta", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const seq = (await state(p)).seq;
    const edit = await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "s-ada", baseSeq: seq, ops: [{ op: "set", block: para(p.ids.a1, "a uno di Ada") }] });
    expect(edit.statusCode, edit.body).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    const q = await questionOf(bea, p, id);
    expect(q.applyBlocked).toEqual({ byId: ada.id, byName: "ada-q" });
    expect(q.current).toMatchObject({ text: "a uno di Ada" });
    const res = await answer(bea, id, "apply");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "changed_after", byId: ada.id, byName: "ada-q" });
    expect(await textOf(p, p.ids.a1)).toBe("a uno di Ada");
    expect((await t.db.select().from(productComments).where(eq(productComments.id, id)))[0]!.answer).toBeNull();
    // «Keep it» e «Open a request» restano.
    expect((await answer(bea, id, "keep")).statusCode).toBe(200);
  });

  it("un'altra frase cambiata dopo la domanda non spegne «Update it»", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const seq = (await state(p)).seq;
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "s-ada", baseSeq: seq, ops: [{ op: "set", block: para(p.ids.b1, "b uno di Ada") }] })).statusCode).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    expect((await questionOf(bea, p, id)).applyBlocked).toBeNull();
    expect((await answer(bea, id, "apply")).statusCode).toBe(200);
  });

  it("la sezione presa da un'altra persona: 409 section_busy, niente scritto, la domanda resta aperta", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const beat = await inject(ada, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: p.ids.hA });
    expect(beat.statusCode, beat.body).toBe(200);
    const res = await answer(bea, id, "apply");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "section_busy" });
    expect(await textOf(p, p.ids.a1)).toBe("a uno");
    expect((await t.db.select().from(productComments).where(eq(productComments.id, id)))[0]!.answer).toBeNull();
  });

  it("«Update it» di un blocco nuovo (insert) lo aggiunge dopo l'ancora con un id nuovo", async () => {
    const p = await page();
    const modelId = `blk-${randomUUID()}`;
    const id = await vagueQuestion(p, undefined, { change: { kind: "insert_after", block: para(modelId, "una frase nuova") as never } });
    const q = await questionOf(bea, p, id);
    expect(q).toMatchObject({ applyMode: "insert", current: null, apply: { text: "una frase nuova" } });
    expect((await answer(bea, id, "apply")).statusCode).toBe(200);
    const blocks = (await state(p)).blocks;
    const at = blocks.findIndex((b) => b.id === p.ids.a1);
    expect(blocks[at + 1]).toMatchObject({ type: "paragraph", content: { text: "una frase nuova" } });
    expect(blocks[at + 1]!.id).not.toBe(modelId);
  });

  it("due risposte insieme: una sola passa, l'altra è 409 already_answered", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const results = await Promise.allSettled([answerProductQuestion(t.db, { id: bea.id, instancePermissions: new Set() }, id, "keep"), answerProductQuestion(t.db, { id: ada.id, instancePermissions: new Set() }, id, "apply")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "already_answered" } });
  });

  it("il servizio richiede docs.edit da sé (non solo la rotta)", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    await expect(answerProductQuestion(t.db, { id: vic.id, instancePermissions: new Set() }, id, "keep")).rejects.toMatchObject({ status: 403 });
  });
});

describe("«Open a request»: createRequest con l'origine della domanda", () => {
  const origin = (p: Page, questionId: string) => ({ kind: "product_doc", pageId: p.id, anchorId: p.ids.a1, questionId });
  const create = (who: U, p: Page, questionId: string, projectOf = projectId) =>
    inject(who, "POST", "/api/requests", { projectId: projectOf, title: "Chiarire a uno", description: "Il cliente dice forse", origin: origin(p, questionId) });
  const jobsOf = async () => (await t.db.select({ id: backlogJobs.id }).from(backlogJobs).where(eq(backlogJobs.projectId, projectId))).length;

  it("la richiesta nasce (il job d'intake) e la domanda si chiude nella stessa scrittura; la voce e il codice si derivano dal job", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const res = await create(bea, p, id);
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const [row] = await t.db.select().from(productComments).where(eq(productComments.id, id));
    expect(row!.answer).toMatchObject({ byId: bea.id, option: "request", requestJobId: jobId, revisionId: null });
    expect(row!.resolvedBy).toBe(bea.id);
    // Finché l'intake non ha finito la voce non c'è ancora.
    expect((await questionOf(bea, p, id)).answer).toMatchObject({ option: "request", requestId: null, requestCode: null });
    // L'intake ha finito: la voce (nuova o fusa) è quella del job.
    const itemId = await createRequestItem(t.db, { projectId, title: "Chiarire a uno", document: "x", requesterId: bea.id, estimate: false });
    await t.db.update(backlogJobs).set({ status: "done", resultItemId: itemId }).where(eq(backlogJobs.id, jobId));
    expect((await questionOf(bea, p, id)).answer).toMatchObject({ requestId: itemId, requestCode: expect.stringMatching(/-R\d+$/) });
    expect(await textOf(p, p.ids.a1)).toBe("a uno");
    // F6: l'origine si salva con la domanda, e la richiesta dice da quale pagina nasce.
    expect(await t.db.select().from(productRequestOrigins).where(eq(productRequestOrigins.intakeJobId, jobId))).toEqual([expect.objectContaining({ pageId: p.id, anchorId: p.ids.a1, questionId: id, createdBy: bea.id })]);
    expect(((await inject(bea, "GET", `/api/requests/${itemId}`)).json() as { productOrigin: unknown }).productOrigin).toMatchObject({ pageId: p.id });
  });

  it("rifiutata PRIMA che la richiesta nasca: domanda già risposta (409 con chi), di un'altra pagina o di un altro progetto (422)", async () => {
    const p = await page();
    const other = await page();
    const id = await vagueQuestion(p);
    const before = await jobsOf();
    // La domanda è di `p`, l'origine dice `other`.
    expect((await inject(bea, "POST", "/api/requests", { projectId, title: "T", description: "", origin: { ...origin(other, id) } })).json()).toMatchObject({ code: "invalid_origin" });
    const { projectId: elsewhere } = await seedRepository(t.db);
    await addMember(app, elsewhere, bea.id, "developer");
    const cross = await create(bea, p, id, elsewhere);
    expect(cross.statusCode).toBe(422);
    expect(cross.json()).toMatchObject({ code: "invalid_origin" });
    expect(await jobsOf()).toBe(before);
    expect((await answer(ada, id, "keep")).statusCode).toBe(200);
    const late = await create(bea, p, id);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: "already_answered", byId: ada.id, byName: "ada-q" });
    expect(await jobsOf()).toBe(before);
  });

  it("una domanda senza richiesta da proporre è 422 invalid_origin; senza docs.edit 403 (il controllo, non solo la rotta)", async () => {
    const p = await page();
    const id = await vagueQuestion(p, undefined, { options: {} });
    const res = await create(bea, p, id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_origin" });
    const withRequest = await vagueQuestion(p);
    await expect(t.db.transaction((tx) => checkProductDocOrigin(tx as never, { id: vic.id, instancePermissions: new Set() }, projectId, origin(p, withRequest) as never))).rejects.toMatchObject({ status: 403 });
  });

  it("dal catalogo di Claude (la scheda B confermata): la stessa regola, e la domanda si chiude col job", async () => {
    const p = await page();
    const id = await vagueQuestion(p);
    const entry = SERVER_CATALOG.get("createRequest")!;
    const args = parseArgs("createRequest", { projectId, title: "Chiarire a uno", description: "d", origin: origin(p, id) })!;
    expect(args).not.toBeNull();
    const user = { id: bea.id, instancePermissions: new Set() } as never;
    const ok = await t.db.transaction((tx) => entry.run(tx as never, user, args, new Set(), {}));
    expect(ok.ok).toBe(true);
    expect((await t.db.select().from(productComments).where(eq(productComments.id, id)))[0]!.answer).toMatchObject({ option: "request", byId: bea.id });
    const again = await t.db.transaction((tx) => entry.run(tx as never, user, args, new Set(), {}));
    expect(again).toMatchObject({ ok: false, refusal: { code: "conflict" } });
  });
});

describe("le domande aperte", () => {
  it("chi ha docs.edit le vede (con la pagina); chi legge soltanto no; una risposta la toglie; pageId restringe", async () => {
    const p = await page();
    const other = await page();
    const id = await vagueQuestion(p);
    const otherId = await vagueQuestion(other);
    const mine = (await inject(bea, "GET", `/api/me/product-questions`)).json() as ProductOpenQuestion[];
    expect(mine.map((q) => q.commentId)).toEqual(expect.arrayContaining([id, otherId]));
    // `quote`: la frase del commento-domanda (`c.quote` del prototipo), anche per una domanda che inserisce.
    expect(mine.find((q) => q.commentId === id)).toMatchObject({ pageId: p.id, pageCode: p.code, projectId, anchorId: p.ids.a1, quote: "a uno", question: { reason: "vague", canAnswer: true } });
    expect((await inject(vic, "GET", `/api/me/product-questions`)).json()).toEqual([]);
    const onPage = (await inject(bea, "GET", `/api/me/product-questions?pageId=${p.id}`)).json() as ProductOpenQuestion[];
    expect(onPage.map((q) => q.commentId)).toEqual([id]);
    expect((await answer(bea, id, "keep")).statusCode).toBe(200);
    expect(((await inject(bea, "GET", `/api/me/product-questions?pageId=${p.id}`)).json() as ProductOpenQuestion[])).toEqual([]);
  });
});
