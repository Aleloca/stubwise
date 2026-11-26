import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createFakeEmbeddingClient, type EmbeddingClient } from "@stubwise/embeddings";
import { docChunks } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Docs, area 5 fetta 1: le pagine manuali hanno i loro embedding, come le
// generate, così la ricerca semantica e la chat RAG le trovano. Fail-open: un
// embedder giù non blocca il salvataggio.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let repositoryId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let embedderDown = false;

const fake = createFakeEmbeddingClient();
const embeddingClient: EmbeddingClient = {
  ...fake,
  embed: async (texts) => {
    if (embedderDown) throw new Error("embedder giù");
    return fake.embed(texts);
  },
};

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example", embeddingClient });
  await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-me@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: lead.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const chunksOf = async (pageId: string) => t.db.select().from(docChunks).where(eq(docChunks.pageId, pageId));

describe("gli embedding delle pagine manuali", () => {
  it("alla creazione la pagina ha i suoi chunk, e la ricerca di progetto la trova anche per significato", async () => {
    const body = "La procedura di rientro dopo un incidente notturno";
    const res = await as("POST", `/api/repositories/${repositoryId}/docs/manual`, { title: "Runbook", body });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: string };
    const chunks = await chunksOf(id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.generationId === null && c.repositoryId === repositoryId)).toBe(true);
    const hits = (await as("GET", `/api/projects/${projectId}/docs/search?q=${encodeURIComponent(body)}`)).json() as { title: string; source: string }[];
    const hit = hits.find((h) => h.title === "Runbook")!;
    expect(hit.source).not.toBe("fulltext");
  });

  it("alla modifica i chunk si rifanno; all'eliminazione se ne vanno", async () => {
    const { id } = (await as("POST", `/api/repositories/${repositoryId}/docs/manual`, { title: "Glossario", body: "Prima versione" })).json() as { id: string };
    const before = (await chunksOf(id)).map((c) => c.content);
    expect((await as("PATCH", `/api/repositories/${repositoryId}/docs/manual/${id}`, { body: "Seconda versione, tutta diversa" })).statusCode).toBe(200);
    const after = (await chunksOf(id)).map((c) => c.content);
    expect(after.join(" ")).toContain("Seconda versione");
    expect(after).not.toEqual(before);
    expect((await as("DELETE", `/api/repositories/${repositoryId}/docs/manual/${id}`)).statusCode).toBe(204);
    expect(await chunksOf(id)).toHaveLength(0);
  });

  it("con l'embedder giù la pagina si salva lo stesso, senza chunk", async () => {
    embedderDown = true;
    try {
      const res = await as("POST", `/api/repositories/${repositoryId}/docs/manual`, { title: "Senza vettori", body: "Testo che si trova per parole" });
      expect(res.statusCode, res.body).toBe(201);
      expect(await chunksOf((res.json() as { id: string }).id)).toHaveLength(0);
    } finally {
      embedderDown = false;
    }
  });

  it("con l'embedder giù una MODIFICA toglie i chunk del testo vecchio: la ricerca per significato non trova più quello che la pagina non dice", async () => {
    const { id } = (await as("POST", `/api/repositories/${repositoryId}/docs/manual`, { title: "Rotazione", body: "Il turno di reperibilità ruota il lunedì" })).json() as { id: string };
    expect((await chunksOf(id)).length).toBeGreaterThan(0);
    embedderDown = true;
    try {
      const res = await as("PATCH", `/api/repositories/${repositoryId}/docs/manual/${id}`, { body: "Testo nuovo, senza vettori" });
      expect(res.statusCode, res.body).toBe(200);
      expect(await chunksOf(id)).toHaveLength(0);
    } finally {
      embedderDown = false;
    }
  });
});
