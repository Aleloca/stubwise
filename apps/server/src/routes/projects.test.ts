import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { decrypt, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

/** Chiave AES-256 di test: la stessa passata a buildApp, riusata per decifrare nelle assert. */
const ENCRYPTION_KEY = randomBytes(32);

const PLAINTEXT_TOKEN = "token-git-in-chiaro-da-non-salvare";

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

const basePayload = {
  name: "Sito Vetrina",
  provider: "github",
  repoUrl: "https://github.com/acme/sito-vetrina",
  credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN },
};

describe("POST /api/projects", () => {
  it("l'admin crea un progetto: 201 con slug generato, ingestionKey 32 hex e senza credenziali", async () => {
    const res = await createProject(basePayload);
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      name: "Sito Vetrina",
      slug: "sito-vetrina",
      provider: "github",
      repoUrl: "https://github.com/acme/sito-vetrina",
      defaultBranch: "main",
      ingestionKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      createdAt: expect.any(String),
    });
    // Il webhookSecret è un segreto HMAC: mai nella proiezione pubblica,
    // nemmeno per l'admin. Si legge solo via GET /:slug/webhook.
    expect(res.body).not.toContain("webhookSecret");
    // Mai credenziali nella risposta, nemmeno cifrate.
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
  });

  it("le credenziali sono salvate cifrate: il plaintext non compare nel DB", async () => {
    const [row] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "sito-vetrina"));
    expect(row).toBeDefined();
    expect(row!.encryptedCredentials).not.toContain(PLAINTEXT_TOKEN);
    expect(row!.encryptedCredentials).not.toContain("acme-bot");
    // E la decifratura con la chiave dell'app restituisce le credenziali originali.
    expect(JSON.parse(decrypt(row!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      username: "acme-bot",
      token: PLAINTEXT_TOKEN,
    });
  });

  it("collisione di slug: stesso nome → suffisso numerico", async () => {
    const res = await createProject(basePayload);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { slug: string }).slug).toBe("sito-vetrina-2");
  });

  it("defaultBranch esplicito viene rispettato e username è opzionale", async () => {
    const res = await createProject({
      name: "API Backend",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/api-backend",
      defaultBranch: "develop",
      credentials: { token: "solo-token" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { slug: string; defaultBranch: string };
    expect(body.defaultBranch).toBe("develop");
    expect(body.slug).toBe("api-backend");
  });

  it("ogni progetto riceve una ingestionKey diversa", async () => {
    const keys = await testDb.db.select({ key: projects.ingestionKey }).from(projects);
    const unique = new Set(keys.map((k) => k.key));
    expect(unique.size).toBe(keys.length);
  });

  it("ogni progetto riceve un webhookSecret diverso", async () => {
    const secrets = await testDb.db.select({ secret: projects.webhookSecret }).from(projects);
    const unique = new Set(secrets.map((s) => s.secret));
    expect(unique.size).toBe(secrets.length);
    for (const { secret } of secrets) {
      expect(secret).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("un member non può creare progetti: 403", async () => {
    const res = await createProject({ ...basePayload, name: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: basePayload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("body non valido (provider sconosciuto): 400", async () => {
    const res = await createProject({ ...basePayload, name: "Rotto", provider: "gitlab" });
    expect(res.statusCode).toBe(400);
  });

  it("campi oltre la lunghezza massima: 400", async () => {
    const tooLongName = await createProject({ ...basePayload, name: "x".repeat(201) });
    expect(tooLongName.statusCode).toBe(400);
    const tooLongRepoUrl = await createProject({
      ...basePayload,
      name: "Url Lungo",
      repoUrl: `https://github.com/acme/${"r".repeat(500)}`,
    });
    expect(tooLongRepoUrl.statusCode).toBe(400);
    const tooLongBranch = await createProject({
      ...basePayload,
      name: "Branch Lungo",
      defaultBranch: "b".repeat(201),
    });
    expect(tooLongBranch.statusCode).toBe(400);
  });
});

describe("GET /api/projects", () => {
  it("un member legge la lista, senza credenziali nel payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body.length).toBeGreaterThanOrEqual(3);
    expect(body.map((p) => p.slug)).toContain("sito-vetrina");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    // Il webhookSecret non deve trapelare nella lista (member né admin).
    expect(res.body).not.toContain("webhookSecret");
  });

  it("nemmeno l'admin vede il webhookSecret nella lista", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:slug", () => {
  it("un member legge il singolo progetto, senza credenziali", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.slug).toBe("sito-vetrina");
    expect(body.name).toBe("Sito Vetrina");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    // Il singolo progetto non espone il webhookSecret a nessun ruolo.
    expect(res.body).not.toContain("webhookSecret");
  });

  it("nemmeno l'admin vede il webhookSecret sul singolo progetto", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/non-esiste",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:slug/webhook", () => {
  it("l'admin legge il webhookSecret e il path del webhook", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina/webhook",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { webhookSecret: string; webhookPath: string };
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{32}$/);
    expect(body.webhookPath).toBe("/webhooks/git/sito-vetrina");
  });

  it("un member non può leggere il webhookSecret: 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina/webhook",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina/webhook",
    });
    expect(res.statusCode).toBe(401);
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/non-esiste/webhook",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/projects/:slug", () => {
  it("l'admin aggiorna nome, repoUrl e defaultBranch; lo slug resta stabile", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: {
        name: "API Backend v2",
        repoUrl: "https://bitbucket.org/acme/api-backend-v2",
        defaultBranch: "main",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe("API Backend v2");
    expect(body.repoUrl).toBe("https://bitbucket.org/acme/api-backend-v2");
    expect(body.defaultBranch).toBe("main");
    // Lo slug è il path della DSN di ingestion: non cambia mai.
    expect(body.slug).toBe("api-backend");
  });

  it("l'admin aggiorna le credenziali: vengono ricifrate, mai in chiaro nel DB", async () => {
    const [before] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "api-backend"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { credentials: { token: "nuovo-token-ruotato" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain("nuovo-token-ruotato");

    const [after] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "api-backend"));
    expect(after!.encryptedCredentials).not.toBe(before!.encryptedCredentials);
    expect(after!.encryptedCredentials).not.toContain("nuovo-token-ruotato");
    expect(JSON.parse(decrypt(after!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      token: "nuovo-token-ruotato",
    });
  });

  it("PATCH senza campi restituisce il progetto invariato", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("API Backend v2");
  });

  it("un member non può aggiornare: 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: memberCookie },
      payload: { name: "Hackerato" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/non-esiste",
      headers: { cookie: adminCookie },
      payload: { name: "Fantasma" },
    });
    expect(res.statusCode).toBe(404);
  });
});
