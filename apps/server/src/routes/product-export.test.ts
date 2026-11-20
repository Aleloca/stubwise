import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { driveFiles, productComments, productPages, projectDecisions, projectMembers, roles } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { PRODUCT_EXPORT_PAGES_MAX, type ProductExportPage, type ProductExportSpace } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F3, Task 4: l'esportazione. Niente commenti; le decisioni e i file
// del Drive come li vede chi esporta; nessun URL firmato (le immagini dalla
// rotta coi byte); lo spazio in ordine d'albero, al più 200 pagine.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let editor: U;
let reader: U;
let noDocs: U;
let projectId: string;
let hiddenProject: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ({ projectId: hiddenProject } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-x@example.com");
  reader = await createUserWithSession(app, "reader-x@example.com");
  noDocs = await createUserWithSession(app, "nodocs-x@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
  const [blind] = await t.db.insert(roles).values({ name: "Senza Docs X", scope: "project", permissions: ["tickets.view_all"] }).returning({ id: roles.id });
  await t.db.insert(projectMembers).values({ projectId, userId: noDocs.id, roleId: blind!.id });
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const create = async (title: string, parentId?: string, pid = projectId) => {
  const res = await inject(editor, "POST", `/api/projects/${pid}/product/pages`, { title, ...(parentId ? { parentId } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string };
};
const para = (id: string, text: string) => ({ id, type: "paragraph", content: { text, marks: [] } });

describe("l'esportazione", () => {
  it("una pagina: i blocchi senza commenti, le decisioni e i file del Drive come li vede chi esporta, nessun URL firmato", async () => {
    const page = await create("Da esportare");
    const [hiddenDecision] = await t.db.insert(projectDecisions).values({ projectId: hiddenProject, source: "manual", sourceKey: `k-${randomUUID()}`, title: "Segreta", decision: "x" } as typeof projectDecisions.$inferInsert).returning();
    const [visibleDecision] = await t.db.insert(projectDecisions).values({ projectId, source: "manual", sourceKey: `k-${randomUUID()}`, title: "Pubblica", decision: "y" } as typeof projectDecisions.$inferInsert).returning();
    const file = (pid: string, name: string, deleted = false) =>
      t.db.insert(driveFiles).values({ projectId: pid, number: Math.floor(Math.random() * 1e6), name, mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `drive/${randomUUID()}`, addedBy: editor.id, ...(deleted ? { deletedAt: new Date() } : {}) } as typeof driveFiles.$inferInsert).returning();
    const [seen] = await file(projectId, "visibile.pdf");
    const [hidden] = await file(hiddenProject, "nascosto.pdf");
    const [gone] = await file(projectId, "tolto.pdf", true);
    const imageId = randomUUID();
    await t.db
      .update(productPages)
      .set({
        blocks: [
          para("blk-a", "Il testo della pagina"),
          { id: "blk-d1", type: "decision", decisionId: hiddenDecision!.id },
          { id: "blk-d2", type: "decision", decisionId: visibleDecision!.id },
          { id: "blk-f1", type: "drive", fileId: seen!.id, code: "X" },
          { id: "blk-f2", type: "drive", fileId: hidden!.id, code: "Y" },
          { id: "blk-f3", type: "drive", fileId: gone!.id, code: "Z" },
          { id: "blk-i", type: "image", src: `product-image:${imageId}`, caption: "Schermata", alt: "" },
        ],
      })
      .where(eq(productPages.id, page.id));
    await t.db.insert(productComments).values({ pageId: page.id, anchorId: "blk-a", quote: "Il testo", body: "COMMENTO RISERVATO" });
    const res = await inject(reader, "GET", `/api/product-pages/${page.id}/export`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as ProductExportPage;
    expect(body.page).toMatchObject({ id: page.id, code: page.code, title: "Da esportare" });
    expect(body.blocks.map((b) => b.id)).toEqual(["blk-a", "blk-d1", "blk-d2", "blk-f1", "blk-f2", "blk-f3", "blk-i"]);
    expect(res.body).not.toContain("COMMENTO RISERVATO");
    expect(body.decisions[hiddenDecision!.id]).toBeNull();
    expect(body.decisions[visibleDecision!.id]).toMatchObject({ title: "Pubblica" });
    expect(body.files).toEqual({ [seen!.id]: { name: "visibile.pdf" }, [hidden!.id]: null, [gone!.id]: null });
    expect(res.body).not.toContain("https://");
    expect(body.blocks.find((b) => b.id === "blk-i")).toMatchObject({ src: `product-image:${imageId}` });
  });

  it("review di F3 (M6): un link con un indirizzo non sicuro esce senza il segno, col solo testo", async () => {
    const page = await create("Link");
    await t.db
      .update(productPages)
      .set({ blocks: [{ id: "blk-l", type: "paragraph", content: { text: "Clicca qui o qua", marks: [{ type: "link", start: 0, end: 6, href: "javascript:alert(1)" }, { type: "link", start: 12, end: 16, href: "https://example.com" }, { type: "bold", start: 7, end: 10 }] } }] })
      .where(eq(productPages.id, page.id));
    const body = (await inject(reader, "GET", `/api/product-pages/${page.id}/export`)).json() as ProductExportPage;
    expect(body.blocks[0]).toMatchObject({ content: { text: "Clicca qui o qua", marks: [{ type: "link", start: 12, end: 16, href: "https://example.com" }, { type: "bold", start: 7, end: 10 }] } });
    expect(JSON.stringify(body)).not.toContain("javascript:");
  });

  it("chi non legge i Docs non esporta (403); chi non vede il progetto 404", async () => {
    const page = await create("Chiusa");
    expect((await inject(noDocs, "GET", `/api/product-pages/${page.id}/export`)).statusCode).toBe(403);
    expect((await inject(noDocs, "GET", `/api/projects/${projectId}/product/export`)).statusCode).toBe(403);
    const outsider = await createUserWithSession(app, `out-x-${randomUUID().slice(0, 6)}@example.com`);
    expect((await inject(outsider, "GET", `/api/product-pages/${page.id}/export`)).statusCode).toBe(404);
  });

  it("lo spazio in ordine d'albero, con la profondità; oltre 200 pagine 413 col numero", async () => {
    const { projectId: space } = await seedRepository(t.db);
    await addMember(app, space, editor.id, "developer");
    const root = await create("Radice", undefined, space);
    const child = await create("Figlia", root.id, space);
    const second = await create("Seconda radice", undefined, space);
    const res = await inject(editor, "GET", `/api/projects/${space}/product/export`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as ProductExportSpace;
    expect(body.pages.map((p) => [p.page.id, p.depth])).toEqual([[root.id, 0], [child.id, 1], [second.id, 0]]);
    await t.db.insert(productPages).values(Array.from({ length: PRODUCT_EXPORT_PAGES_MAX - 2 }, (_, i) => ({ projectId: space, title: `Riempi ${i}` })));
    const big = await inject(editor, "GET", `/api/projects/${space}/product/export`);
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ code: "too_many_pages", message: expect.any(String), count: PRODUCT_EXPORT_PAGES_MAX + 1, max: PRODUCT_EXPORT_PAGES_MAX });
  });
});
