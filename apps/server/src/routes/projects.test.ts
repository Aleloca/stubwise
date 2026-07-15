import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiProviders } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createProject(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie },
    payload,
  });
}

/** Seed di un provider AI direttamente in DB (l'API di creazione non è qui). */
async function seedAiProvider(label: string): Promise<string> {
  const [provider] = await testDb.db
    .insert(aiProviders)
    .values({ position: 1, kind: "api_key", label, secretEncrypted: "x" })
    .returning({ id: aiProviders.id });
  return provider!.id;
}

describe("POST /api/projects", () => {
  it("l'admin crea un progetto: 201 con slug derivato e default", async () => {
    const res = await createProject({ name: "Prodotto Acme" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      name: "Prodotto Acme",
      slug: "prodotto-acme",
      description: null,
      aiProviderId: null,
      docAutoUpdate: false,
      dailyReportEnabled: false,
      // Fase 3: il progetto nasce con la chiave di ingestion (32 hex) e il
      // contatore ticket per-progetto a 1.
      ingestionKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      nextTicketNumber: 1,
      createdAt: expect.any(String),
    });
  });

  it("due progetti ricevono ingestionKey diverse (uniche)", async () => {
    const a = await createProject({ name: "Ingest A" });
    const b = await createProject({ name: "Ingest B" });
    const keyA = (a.json() as { ingestionKey: string }).ingestionKey;
    const keyB = (b.json() as { ingestionKey: string }).ingestionKey;
    expect(keyA).toMatch(/^[0-9a-f]{32}$/);
    expect(keyB).toMatch(/^[0-9a-f]{32}$/);
    expect(keyA).not.toBe(keyB);
  });

  it("collisione di slug: stesso nome → suffisso numerico", async () => {
    const res = await createProject({ name: "Prodotto Acme" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { slug: string }).slug).toBe("prodotto-acme-2");
  });

  it("description, docAutoUpdate e aiProviderId esistente vengono impostati", async () => {
    const providerId = await seedAiProvider("Provider create");
    const res = await createProject({
      name: "Con Impostazioni",
      description: "Un prodotto con impostazioni",
      docAutoUpdate: true,
      aiProviderId: providerId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.description).toBe("Un prodotto con impostazioni");
    expect(body.docAutoUpdate).toBe(true);
    expect(body.aiProviderId).toBe(providerId);
  });

  it("aiProviderId inesistente: 400", async () => {
    const res = await createProject({
      name: "Provider KO",
      aiProviderId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(400);
  });

  it("un member non può creare progetti: 403", async () => {
    const res = await createProject({ name: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "X" } });
    expect(res.statusCode).toBe(401);
  });

  it("body non valido (name mancante): 400", async () => {
    const res = await createProject({ description: "senza nome" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/projects", () => {
  it("elenca i progetti col conteggio dei repository", async () => {
    const { projectId } = await seedRepository(testDb.db);
    await seedRepository(testDb.db, {}); // un secondo gruppo con un repo
    // Aggiunge un secondo repository allo stesso progetto.
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; repositoryCount: number }[];
    const target = body.find((p) => p.id === projectId);
    expect(target).toBeDefined();
    expect(target!.repositoryCount).toBe(1);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:projectId", () => {
  it("dettaglio con l'elenco (sintetico) dei repository", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      repositories: { id: string; name: string; slug: string; provider: string }[];
    };
    expect(body.id).toBe(projectId);
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0]!.id).toBe(repositoryId);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/projects/:projectId", () => {
  it("aggiorna name/description/docAutoUpdate", async () => {
    const created = await createProject({ name: "Da Aggiornare" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: "Aggiornato", description: "nuova", docAutoUpdate: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe("Aggiornato");
    expect(body.description).toBe("nuova");
    expect(body.docAutoUpdate).toBe(true);
  });

  it("attiva dailyReportEnabled e lo persiste/ritorna", async () => {
    const created = await createProject({ name: "Con Report" });
    const id = (created.json() as { id: string }).id;
    // Default false alla creazione.
    expect((created.json() as { dailyReportEnabled: boolean }).dailyReportEnabled).toBe(false);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { dailyReportEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { dailyReportEnabled: boolean }).dailyReportEnabled).toBe(true);

    // Persistito: una GET successiva lo riflette.
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
    });
    expect((get.json() as { dailyReportEnabled: boolean }).dailyReportEnabled).toBe(true);
  });

  it("aiProviderId esistente lo imposta, null lo azzera", async () => {
    const created = await createProject({ name: "AI Toggle" });
    const id = (created.json() as { id: string }).id;
    const providerId = await seedAiProvider("Provider patch");

    const set = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { aiProviderId: providerId },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { aiProviderId: string | null }).aiProviderId).toBe(providerId);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { aiProviderId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { aiProviderId: string | null }).aiProviderId).toBeNull();
  });

  it("aiProviderId inesistente: 400", async () => {
    const created = await createProject({ name: "AI KO Patch" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { aiProviderId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000000",
      headers: { cookie: adminCookie },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può aggiornare: 403", async () => {
    const created = await createProject({ name: "Protetto" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: memberCookie },
      payload: { name: "Hack" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/projects/:projectId", () => {
  it("l'admin elimina un progetto: 204 (cascade sui repository)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    // Idempotenza inversa: un secondo delete è 404.
    const again = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: { cookie: adminCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("un member non può eliminare: 403", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
