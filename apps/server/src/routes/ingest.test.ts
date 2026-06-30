import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

interface SeededProject {
  id: string;
  slug: string;
  ingestionKey: string;
}

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let project: SeededProject;
let otherProject: SeededProject;

/** Evento errore valido; stesso messaggio → stesso fingerprint → dedup. */
function errorEvent(message: string) {
  return {
    kind: "error",
    message,
    errorType: "TypeError",
    breadcrumbs: [],
    timestamp: "2026-06-10T10:00:00.000Z",
  };
}

function feedbackEvent(message: string) {
  return { kind: "feedback", message };
}

async function createGitAccount(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: { name: "Account di test", provider: "github", credentials: { token: "token-di-test" } },
  });
  if (res.statusCode !== 201) {
    throw new Error(`creazione account git fallita: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { id: string }).id;
}

async function createProject(name: string): Promise<SeededProject> {
  const gitAccountId = await createGitAccount();
  // L'ingestion è per-repository (la chiave vive sul repo): creiamo un progetto
  // (gruppo) e vi montiamo un repository, restituendo la proiezione del repo.
  const [group] = await testDb.db
    .insert(projects)
    .values({ name: `${name} — gruppo`, slug: `gruppo-${randomBytes(4).toString("hex")}` })
    .returning({ id: projects.id });
  const res = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: {
      projectId: group!.id,
      name,
      gitAccountId,
      repoUrl: `https://github.com/acme/${name}`,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`creazione repository fallita: ${res.statusCode} ${res.body}`);
  }
  return res.json() as SeededProject;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY,
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
  project = await createProject("ingestione");
  otherProject = await createProject("altro-progetto");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function ingest(
  instance: FastifyInstance,
  slug: string,
  key: string | undefined,
  events: unknown[],
  extraHeaders: Record<string, string> = {},
) {
  return instance.inject({
    method: "POST",
    url: `/ingest/${slug}`,
    headers: {
      ...(key !== undefined ? { "x-stubwise-key": key } : {}),
      ...extraHeaders,
    },
    payload: { events },
  });
}

describe("POST /ingest/:slug", () => {
  it("chiave valida e batch misto: 202 con accepted/created/deduped e ticket nel DB", async () => {
    const res = await ingest(app, project.slug, project.ingestionKey, [
      errorEvent("x is not a function"),
      errorEvent("x is not a function"), // stesso fingerprint → dedup
      feedbackEvent("Il bottone Salva non funziona"),
      { kind: "ticket", title: "Aggiungere dark mode", type: "feature", priority: "low" },
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 4, created: 3, deduped: 1 });

    const rows = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.repositoryId, project.id));
    expect(rows).toHaveLength(3);
    const errorTicket = rows.find((r) => r.source === "sdk_error");
    expect(errorTicket).toBeDefined();
    expect(errorTicket!.occurrences).toBe(2);
  });

  it("chiave errata: 401", async () => {
    const res = await ingest(app, project.slug, randomBytes(16).toString("hex"), [
      feedbackEvent("non deve entrare"),
    ]);
    expect(res.statusCode).toBe(401);
  });

  it("header X-Stubwise-Key assente: 401", async () => {
    const res = await ingest(app, project.slug, undefined, [feedbackEvent("niente chiave")]);
    expect(res.statusCode).toBe(401);
  });

  it("slug sconosciuto: 401 con lo stesso corpo della chiave errata (no enumerazione)", async () => {
    const wrongKey = await ingest(app, project.slug, randomBytes(16).toString("hex"), [
      feedbackEvent("x"),
    ]);
    const unknownSlug = await ingest(app, "non-esiste", project.ingestionKey, [
      feedbackEvent("x"),
    ]);
    expect(unknownSlug.statusCode).toBe(401);
    expect(unknownSlug.body).toBe(wrongKey.body);
  });

  it("la chiave di un altro progetto non vale per questo slug: 401", async () => {
    const res = await ingest(app, project.slug, otherProject.ingestionKey, [
      feedbackEvent("chiave incrociata"),
    ]);
    expect(res.statusCode).toBe(401);
  });

  it("payload non valido (kind sconosciuto): 422", async () => {
    const res = await ingest(app, project.slug, project.ingestionKey, [
      { kind: "esplosione", message: "boom" },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it("payload non valido (oltre 100 eventi): 422", async () => {
    const events = Array.from({ length: 101 }, (_, i) => feedbackEvent(`evento ${i}`));
    const res = await ingest(app, project.slug, project.ingestionKey, events);
    expect(res.statusCode).toBe(422);
  });

  it("la validazione delle altre route resta 400 (il 422 è solo dell'ingestion)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: adminCookie },
      // name mancante: lo schema del progetto (gruppo) lo richiede → 400.
      payload: { description: "senza nome" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("rate limiting di POST /ingest/:slug", () => {
  let limited: FastifyInstance;

  beforeAll(() => {
    // App separata con limite minuscolo: contatori in-memory freschi e
    // nessuna interferenza con i test funzionali qui sopra.
    limited = buildApp({
      db: testDb.db,
      ingestRateLimit: { max: 3, timeWindow: "1 minute" },
    });
  });

  afterAll(async () => {
    await limited.close();
  });

  it("oltre il limite per chiave: 429; un'altra chiave ha il suo bucket", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await ingest(limited, project.slug, project.ingestionKey, [
        feedbackEvent(`burst ${i}`),
      ]);
      expect(res.statusCode).toBe(202);
    }
    const over = await ingest(limited, project.slug, project.ingestionKey, [
      feedbackEvent("oltre il limite"),
    ]);
    expect(over.statusCode).toBe(429);
    const body = over.json() as { statusCode: number; message: string };
    expect(body.statusCode).toBe(429);
    expect(body.message).toMatch(/Rate limit/i);

    // Il keyGenerator usa la chiave di ingestion: un altro progetto passa.
    const other = await ingest(limited, otherProject.slug, otherProject.ingestionKey, [
      feedbackEvent("altro bucket"),
    ]);
    expect(other.statusCode).toBe(202);
  });
});

describe("rate limiting di /api/auth/login e /api/auth/register", () => {
  let limited: FastifyInstance;

  beforeAll(() => {
    limited = buildApp({
      db: testDb.db,
      sessionSecret: SESSION_SECRET,
      authRateLimit: { max: 2, timeWindow: "1 minute" },
    });
  });

  afterAll(async () => {
    await limited.close();
  });

  it("login: anche i tentativi con password errata contano, poi 429", async () => {
    for (let i = 1; i <= 2; i++) {
      const res = await limited.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "password-sbagliata" },
      });
      expect(res.statusCode).toBe(401);
    }
    // Il terzo tentativo viene rifiutato anche con la password giusta.
    const res = await limited.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "password-sicura" },
    });
    expect(res.statusCode).toBe(429);
  });

  it("register: oltre il limite per IP → 429 (bucket separato dal login)", async () => {
    for (let i = 1; i <= 2; i++) {
      const res = await limited.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          token: "token-inesistente",
          email: `nuovo${i}@example.com`,
          password: "password-lunga",
        },
      });
      expect(res.statusCode).toBe(410);
    }
    const res = await limited.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: "token-inesistente",
        email: "nuovo3@example.com",
        password: "password-lunga",
      },
    });
    expect(res.statusCode).toBe(429);
  });
});

describe("CORS aperto solo sull'ingestion", () => {
  it("preflight OPTIONS su /ingest/:slug: origin *, POST e x-stubwise-key ammessi", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: `/ingest/${project.slug}`,
      headers: {
        origin: "https://app-cliente.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-stubwise-key",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]?.toString().toLowerCase()).toContain(
      "x-stubwise-key",
    );
  });

  it("la risposta del POST cross-origin porta access-control-allow-origin *", async () => {
    const res = await ingest(
      app,
      project.slug,
      project.ingestionKey,
      [feedbackEvent("cross origin")],
      { origin: "https://app-cliente.example.com" },
    );
    expect(res.statusCode).toBe(202);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("le route API non espongono header CORS", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tickets",
      headers: { cookie: memberCookie, origin: "https://app-cliente.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
