import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { alertSubscriptions, notifications, productComments, productDocJobs, productSectionHolds, projectDecisions } from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeClaudeFacts } from "@stubwise/notifications";
import type { InboxItem, ProductFact, ProductOpenQuestion, ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F5, Task 5 — le card `product_doc.updated` e `product_doc.question`.
// Le pubblica lo scrittore di Claude (`writeClaudeFacts`) nella sua
// transazione. Destinatari: chi segue la pagina SEMPRE (`follower`), più chi
// ha la riga accesa (di partenza chi ha `docs.edit`); mai Claude, mai il
// titolare della fonte. Fonte, frasi, «per conto di», chi ha annullato e la
// domanda si DERIVANO a lettura.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U; // titolare delle fonti (developer)
let bea: U; // developer: la riga accesa di partenza
let cid: U; // developer che SEGUE la pagina con la riga spenta
let dan: U; // developer con la riga spenta, che non segue
let vic: U; // viewer: docs.view senza docs.edit
let wen: U; // viewer con la riga accesa a mano
let adminId: string; // il full admin del setup: membro implicito con docs.edit, la riga accesa di partenza
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  ({ adminId } = await seedUsers(app));
  ({ projectId } = await seedRepository(t.db));
  ada = await createUserWithSession(app, "ada-al@example.com");
  bea = await createUserWithSession(app, "bea-al@example.com");
  cid = await createUserWithSession(app, "cid-al@example.com");
  dan = await createUserWithSession(app, "dan-al@example.com");
  vic = await createUserWithSession(app, "vic-al@example.com");
  wen = await createUserWithSession(app, "wen-al@example.com");
  for (const u of [ada, bea, cid, dan]) await addMember(app, projectId, u.id, "developer");
  for (const u of [vic, wen]) await addMember(app, projectId, u.id, "viewer");
  for (const alertType of ["product_doc.updated", "product_doc.question"]) {
    await t.db.insert(alertSubscriptions).values([
      { userId: cid.id, projectId, alertType, app: false, phone: false },
      { userId: dan.id, projectId, alertType, app: false, phone: false },
      { userId: wen.id, projectId, alertType, app: true, phone: false },
    ]);
  }
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const rich = (text: string) => ({ text, marks: [] });
const para = (id: string, text: string) => ({ id, type: "paragraph", content: rich(text) });

/** Una pagina con due frasi; cid e ada la seguono. */
async function page() {
  const created = (await inject(bea, "POST", `/api/projects/${projectId}/product/pages`, { title: `A ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(bea, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const ids = { a1: `blk-${randomUUID()}`, a2: `blk-${randomUUID()}` };
  const ops = [
    { op: "insert", afterId: view.blocks[0]!.id, block: para(ids.a1, "a uno") },
    { op: "insert", afterId: ids.a1, block: para(ids.a2, "a due") },
  ];
  expect((await inject(bea, "POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops })).statusCode).toBe(200);
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  for (const who of [cid, ada]) expect((await inject(who, "PUT", `/api/product-pages/${created.id}/follow`)).statusCode).toBe(204);
  return { ...created, ids };
}
type Page = Awaited<ReturnType<typeof page>>;

async function decision() {
  const [d] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `k-${randomUUID()}`, title: "Si paga a 60 giorni", decision: "sì", decidedByUserId: ada.id } as typeof projectDecisions.$inferInsert).returning();
  await t.db.delete(productDocJobs).where(eq(productDocJobs.sourceId, d!.id));
  return d!;
}

const seqOf = async (p: Page) => ((await inject(bea, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView).seq;

/** Claude cambia a1 e a2 per conto di Ada (una revisione, due segni). */
async function claudeEdits(p: Page, source: { kind: "decision" | "email"; id: string }, waited: "budget" | "paused" | null = null) {
  // `before`: la frase di adesso, obbligatoria per riscriverla (revisione di F5).
  const fact = (id: string, anchorId: string, before: string, after: string): ProductFact => ({ id, pageId: p.id, anchorId, change: { kind: "replace", text: rich(after) }, clarity: "clear", before: rich(before) });
  const out = await writeClaudeFacts(t.db, { projectId, pageId: p.id, facts: [fact("f1", p.ids.a1, "a uno", "a UNO"), fact("f2", p.ids.a2, "a due", "a DUE")], source, ownerId: ada.id, arrivedSeq: await seqOf(p), waited });
  expect(out.kind).toBe("written");
  return (out as { revisionId: string }).revisionId;
}

/** Un «forse» su a1: una domanda. */
async function claudeAsks(p: Page) {
  const fact: ProductFact = { id: "fq", pageId: p.id, anchorId: p.ids.a1, change: { kind: "replace", text: rich("a UNO, forse") }, clarity: "vague", options: { request: { title: "Chiarire", description: "" } } };
  const out = await writeClaudeFacts(t.db, { projectId, pageId: p.id, facts: [fact], source: { kind: "decision", id: (await decision()).id }, ownerId: ada.id, arrivedSeq: await seqOf(p) });
  return (out as { outcomes: { kind: string; commentId?: string }[] }).outcomes.find((o) => o.kind === "question")!.commentId!;
}

const rowsOf = (kind: string, key: string, value: string) =>
  t.db.select().from(notifications).where(and(eq(notifications.kind, kind as never), sql`${notifications.event}->>${key} = ${value}`));

async function cardOf(who: U, notificationId: string): Promise<InboxItem | undefined> {
  const res = await inject(who, "GET", "/api/inbox");
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: InboxItem[] }).items.find((i) => i.id === notificationId);
}

describe("i destinatari", () => {
  it("una modifica di Claude: chi segue SEMPRE (anche con la riga spenta), chi ha la riga accesa; mai il titolare della fonte, mai Claude", async () => {
    const p = await page();
    const revisionId = await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    const rows = await rowsOf("product_doc.updated", "revisionId", revisionId);
    const to = new Set(rows.map((r) => r.userId));
    // bea: docs.edit, accesa di partenza; cid: segue con la riga spenta; wen: viewer che l'ha accesa.
    expect([...to].sort()).toEqual([adminId, bea.id, cid.id, wen.id].sort());
    // ada è il titolare (e segue): esclusa. dan l'ha spenta e non segue. vic legge senza docs.edit: spenta di partenza.
    expect(rows.find((r) => r.userId === cid.id)!.event).toMatchObject({ alertMandatory: "follower" });
    expect(rows[0]!.event).toMatchObject({ kind: "product_doc.updated", pageId: p.id, pageCode: p.code, projectId, revisionId });
    // Nel jsonb mai il testo della pagina né il titolo della fonte.
    expect(JSON.stringify(rows[0]!.event)).not.toContain("a UNO");
    expect(JSON.stringify(rows[0]!.event)).not.toContain("60 giorni");
  });

  it("un lettore senza docs.edit non la riceve di partenza, ma la può accendere dalle Preferenze (la rotta vera)", async () => {
    const p = await page();
    const first = await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    expect((await rowsOf("product_doc.updated", "revisionId", first)).some((r) => r.userId === vic.id)).toBe(false);
    const on = await inject(vic, "PUT", `/api/me/alert-subscriptions/${projectId}/product_doc.updated`, { app: true });
    expect(on.statusCode, on.body).toBeLessThan(300);
    const p2 = await page();
    const second = await claudeEdits(p2, { kind: "decision", id: (await decision()).id });
    expect((await rowsOf("product_doc.updated", "revisionId", second)).some((r) => r.userId === vic.id)).toBe(true);
  });

  it("una domanda di Claude: gli stessi destinatari, con l'id del commento", async () => {
    const p = await page();
    const commentId = await claudeAsks(p);
    const rows = await rowsOf("product_doc.question", "questionId", commentId);
    expect(rows.map((r) => r.userId).sort()).toEqual([adminId, bea.id, cid.id, wen.id].sort());
  });
});

describe("la card come la legge chi la riceve", () => {
  it("updated: la fonte nella forma di chi legge, le frasi, «per conto di», il primo segno; un'email di un altro senza oggetto", async () => {
    const p = await page();
    const mail = await seedEmailMessage(t.db, { userId: ada.id, subject: "Oggetto riservato" });
    const revisionId = await claudeEdits(p, { kind: "email", id: mail.messageId });
    const [row] = (await rowsOf("product_doc.updated", "revisionId", revisionId)).filter((r) => r.userId === bea.id);
    const card = await cardOf(bea, row!.id);
    expect(card).toMatchObject({ objectGone: false, productDoc: { pageId: p.id, pageCode: p.code, commentId: null } });
    expect(card!.productDoc!.claude).toMatchObject({
      revisionId,
      changes: 2,
      onBehalfOfName: "ada-al",
      undoneByName: null,
      markAnchorId: p.ids.a1,
      question: null,
    });
    expect(card!.productDoc!.claude!.sources).toEqual([expect.objectContaining({ kind: "email", canOpen: false, id: null, title: null, ownerName: "ada-al" })]);
    expect(JSON.stringify(card)).not.toContain("Oggetto riservato");
  });

  it("`waited` (registro dei rimandi): dopo un'attesa per budget o per pausa la card lo dice; senza attesa, in una card di prima o con un valore ignoto è null", async () => {
    const waitedOf = async (revisionId: string) => {
      const [row] = (await rowsOf("product_doc.updated", "revisionId", revisionId)).filter((r) => r.userId === bea.id);
      return (await cardOf(bea, row!.id))!.productDoc!.claude!.waited;
    };
    const d = async () => ({ kind: "decision" as const, id: (await decision()).id });
    expect(await waitedOf(await claudeEdits(await page(), await d(), "budget"))).toBe("budget");
    expect(await waitedOf(await claudeEdits(await page(), await d(), "paused"))).toBe("paused");
    expect(await waitedOf(await claudeEdits(await page(), await d()))).toBeNull();
    // Una card pubblicata prima (senza il campo) e una con un valore che il server non conosce.
    const old = await claudeEdits(await page(), await d(), "budget");
    await t.db.update(notifications).set({ event: sql`${notifications.event} - 'waited'` }).where(sql`${notifications.event}->>'revisionId' = ${old}`);
    expect(await waitedOf(old)).toBeNull();
    const odd = await claudeEdits(await page(), await d(), "budget");
    await t.db.update(notifications).set({ event: sql`jsonb_set(${notifications.event}, '{waited}', '"limit"')` }).where(sql`${notifications.event}->>'revisionId' = ${odd}`);
    expect(await waitedOf(odd)).toBeNull();
  });

  it("updated dopo «Undo all»: chi ha annullato, e nessun segno a cui portare", async () => {
    const p = await page();
    const revisionId = await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    expect((await inject(bea, "POST", `/api/product-revisions/${revisionId}/undo-all`)).statusCode).toBe(200);
    const [row] = (await rowsOf("product_doc.updated", "revisionId", revisionId)).filter((r) => r.userId === cid.id);
    const card = await cardOf(cid, row!.id);
    expect(card!.productDoc!.claude).toMatchObject({ undoneByName: "bea-al", markAnchorId: null, changes: 2 });
  });

  it("question: il motivo, la risposta e chi ha risposto, a lettura (la card vecchia si aggiorna)", async () => {
    const p = await page();
    const commentId = await claudeAsks(p);
    const [row] = (await rowsOf("product_doc.question", "questionId", commentId)).filter((r) => r.userId === bea.id);
    let card = await cardOf(bea, row!.id);
    expect(card).toMatchObject({ objectGone: false, productDoc: { pageId: p.id, commentId, threadRootId: commentId } });
    expect(card!.productDoc!.claude).toMatchObject({ changes: 0, question: { reason: "vague", answer: null, answeredByName: null, canRequest: true } });
    expect((await inject(cid, "POST", `/api/product-comments/${commentId}/answer`, { option: "keep" })).statusCode).toBe(200);
    card = await cardOf(bea, row!.id);
    expect(card!.productDoc!.claude!.question).toMatchObject({ answer: "keep", answeredByName: "cid-al" });
  });
});

describe("l'oggetto che non c'è più", () => {
  it("pagina eliminata: le due card sono `objectGone`, senza codice né fonte; una domanda eliminata pure", async () => {
    const p = await page();
    const revisionId = await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    const commentId = await claudeAsks(p);
    const [up] = (await rowsOf("product_doc.updated", "revisionId", revisionId)).filter((r) => r.userId === bea.id);
    const [qu] = (await rowsOf("product_doc.question", "questionId", commentId)).filter((r) => r.userId === bea.id);
    expect(await cardOf(bea, qu!.id)).toMatchObject({ objectGone: false });
    await t.db.update(productComments).set({ deletedAt: new Date(), body: "" }).where(eq(productComments.id, commentId));
    expect(await cardOf(bea, qu!.id)).toMatchObject({ objectGone: true, productDoc: null });
    expect((await inject(bea, "DELETE", `/api/product-pages/${p.id}`)).statusCode).toBeLessThan(300);
    const gone = await cardOf(bea, up!.id);
    expect(gone).toMatchObject({ objectGone: true, productDoc: null });
    expect(gone!.text).not.toContain(p.code);
  });
});

describe("le domande aperte: solo chi le riceve e può rispondere", () => {
  it("chi segue o ha la riga accesa, con docs.edit; non chi l'ha spenta senza seguire, non chi legge soltanto", async () => {
    const p = await page();
    const commentId = await claudeAsks(p);
    const ids = async (who: U) => ((await inject(who, "GET", `/api/me/product-questions?pageId=${p.id}`)).json() as ProductOpenQuestion[]).map((q) => q.commentId);
    expect(await ids(bea)).toEqual([commentId]);
    expect(await ids(cid)).toEqual([commentId]);
    expect(await ids(dan)).toEqual([]);
    // wen ha la riga accesa ma non ha docs.edit: non può rispondere.
    expect(await ids(wen)).toEqual([]);
    expect(await ids(vic)).toEqual([]);
  });
});
