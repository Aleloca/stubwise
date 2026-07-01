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
const PUBLIC_URL = "https://stubwise.example.com";

interface SeededProject {
  id: string;
  slug: string;
  ingestionKey: string;
}

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberId: string;
let project: SeededProject;
let otherProject: SeededProject;

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
  // Dalla Fase 3 l'inbound è a livello di PROGETTO: la chiave d'ingestion e lo
  // slug sono quelli del progetto. Vi montiamo un repository per completezza.
  const slug = `gruppo-${randomBytes(4).toString("hex")}`;
  const ingestionKey = randomBytes(16).toString("hex");
  const [group] = await testDb.db
    .insert(projects)
    .values({ name: `${name} — gruppo`, slug, ingestionKey })
    .returning({ id: projects.id });
  const res = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: { projectId: group!.id, name, gitAccountId, repoUrl: `https://github.com/acme/${name}` },
  });
  if (res.statusCode !== 201) {
    throw new Error(`creazione repository fallita: ${res.statusCode} ${res.body}`);
  }
  return { id: group!.id, slug, ingestionKey };
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: PUBLIC_URL,
  });
  let memberCookie: string;
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
  void memberCookie;
  project = await createProject("inbound");
  otherProject = await createProject("inbound-altro");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function inbound(
  instance: FastifyInstance,
  slug: string,
  key: string | undefined,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return instance.inject({
    method: "POST",
    url: `/api/inbound/${slug}/ticket`,
    headers: {
      ...(key !== undefined ? { "x-stubwise-key": key } : {}),
      ...extraHeaders,
    },
    payload,
  });
}

const validTicket = { title: "Server down", body: "Tutto fermo", type: "bug", priority: "high" };

describe("POST /api/inbound/:slug/ticket — auth", () => {
  it("chiave errata: 401", async () => {
    const res = await inbound(app, project.slug, randomBytes(16).toString("hex"), validTicket);
    expect(res.statusCode).toBe(401);
  });

  it("header X-Stubwise-Key assente: 401", async () => {
    const res = await inbound(app, project.slug, undefined, validTicket);
    expect(res.statusCode).toBe(401);
  });

  it("slug sconosciuto: 401 con lo stesso corpo della chiave errata (no enumerazione)", async () => {
    const wrongKey = await inbound(app, project.slug, randomBytes(16).toString("hex"), validTicket);
    const unknownSlug = await inbound(app, "non-esiste", project.ingestionKey, validTicket);
    expect(unknownSlug.statusCode).toBe(401);
    expect(unknownSlug.body).toBe(wrongKey.body);
  });

  it("la chiave di un altro progetto non vale per questo slug: 401", async () => {
    const res = await inbound(app, project.slug, otherProject.ingestionKey, validTicket);
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/inbound/:slug/ticket — creazione", () => {
  it("payload valido: 201 con {id, number, url} e ticket source webhook nel DB", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, validTicket);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; number: number; url: string };
    expect(body.id).toBeTruthy();
    expect(typeof body.number).toBe("number");
    expect(body.url).toBe(`${PUBLIC_URL}/tickets/${body.id}`);

    const [ticket] = await testDb.db.select().from(tickets).where(eq(tickets.id, body.id));
    expect(ticket!.source).toBe("webhook");
    expect(ticket!.title).toBe("Server down");
    expect(ticket!.body).toContain("Tutto fermo");
    expect(ticket!.type).toBe("bug");
    expect(ticket!.priority).toBe("high");
    expect(ticket!.number).toBe(body.number);
  });

  it("priority omessa: default medium", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, {
      title: "Senza priorità",
      type: "task",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };
    const [ticket] = await testDb.db.select().from(tickets).where(eq(tickets.id, body.id));
    expect(ticket!.priority).toBe("medium");
  });

  it("type mancante: 422", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, {
      title: "Senza type",
      priority: "low",
    });
    expect(res.statusCode).toBe(422);
  });

  it("type invalido: 422", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, {
      title: "Type sbagliato",
      type: "esplosione",
    });
    expect(res.statusCode).toBe(422);
  });

  it("title vuoto: 422", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, { title: "", type: "bug" });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /api/inbound/:slug/ticket — attribuzione reporter", () => {
  it("reporterEmail che matcha un utente: assigneeId valorizzato, nessuna nota 'no account'", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, {
      title: "Attribuito",
      type: "bug",
      reporterEmail: "MEMBER@example.com", // case-insensitive
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };
    const [ticket] = await testDb.db.select().from(tickets).where(eq(tickets.id, body.id));
    expect(ticket!.assigneeId).toBe(memberId);
    expect(ticket!.body).not.toContain("no Stubwise account");
    expect(ticket!.body).toContain("Reported via webhook");
  });

  it("reporterEmail senza match: assigneeId null e provenienza con email nel body", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, {
      title: "Sconosciuto",
      type: "bug",
      reporterEmail: "estraneo@example.com",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };
    const [ticket] = await testDb.db.select().from(tickets).where(eq(tickets.id, body.id));
    expect(ticket!.assigneeId).toBeNull();
    expect(ticket!.body).toContain("no Stubwise account: estraneo@example.com");
  });

  it("senza reporterEmail: assigneeId null e provenienza generica", async () => {
    const res = await inbound(app, project.slug, project.ingestionKey, {
      title: "Anonimo",
      type: "bug",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };
    const [ticket] = await testDb.db.select().from(tickets).where(eq(tickets.id, body.id));
    expect(ticket!.assigneeId).toBeNull();
    expect(ticket!.body).toContain("Reported via webhook");
    expect(ticket!.body).not.toContain("no Stubwise account");
  });
});

describe("POST /api/inbound/:slug/ticket — CORS", () => {
  it("preflight OPTIONS: origin *, POST e x-stubwise-key ammessi", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: `/api/inbound/${project.slug}/ticket`,
      headers: {
        origin: "https://terzo.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-stubwise-key",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
