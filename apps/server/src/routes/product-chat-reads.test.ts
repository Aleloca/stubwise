import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessions, claudeConversationProjects, claudeConversations, emailProposals, issueChatToolToken, productPageRevisions, productSectionHolds, projects } from "@stubwise/db";
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
let admin: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  const seeded = await seedUsers(app);
  admin = { id: seeded.adminId, headers: { cookie: seeded.adminCookie } } as U;
  ada = await createUserWithSession(app, "ada-cr@example.com");
  bea = await createUserWithSession(app, "bea-cr@example.com");
  out = await createUserWithSession(app, "out-cr@example.com");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

async function turn(who: U, kind: "free" | "public" | "mention" = "free") {
  let sessionId: string;
  if (kind === "mention") {
    // Un turno di @Claude nella Chat: la risposta sta in un canale (ospiti compresi).
    const [mention] = await t.db.insert(agentSessions).values({ ownerKey: `chat_mention:${randomUUID()}`, kind: "chat_mention", title: "" }).returning();
    await t.db.insert(claudeConversations).values({ sessionId: mention!.id, ownerId: who.id, title: "" });
    sessionId = mention!.id;
  } else {
    const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: who.headers.cookie }, payload: {} });
    sessionId = (res.json() as { id: string }).id;
    if (kind === "public") await t.db.update(claudeConversations).set({ visibility: "public" }).where(eq(claudeConversations.sessionId, sessionId));
  }
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
    // Col token del turno nemmeno Ada riceve l'oggetto della SUA email (review di F6, I1): la risposta
    // può stare in una conversazione pubblica o in un canale. Il tipo, il titolare e `canOpen` restano.
    for (const kind of ["free", "public", "mention"] as const) {
      const res = await (await turn(ada, kind)).get(`/api/product-changes?projectId=${s.projectId}`);
      expect(res.statusCode, `${kind}: ${res.body}`).toBe(200);
      expect(res.body, kind).not.toContain("Pagamenti a 60 giorni");
      expect((res.json() as ProductChanges).items.find((i) => i.kind === "claude"), kind).toMatchObject({ source: { kind: "email", canOpen: true, title: null, thread: null, ownerName: expect.any(String) } });
    }
    // La rotta letta dal desktop (il cookie di Ada) resta com'è: lei vede la sua email.
    const desk = await app.inject({ method: "GET", url: `/api/product-changes?projectId=${s.projectId}`, headers: { cookie: ada.headers.cookie } });
    expect((desk.json() as ProductChanges).items.find((i) => i.kind === "claude")).toMatchObject({ source: { canOpen: true, title: "Pagamenti a 60 giorni", thread: expect.objectContaining({ threadId: expect.any(String) }) } });
  });

  it("un full admin: i progetti archiviati non ci sono, e un projectId archiviato o inesistente è 404 (review di F6, M2)", async () => {
    const open = await space();
    const archived = await space();
    for (const s of [open, archived]) await t.db.insert(productPageRevisions).values({ pageId: s.page.id, seq: 98, lastSeq: 98, actorId: ada.id, kind: "edit", changes: [] });
    await t.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived.projectId));
    const adminTurn = await turn(admin);
    const body = (await adminTurn.get("/api/product-changes")).json() as ProductChanges;
    expect(body.items.map((i) => i.projectId)).toContain(open.projectId);
    expect(body.items.map((i) => i.projectId)).not.toContain(archived.projectId);
    expect((await adminTurn.get(`/api/product-changes?projectId=${archived.projectId}`)).statusCode).toBe(404);
    expect((await adminTurn.get(`/api/product-changes?projectId=${randomUUID()}`)).statusCode).toBe(404);
    expect((await adminTurn.get(`/api/product-changes?projectId=${open.projectId}`)).statusCode).toBe(200);
  });

  it("chi non legge i Docs in nessun progetto riceve un elenco vuoto", async () => {
    await space();
    const res = await (await turn(out)).get("/api/product-changes");
    expect(res.json()).toEqual({ items: [], more: false });
  });
});
