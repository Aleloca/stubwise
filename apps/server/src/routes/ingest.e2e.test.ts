// Test end-to-end della fase di ingestion: l'SDK Node REALE (entry point
// @stubwise/sdk/node, quindi il pacchetto buildato in dist) punta all'app
// Fastify reale in ascolto su una porta effimera. Niente app.inject, niente
// fetch mockata: il percorso è SDK → HTTP → route → processor → Postgres.
import { randomBytes } from "node:crypto";
import {
  __resetForTesting,
  addBreadcrumb,
  captureError,
  captureFeedback,
  createTicket,
  flush,
  init,
} from "@stubwise/sdk/node";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiJobs, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;

type TicketRow = typeof tickets.$inferSelect;

async function projectTickets(): Promise<TicketRow[]> {
  // Dalla Fase 3 l'ingestion è a livello di PROGETTO: i ticket SDK nascono col
  // solo projectId (niente repository bersaglio).
  return testDb.db.select().from(tickets).where(eq(tickets.projectId, projectId));
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY,
  });
  const { adminCookie } = await seedUsers(app);
  const account = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: { name: "Account e2e", provider: "github", credentials: { token: "token-di-test" } },
  });
  if (account.statusCode !== 201) {
    throw new Error(`creazione account git fallita: ${account.statusCode} ${account.body}`);
  }
  const gitAccountId = (account.json() as { id: string }).id;
  // Dalla Fase 3 l'ingestion è a livello di PROGETTO: slug e chiave sono del
  // progetto. Vi montiamo un repository per completezza del modello.
  const projectSlug = `gruppo-${randomBytes(4).toString("hex")}`;
  const ingestionKey = randomBytes(16).toString("hex");
  const [group] = await testDb.db
    .insert(projects)
    .values({ name: "e2e — gruppo", slug: projectSlug, ingestionKey })
    .returning({ id: projects.id });
  const created = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: {
      projectId: group!.id,
      name: "e2e-ingestion",
      gitAccountId,
      repoUrl: "https://github.com/acme/e2e-ingestion",
    },
  });
  if (created.statusCode !== 201) {
    throw new Error(`creazione repository fallita: ${created.statusCode} ${created.body}`);
  }
  const project = { id: group!.id, slug: projectSlug, ingestionKey };
  projectId = project.id;

  // Server HTTP vero su porta effimera: l'SDK parla via rete, non via inject.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`indirizzo del server inatteso: ${String(address)}`);
  }

  // parseDsn accetta http: per gli ambienti locali; il path /p/<slug> del
  // DSN viene mappato dall'SDK su /ingest/<slug>.
  init({
    dsn: `http://${project.ingestionKey}@127.0.0.1:${address.port}/p/${project.slug}`,
    release: "e2e-1.0.0",
    environment: "test",
    registerProcessHandlers: false, // il processo di vitest non va toccato
  });
}, 120_000);

afterAll(async () => {
  __resetForTesting();
  await app.close();
  await testDb.stop();
});

describe("e2e: SDK Node → POST /ingest/:slug → Postgres", () => {
  it("captureError produce un ticket sdk_error con payload tecnico e aiJob in coda", async () => {
    addBreadcrumb({ type: "log", message: "avvio del batch notturno" });
    const error = new TypeError("e2e: il checkout esplode");
    captureError(error, { url: "https://shop.example.com/checkout" });
    await flush();

    const rows = await projectTickets();
    const ticket = rows.find((r) => r.source === "sdk_error");
    expect(ticket).toBeDefined();
    expect(ticket!.title).toBe("TypeError: e2e: il checkout esplode");
    expect(ticket!.type).toBe("bug");
    expect(ticket!.occurrences).toBe(1);

    const payload = ticket!.technicalPayload as {
      message: string;
      stack?: string;
      url?: string;
      userAgent?: string;
      release?: string;
      environment?: string;
      breadcrumbs: { type: string; message: string }[];
    };
    expect(payload.message).toBe("e2e: il checkout esplode");
    expect(payload.stack).toContain("TypeError: e2e: il checkout esplode");
    expect(payload.url).toBe("https://shop.example.com/checkout");
    expect(payload.userAgent).toBeUndefined(); // in Node non esiste navigator
    expect(payload.release).toBe("e2e-1.0.0");
    expect(payload.environment).toBe("test");
    expect(payload.breadcrumbs).toEqual([
      expect.objectContaining({ type: "log", message: "avvio del batch notturno" }),
    ]);

    const jobs = await testDb.db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticket!.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("queued");
  });

  // NOTA ordine: questo test dipende dal ticket creato dal test captureError
  // qui sopra (vitest esegue i test di uno stesso file in sequenza).
  it("lo stesso errore catturato di nuovo si dedupa sul ticket esistente", async () => {
    captureError(new TypeError("e2e: il checkout esplode"));
    await flush();

    const rows = await projectTickets();
    const errorTickets = rows.filter((r) => r.source === "sdk_error");
    expect(errorTickets).toHaveLength(1);
    expect(errorTickets[0]!.occurrences).toBe(2);
  });

  it("captureFeedback produce un ticket sdk_feedback", async () => {
    captureFeedback({
      message: "e2e: il bottone Salva non risponde",
      email: "utente@example.com",
      url: "https://shop.example.com/profile",
    });
    await flush();

    const rows = await projectTickets();
    const ticket = rows.find((r) => r.source === "sdk_feedback");
    expect(ticket).toBeDefined();
    expect(ticket!.title).toBe("e2e: il bottone Salva non risponde");
    expect(ticket!.type).toBe("feedback");
    expect(ticket!.body).toContain("Email: utente@example.com");
    expect(ticket!.body).toContain("URL: https://shop.example.com/profile");

    const jobs = await testDb.db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticket!.id));
    expect(jobs).toHaveLength(1);
  });

  it("createTicket produce un ticket esplicito con type e priority del client", async () => {
    createTicket({
      title: "e2e: aggiungere export CSV",
      body: "Richiesto dal team contabilità",
      type: "feature",
      priority: "high",
    });
    await flush();

    const rows = await projectTickets();
    const ticket = rows.find((r) => r.source === "api");
    expect(ticket).toBeDefined();
    expect(ticket!.title).toBe("e2e: aggiungere export CSV");
    expect(ticket!.body).toBe("Richiesto dal team contabilità");
    expect(ticket!.type).toBe("feature");
    expect(ticket!.priority).toBe("high");

    const jobs = await testDb.db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticket!.id));
    expect(jobs).toHaveLength(1);
  });
});
