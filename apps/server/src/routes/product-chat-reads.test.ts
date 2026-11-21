import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { claudeConversationProjects, claudeConversations, emailProposals, issueChatToolToken, productPageRevisions, productSectionHolds } from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductChanges } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 11, F6, Task 4 — le letture di Claude sulla doc di prodotto, col token
 * del turno: una pagina per codice (`read_product_page`) e i cambi recenti
 * (`read_product_changes`). 200 a chi legge i Docs, 404 agli altri; la
 * lettura riuscita segna la conversazione NON fidata e registra i progetti.
 */

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let bea: U;
let out: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ada = await createUserWithSession(app, "ada-cr@example.com");
  bea = await createUserWithSession(app, "bea-cr@example.com");
  out = await createUserWithSession(app, "out-cr@example.com");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

async function turn(who: U) {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: who.headers.cookie }, payload: {} });
  const sessionId = (res.json() as { id: string }).id;
  const token = await issueChatToolToken(t.db, { sessionId, userId: who.id, ttlMs: 60_000 });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const mark = async () => (await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId)))[0]?.at ?? null;
  const projectsRead = async () => (await t.db.select({ id: claudeConversationProjects.projectId }).from(claudeConversationProjects).where(eq(claudeConversationProjects.sessionId, sessionId))).map((r) => r.id);
  return { get, mark, projectsRead };
}

async function space(withBea = true) {
  const { projectId } = await seedRepository(t.db);
  await addMember(app, projectId, ada.id, "developer");
  if (withBea) await addMember(app, projectId, bea.id, "viewer");
  const created = await app.inject({ method: "POST", url: `/api/projects/${projectId}/product/pages`, headers: { cookie: ada.headers.cookie }, payload: { title: `Pagamenti ${randomUUID().slice(0, 4)}` } });
  const page = created.json() as { id: string; code: string };
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, page.id));
  return { projectId, page };
}

describe("read_product_page: GET /api/product-pages/by-code/:code col token del turno", () => {
  it("chi legge i Docs la legge (200), la conversazione è segnata NON fidata e il progetto registrato; chi non è nel progetto riceve 404 e niente segno", async () => {
    const s = await space();
    const mine = await turn(bea);
    expect(await mine.mark()).toBeNull();
    const res = await mine.get(`/api/product-pages/by-code/${s.page.code}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await mine.mark()).not.toBeNull();
    expect(await mine.projectsRead()).toEqual([s.projectId]);

    const theirs = await turn(out);
    expect((await theirs.get(`/api/product-pages/by-code/${s.page.code}`)).statusCode).toBe(404);
    expect(await theirs.mark()).toBeNull();
  });
});

describe("read_product_changes: GET /api/product-changes col token del turno", () => {
  it("i cambi dei soli progetti in cui chi chiede legge i Docs, dal più recente; la fonte come la vede lui; segna la conversazione e registra i progetti", async () => {
    const s = await space();
    const other = await space(false);
    // Una revisione di Claude dall'email di Ada, sulla pagina del primo progetto.
    const mail = await seedEmailMessage(t.db, { userId: ada.id, subject: "Pagamenti a 60 giorni" });
    await t.db.insert(emailProposals).values({ emailMessageId: mail.messageId, projectId: s.projectId, status: "proposed", classification: {} });
    await t.db.insert(productPageRevisions).values({ pageId: s.page.id, seq: 99, lastSeq: 99, actorId: null, kind: "claude", changes: [], via: "claude", onBehalfOf: ada.id, sourceKind: "email", sourceId: mail.messageId });
    // Bea non è nel secondo progetto (gli altri del file sono suoi: il filtro è la WHERE, non l'ordine).
    const beaTurn = await turn(bea);
    const res = await beaTurn.get(`/api/product-changes?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as ProductChanges;
    expect(body.items.map((i) => i.projectId)).toContain(s.projectId);
    expect(body.items.map((i) => i.projectId)).not.toContain(other.projectId);
    const claude = body.items.find((i) => i.kind === "claude")!;
    expect(claude).toMatchObject({ pageCode: s.page.code, via: "claude", source: { kind: "email", canOpen: false } });
    // La casella è di Ada: Bea non legge l'oggetto (`mailbox_owner`).
    expect(res.body).not.toContain("Pagamenti a 60 giorni");
    expect(await beaTurn.mark()).not.toBeNull();
    expect(await beaTurn.projectsRead()).toContain(s.projectId);
    expect(await beaTurn.projectsRead()).not.toContain(other.projectId);
    // Un progetto che non legge: 404, come se non ci fosse.
    expect((await beaTurn.get(`/api/product-changes?projectId=${other.projectId}`)).statusCode).toBe(404);
    // Ada vede la sua email.
    const adaBody = (await (await turn(ada)).get(`/api/product-changes?projectId=${s.projectId}`)).json() as ProductChanges;
    expect(adaBody.items.find((i) => i.kind === "claude")).toMatchObject({ source: { canOpen: true, title: "Pagamenti a 60 giorni" } });
  });

  it("chi non legge i Docs in nessun progetto riceve un elenco vuoto", async () => {
    await space();
    const res = await (await turn(out)).get("/api/product-changes");
    expect(res.json()).toEqual({ items: [], more: false });
  });
});
