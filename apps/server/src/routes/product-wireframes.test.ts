import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { instanceSettings, productDocJobs, productPageImages, productPageRevisions, productSectionHolds, productWireframes } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductPageView, ProductRevisionView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F6 — le bozze di schermata: il blocco nasce subito col disegno in
// arrivo (il worker), «Redraw», «Pick», «Keep», «Replace with an image».

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let vic: U;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ada = await createUserWithSession(app, "ada-wf@example.com");
  vic = await createUserWithSession(app, "vic-wf@example.com");
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, vic.id, "viewer");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

async function page(text = "Il checkout in tre passi.") {
  const created = (await inject(ada, "POST", `/api/projects/${projectId}/product/pages`, { title: `W ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(ada, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const ids = { p1: `blk-${randomUUID()}`, empty: `blk-${randomUUID()}` };
  const ops = [
    { op: "insert", afterId: view.blocks[0]!.id, block: { id: ids.p1, type: "paragraph", content: { text, marks: [] } } },
    { op: "insert", afterId: ids.p1, block: { id: ids.empty, type: "paragraph", content: { text: "/sketch", marks: [] } } },
  ];
  expect((await inject(ada, "POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops })).statusCode).toBe(200);
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  return { ...created, ids };
}
type Page = Awaited<ReturnType<typeof page>>;
const state = async (p: Page) => (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
const clearHolds = (p: Page) => t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));

/** Il worker ha disegnato: le varianti, pronte. */
const drawn = (wireframeId: string, n: number) =>
  t.db.update(productWireframes).set({ status: "ready", variants: Array.from({ length: n }, (_, i) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>v${i}</text></svg>` })) }).where(eq(productWireframes.id, wireframeId));

describe("«Draw this screen»", () => {
  it("il blocco nasce subito (`drawing`), con una revisione di chi chiede `via: claude`, e il lavoro della coda", async () => {
    const p = await page();
    const res = await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: p.ids.p1 });
    expect(res.statusCode, res.body).toBe(202);
    const { blockId, wireframeId } = res.json() as { blockId: string; wireframeId: string };
    await clearHolds(p);
    const v = await state(p);
    const at = v.blocks.findIndex((b) => b.id === p.ids.p1);
    expect(v.blocks[at + 1]).toEqual({ id: blockId, type: "wireframe", wireframeId, variant: 0 });
    expect(v.wireframes).toEqual([{ id: wireframeId, status: "drawing", variants: [], error: null }]);
    expect(await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, wireframeId))).toEqual([expect.objectContaining({ sourceKind: "wireframe", status: "queued" })]);
    const revs = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, p.id));
    expect(revs.at(-1)).toMatchObject({ actorId: ada.id, via: "claude", kind: "edit" });
  });

  it("al posto di un paragrafo col solo «/…»: lo stesso id; un paragrafo con del testo è 422; chi legge soltanto 403; il budget 409", async () => {
    const p = await page();
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { replaceId: p.ids.p1 })).json()).toMatchObject({ code: "invalid_replace" });
    const ok = await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { replaceId: p.ids.empty });
    expect(ok.statusCode, ok.body).toBe(202);
    expect((ok.json() as { blockId: string }).blockId).toBe(p.ids.empty);
    await clearHolds(p);
    expect((await state(p)).blocks.find((b) => b.id === p.ids.empty)).toMatchObject({ type: "wireframe" });
    expect((await inject(vic, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: null })).statusCode).toBe(403);
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "0" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "0" } });
    try {
      // D-7.1 (review del lotto 4, I-1): il Developer riceve budget_exhausted; il Project Lead lo scavalca.
      expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: null })).json()).toMatchObject({ code: "budget_exhausted" });
      const lead = await createUserWithSession(app, `lead-wf-${randomUUID().slice(0, 6)}@example.com`);
      await addMember(app, projectId, lead.id, "project_lead");
      const drawn = await inject(lead, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: null });
      expect(drawn.statusCode, drawn.body).toBe(202);
      const wfId = (drawn.json() as { wireframeId: string }).wireframeId;
      const [job] = await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, wfId));
      expect(job).toMatchObject({ sourceKind: "wireframe", budgetBypass: true });
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("una persona non scrive da sé un blocco `wireframe` (le bozze le disegna Claude)", async () => {
    const p = await page();
    const v = await state(p);
    const res = await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "s", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: { id: `blk-${randomUUID()}`, type: "wireframe", wireframeId: randomUUID(), variant: 0 } }] });
    expect(res.json()).toMatchObject({ code: "invalid_wireframe" });
  });
});

describe("«Redraw», «Pick», «Keep», «Replace with an image»", () => {
  async function sketch() {
    const p = await page();
    const { blockId, wireframeId } = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: p.ids.p1 })).json() as { blockId: string; wireframeId: string };
    await clearHolds(p);
    await drawn(wireframeId, 2);
    return { p, blockId, wireframeId };
  }

  it("«Redraw» rimette `drawing` e riaccoda; il doppio clic (fromVariant vecchio) e un disegno in corso non fanno niente", async () => {
    const { p, blockId, wireframeId } = await sketch();
    await t.db.update(productDocJobs).set({ status: "done" }).where(eq(productDocJobs.sourceId, wireframeId));
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/redraw`, { fromVariant: 1 })).statusCode).toBe(202);
    expect((await t.db.select().from(productWireframes).where(eq(productWireframes.id, wireframeId)))[0]!.status).toBe("ready");
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/redraw`, { fromVariant: 0 })).statusCode).toBe(202);
    expect((await t.db.select().from(productWireframes).where(eq(productWireframes.id, wireframeId)))[0]!.status).toBe("drawing");
    expect((await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, wireframeId)))[0]).toMatchObject({ status: "queued" });
    expect((await state(p)).wireframes[0]).toMatchObject({ status: "drawing", variants: [expect.anything(), expect.anything()] });
  });

  it("«Pick» una variante disegnata (una revisione della persona); una che non c'è è 422; «Keep» toglie l'etichetta, due volte non scrive", async () => {
    const { p, blockId } = await sketch();
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/pick`, { variant: 5 })).json()).toMatchObject({ code: "invalid_variant" });
    const picked = await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/pick`, { variant: 1 });
    expect(picked.statusCode, picked.body).toBe(200);
    const [rev] = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.id, (picked.json() as { revisionId: string }).revisionId));
    expect(rev).toMatchObject({ actorId: ada.id, via: null });
    await clearHolds(p);
    expect((await state(p)).blocks.find((b) => b.id === blockId)).toMatchObject({ variant: 1 });
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/keep`)).json()).toMatchObject({ revisionId: expect.any(String) });
    await clearHolds(p);
    expect((await state(p)).blocks.find((b) => b.id === blockId)).toMatchObject({ kept: true });
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/keep`)).json()).toEqual({ revisionId: null });
  });

  it("«Replace with an image»: solo un'immagine caricata in QUESTA pagina; stesso id, didascalia vuota", async () => {
    const { p, blockId } = await sketch();
    const other = await page();
    const [foreign] = await t.db.insert(productPageImages).values({ pageId: other.id, projectId, storageKey: `k-${randomUUID()}`, mime: "image/png", sizeBytes: 1 }).returning();
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/replace-image`, { src: `product-image:${foreign!.id}`, alt: "" })).json()).toMatchObject({ code: "invalid_image" });
    const [mine] = await t.db.insert(productPageImages).values({ pageId: p.id, projectId, storageKey: `k-${randomUUID()}`, mime: "image/png", sizeBytes: 1 }).returning();
    const res = await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/replace-image`, { src: `product-image:${mine!.id}`, alt: "Il checkout" });
    expect(res.statusCode, res.body).toBe(200);
    await clearHolds(p);
    expect((await state(p)).blocks.find((b) => b.id === blockId)).toEqual({ id: blockId, type: "image", src: `product-image:${mine!.id}`, caption: "", alt: "Il checkout" });
  });
});

describe("«Undo» dalla cronologia di «Keep» e «Replace with an image» (il prototipo: `isUndoableRevision`)", () => {
  async function sketch() {
    const p = await page();
    const { blockId, wireframeId } = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: p.ids.p1 })).json() as { blockId: string; wireframeId: string };
    await clearHolds(p);
    await drawn(wireframeId, 2);
    return { p, blockId, wireframeId };
  }
  const history = async (who: U, p: Page) => (await inject(who, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[];
  const undoAll = (who: U, revisionId: string) => inject(who, "POST", `/api/product-revisions/${revisionId}/undo-all`);

  it("«Keep» si annulla: l'etichetta torna, una revisione `undo` di chi annulla; due volte è 409 `already_undone`", async () => {
    const { p, blockId, wireframeId } = await sketch();
    const kept = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/keep`)).json() as { revisionId: string };
    await clearHolds(p);
    const row = (await history(ada, p)).find((r) => r.id === kept.revisionId)!;
    expect(row).toMatchObject({ wireframe: "kept", undo: { enabled: true }, undoByAnchor: { [blockId]: { enabled: true } }, undoneCount: { done: 0, count: 1 } });
    expect((await history(vic, p)).find((r) => r.id === kept.revisionId)).toMatchObject({ undo: { enabled: false, reason: "no_permission" } });
    const res = await undoAll(ada, kept.revisionId);
    expect(res.statusCode, res.body).toBe(200);
    await clearHolds(p);
    expect((await state(p)).blocks.find((b) => b.id === blockId)).toEqual({ id: blockId, type: "wireframe", wireframeId, variant: 0 });
    const [undo] = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.id, (res.json() as { revisionId: string }).revisionId));
    expect(undo).toMatchObject({ kind: "undo", undoOf: kept.revisionId, actorId: ada.id });
    expect((await history(ada, p)).find((r) => r.id === kept.revisionId)).toMatchObject({ undo: { enabled: false, reason: "already_undone", byId: ada.id }, undoneCount: { done: 1, count: 1 }, undoneById: ada.id });
    const again = await undoAll(ada, kept.revisionId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already_undone" });
  });

  it("«Replace with an image» si annulla: torna la bozza; toccata dopo è 409 `changed_after`", async () => {
    const { p, blockId, wireframeId } = await sketch();
    const [img] = await t.db.insert(productPageImages).values({ pageId: p.id, projectId, storageKey: `k-${randomUUID()}`, mime: "image/png", sizeBytes: 1 }).returning();
    const replaced = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/replace-image`, { src: `product-image:${img!.id}`, alt: "" })).json() as { revisionId: string };
    await clearHolds(p);
    expect((await history(ada, p)).find((r) => r.id === replaced.revisionId)).toMatchObject({ wireframe: "replaced", undo: { enabled: true } });
    const res = await undoAll(ada, replaced.revisionId);
    expect(res.statusCode, res.body).toBe(200);
    await clearHolds(p);
    expect((await state(p)).blocks.find((b) => b.id === blockId)).toEqual({ id: blockId, type: "wireframe", wireframeId, variant: 0 });

    // Di nuovo, poi una persona cambia la didascalia: l'«Undo» si spegne col suo nome.
    const again = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/replace-image`, { src: `product-image:${img!.id}`, alt: "x" })).json() as { revisionId: string };
    await clearHolds(p);
    const v = await state(p);
    const image = v.blocks.find((b) => b.id === blockId)!;
    expect((await inject(ada, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "s2", baseSeq: v.seq, ops: [{ op: "set", block: { ...image, caption: "Il checkout" } }] })).statusCode).toBe(200);
    await clearHolds(p);
    expect((await history(ada, p)).find((r) => r.id === again.revisionId)).toMatchObject({ undo: { enabled: false, reason: "changed_after", byId: ada.id } });
    const blocked = await undoAll(ada, again.revisionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "changed_after" });
    expect((await state(p)).blocks.find((b) => b.id === blockId)).toMatchObject({ type: "image", caption: "Il checkout" });
  });

  it("«Draw» è una revisione di Claude per conto di chi chiede (`via`, `wireframe: drew`); «Pick» non si annulla dalla cronologia (404)", async () => {
    const { p, blockId } = await sketch();
    const draw = (await history(ada, p)).find((r) => r.kind === "edit" && r.wireframe === "drew");
    expect(draw).toMatchObject({ via: "claude", undo: null });
    const picked = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/pick`, { variant: 1 })).json() as { revisionId: string };
    await clearHolds(p);
    expect((await history(ada, p)).find((r) => r.id === picked.revisionId)).toMatchObject({ wireframe: null, undo: null });
    expect((await undoAll(ada, picked.revisionId)).statusCode).toBe(404);
  });
});
