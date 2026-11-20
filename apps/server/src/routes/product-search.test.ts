import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { productPages, projectMembers, projects, roles } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient, type EmbeddingClient } from "@stubwise/embeddings";
import { productSearchText, type ProductBlock, type ProductPageView, type ProductSearchResults, type SearchResults } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { embedStaleProductPages } from "../services/product-embed.js";
import { searchProductPages } from "../services/product-search.js";
import { actorAs, addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F3, Task 2: la ricerca «In Product». Solo le pagine che chi cerca
// legge (`docs.view`), filtrate nella WHERE prima del limite; un progetto
// archiviato fuori; la frase senza `href`; il testo anche con l'embedder giù.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let reader: U;
let editor: U;
let noDocs: U;
let projectId: string;
let hiddenProject: string;
const embedder = createFakeEmbeddingClient();
let current: EmbeddingClient = embedder;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), embeddingClient: { embed: (texts: string[]) => current.embed(texts) } as EmbeddingClient });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ({ projectId: hiddenProject } = await seedRepository(t.db));
  reader = await createUserWithSession(app, "reader-s@example.com");
  editor = await createUserWithSession(app, "editor-s@example.com");
  await addMember(app, projectId, editor.id, "developer");
  noDocs = await createUserWithSession(app, "nodocs-s@example.com");
  await addMember(app, projectId, reader.id, "viewer");
  const [blind] = await t.db.insert(roles).values({ name: "Senza Docs S", scope: "project", permissions: ["tickets.view_all"] }).returning({ id: roles.id });
  await t.db.insert(projectMembers).values({ projectId, userId: noDocs.id, roleId: blind!.id });
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const rich = (text: string, marks: object[] = []) => ({ text, marks });
const para = (id: string, text: string, marks: object[] = []) => ({ id, type: "paragraph", content: rich(text, marks) });
let n = 0;
/** Una pagina scritta direttamente, col testo cercabile come lo scrivono le rotte (`productSearchText`). */
async function page(pid: string, title: string, blocks: object[], updatedAt = new Date()) {
  const full = `${title} ${++n}`;
  const [row] = await t.db.insert(productPages).values({ projectId: pid, title: full, blocks, searchText: productSearchText(full, blocks as ProductBlock[]), updatedAt }).returning();
  return row!;
}
const search = (who: U, q: string, pid = projectId) =>
  app.inject({ method: "GET", url: `/api/projects/${pid}/product/search?q=${encodeURIComponent(q)}`, headers: { cookie: who.headers.cookie } });
const globalSearch = async (who: U, q: string) =>
  ((await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie: who.headers.cookie } })).json() as SearchResults).product;

describe("la ricerca «In Product»", () => {
  it("chi legge i Docs trova la pagina per una parola del testo (piegata), con la frase; chi non li legge non trova niente, e il conteggio non lo tradisce", async () => {
    const p = await page(projectId, "Consegne", [para("a", "Introduzione"), para("b", "Il CAFFÈ si serve caldo")]);
    const res = await search(reader, "caffe caldo");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as ProductSearchResults;
    expect(body.items.map((h) => h.page.id)).toContain(p.id);
    expect(body.items.find((h) => h.page.id === p.id)!.passage).toBe("Il CAFFÈ si serve caldo");
    expect((await search(noDocs, "caffe")).statusCode).toBe(403);
    expect(await globalSearch(noDocs, "caffe")).toEqual({ items: [], hasMore: false });
    expect((await globalSearch(reader, "caffe")).items.map((h) => h.page.id)).toContain(p.id);
  });

  it("le scritture vere tengono aggiornato il testo cercabile: crea, scrivi a operazioni, rinomina", async () => {
    const inject = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      app.inject({ method, url, headers: { cookie: editor.headers.cookie }, ...(payload ? { payload: payload as never } : {}) });
    const created = (await inject("POST", `/api/projects/${projectId}/product/pages`, { title: "Pagina Fenicottero" })).json() as { id: string; code: string };
    const found = async (q: string) => ((await search(reader, q)).json() as ProductSearchResults).items.map((h) => h.page.id);
    expect(await found("fenicottero")).toContain(created.id);
    const view = (await inject("GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
    const saved = await inject("POST", `/api/product-pages/${created.id}/ops`, { sessionId: "s", baseSeq: view.seq, ops: [{ op: "set", block: para(view.blocks[0]!.id as string, "Arriva la Gru coronata") }] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await found("gru coronata")).toContain(created.id);
    expect((await inject("PATCH", `/api/product-pages/${created.id}`, { title: "Pagina Pellicano" })).statusCode).toBeLessThan(300);
    expect(await found("pellicano")).toContain(created.id);
    expect(await found("fenicottero")).not.toContain(created.id);
    expect(await found("gru")).toContain(created.id);
  });

  it("un indirizzo di un link non è testo: non si trova per lui, e la frase non lo contiene", async () => {
    const p = await page(projectId, "Link", [para("a", "Vedi il menù", [{ type: "link", start: 5, end: 12, href: "https://segretissimo.example/menu" }])]);
    expect((await search(reader, "segretissimo")).json()).toEqual({ items: [], hasMore: false });
    const hit = (await search(reader, "menu")).json() as ProductSearchResults;
    const mine = hit.items.find((h) => h.page.id === p.id)!;
    expect(mine.passage).toBe("Vedi il menù");
    expect(JSON.stringify(mine)).not.toContain("segretissimo");
  });

  it("si trova anche per codice e titolo, e per testo con l'embedder giù", async () => {
    const p = await page(projectId, "Titolo univoco Zanzibar", [para("a", "niente")]);
    current = { embed: async () => Promise.reject(new Error("ollama giù")) } as unknown as EmbeddingClient;
    try {
      const hit = (await search(reader, "zanzibar")).json() as ProductSearchResults;
      expect(hit.items.map((h) => h.page.id)).toContain(p.id);
      const code = hit.items.find((h) => h.page.id === p.id)!.page.code;
      expect(((await search(reader, code)).json() as ProductSearchResults).items.map((h) => h.page.id)).toContain(p.id);
    } finally {
      current = embedder;
    }
  });

  it("un progetto archiviato è fuori, anche dalla ricerca globale", async () => {
    const { projectId: archived } = await seedRepository(t.db);
    await addMember(app, archived, reader.id, "viewer");
    const p = await page(archived, "Archiviata Quokka", [para("a", "quokka")]);
    expect((await globalSearch(reader, "quokka")).items.map((h) => h.page.id)).toContain(p.id);
    await t.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived));
    expect((await globalSearch(reader, "quokka")).items.map((h) => h.page.id)).not.toContain(p.id);
    expect((await search(reader, "quokka", archived)).statusCode).toBe(404);
  });

  it("il filtro di progetto sta nella WHERE, prima del limite: tante pagine invisibili più nuove non nascondono quella visibile", async () => {
    const visible = await page(projectId, "Visibile", [para("a", "ornitorinco")], new Date(Date.now() - 3600_000));
    for (let i = 0; i < 8; i++) await page(hiddenProject, "Nascosta", [para("a", "ornitorinco")]);
    const out = await searchProductPages(t.db, embedder, actorAs(reader.id, "member"), "ornitorinco", { limit: 3, semantic: false });
    expect(out.items.map((h) => h.page.id)).toEqual([visible.id]);
    expect(out.hasMore).toBe(false);
  });

  it("per significato: i chunk di un progetto che chi cerca non legge non escono", async () => {
    const hidden = await page(hiddenProject, "Segreta", [para("a", "Il piano segreto del lancio")], new Date(Date.now() - 120_000));
    const mine = await page(projectId, "Mia", [para("a", "Il piano pubblico del lancio")], new Date(Date.now() - 120_000));
    await embedStaleProductPages(t.db, embedder, { warn: vi.fn() });
    const out = await searchProductPages(t.db, embedder, actorAs(reader.id, "member"), "Il piano segreto del lancio", { semantic: true });
    expect(out.items.map((h) => h.page.id)).not.toContain(hidden.id);
    expect(out.items.map((h) => h.page.id)).toContain(mine.id);
  });
});
