import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { productComments, productDocJobs, productSectionHolds, projectDecisions } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeClaudeFacts, type ClaudeWriteResult } from "@stubwise/notifications";
import type { ProductFact, ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Revisione di F5 (46, 21 nov 2026): lo scrittore di Claude RICONTROLLA come
// le scritture delle persone. Un fatto che non regge si scarta o diventa una
// domanda, mai un crash, mai un blocco che una persona non potrebbe scrivere.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let projectId: string;
let projectCode: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ada = await createUserWithSession(app, "ada-wr@example.com");
  await addMember(app, projectId, ada.id, "developer");
  const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie: ada.headers.cookie } });
  projectCode = (res.json() as { code: string }).code;
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: ada.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const rich = (text: string) => ({ text, marks: [] });
const para = (id: string, text: string) => ({ id, type: "paragraph", content: rich(text) });

/** Una pagina con una frase e una tabella 1×2, scritte da Ada. */
async function page() {
  const created = (await inject("POST", `/api/projects/${projectId}/product/pages`, { title: `W ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject("GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const ids = { p1: `blk-${randomUUID()}`, tb: `blk-${randomUUID()}`, row: `blk-${randomUUID()}`, c1: `blk-${randomUUID()}`, c2: `blk-${randomUUID()}` };
  const table = { id: ids.tb, type: "table", rows: [{ id: ids.row, cells: [{ id: ids.c1, content: { text: "cella", marks: [{ type: "bold", start: 0, end: 5 }] } }, { id: ids.c2, content: rich("due") }] }] };
  const ops = [
    { op: "insert", afterId: view.blocks[0]!.id, block: para(ids.p1, "a uno") },
    { op: "insert", afterId: ids.p1, block: table },
  ];
  expect((await inject("POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops })).statusCode).toBe(200);
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  return { ...created, ids };
}
type Page = Awaited<ReturnType<typeof page>>;
const state = async (p: Page) => (await inject("GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;

async function source() {
  const [d] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `k-${randomUUID()}`, title: "D", decision: "sì", decidedByUserId: ada.id } as typeof projectDecisions.$inferInsert).returning();
  await t.db.delete(productDocJobs).where(eq(productDocJobs.sourceId, d!.id));
  return { kind: "decision" as const, id: d!.id };
}

async function write(p: Page, facts: ProductFact[], ownerId: string | null = ada.id): Promise<Extract<ClaudeWriteResult, { kind: "written" }>> {
  const out = await writeClaudeFacts(t.db, { projectId, pageId: p.id, facts, source: await source(), ownerId, arrivedSeq: (await state(p)).seq });
  expect(out.kind).toBe("written");
  return out as Extract<ClaudeWriteResult, { kind: "written" }>;
}
const fact = (p: Page, over: Partial<ProductFact>): ProductFact => ({ id: `f-${randomUUID().slice(0, 6)}`, pageId: p.id, anchorId: p.ids.p1, change: { kind: "replace", text: rich("a UNO") }, clarity: "clear", before: rich("a uno"), ...over });
const questionReasons = async (p: Page) => (await t.db.select().from(productComments).where(eq(productComments.pageId, p.id))).flatMap((c) => (c.question ? [(c.question as { reason: string }).reason] : []));

describe("lo scrittore ricontrolla (revisione di F5)", () => {
  it("2. un replace o un link_task senza ancora si scarta, senza far saltare la transazione", async () => {
    const p = await page();
    const out = await write(p, [fact(p, { anchorId: null }), fact(p, { anchorId: null, change: { kind: "link_task", taskCode: "X-1" } })]);
    expect(out.outcomes.map((o) => o.kind)).toEqual(["none", "none"]);
    expect(out.revisionId).toBeNull();
  });

  it("5. un replace senza `before` non entra da solo: una domanda (anche `clear`, anche senza `contradicts`)", async () => {
    const p = await page();
    const noBefore = fact(p, {});
    delete noBefore.before;
    const out = await write(p, [noBefore]);
    expect(out.outcomes[0]).toMatchObject({ kind: "question", reason: "contradicts_person" });
    expect((await state(p)).blocks.find((b) => b.id === p.ids.p1)).toMatchObject({ content: { text: "a uno" } });
  });

  it("3. un blocco nuovo: tutti gli id li genera il server (anche righe e celle), mai `top`", async () => {
    const p = await page();
    const table = { id: "top", type: "table", rows: [{ id: p.ids.row, cells: [{ id: "top", content: rich("x") }] }] };
    const out = await write(p, [fact(p, { change: { kind: "insert_after", block: table as never }, before: undefined })]);
    expect(out.outcomes[0]!.kind).toBe("edit");
    const inserted = (await state(p)).blocks.find((b) => b.type === "table" && b.id !== p.ids.tb) as { id: string; rows: { id: string; cells: { id: string }[] }[] };
    const ids = [inserted.id, inserted.rows[0]!.id, inserted.rows[0]!.cells[0]!.id];
    expect(ids.every((id) => id.startsWith("blk-") && id !== p.ids.row)).toBe(true);
  });

  it("3. un blocco con un riferimento (immagine, file, decisione, bozza) non lo scrive Claude", async () => {
    const p = await page();
    const blocks = [
      { id: "n1", type: "image", src: `product-image:${randomUUID()}`, caption: "", alt: "" },
      { id: "n2", type: "decision", decisionId: randomUUID() },
      { id: "n3", type: "drive", fileId: randomUUID(), code: "X-F1" },
      { id: "n4", type: "wireframe", wireframeId: "w", variant: 0 },
    ];
    const out = await write(p, blocks.map((block) => fact(p, { change: { kind: "insert_after", block: block as never }, before: undefined })));
    expect(out.outcomes.map((o) => o.kind)).toEqual(["none", "none", "none", "none"]);
    expect(out.revisionId).toBeNull();
  });

  it("6. link_task: una task che non c'è (o di un altro progetto) si scarta; una vera si aggiunge, e la cella tiene i suoi segni", async () => {
    const p = await page();
    const ghost = await write(p, [fact(p, { change: { kind: "link_task", taskCode: `${projectCode}-99999` } })]);
    expect(ghost.outcomes[0]).toMatchObject({ kind: "none", why: "task_unknown" });
    await seedTicket(t.db, { projectId, repositoryId: randomUUID(), number: 4242 });
    const task = { code: `${projectCode}-4242` };
    const ok = await write(p, [fact(p, { anchorId: p.ids.c1, change: { kind: "link_task", taskCode: task.code }, before: { text: "cella", marks: [] } })]);
    expect(ok.outcomes[0]!.kind).toBe("edit");
    const table = (await state(p)).blocks.find((b) => b.id === p.ids.tb) as { rows: { cells: { id: string; content: { text: string; marks: unknown[] } }[] }[] };
    expect(table.rows[0]!.cells[0]!.content).toMatchObject({ text: `cella ${task.code}`, marks: [{ type: "bold", start: 0, end: 5 }] });
  });

  it("un link nuovo nel testo di Claude non entra da solo: una domanda", async () => {
    const p = await page();
    const out = await write(p, [fact(p, { change: { kind: "replace", text: { text: "a uno qui", marks: [{ type: "link", start: 6, end: 9, href: "https://evil.example" }] } } })]);
    expect(out.outcomes[0]).toMatchObject({ kind: "question" });
  });

  it("4. senza un titolare noto (una chiusura di sistema) Claude non scrive: una domanda `no_permission`", async () => {
    const p = await page();
    const out = await write(p, [fact(p, {})], null);
    expect(out.outcomes[0]).toMatchObject({ kind: "question", reason: "no_permission" });
  });

  it("una domanda senza ancora va sulla prima ANCORA della pagina (una cella, per una tabella in cima)", async () => {
    const p = await page();
    // La tabella in cima alla pagina: il primo blocco non è un'ancora, la sua prima cella sì.
    const top = { id: `blk-${randomUUID()}`, type: "table", rows: [{ id: `blk-${randomUUID()}`, cells: [{ id: `blk-${randomUUID()}`, content: rich("prima") }] }] };
    expect((await inject("POST", `/api/product-pages/${p.id}/ops`, { sessionId: "setup", baseSeq: (await state(p)).seq, ops: [{ op: "insert", afterId: null, block: top }] })).statusCode).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    await write(p, [fact(p, { anchorId: null, change: { kind: "insert_after", block: para("x", "nuova") as never }, clarity: "vague", before: undefined })]);
    const [q] = (await t.db.select().from(productComments).where(eq(productComments.pageId, p.id))).filter((c) => c.question);
    const anchors = (await state(p)).blocks.flatMap((b) => (b.type === "table" ? (b as { rows: { cells: { id: string }[] }[] }).rows.flatMap((r) => r.cells.map((c) => c.id)) : [b.id as string]));
    expect(anchors).toContain(q!.anchorId);
    expect(q!.anchorId).toBe(top.rows[0]!.cells[0]!.id);
    expect(await questionReasons(p)).toEqual(["vague"]);
  });
});
