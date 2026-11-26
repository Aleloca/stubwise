import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { productClaudeMarks, productDocJobs, productPageRevisions, productSectionHolds, projectDecisions } from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeClaudeFacts } from "@stubwise/notifications";
import type { ProductMarkView, ProductPageView, ProductRevisionView, ProductSpaceView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { acceptProductMark, undoProductMark, undoProductRevision } from "../services/product-claude.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F5, Task 4 — i segni di Claude, «Looks good», «Undo» e «Undo all»,
// la fonte vista e la riga «riprende quando…». Le modifiche di Claude le
// scrive lo scrittore VERO (`writeClaudeFacts`), come il worker.

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
  ada = await createUserWithSession(app, "ada-cl@example.com");
  bea = await createUserWithSession(app, "bea-cl@example.com");
  vic = await createUserWithSession(app, "vic-cl@example.com");
  // Il full admin del setup: vede ogni progetto, ma la posta di un altro no (N-2 = a).
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
  const created = (await inject(ada, "POST", `/api/projects/${projectId}/product/pages`, { title: `P ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
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

const state = async (p: { code: string }) => (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
const textOf = async (p: { code: string }, id: string) => ((await state(p)).blocks.find((b) => b.id === id) as { content: { text: string } } | undefined)?.content.text;
const marksOf = async (who: U, p: { id: string }) => {
  const res = await inject(who, "GET", `/api/product-pages/${p.id}/marks`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ProductMarkView[];
};

/** Una decisione presa da Ada: la fonte. */
async function decision() {
  const [d] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `k-${randomUUID()}`, title: "Si paga a 60 giorni", decision: "sì", decidedByUserId: ada.id } as typeof projectDecisions.$inferInsert).returning();
  // Il trigger ha accodato il lavoro: qui scriviamo a mano, il lavoro non serve.
  await t.db.delete(productDocJobs).where(eq(productDocJobs.sourceId, d!.id));
  return d!;
}

/** Claude cambia a1 e a2 (una revisione, due segni) per conto di Ada. */
async function claudeEdits(p: Awaited<ReturnType<typeof page>>, source: { kind: "decision" | "email"; id: string } , ownerId = ada.id) {
  const seq = (await state(p)).seq;
  const fact = (id: string, anchorId: string, before: string, after: string) => ({ id, pageId: p.id, anchorId, change: { kind: "replace" as const, text: rich(after) }, clarity: "clear" as const, before: rich(before) });
  const out = await writeClaudeFacts(t.db, { projectId, pageId: p.id, facts: [fact("f1", p.ids.a1, "a uno", "a UNO"), fact("f2", p.ids.a2, "a due", "a DUE")], source, ownerId, arrivedSeq: seq });
  expect(out.kind).toBe("written");
  return (out as { revisionId: string }).revisionId;
}

describe("i segni di Claude", () => {
  it("un segno per ancora, con la revisione, il gruppo, per conto di chi, la fonte vista; «Looks good» lo toglie", async () => {
    const p = await page();
    const d = await decision();
    const revisionId = await claudeEdits(p, { kind: "decision", id: d.id });
    const marks = await marksOf(bea, p);
    expect(marks.map((m) => m.anchorId).sort()).toEqual([p.ids.a1, p.ids.a2].sort());
    expect(marks[0]).toMatchObject({ revisionId, groupAnchors: 2, onBehalfOfId: ada.id, onBehalfOfName: "ada-cl", canAccept: true, undo: { enabled: true }, cell: null });
    expect(marks[0]!.source).toMatchObject({ kind: "decision", canOpen: true, id: d.id, title: "Si paga a 60 giorni", ownerId: ada.id, ownerName: "ada-cl", gone: false });

    const mark = marks.find((m) => m.anchorId === p.ids.a1)!;
    expect((await inject(vic, "POST", `/api/product-marks/${mark.id}/looks-good`)).statusCode).toBe(403);
    expect((await inject(bea, "POST", `/api/product-marks/${mark.id}/looks-good`)).statusCode).toBe(204);
    expect((await marksOf(bea, p)).map((m) => m.anchorId)).toEqual([p.ids.a2]);
    // Chi legge senza docs.edit vede i segni, non può accettarli né annullarli.
    expect((await marksOf(vic, p))[0]).toMatchObject({ canAccept: false, undo: { enabled: false, reason: "no_permission", byId: null } });
  });

  it("un'email la APRE solo chi ha la casella: un admin legge solo «da un'email di …»", async () => {
    const p = await page();
    const mail = await seedEmailMessage(t.db, { userId: ada.id, subject: "Pagamenti" });
    await claudeEdits(p, { kind: "email", id: mail.messageId });
    const [mine] = await marksOf(ada, p);
    expect(mine!.source).toMatchObject({ kind: "email", canOpen: true, id: mail.messageId, title: "Pagamenti", ownerName: "ada-cl", thread: { accountId: mail.accountId } });
    for (const who of [bea, admin]) {
      const [theirs] = await marksOf(who, p);
      expect(theirs!.source).toMatchObject({ kind: "email", canOpen: false, id: null, title: null, thread: null, ownerId: ada.id, ownerName: "ada-cl" });
    }
  });
});

describe("«Undo» e «Undo all»", () => {
  it("«Undo» rimette la frase com'era, in una revisione `undo` con undo_of; il segno si chiude; il secondo è 409 already_undone", async () => {
    const p = await page();
    const revisionId = await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    const mark = (await marksOf(bea, p)).find((m) => m.anchorId === p.ids.a1)!;
    const res = await inject(bea, "POST", `/api/product-marks/${mark.id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await textOf(p, p.ids.a1)).toBe("a uno");
    expect(await textOf(p, p.ids.a2)).toBe("a DUE");
    const [undo] = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.id, res.json().revisionId));
    expect(undo).toMatchObject({ kind: "undo", undoOf: revisionId, actorId: bea.id });
    expect((await t.db.select().from(productClaudeMarks).where(eq(productClaudeMarks.id, mark.id)))[0]).toMatchObject({ status: "undone", decidedBy: bea.id });
    const again = await inject(bea, "POST", `/api/product-marks/${mark.id}/undo`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already_undone", byId: bea.id });
  });

  it("toccata da una persona DOPO Claude: «Undo» spento (`changed_after`, chi) e 409; la pagina resta com'è", async () => {
    const p = await page();
    await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    const s = await state(p);
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "ada", baseSeq: s.seq, ops: [{ op: "set", block: para(p.ids.a1, "a uno, di Ada") }] })).statusCode).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    const marks = await marksOf(bea, p);
    const a1 = marks.find((m) => m.anchorId === p.ids.a1)!;
    const a2 = marks.find((m) => m.anchorId === p.ids.a2)!;
    expect(a1.undo).toEqual({ enabled: false, reason: "changed_after", byId: ada.id, byName: "ada-cl" });
    expect(a2.undo).toMatchObject({ enabled: true });
    const res = await inject(bea, "POST", `/api/product-marks/${a1.id}/undo`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "changed_after", byId: ada.id, byName: "ada-cl" });
    expect(await textOf(p, p.ids.a1)).toBe("a uno, di Ada");
    // «Undo all» è tutto o niente: un'ancora toccata dopo lo ferma.
    expect((await inject(bea, "POST", `/api/product-revisions/${a1.revisionId}/undo-all`)).statusCode).toBe(409);
    expect(await textOf(p, p.ids.a2)).toBe("a DUE");
  });

  it("«Undo all» rimette tutte le ancore in UNA revisione; la cronologia dice fonte, per conto di chi e «2 di 2 annullate»", async () => {
    const p = await page();
    const d = await decision();
    const revisionId = await claudeEdits(p, { kind: "decision", id: d.id });
    let revs = (await inject(bea, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[];
    const claude = revs.find((r) => r.id === revisionId)!;
    expect(claude).toMatchObject({ kind: "claude", via: "claude", onBehalfOfId: ada.id, onBehalfOfName: "ada-cl", source: { kind: "decision", id: d.id }, undo: { enabled: true }, undoneCount: { done: 0, count: 2 } });
    expect(Object.keys(claude.undoByAnchor).sort()).toEqual([p.ids.a1, p.ids.a2].sort());

    const res = await inject(bea, "POST", `/api/product-revisions/${revisionId}/undo-all`);
    expect(res.statusCode, res.body).toBe(200);
    expect([await textOf(p, p.ids.a1), await textOf(p, p.ids.a2)]).toEqual(["a uno", "a due"]);
    revs = (await inject(bea, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[];
    expect(revs.filter((r) => r.kind === "undo")).toHaveLength(1);
    expect(revs.find((r) => r.kind === "undo")).toMatchObject({ undoOf: revisionId });
    expect(revs.find((r) => r.id === revisionId)).toMatchObject({ undo: { enabled: false, reason: "already_undone", byId: bea.id }, undoneCount: { done: 2, count: 2 }, undoneById: bea.id });
    expect(await marksOf(bea, p)).toEqual([]);
  });

  it("una sezione presa da un altro: «Undo» 409 section_busy, niente cambia", async () => {
    const p = await page();
    await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    await t.db.insert(productSectionHolds).values({ pageId: p.id, sectionId: p.ids.hA, userId: ada.id, expiresAt: new Date(Date.now() + 60_000) });
    const mark = (await marksOf(bea, p))[0]!;
    const res = await inject(bea, "POST", `/api/product-marks/${mark.id}/undo`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "section_busy", sectionId: p.ids.hA, by: { id: ada.id } });
    expect((await marksOf(bea, p))).toHaveLength(2);
  });

  it("difesa in profondità: anche chiamati DIRETTAMENTE (senza la rotta), i servizi rifiutano chi non ha docs.edit", async () => {
    const p = await page();
    const revisionId = await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    const mark = (await marksOf(bea, p))[0]!;
    const asVic = { id: vic.id, instancePermissions: new Set<never>() };
    for (const call of [() => acceptProductMark(t.db, asVic, mark.id), () => undoProductMark(t.db, asVic, mark.id), () => undoProductRevision(t.db, asVic, revisionId)]) {
      await expect(call()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
    expect(await marksOf(bea, p)).toHaveLength(2);
  });

  it("un segno di una pagina che non vedi è 404", async () => {
    const p = await page();
    await claudeEdits(p, { kind: "decision", id: (await decision()).id });
    const mark = (await marksOf(bea, p))[0]!;
    const out = await createUserWithSession(app, `out-${randomUUID().slice(0, 6)}@example.com`);
    expect((await inject(out, "POST", `/api/product-marks/${mark.id}/undo`)).statusCode).toBe(404);
    expect((await inject(out, "GET", `/api/product-pages/${p.id}/marks`)).statusCode).toBe(404);
  });
});

describe("la riga «riprende quando…»", () => {
  it("sullo spazio: quanti lavori fermi e il motivo più grave", async () => {
    const space = async () => (await inject(bea, "GET", `/api/projects/${projectId}/product`)).json() as ProductSpaceView;
    await t.db.delete(productDocJobs).where(eq(productDocJobs.projectId, projectId));
    expect((await space()).claudeHeld).toBeNull();
    await t.db.insert(productDocJobs).values([
      { projectId, sourceKind: "decision", sourceId: randomUUID(), status: "held", heldReason: "section_busy" },
      { projectId, sourceKind: "decision", sourceId: randomUUID(), status: "held", heldReason: "budget" },
      { projectId, sourceKind: "decision", sourceId: randomUUID(), status: "queued" },
    ]);
    expect((await space()).claudeHeld).toEqual({ reason: "budget", count: 2 });
  });
});
