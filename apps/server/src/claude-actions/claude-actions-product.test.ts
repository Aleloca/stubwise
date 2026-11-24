import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  emailProposals,
  instanceSettings,
  issueChatToolToken,
  productDocJobs,
  productFirstVersions,
  productPageRevisions,
  productPageUpdates,
  productSectionHolds,
  productWireframes,
} from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { requestProductPageUpdate } from "../services/product-claude-actions.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 11, F6, Task 4 — le sei voci della doc di prodotto nel catalogo di
 * Claude. Tutte B (F6-1 = a); le tre che fanno partire il modello lo dicono
 * (`starts_work`). Il permesso è `docs.edit` nel progetto, come la rotta; le
 * scritture passano dai servizi della pagina; «Annulla» con gli inversi.
 */

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let bea: U;
let vic: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ada = await createUserWithSession(app, "ada-cp@example.com");
  bea = await createUserWithSession(app, "bea-cp@example.com");
  vic = await createUserWithSession(app, "vic-cp@example.com");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

/** Un progetto con Ada e Bea (developer) e Vic (viewer), e un'email di Ada e una di Bea per il progetto. */
async function space() {
  const { projectId } = await seedRepository(t.db);
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, bea.id, "developer");
  await addMember(app, projectId, vic.id, "viewer");
  const adaMail = await seedEmailMessage(t.db, { userId: ada.id, subject: "Pagamenti a 60 giorni" });
  const beaMail = await seedEmailMessage(t.db, { userId: bea.id, subject: "Riservata di Bea" });
  for (const m of [adaMail, beaMail]) await t.db.insert(emailProposals).values({ emailMessageId: m.messageId, projectId, status: "proposed", classification: {} });
  return { projectId, adaMail, beaMail };
}
type Space = Awaited<ReturnType<typeof space>>;

async function page(s: Space) {
  const created = (await inject(ada, "POST", `/api/projects/${s.projectId}/product/pages`, { title: `P ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  const view = (await inject(ada, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  return { ...created, firstBlockId: view.blocks[0]!.id };
}

/** La conversazione e il token del turno; `send` propone. */
async function open(who: U) {
  const res = await inject(who, "POST", "/api/claude/conversations", {});
  const sid = (res.json() as { id: string }).id;
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: who.id, ttlMs: 60_000 });
  const send = async (actions: unknown[]) => {
    const proposed = await app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-cp-${++n}`, actions } });
    return proposed.json() as { status: string; proposalId: string | null; reason: string | null };
  };
  return { sid, send };
}
async function propose(who: U, actions: unknown[]) {
  const { sid, send } = await open(who);
  return { sid, body: await send(actions) };
}
/** Propone; una B si legge (classe e motivi) e si conferma. */
async function proposeAndConfirm(who: U, actions: unknown[]) {
  const { sid, body } = await propose(who, actions);
  expect(body.status, JSON.stringify(body)).toBe("awaiting_confirmation");
  const [view] = (await inject(who, "GET", `/api/claude/conversations/${sid}/proposals`)).json() as { id: string; cls: string; reasons: { kind: string }[] }[];
  const confirmed = await inject(who, "POST", `/api/claude/proposals/${view!.id}/confirm`, {});
  return { view: view!, confirmed, groupId: (confirmed.json() as { groupId?: string }).groupId ?? null, sid };
}
const undo = (who: U, groupId: string) => inject(who, "POST", `/api/claude/groups/${groupId}/undo`);
/** I codici che la vista del gruppo dà a ogni azione (la frase «fatto» li nomina). */
const groupCodes = async (who: U, sid: string) => ((await inject(who, "GET", `/api/claude/conversations/${sid}/groups`)).json() as { actions: { codes: string[] }[] }[]).map((g) => g.actions.map((a) => a.codes));

describe("drawWireframe e deleteWireframe", () => {
  it("B con `starts_work`: il blocco e il lavoro alla conferma (mai a secco); «Annulla» toglie la bozza e la sua riga", async () => {
    const s = await space();
    const p = await page(s);
    const { view, confirmed, groupId, sid } = await proposeAndConfirm(ada, [{ fn: "drawWireframe", args: { pageId: p.id, afterId: p.firstBlockId } }]);
    expect(view.cls).toBe("B");
    expect(view.reasons.map((r) => r.kind)).toContain("starts_work");
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await groupCodes(ada, sid)).toEqual([[[p.code]]]);
    const [wf] = await t.db.select().from(productWireframes).where(eq(productWireframes.pageId, p.id));
    expect(wf).toMatchObject({ status: "drawing", requestedBy: ada.id });
    expect(await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, wf!.id))).toHaveLength(1);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    expect((await undo(ada, groupId!)).json()).toEqual({ kind: "undone" });
    const after = (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
    expect(after.blocks.some((b) => b.type === "wireframe")).toBe(false);
    expect(await t.db.select().from(productWireframes).where(eq(productWireframes.pageId, p.id))).toEqual([]);
    const revs = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, p.id));
    expect(revs.at(-1)).toMatchObject({ kind: "undo", actorId: ada.id });
  });

  it("senza `docs.edit` (Viewer) è rifiutata, e non nasce niente; col budget finito pure", async () => {
    const s = await space();
    const p = await page(s);
    expect((await propose(vic, [{ fn: "drawWireframe", args: { pageId: p.id } }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("missing docs.edit") });
    // La conversazione prima: col budget finito non se ne apre una nuova.
    const turn = await open(ada);
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "0" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "0" } });
    try {
      expect(await turn.send([{ fn: "drawWireframe", args: { pageId: p.id } }])).toMatchObject({ status: "refused", reason: expect.stringContaining("budget") });
    } finally {
      await t.db.delete(instanceSettings);
    }
    expect(await t.db.select().from(productWireframes).where(eq(productWireframes.pageId, p.id))).toEqual([]);
  });

  it("deleteWireframe: dopo che qualcuno ha toccato il blocco è un conflitto (`changed_after`), e la bozza resta", async () => {
    const s = await space();
    const p = await page(s);
    const drawn = await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: p.firstBlockId });
    const { blockId, wireframeId } = drawn.json() as { blockId: string; wireframeId: string };
    const revisionId = (await t.db.select().from(productPageRevisions).where(and(eq(productPageRevisions.pageId, p.id), eq(productPageRevisions.via, "claude")))).at(-1)!.id;
    await t.db.update(productWireframes).set({ status: "ready", variants: [{ svg: "<svg/>" }] }).where(eq(productWireframes.id, wireframeId));
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    expect((await inject(bea, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/keep`)).statusCode).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    // La prova a secco lo vede già: la proposta è rifiutata col motivo.
    expect((await propose(ada, [{ fn: "deleteWireframe", args: { pageId: p.id, blockId, revisionId } }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("changed_after") });
    expect(await t.db.select().from(productWireframes).where(eq(productWireframes.id, wireframeId))).toHaveLength(1);
  });
});

describe("undoProductUpdate", () => {
  it("annulla un gesto annullabile dalla cronologia («Keep»): la bozza torna con l'etichetta", async () => {
    const s = await space();
    const p = await page(s);
    const { blockId, wireframeId } = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes`, { afterId: p.firstBlockId })).json() as { blockId: string; wireframeId: string };
    await t.db.update(productWireframes).set({ status: "ready", variants: [{ svg: "<svg/>" }] }).where(eq(productWireframes.id, wireframeId));
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    const kept = (await inject(ada, "POST", `/api/product-pages/${p.id}/wireframes/${blockId}/keep`)).json() as { revisionId: string };
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    const { view, confirmed, sid } = await proposeAndConfirm(ada, [{ fn: "undoProductUpdate", args: { revisionId: kept.revisionId } }]);
    expect(view.cls).toBe("B");
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // Il gruppo dice la pagina (richiesta di 94): il codice risolto dalla revisione, come per `updateProductPage`.
    const [group] = (await inject(ada, "GET", `/api/claude/conversations/${sid}/groups`)).json() as { actions: { codes: string[] }[] }[];
    expect(group!.actions[0]!.codes).toEqual([p.code]);
    const after = (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
    expect(after.blocks.find((b) => b.id === blockId)).not.toHaveProperty("kept");
  });
});

describe("updateProductPage", () => {
  it("B con `starts_work`: alla conferma UNA richiesta per la pagina e la fonte, col suo lavoro della coda; una seconda mentre è viva è un conflitto", async () => {
    const s = await space();
    const p = await page(s);
    const args = { pageId: p.id, source: { kind: "email", id: s.adaMail.messageId } };
    const { view, confirmed, sid } = await proposeAndConfirm(ada, [{ fn: "updateProductPage", args }]);
    expect(view.cls).toBe("B");
    expect(view.reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(["starts_work", "irreversible"]));
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await groupCodes(ada, sid)).toEqual([[[p.code]]]);
    const [u] = await t.db.select().from(productPageUpdates).where(eq(productPageUpdates.pageId, p.id));
    expect(u).toMatchObject({ sourceKind: "email", sourceId: s.adaMail.messageId, requestedBy: ada.id, finishedAt: null });
    expect(await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, u!.id))).toEqual([expect.objectContaining({ sourceKind: "page_update", status: "queued" })]);
    expect((await propose(ada, [{ fn: "updateProductPage", args }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("already_updating") });
  });

  it("D-7.1 (review del lotto 4, I-1): col budget finito il Developer riceve `budget_exhausted` e nulla nasce; il Project Lead lo scavalca e il lavoro lo porta", async () => {
    const s = await space();
    const p = await page(s);
    const source = { kind: "email" as const, id: s.adaMail.messageId };
    const asAda = { id: ada.id, instancePermissions: new Set<string>() } as never;
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "0" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "0" } });
    try {
      await expect(requestProductPageUpdate(t.db, asAda, p.id, source)).rejects.toMatchObject({ code: "budget_exhausted" });
      expect(await t.db.select().from(productPageUpdates).where(eq(productPageUpdates.pageId, p.id))).toEqual([]);
      await addMember(app, s.projectId, ada.id, "project_lead");
      const { updateId } = await requestProductPageUpdate(t.db, asAda, p.id, source);
      expect(await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, updateId))).toEqual([expect.objectContaining({ sourceKind: "page_update", budgetBypass: true })]);
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("review del lotto 5 (M-3, 46): col budget finito, chi lo scavalca e trova la richiesta FERMA la riprende (scavalco sul lavoro, di nuovo in coda, la stessa richiesta)", async () => {
    const s = await space();
    const p = await page(s);
    const source = { kind: "email" as const, id: s.adaMail.messageId };
    const asAda = { id: ada.id, instancePermissions: new Set<string>() } as never;
    // Chiesta prima che il budget finisse, poi fermata per il budget.
    const { updateId } = await requestProductPageUpdate(t.db, asAda, p.id, source);
    await t.db.update(productDocJobs).set({ status: "held", heldReason: "budget" }).where(eq(productDocJobs.sourceId, updateId));
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "0" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "0" } });
    try {
      // Ada da Developer: il budget la ferma (non scavalca).
      await expect(requestProductPageUpdate(t.db, asAda, p.id, source)).rejects.toMatchObject({ code: "budget_exhausted" });
      // Ada diventa Project Lead: riprende la stessa richiesta.
      await addMember(app, s.projectId, ada.id, "project_lead");
      expect(await requestProductPageUpdate(t.db, asAda, p.id, source)).toEqual({ updateId });
      expect(await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, updateId))).toEqual([expect.objectContaining({ status: "queued", heldReason: null, budgetBypass: true })]);
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("revisione dei lotti 6–7 (I-2): la ripresa rimette in coda SOLO un fermo per il budget; il backoff e un fermo per il limite restano come sono", async () => {
    const s = await space();
    const source = { kind: "email" as const, id: s.adaMail.messageId };
    const asAda = { id: ada.id, instancePermissions: new Set<string>() } as never;
    await addMember(app, s.projectId, ada.id, "project_lead");
    const later = new Date(Date.now() + 3_600_000);
    // In backoff: in coda, ma non prima di `later`.
    const backoff = await page(s);
    const a = await requestProductPageUpdate(t.db, asAda, backoff.id, source);
    await t.db.update(productDocJobs).set({ status: "queued", notBefore: later }).where(eq(productDocJobs.sourceId, a.updateId));
    // Fermo per il limite del provider.
    const limited = await page(s);
    const b = await requestProductPageUpdate(t.db, asAda, limited.id, source);
    await t.db.update(productDocJobs).set({ status: "held", heldReason: "limit", notBefore: later }).where(eq(productDocJobs.sourceId, b.updateId));
    await t.db.update(productDocJobs).set({ budgetBypass: false }).where(inArray(productDocJobs.sourceId, [a.updateId, b.updateId]));

    expect(await requestProductPageUpdate(t.db, asAda, backoff.id, source)).toEqual({ updateId: a.updateId });
    expect(await requestProductPageUpdate(t.db, asAda, limited.id, source)).toEqual({ updateId: b.updateId });
    const [ja] = await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, a.updateId));
    const [jb] = await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, b.updateId));
    expect(ja).toMatchObject({ status: "queued", heldReason: null, budgetBypass: true });
    expect(ja!.notBefore?.getTime()).toBe(later.getTime());
    expect(jb).toMatchObject({ status: "held", heldReason: "limit", budgetBypass: true });
    expect(jb!.notBefore?.getTime()).toBe(later.getTime());
  });

  it("la fonte deve essere di chi chiede da aprire (l'email di Bea per Ada è come se non ci fosse) e del progetto; senza `docs.edit` niente", async () => {
    const s = await space();
    const p = await page(s);
    expect((await propose(ada, [{ fn: "updateProductPage", args: { pageId: p.id, source: { kind: "email", id: s.beaMail.messageId } } }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("not found, or not visible") });
    const other = await seedEmailMessage(t.db, { userId: ada.id, subject: "Di un altro progetto" });
    expect((await propose(ada, [{ fn: "updateProductPage", args: { pageId: p.id, source: { kind: "email", id: other.messageId } } }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("invalid_source") });
    expect((await propose(vic, [{ fn: "updateProductPage", args: { pageId: p.id, source: { kind: "email", id: s.adaMail.messageId } } }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("missing docs.edit") });
    expect(await t.db.select().from(productPageUpdates).where(eq(productPageUpdates.pageId, p.id))).toEqual([]);
  });
});

describe("writeFirstVersion e undoFirstVersion", () => {
  it("B con `starts_work`: la prima versione parte alla conferma; «Annulla» la toglie (undoFirstVersion)", async () => {
    const s = await space();
    const { view, confirmed, groupId } = await proposeAndConfirm(ada, [{ fn: "writeFirstVersion", args: { projectId: s.projectId, sources: [{ kind: "text", text: "Le note del kickoff" }] } }]);
    expect(view.cls).toBe("B");
    expect(view.reasons.map((r) => r.kind)).toContain("starts_work");
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const [fv] = await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.projectId, s.projectId));
    expect(fv).toMatchObject({ status: "writing", startedBy: ada.id });
    expect((await undo(ada, groupId!)).json()).toEqual({ kind: "undone" });
    const [after] = await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv!.id));
    expect(after?.status ?? "gone").not.toBe("writing");
  });

  it("senza `docs.edit` (Viewer) è rifiutata", async () => {
    const s = await space();
    expect((await propose(vic, [{ fn: "writeFirstVersion", args: { projectId: s.projectId, sources: [{ kind: "text", text: "x" }] } }])).body).toMatchObject({ status: "refused", reason: expect.stringContaining("missing docs.edit") });
    expect(await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.projectId, s.projectId))).toEqual([]);
  });
});
