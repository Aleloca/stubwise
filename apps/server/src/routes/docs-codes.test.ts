import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { chatChannels, chatMessageCitations, docGenerations, docPageCodes, docPages, projects, repositories } from "@stubwise/db";
import { and } from "drizzle-orm";
import { citationViews } from "../chat/citations.js";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Docs, area 5 fetta 1: i codici `<PRJ>-D<n>` nelle letture (albero, pagina,
// highlights, ricerca) e la risoluzione di un codice, con `docs.view`.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let repositoryId: string;
let projectCode: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let outsider: U;

async function generation(): Promise<string> {
  const [g] = await t.db.insert(docGenerations).values({ repositoryId, status: "succeeded", commitSha: "abc1234" }).returning({ id: docGenerations.id });
  await t.db.update(repositories).set({ currentDocGenerationId: g!.id }).where(eq(repositories.id, repositoryId));
  return g!.id;
}

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example", embeddingClient: createFakeEmbeddingClient() });
  await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(t.db));
  projectCode = (await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)))[0]!.code;
  lead = await createUserWithSession(app, "lead-dc@example.com");
  outsider = await createUserWithSession(app, "outsider-dc@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  const g = await generation();
  await t.db.insert(docPages).values([
    { repositoryId, generationId: g, kind: "technical", slug: "overview", title: "Overview", body: "Il quadro zibaldone del sistema", viewCount: 5 },
    { repositoryId, generationId: g, kind: "functional", slug: "login", title: "Login", body: "Come si entra" },
  ]);
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe("i codici delle pagine nelle letture", () => {
  it("albero e pagina hanno il codice; una rigenerazione con lo stesso slug lo tiene", async () => {
    const tree = (await as(lead, "GET", `/api/repositories/${repositoryId}/docs/tree`)).json() as { slug: string; code: string | null }[];
    expect(tree.find((n) => n.slug === "overview")!.code).toBe(`${projectCode}-D1`);
    expect(tree.find((n) => n.slug === "login")!.code).toBe(`${projectCode}-D2`);
    const page = (await as(lead, "GET", `/api/repositories/${repositoryId}/docs/pages/login`)).json() as { code: string | null };
    expect(page.code).toBe(`${projectCode}-D2`);
    const g2 = await generation();
    await t.db.insert(docPages).values([
      { repositoryId, generationId: g2, kind: "technical", slug: "overview", title: "Overview v2", body: "Il quadro zibaldone, rifatto" },
      { repositoryId, generationId: g2, kind: "functional", slug: "login", title: "Login v2", body: "Come si entra" },
    ]);
    const after = (await as(lead, "GET", `/api/repositories/${repositoryId}/docs/tree`)).json() as { slug: string; title: string; code: string | null }[];
    expect(after.find((n) => n.slug === "overview")).toMatchObject({ title: "Overview v2", code: `${projectCode}-D1` });
  });

  it("highlights e ricerca hanno il codice; un codice esatto va in cima alla ricerca globale", async () => {
    const hl = (await as(lead, "GET", `/api/repositories/${repositoryId}/docs/highlights`)).json() as { topViewed: { slug: string; code: string | null }[] };
    expect(hl.topViewed.every((r) => r.code !== null)).toBe(true);
    const projectSearch = (await as(lead, "GET", `/api/projects/${projectId}/docs/search?q=zibaldone`)).json() as { slug: string; code: string | null }[];
    expect(projectSearch.find((r) => r.slug === "overview")!.code).toBe(`${projectCode}-D1`);
    const global = (await as(lead, "GET", `/api/search?q=zibaldone`)).json() as { docs: { items: { slug: string; code: string | null }[] } };
    expect(global.docs.items.find((r) => r.slug === "overview")!.code).toBe(`${projectCode}-D1`);
    // «Login» non contiene la parola: col codice esatto arriva lo stesso, in cima.
    const byCode = (await as(lead, "GET", `/api/search?q=${projectCode}-D2`)).json() as { docs: { items: { slug: string; code: string | null }[] } };
    expect(byCode.docs.items[0]).toMatchObject({ slug: "login", code: `${projectCode}-D2` });
    const forOutsider = (await as(outsider, "GET", `/api/search?q=${projectCode}-D2`)).json() as { docs: { items: unknown[] } };
    expect(forOutsider.docs.items).toEqual([]);
  });
});

describe("la risoluzione di un codice", () => {
  it("a chi legge i Docs del progetto: repository e slug; a chi non vede il progetto, 404 come un codice che non c'è", async () => {
    const ok = await as(lead, "GET", `/api/docs/codes/${projectCode}-D2`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ projectId, repositoryId, slug: "login", available: true });
    expect((ok.json() as { repositorySlug: string }).repositorySlug.length).toBeGreaterThan(0);
    expect((await as(outsider, "GET", `/api/docs/codes/${projectCode}-D2`)).statusCode).toBe(404);
    expect((await as(lead, "GET", `/api/docs/codes/${projectCode}-D999`)).statusCode).toBe(404);
    expect((await as(lead, "GET", `/api/docs/codes/${projectCode}-T2`)).statusCode).toBe(404);
  });

  it("senza distinzione di maiuscole, come la ricerca", async () => {
    const lower = await as(lead, "GET", `/api/docs/codes/${projectCode.toLowerCase()}-d2`);
    expect(lower.statusCode, lower.body).toBe(200);
    expect(lower.json()).toMatchObject({ projectId, slug: "login" });
    expect((await as(outsider, "GET", `/api/docs/codes/${projectCode.toLowerCase()}-d2`)).statusCode).toBe(404);
  });

  it("una pagina manuale eliminata: il codice resta, `available` falso", async () => {
    const created = await as(lead, "POST", `/api/repositories/${repositoryId}/docs/manual`, { title: "Runbook", body: "passi" });
    expect(created.statusCode, created.body).toBe(201);
    const { id, slug } = created.json() as { id: string; slug: string };
    const tree = (await as(lead, "GET", `/api/repositories/${repositoryId}/docs/tree`)).json() as { slug: string; code: string | null }[];
    const code = tree.find((n) => n.slug === slug)!.code!;
    expect((await as(lead, "DELETE", `/api/repositories/${repositoryId}/docs/manual/${id}`)).statusCode).toBe(204);
    expect((await as(lead, "GET", `/api/docs/codes/${code}`)).json()).toMatchObject({ slug, available: false });
  });
});

describe("le citazioni doc della Chat (F1.3)", () => {
  type Cit = { kind: string; id: string; label: string; code: string | null; doc: { repositoryId: string; repositorySlug: string; slug: string } | null };
  async function general(): Promise<string> {
    const [row] = await t.db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
    return row!.id;
  }
  const codeIdOf = async (slug: string) =>
    (await t.db.select({ id: docPageCodes.id }).from(docPageCodes).where(and(eq(docPageCodes.repositoryId, repositoryId), eq(docPageCodes.slug, slug))))[0]!.id;
  const pageIdOf = async (slug: string) =>
    (await t.db.select({ id: docPages.id }).from(docPages).where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.slug, slug))).orderBy(docPages.createdAt))
      .at(-1)!.id;

  it("una scelta col «#» (anche con l'id di pagina di un client vecchio) si salva sul codice, col link, e sopravvive a una rigenerazione", async () => {
    const g = await general();
    const pageId = await pageIdOf("overview");
    const res = await as(lead, "POST", `/api/chat/channels/${g}/messages`, { text: "leggete Overview v2", citations: [{ kind: "doc", id: pageId }] });
    expect(res.statusCode, res.body).toBe(201);
    const msg = res.json() as { id: string; citations: Cit[] };
    const codeId = await codeIdOf("overview");
    expect(msg.citations).toEqual([
      expect.objectContaining({ kind: "doc", id: codeId, code: `${projectCode}-D1`, doc: expect.objectContaining({ repositoryId, slug: "overview" }) }),
    ]);
    const [stored] = await t.db.select().from(chatMessageCitations).where(eq(chatMessageCitations.messageId, msg.id));
    expect(stored!.refId).toBe(codeId);
    // Una generazione nuova: righe nuove, la citazione regge e porta il titolo nuovo.
    const g3 = await generation();
    await t.db.insert(docPages).values([
      { repositoryId, generationId: g3, kind: "technical", slug: "overview", title: "Overview v3", body: "ancora zibaldone" },
      { repositoryId, generationId: g3, kind: "functional", slug: "login", title: "Login v3", body: "Come si entra" },
    ]);
    const again = (await as(lead, "GET", `/api/chat/messages/${msg.id}`)).json() as { citations: Cit[] };
    expect(again.citations).toEqual([expect.objectContaining({ id: codeId, label: "Overview v3", code: `${projectCode}-D1` })]);
  });

  it("un codice D scritto a mano diventa una citazione per chi legge la pagina; chi non legge i Docs non la vede", async () => {
    const g = await general();
    const res = await as(lead, "POST", `/api/chat/channels/${g}/messages`, { text: `per l'ingresso vedi ${projectCode}-D2` });
    const msg = res.json() as { id: string; citations: Cit[] };
    expect(msg.citations).toEqual([expect.objectContaining({ kind: "doc", code: `${projectCode}-D2`, doc: expect.objectContaining({ slug: "login" }) })]);
    const rows = await t.db.select().from(chatMessageCitations).where(eq(chatMessageCitations.messageId, msg.id));
    // L'esterno legge i Docs di un ALTRO progetto: la regola deve guardare il progetto della pagina.
    const elsewhere = await seedRepository(t.db);
    await addMember(app, elsewhere.projectId, outsider.id, "developer");
    const forOutsider = await citationViews(t.db, { id: outsider.id, instancePermissions: new Set<never>() }, rows);
    expect(forOutsider.get(msg.id) ?? []).toEqual([]);
  });

  it("una modifica che toglie codice e titolo toglie la citazione; il codice basta a tenerla", async () => {
    const g = await general();
    const created = (await as(lead, "POST", `/api/chat/channels/${g}/messages`, { text: `vedi ${projectCode}-D2` })).json() as { id: string };
    const kept = (await as(lead, "PATCH", `/api/chat/messages/${created.id}`, { text: `ripeto: ${projectCode}-D2 e basta` })).json() as { citations: Cit[] };
    expect(kept.citations).toHaveLength(1);
    const gone = (await as(lead, "PATCH", `/api/chat/messages/${created.id}`, { text: `niente più (${projectCode}-D20)` })).json() as { citations: Cit[] };
    expect(gone.citations).toEqual([]);
  });

  it("«con citazioni» conta una citazione doc solo per chi legge la pagina", async () => {
    const g = await general();
    await as(lead, "POST", `/api/chat/channels/${g}/messages`, { text: `quartiere ${projectCode}-D1` });
    const hits = (await as(lead, "GET", `/api/chat/search?q=quartiere&withCitations=true`)).json() as { items: unknown[] };
    expect(hits.items).toHaveLength(1);
  });
});

