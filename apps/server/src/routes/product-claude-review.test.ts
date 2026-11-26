import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { backlogJobs, productClaudeMarks, productComments, productDocJobs, productSectionHolds, projectDecisions } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeClaudeFacts } from "@stubwise/notifications";
import type { ProductFact, ProductMarkView, ProductOpenQuestion, ProductPageView, ProductRevisionView, ProductSpaceView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Revisione di F5 (46, 21 nov 2026) e di R11-5: «Undo» come il prototipo
// (`marks.ts`, `anchorUndo`), «Update it» con le regole delle persone, e i
// minori del server.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let bea: U;
let vic: U;
let cora: U;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ada = await createUserWithSession(app, "ada-rv@example.com");
  bea = await createUserWithSession(app, "bea-rv@example.com");
  vic = await createUserWithSession(app, "vic-rv@example.com");
  cora = await createUserWithSession(app, "cora-rv@example.com");
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, bea.id, "developer");
  await addMember(app, projectId, vic.id, "viewer");
  await addMember(app, projectId, cora.id, "contributor");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const rich = (text: string) => ({ text, marks: [] });
const para = (id: string, text: string) => ({ id, type: "paragraph", content: rich(text) });

async function page() {
  const created = (await inject(ada, "POST", `/api/projects/${projectId}/product/pages`, { title: `R ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(ada, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const ids = { a1: `blk-${randomUUID()}`, a2: `blk-${randomUUID()}` };
  const ops = [
    { op: "insert", afterId: view.blocks[0]!.id, block: para(ids.a1, "a uno") },
    { op: "insert", afterId: ids.a1, block: para(ids.a2, "a due") },
  ];
  expect((await inject(ada, "POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops })).statusCode).toBe(200);
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  return { ...created, ids };
}
type Page = Awaited<ReturnType<typeof page>>;
const state = async (p: Page) => (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
const textOf = async (p: Page, id: string) => ((await state(p)).blocks.find((b) => b.id === id) as { content: { text: string } } | undefined)?.content.text;
const marksOf = async (who: U, p: Page) => (await inject(who, "GET", `/api/product-pages/${p.id}/marks`)).json() as ProductMarkView[];
async function decision() {
  const [d] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `k-${randomUUID()}`, title: "D", decision: "sì", decidedByUserId: ada.id } as typeof projectDecisions.$inferInsert).returning();
  await t.db.delete(productDocJobs).where(eq(productDocJobs.sourceId, d!.id));
  return { kind: "decision" as const, id: d!.id };
}
async function claude(p: Page, facts: ProductFact[], source?: { kind: "decision" | "task"; id: string }) {
  const out = await writeClaudeFacts(t.db, { projectId, pageId: p.id, facts, source: source ?? (await decision()), ownerId: ada.id, arrivedSeq: (await state(p)).seq });
  expect(out.kind).toBe("written");
  return out as { revisionId: string; outcomes: { kind: string; commentId?: string }[] };
}
const edits = (p: Page): ProductFact[] => [
  { id: "f1", pageId: p.id, anchorId: p.ids.a1, change: { kind: "replace", text: rich("a UNO") }, clarity: "clear", before: rich("a uno") },
  { id: "f2", pageId: p.id, anchorId: p.ids.a2, change: { kind: "replace", text: rich("a DUE") }, clarity: "clear", before: rich("a due") },
];

describe("A. «Undo» dopo «Looks good», come il prototipo", () => {
  it("un segno accettato si annulla lo stesso; «Undo all» con un segno accettato e uno aperto annulla entrambi", async () => {
    const p = await page();
    const { revisionId } = await claude(p, edits(p));
    const [m1] = (await marksOf(bea, p)).filter((m) => m.anchorId === p.ids.a1);
    expect((await inject(bea, "POST", `/api/product-marks/${m1!.id}/looks-good`)).statusCode).toBe(204);
    // La cronologia: «Undo» acceso su entrambe le ancore, e l'id del segno per ancora.
    const rev = ((await inject(bea, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[]).find((r) => r.id === revisionId)!;
    expect(rev.undoByAnchor[p.ids.a1]).toMatchObject({ enabled: true });
    expect(rev.markIdByAnchor[p.ids.a1]).toBe(m1!.id);
    const all = await inject(bea, "POST", `/api/product-revisions/${revisionId}/undo-all`);
    expect(all.statusCode, all.body).toBe(200);
    expect(await textOf(p, p.ids.a1)).toBe("a uno");
    expect(await textOf(p, p.ids.a2)).toBe("a due");
  });

  it("«Undo» del solo segno accettato", async () => {
    const p = await page();
    await claude(p, edits(p));
    const [m1] = (await marksOf(bea, p)).filter((m) => m.anchorId === p.ids.a1);
    expect((await inject(bea, "POST", `/api/product-marks/${m1!.id}/looks-good`)).statusCode).toBe(204);
    const res = await inject(bea, "POST", `/api/product-marks/${m1!.id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await textOf(p, p.ids.a1)).toBe("a uno");
    expect((await t.db.select().from(productClaudeMarks).where(eq(productClaudeMarks.id, m1!.id)))[0]).toMatchObject({ status: "undone" });
  });
});

describe("B. il motivo di «Undo» per chi legge soltanto", () => {
  it("prima `no_permission`, anche se una persona ha cambiato la frase dopo", async () => {
    const p = await page();
    const { revisionId } = await claude(p, edits(p));
    const seq = (await state(p)).seq;
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "s", baseSeq: seq, ops: [{ op: "set", block: para(p.ids.a1, "di Ada") }] })).statusCode).toBe(200);
    const rev = ((await inject(vic, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[]).find((r) => r.id === revisionId)!;
    expect(rev.undoByAnchor[p.ids.a1]).toMatchObject({ enabled: false, reason: "no_permission", byId: null });
    expect(rev.undo).toMatchObject({ reason: "no_permission" });
  });
});

describe("una tabella aggiunta da Claude", () => {
  async function claudeTable(p: Page) {
    const table = { id: "t", type: "table", rows: [{ id: "r", cells: [{ id: "c1", content: rich("uno") }, { id: "c2", content: rich("due") }] }] };
    await claude(p, [{ id: "ft", pageId: p.id, anchorId: p.ids.a2, change: { kind: "insert_after", block: table as never }, clarity: "clear" }]);
    const marks = await marksOf(bea, p);
    expect(marks).toHaveLength(2);
    return marks;
  }

  it("una cella toccata da una persona spegne «Undo» di OGNI cella (si toglierebbe tutta la tabella)", async () => {
    const p = await page();
    const marks = await claudeTable(p);
    const table = (await state(p)).blocks.find((b) => b.type === "table") as { id: string; rows: { id: string; cells: { id: string; content: unknown }[] }[] };
    const touched = { ...table, rows: table.rows.map((r) => ({ ...r, cells: r.cells.map((c, i) => (i === 1 ? { ...c, content: rich("di Ada") } : c)) })) };
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "s", baseSeq: (await state(p)).seq, ops: [{ op: "set", block: touched }] })).statusCode).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    const first = marks.find((m) => m.anchorId === table.rows[0]!.cells[0]!.id)!;
    expect((await marksOf(bea, p)).find((m) => m.id === first.id)!.undo).toMatchObject({ enabled: false, reason: "changed_after", byId: ada.id });
    const res = await inject(bea, "POST", `/api/product-marks/${first.id}/undo`);
    expect(res.statusCode).toBe(409);
    expect((await state(p)).blocks.some((b) => b.type === "table")).toBe(true);
  });

  it("senza tocchi, «Undo» di una cella toglie la tabella e chiude i segni di tutte le sue celle", async () => {
    const p = await page();
    const marks = await claudeTable(p);
    expect((await inject(bea, "POST", `/api/product-marks/${marks[0]!.id}/undo`)).statusCode).toBe(200);
    expect((await state(p)).blocks.some((b) => b.type === "table")).toBe(false);
    expect((await t.db.select().from(productClaudeMarks).where(eq(productClaudeMarks.pageId, p.id))).every((m) => m.status === "undone")).toBe(true);
  });
});

describe("«Update it» con le regole delle persone", () => {
  it("un blocco nuovo: id generati dal server; un riferimento (decisione) non si inserisce", async () => {
    const p = await page();
    const vague = (block: unknown): ProductFact => ({ id: `fv-${randomUUID().slice(0, 4)}`, pageId: p.id, anchorId: p.ids.a1, change: { kind: "insert_after", block: block as never }, clarity: "vague" });
    const out = await claude(p, [vague(para("top", "nuova frase"))]);
    const commentId = out.outcomes.find((o) => o.kind === "question")!.commentId!;
    expect((await inject(bea, "POST", `/api/product-comments/${commentId}/answer`, { option: "apply" })).statusCode).toBe(200);
    const inserted = (await state(p)).blocks.find((b) => (b as { content?: { text: string } }).content?.text === "nuova frase")!;
    expect(inserted.id).not.toBe("top");
    expect(String(inserted.id)).toMatch(/^blk-/);
  });
});

describe("i minori del server", () => {
  it("la fonte task la apre solo chi vede la task: un Contributor non richiedente legge il codice, non il titolo", async () => {
    const p = await page();
    const { ticketId } = await seedTicket(t.db, { projectId, repositoryId: randomUUID(), number: 777 });
    await claude(p, edits(p), { kind: "task", id: ticketId });
    const [mine] = await marksOf(ada, p);
    expect(mine!.source).toMatchObject({ kind: "task", canOpen: true, title: "Ticket di test" });
    const [theirs] = await marksOf(cora, p);
    expect(theirs!.source).toMatchObject({ kind: "task", canOpen: false, id: null, title: null, code: expect.stringMatching(/-777$/) });
  });

  it("le domande aperte non vanno al titolare della fonte", async () => {
    const p = await page();
    const out = await claude(p, [{ ...edits(p)[0]!, clarity: "vague" }]);
    const commentId = out.outcomes.find((o) => o.kind === "question")!.commentId!;
    const ids = async (who: U) => ((await inject(who, "GET", `/api/me/product-questions?pageId=${p.id}`)).json() as ProductOpenQuestion[]).map((q) => q.commentId);
    expect(await ids(bea)).toEqual([commentId]);
    expect(await ids(ada)).toEqual([]);
  });

  it("«Open a request» con l'intake fallito: la domanda torna aperta e si può rispondere di nuovo", async () => {
    const p = await page();
    const out = await claude(p, [{ ...edits(p)[0]!, clarity: "vague", options: { request: { title: "R", description: "d" } } }]);
    const commentId = out.outcomes.find((o) => o.kind === "question")!.commentId!;
    const origin = { kind: "product_doc", pageId: p.id, anchorId: p.ids.a1, questionId: commentId };
    const res = await inject(bea, "POST", "/api/requests", { projectId, title: "R", description: "d", origin });
    expect(res.statusCode, res.body).toBe(202);
    await t.db.update(backlogJobs).set({ status: "failed" }).where(eq(backlogJobs.id, (res.json() as { jobId: string }).jobId));
    const open = ((await inject(bea, "GET", `/api/me/product-questions?pageId=${p.id}`)).json() as ProductOpenQuestion[]).map((q) => q.commentId);
    expect(open).toEqual([commentId]);
    expect((await inject(bea, "POST", `/api/product-comments/${commentId}/answer`, { option: "keep" })).statusCode).toBe(200);
    void productComments;
  });

  it("la riga «Claude riprende quando…» non sparisce quando il lavoro fermo torna in coda", async () => {
    const p = await page();
    void p;
    const [job] = await t.db.insert(productDocJobs).values({ projectId, sourceKind: "decision", sourceId: randomUUID(), status: "queued", lastHeldReason: "limit" }).returning();
    const space = (await inject(bea, "GET", `/api/projects/${projectId}/product`)).json() as ProductSpaceView;
    expect(space.claudeHeld).toMatchObject({ reason: "limit" });
    await t.db.delete(productDocJobs).where(eq(productDocJobs.id, job!.id));
  });
});
