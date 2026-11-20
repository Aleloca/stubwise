import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { productPageFollows, productPageRevisions, productPages, projectDecisions, projects } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductPageView, ProductSpaceView, ProductTreeNode } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F1: lo spazio Product. `docs.view` legge, `docs.edit` scrive;
// invisibile e archiviato = 404; il codice in un progetto visibile senza
// `docs.view` è 403 anche se la pagina non c'è (il prototipo).

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let editor: U;
let reader: U;
let noDocs: U;
let outsider: U;
let projectId: string;
let projectCode: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  projectCode = (await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)))[0]!.code;
  editor = await createUserWithSession(app, "editor-pd@example.com");
  reader = await createUserWithSession(app, "reader-pd@example.com");
  noDocs = await createUserWithSession(app, "nodocs-pd@example.com");
  outsider = await createUserWithSession(app, "out-pd@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
  // Contributor ha `docs.view`: un ruolo senza, per la regola del 403.
  const { roles, projectMembers } = await import("@stubwise/db");
  const [blind] = await t.db.insert(roles).values({ name: "Senza Docs", scope: "project", permissions: ["tickets.view_all"] }).returning({ id: roles.id });
  await t.db.insert(projectMembers).values({ projectId, userId: noDocs.id, roleId: blind!.id });
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const create = async (title: string, extra: Record<string, unknown> = {}, pid = projectId) => {
  const res = await inject(editor, "POST", `/api/projects/${pid}/product/pages`, { title, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string };
};
const space = async (who: U, pid = projectId) => inject(who, "GET", `/api/projects/${pid}/product`);
const titlesOf = (nodes: ProductTreeNode[]): unknown[] => nodes.map((n) => (n.children.length > 0 ? [n.page.title, titlesOf(n.children)] : n.page.title));

describe("lo spazio Product", () => {
  it("crea: il codice dalla serie dei Docs, un paragrafo vuoto, una revisione `create`, chi crea segue", async () => {
    const page = await create("Visione");
    expect(page.code).toMatch(new RegExp(`^${projectCode}-D\\d+$`));
    const [row] = await t.db.select().from(productPages).where(eq(productPages.id, page.id));
    expect(row!.blocks).toMatchObject([{ type: "paragraph", content: { text: "" } }]);
    expect(await t.db.select({ kind: productPageRevisions.kind }).from(productPageRevisions).where(eq(productPageRevisions.pageId, page.id))).toEqual([{ kind: "create" }]);
    expect(await t.db.select().from(productPageFollows).where(eq(productPageFollows.pageId, page.id))).toHaveLength(1);
  });

  it("`docs.view` legge lo spazio e la pagina, ma non scrive; senza `docs.edit` 403", async () => {
    const page = await create("Lettori");
    const s = await space(reader);
    expect(s.statusCode).toBe(200);
    expect((s.json() as ProductSpaceView).permissions).toEqual({ edit: false });
    const view = (await inject(reader, "GET", `/api/product-pages/by-code/${page.code}`)).json() as ProductPageView;
    expect(view.permissions).toEqual({ edit: false, delete: false });
    expect((await inject(reader, "POST", `/api/projects/${projectId}/product/pages`, { title: "No" })).statusCode).toBe(403);
    expect((await inject(reader, "PATCH", `/api/product-pages/${page.id}`, { title: "No" })).statusCode).toBe(403);
    expect((await inject(reader, "DELETE", `/api/product-pages/${page.id}`)).statusCode).toBe(403);
  });

  it("un non membro: 404 su spazio, pagina e scritture", async () => {
    const page = await create("Nascosta");
    expect((await space(outsider)).statusCode).toBe(404);
    expect((await inject(outsider, "GET", `/api/product-pages/by-code/${page.code}`)).statusCode).toBe(404);
    expect((await inject(outsider, "PATCH", `/api/product-pages/${page.id}`, { title: "No" })).statusCode).toBe(404);
  });

  it("il codice in un progetto visibile senza `docs.view`: 403, anche per un codice che non c'è", async () => {
    const page = await create("Con codice");
    expect((await inject(noDocs, "GET", `/api/product-pages/by-code/${page.code}`)).statusCode).toBe(403);
    expect((await inject(noDocs, "GET", `/api/product-pages/by-code/${projectCode}-D99999`)).statusCode).toBe(403);
    expect((await inject(editor, "GET", `/api/product-pages/by-code/${projectCode}-D99999`)).statusCode).toBe(404);
  });

  it("un progetto archiviato è come inesistente", async () => {
    const other = await seedRepository(t.db);
    await addMember(app, other.projectId, editor.id, "developer");
    const page = await create("Archiviata", {}, other.projectId);
    await t.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, other.projectId));
    expect((await space(editor, other.projectId)).statusCode).toBe(404);
    expect((await inject(editor, "GET", `/api/product-pages/by-code/${page.code}`)).statusCode).toBe(404);
  });

  it("albero, rinomina e sposta: l'ordine fra i fratelli, le briciole, il ciclo rifiutato (409), `move` solo se cambia il genitore", async () => {
    const other = await seedRepository(t.db);
    await addMember(app, other.projectId, editor.id, "developer");
    const a = await create("A", {}, other.projectId);
    const b = await create("B", {}, other.projectId);
    const c = await create("C", { parentId: a.id }, other.projectId);
    expect(titlesOf(((await space(editor, other.projectId)).json() as ProductSpaceView).tree)).toEqual([["A", ["C"]], "B"]);
    expect((await inject(editor, "PATCH", `/api/product-pages/${b.id}`, { move: { parentId: null, index: 0 } })).statusCode).toBe(204);
    expect(titlesOf(((await space(editor, other.projectId)).json() as ProductSpaceView).tree)).toEqual(["B", ["A", ["C"]]]);
    expect((await inject(editor, "PATCH", `/api/product-pages/${a.id}`, { move: { parentId: c.id, index: 0 } })).statusCode).toBe(409);
    expect((await inject(editor, "PATCH", `/api/product-pages/${c.id}`, { title: "C nuova", move: { parentId: b.id, index: 0 } })).statusCode).toBe(204);
    const view = (await inject(editor, "GET", `/api/product-pages/by-code/${c.code}`)).json() as ProductPageView;
    expect(view.title).toBe("C nuova");
    expect(view.breadcrumbs.map((p) => p.title)).toEqual(["B"]);
    const kinds = (await t.db.select({ kind: productPageRevisions.kind }).from(productPageRevisions).where(eq(productPageRevisions.pageId, b.id))).map((r) => r.kind);
    expect(kinds).toEqual(["create"]);
    const cKinds = (await t.db.select({ kind: productPageRevisions.kind }).from(productPageRevisions).where(eq(productPageRevisions.pageId, c.id))).map((r) => r.kind).sort();
    expect(cKinds).toEqual(["create", "move", "rename"]);
  });

  it("elimina: con figlie 409; senza, la pagina va e il codice resta preso", async () => {
    const parent = await create("Padre");
    const child = await create("Figlia", { parentId: parent.id });
    expect((await inject(editor, "DELETE", `/api/product-pages/${parent.id}`)).statusCode).toBe(409);
    expect((await inject(editor, "DELETE", `/api/product-pages/${child.id}`)).statusCode).toBe(204);
    expect((await inject(editor, "GET", `/api/product-pages/by-code/${child.code}`)).statusCode).toBe(404);
    const next = await create("Dopo");
    expect(Number(next.code.split("-D")[1])).toBeGreaterThan(Number(child.code.split("-D")[1]));
  });

  it("una decisione citata in un blocco: il titolo a chi ne vede il progetto, null a chi no", async () => {
    const other = await seedRepository(t.db);
    const [hidden] = await t.db.insert(projectDecisions).values({ projectId: other.projectId, source: "manual", sourceKey: "k1", title: "Segreta", decision: "x" } as typeof projectDecisions.$inferInsert).returning();
    const [visible] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: "k2", title: "Pubblica", decision: "y" } as typeof projectDecisions.$inferInsert).returning();
    const page = await create("Decisioni");
    await t.db
      .update(productPages)
      .set({ blocks: [{ id: "blk-d1", type: "decision", decisionId: hidden!.id }, { id: "blk-d2", type: "decision", decisionId: visible!.id }] })
      .where(eq(productPages.id, page.id));
    const view = (await inject(reader, "GET", `/api/product-pages/by-code/${page.code}`)).json() as ProductPageView;
    expect(view.decisions[hidden!.id]).toBeNull();
    expect(view.decisions[visible!.id]).toMatchObject({ title: "Pubblica" });
  });
});
