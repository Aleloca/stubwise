import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { backlogItemTickets, backlogJobs, createRequestItem, productRequestOrigins, projectMembers, projects, roles, tickets } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductBacklogCandidates, ProductLinkedRequest, ProductPageView, ProjectRequestView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F6 — dalla pagina al backlog: le voci che una pagina propone, la
// proposta con l'origine (pagina e frase, mai la frase in lettura), la
// `productOrigin` derivata su richieste e task, e «From this page».

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U; // Developer: scrive i Docs e vede tutto il backlog.
let wes: U; // scrive i Docs, ma del backlog vede solo il suo.
let nod: U; // vede il backlog, ma non i Docs.
let vic: U; // Viewer: legge soltanto.
let out: U; // fuori dal progetto.
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ada = await createUserWithSession(app, "ada-bk@example.com");
  wes = await createUserWithSession(app, "wes-bk@example.com");
  nod = await createUserWithSession(app, "nod-bk@example.com");
  vic = await createUserWithSession(app, "vic-bk@example.com");
  out = await createUserWithSession(app, "out-bk@example.com");
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, vic.id, "viewer");
  const custom = async (name: string, permissions: string[]) => (await t.db.insert(roles).values({ name, scope: "project", permissions }).returning())[0]!.id;
  await t.db.insert(projectMembers).values({ projectId, userId: wes.id, roleId: await custom("Writer", ["docs.view", "docs.edit", "backlog.create"]) });
  await t.db.insert(projectMembers).values({ projectId, userId: nod.id, roleId: await custom("Backlog only", ["backlog.view_all", "backlog.create", "tickets.view_all"]) });
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

/** Una pagina: un titolo con due voci sotto, poi un altro titolo con una. */
async function page() {
  const created = (await inject(ada, "POST", `/api/projects/${projectId}/product/pages`, { title: `Phases ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(ada, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const ids = { h1: `blk-${randomUUID()}`, a: `blk-${randomUUID()}`, b: `blk-${randomUUID()}`, h2: `blk-${randomUUID()}`, c: `blk-${randomUUID()}` };
  const text = (s: string) => ({ text: s, marks: [] });
  const ops = [
    { op: "insert", afterId: view.blocks[0]!.id, block: { id: ids.h1, type: "heading", level: 2, content: text("Phase 1") } },
    { op: "insert", afterId: ids.h1, block: { id: ids.a, type: "bullet", indent: 0, content: text("Bills as PDF") } },
    { op: "insert", afterId: ids.a, block: { id: ids.b, type: "todo", checked: false, content: text("Meter readings from the app") } },
    { op: "insert", afterId: ids.b, block: { id: ids.h2, type: "heading", level: 2, content: text("Phase 2") } },
    { op: "insert", afterId: ids.h2, block: { id: ids.c, type: "numbered", indent: 0, content: text("Fault reports with a photo") } },
  ];
  expect((await inject(ada, "POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops })).statusCode).toBe(200);
  return { ...created, ids };
}
type Page = Awaited<ReturnType<typeof page>>;

const candidates = async (who: U, p: Page, from?: string) => (await inject(who, "GET", `/api/product-pages/${p.id}/backlog-candidates${from ? `?fromAnchorId=${from}` : ""}`)).json() as ProductBacklogCandidates;

/** «Turn into backlog items» confermato: la richiesta con l'origine (pagina e frase). */
async function propose(who: U, p: Page, anchorId: string, title = "T") {
  const res = await inject(who, "POST", "/api/requests", { projectId, title, description: title, origin: { kind: "product_doc", pageId: p.id, anchorId } });
  return res;
}

/** L'intake ha finito: la voce del job. */
async function intakeDone(jobId: string, requesterId: string, title = "T") {
  const itemId = await createRequestItem(t.db, { projectId, title, document: title, requesterId, estimate: false });
  await t.db.update(backlogJobs).set({ status: "done", resultItemId: itemId }).where(eq(backlogJobs.id, jobId));
  return itemId;
}

describe("le voci che una pagina propone", () => {
  it("la pagina intera e la sola sezione di un titolo; un'ancora che non è un titolo è 422; chi legge soltanto 403; chi è fuori 404", async () => {
    const p = await page();
    expect((await candidates(ada, p)).candidates.map((c) => [c.anchorId, c.title, c.description])).toEqual([
      [p.ids.a, "Bills as PDF", "Bills as PDF"],
      [p.ids.b, "Meter readings from the app", "Meter readings from the app"],
      [p.ids.c, "Fault reports with a photo", "Fault reports with a photo"],
    ]);
    expect((await candidates(ada, p, p.ids.h2)).candidates.map((c) => c.anchorId)).toEqual([p.ids.c]);
    expect((await inject(ada, "GET", `/api/product-pages/${p.id}/backlog-candidates?fromAnchorId=${p.ids.a}`)).json()).toMatchObject({ code: "invalid_anchor" });
    expect((await inject(vic, "GET", `/api/product-pages/${p.id}/backlog-candidates`)).statusCode).toBe(403);
    expect((await inject(out, "GET", `/api/product-pages/${p.id}/backlog-candidates`)).statusCode).toBe(404);
  });

  it("una frase proposta non torna; la seconda proposta è 409 `already_proposed`; la nota coi codici che chi guarda vede e quante altre", async () => {
    const p = await page();
    const first = await propose(ada, p, p.ids.a, "Bills as PDF");
    expect(first.statusCode, first.body).toBe(202);
    // In coda: la frase è già presa (il doppio clic), anche prima che l'intake finisca.
    expect((await candidates(ada, p)).candidates.map((c) => c.anchorId)).toEqual([p.ids.b, p.ids.c]);
    const again = await propose(ada, p, p.ids.a);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already_proposed" });
    const itemId = await intakeDone((first.json() as { jobId: string }).jobId, ada.id, "Bills as PDF");
    const [item] = await t.db.select().from(productRequestOrigins).where(eq(productRequestOrigins.pageId, p.id));
    expect(item).toMatchObject({ anchorId: p.ids.a, questionId: null, createdBy: ada.id });
    const code = ((await inject(ada, "GET", `/api/requests/${itemId}`)).json() as ProjectRequestView).code;
    expect((await candidates(ada, p)).alreadyProposed).toEqual({ codes: [code], hidden: 0 });
    // Chi del backlog vede solo il suo: il codice non esce, si conta.
    expect((await candidates(wes, p)).alreadyProposed).toEqual({ codes: [], hidden: 1 });
    // Un intake fallito libera la frase.
    const second = await propose(ada, p, p.ids.b);
    await t.db.update(backlogJobs).set({ status: "failed" }).where(eq(backlogJobs.id, (second.json() as { jobId: string }).jobId));
    expect((await candidates(ada, p)).candidates.map((c) => c.anchorId)).toEqual([p.ids.b, p.ids.c]);
  });

  it("un'ancora che non c'è più lascia l'origine sulla pagina (frase null), e non prende nessuna frase", async () => {
    const p = await page();
    const res = await propose(ada, p, "blk-gone");
    expect(res.statusCode, res.body).toBe(202);
    const [o] = await t.db.select().from(productRequestOrigins).where(eq(productRequestOrigins.pageId, p.id));
    expect(o).toMatchObject({ anchorId: null });
    expect((await candidates(ada, p)).candidates).toHaveLength(3);
  });

  it("una pagina di un altro progetto, o che chi propone non legge: 422 `invalid_origin`, e niente richiesta", async () => {
    const p = await page();
    const res = await inject(nod, "POST", "/api/requests", { projectId, title: "T", description: "", origin: { kind: "product_doc", pageId: p.id, anchorId: p.ids.a } });
    expect(res.json()).toMatchObject({ code: "invalid_origin" });
    expect(await t.db.select().from(productRequestOrigins).where(eq(productRequestOrigins.pageId, p.id))).toEqual([]);
  });
});

describe("«From the doc» e «From this page»", () => {
  it("`productOrigin` della richiesta e della task che ne nasce: il titolo di adesso; null a chi non legge la pagina; mai la frase", async () => {
    const p = await page();
    const res = await propose(ada, p, p.ids.c, "Fault reports");
    const itemId = await intakeDone((res.json() as { jobId: string }).jobId, ada.id, "Fault reports");
    const view = (await inject(ada, "GET", `/api/requests/${itemId}`)).json() as ProjectRequestView;
    expect(view.productOrigin).toEqual({ pageId: p.id, code: p.code, title: expect.stringMatching(/^Phases /) });
    expect(JSON.stringify(view.productOrigin)).not.toContain("Fault reports with a photo");
    expect(((await inject(nod, "GET", `/api/requests/${itemId}`)).json() as ProjectRequestView).productOrigin).toBeNull();
    const list = (await inject(ada, "GET", `/api/requests?projectId=${projectId}`)).json() as ProjectRequestView[];
    expect(list.find((r) => r.id === itemId)!.productOrigin).toMatchObject({ pageId: p.id });

    const { ticketId } = await seedTicket(t.db, { projectId, repositoryId: undefined });
    await t.db.insert(backlogItemTickets).values({ itemId, ticketId, role: "converted_to" });
    const [ticket] = await t.db.select({ number: tickets.number, projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId));
    const taskCode = `${(await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, ticket!.projectId)))[0]!.code}-${ticket!.number}`;
    const task = await inject(ada, "GET", `/api/tasks/by-code/${taskCode}`);
    expect(task.statusCode, task.body).toBe(200);
    expect((task.json() as { productOrigin: unknown }).productOrigin).toEqual({ pageId: p.id, code: p.code, title: expect.any(String) });
    const theirs = await inject(nod, "GET", `/api/tasks/by-code/${taskCode}`);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect((theirs.json() as { productOrigin: unknown }).productOrigin).toBeNull();

    // «From this page»: la richiesta con la sua task.
    const linked = (await inject(ada, "GET", `/api/product-pages/${p.id}/requests`)).json() as ProductLinkedRequest[];
    expect(linked).toEqual([{ id: itemId, code: view.code, title: "Fault reports", status: view.status, taskCodes: [taskCode] }]);
  });

  it("«From this page» senza le richieste che chi guarda non vede; 403 a chi è nel progetto senza i Docs, 404 a chi è fuori", async () => {
    const p = await page();
    const mine = await propose(wes, p, p.ids.a, "Mine");
    const mineId = await intakeDone((mine.json() as { jobId: string }).jobId, wes.id, "Mine");
    const theirs = await propose(ada, p, p.ids.b, "Theirs");
    const theirsId = await intakeDone((theirs.json() as { jobId: string }).jobId, ada.id, "Theirs");
    expect(((await inject(ada, "GET", `/api/product-pages/${p.id}/requests`)).json() as ProductLinkedRequest[]).map((r) => r.id)).toEqual([mineId, theirsId]);
    expect(((await inject(wes, "GET", `/api/product-pages/${p.id}/requests`)).json() as ProductLinkedRequest[]).map((r) => r.id)).toEqual([mineId]);
    expect((await inject(nod, "GET", `/api/product-pages/${p.id}/requests`)).statusCode).toBe(403);
    expect((await inject(out, "GET", `/api/product-pages/${p.id}/requests`)).statusCode).toBe(404);
  });
});
