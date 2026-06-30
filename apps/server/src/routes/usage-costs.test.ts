import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { eq } from "drizzle-orm";
import { agentRuns, aiJobs, aiProviders, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

// Id popolati nel beforeAll: due progetti, due provider, e i job/run con
// costi/token/modelli noti su date diverse.
let projectAId: string;
let projectBId: string;
let providerXId: string;
let providerYId: string;

/** Progetto (gruppo) → repository bersaglio di default. */
const repoForProject = new Map<string, string>();

async function createProject(name: string): Promise<string> {
  const { projectId, repositoryId } = await seedRepository(testDb.db);
  repoForProject.set(projectId, repositoryId);
  // I costi sono aggregati per progetto (gruppo): fissiamo un nome noto per le
  // asserzioni di byProject.
  await testDb.db.update(projects).set({ name }).where(eq(projects.id, projectId));
  return projectId;
}

async function createTicket(projectId: string, title: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/tickets",
    headers: { cookie: users.memberCookie },
    payload: { projectId, repositoryId: repoForProject.get(projectId), title, type: "bug" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createJob(
  ticketId: string,
  createdAt: Date,
  providerId: string | null,
): Promise<string> {
  const [job] = await testDb.db
    .insert(aiJobs)
    .values({ ticketId, createdAt, providerId })
    .returning();
  return job!.id;
}

async function addRun(
  jobId: string,
  model: string,
  input: number,
  output: number,
  cache: number,
  costUsd: string | null,
): Promise<void> {
  await testDb.db.insert(agentRuns).values({
    jobId,
    phase: "fix",
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cache,
    costUsd,
  });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);

  projectAId = await createProject("Project A");
  projectBId = await createProject("Project B");

  [providerXId, providerYId] = (
    await testDb.db
      .insert(aiProviders)
      .values([
        { position: 0, kind: "api_key", label: "Provider X", secretEncrypted: "enc-x" },
        { position: 1, kind: "account", label: "Provider Y", secretEncrypted: "enc-y" },
      ])
      .returning()
  ).map((p) => p.id) as [string, string];

  const ticketA = await createTicket(projectAId, "A bug");
  const ticketB = await createTicket(projectBId, "B bug");

  // --- Giorno 2026-05-10, progetto A, provider X ---
  // Due run: claude-opus (costo) + claude-haiku (costo null → conta 0).
  const job1 = await createJob(ticketA, new Date("2026-05-10T09:00:00Z"), providerXId);
  await addRun(job1, "claude-opus", 1000, 200, 50, "1.500000");
  await addRun(job1, "claude-haiku", 300, 100, 10, null);

  // --- Giorno 2026-05-11, progetto A, provider Y ---
  const job2 = await createJob(ticketA, new Date("2026-05-11T12:00:00Z"), providerYId);
  await addRun(job2, "claude-opus", 2000, 500, 100, "2.250000");

  // --- Giorno 2026-05-11, progetto B, nessun provider (env/default) ---
  const job3 = await createJob(ticketB, new Date("2026-05-11T15:00:00Z"), null);
  await addRun(job3, "claude-haiku", 500, 150, 25, "0.300000");

  // --- Fuori range (2025), non deve comparire nei filtri ristretti ---
  const jobOld = await createJob(ticketA, new Date("2025-01-01T00:00:00Z"), providerXId);
  await addRun(jobOld, "claude-opus", 9999, 9999, 9999, "99.000000");
}, 180_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function getCosts(query = "", cookie?: string) {
  return app.inject({
    method: "GET",
    url: `/api/ai-usage/costs${query}`,
    headers: cookie ? { cookie } : {},
  });
}

const FULL_RANGE = "?from=2026-05-01&to=2026-05-31";

describe("GET /api/ai-usage/costs — auth", () => {
  it("senza sessione: 401", async () => {
    expect((await getCosts(FULL_RANGE)).statusCode).toBe(401);
  });

  it("un member non può accedere: 403", async () => {
    expect((await getCosts(FULL_RANGE, users.memberCookie)).statusCode).toBe(403);
  });
});

describe("GET /api/ai-usage/costs — totals", () => {
  it("somma costo/token e conta i job nel range; costo null conta 0", async () => {
    const res = await getCosts(FULL_RANGE, users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totals: {
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        jobs: number;
      };
    };
    // Costo: 1.5 + 0 (null) + 2.25 + 0.3 = 4.05
    expect(body.totals.costUsd).toBeCloseTo(4.05, 6);
    // Input: 1000 + 300 + 2000 + 500 = 3800
    expect(body.totals.inputTokens).toBe(3800);
    // Output: 200 + 100 + 500 + 150 = 950
    expect(body.totals.outputTokens).toBe(950);
    // Cache: 50 + 10 + 100 + 25 = 185
    expect(body.totals.cacheReadTokens).toBe(185);
    // Job distinti nel range: 3 (il vecchio è fuori range).
    expect(body.totals.jobs).toBe(3);
  });
});

describe("GET /api/ai-usage/costs — byDay", () => {
  it("una riga per giorno, ordinata, con somme corrette", async () => {
    const res = await getCosts(FULL_RANGE, users.adminCookie);
    const body = res.json() as {
      byDay: { day: string; costUsd: number; inputTokens: number; jobs: number }[];
    };
    expect(body.byDay.map((d) => d.day)).toEqual(["2026-05-10", "2026-05-11"]);

    const d10 = body.byDay.find((d) => d.day === "2026-05-10")!;
    expect(d10.costUsd).toBeCloseTo(1.5, 6);
    expect(d10.inputTokens).toBe(1300); // 1000 + 300
    expect(d10.jobs).toBe(1);

    const d11 = body.byDay.find((d) => d.day === "2026-05-11")!;
    expect(d11.costUsd).toBeCloseTo(2.55, 6); // 2.25 + 0.3
    expect(d11.inputTokens).toBe(2500); // 2000 + 500
    expect(d11.jobs).toBe(2);
  });
});

describe("GET /api/ai-usage/costs — byModel", () => {
  it("somma per modello", async () => {
    const res = await getCosts(FULL_RANGE, users.adminCookie);
    const body = res.json() as {
      byModel: { model: string; costUsd: number; inputTokens: number }[];
    };
    const opus = body.byModel.find((m) => m.model === "claude-opus")!;
    expect(opus.costUsd).toBeCloseTo(3.75, 6); // 1.5 + 2.25
    expect(opus.inputTokens).toBe(3000); // 1000 + 2000

    const haiku = body.byModel.find((m) => m.model === "claude-haiku")!;
    expect(haiku.costUsd).toBeCloseTo(0.3, 6); // null(→0) + 0.3
    expect(haiku.inputTokens).toBe(800); // 300 + 500
  });
});

describe("GET /api/ai-usage/costs — byProject", () => {
  it("somma per progetto, con nome", async () => {
    const res = await getCosts(FULL_RANGE, users.adminCookie);
    const body = res.json() as {
      byProject: { projectId: string; projectName: string; costUsd: number }[];
    };
    const a = body.byProject.find((p) => p.projectId === projectAId)!;
    expect(a.projectName).toBe("Project A");
    expect(a.costUsd).toBeCloseTo(3.75, 6); // 1.5 + 2.25

    const b = body.byProject.find((p) => p.projectId === projectBId)!;
    expect(b.projectName).toBe("Project B");
    expect(b.costUsd).toBeCloseTo(0.3, 6);
  });
});

describe("GET /api/ai-usage/costs — byProvider", () => {
  it("somma per provider, con label; provider null = default/env", async () => {
    const res = await getCosts(FULL_RANGE, users.adminCookie);
    const body = res.json() as {
      byProvider: {
        providerId: string | null;
        providerLabel: string | null;
        costUsd: number;
      }[];
    };
    const x = body.byProvider.find((p) => p.providerId === providerXId)!;
    expect(x.providerLabel).toBe("Provider X");
    expect(x.costUsd).toBeCloseTo(1.5, 6);

    const y = body.byProvider.find((p) => p.providerId === providerYId)!;
    expect(y.providerLabel).toBe("Provider Y");
    expect(y.costUsd).toBeCloseTo(2.25, 6);

    const none = body.byProvider.find((p) => p.providerId === null)!;
    expect(none.providerLabel).toBeNull();
    expect(none.costUsd).toBeCloseTo(0.3, 6);
  });
});

describe("GET /api/ai-usage/costs — range filter", () => {
  it("from/to esclude i run fuori finestra", async () => {
    // Solo il 2026-05-11: esclude il 10/05 e il vecchio 2025.
    const res = await getCosts("?from=2026-05-11&to=2026-05-11", users.adminCookie);
    const body = res.json() as { totals: { jobs: number; costUsd: number }; byDay: unknown[] };
    expect(body.byDay).toHaveLength(1);
    expect(body.totals.jobs).toBe(2);
    expect(body.totals.costUsd).toBeCloseTo(2.55, 6);
  });

  it("senza from/to: default ultimi 30 giorni (esclude i dati di test datati 2026-05)", async () => {
    // I dati seedati sono a maggio 2026; il default è "ultimi 30 giorni da
    // ora", quindi non li include (la data corrente è ben oltre). Verifichiamo
    // solo che la risposta sia ben formata e il range venga riempito.
    const res = await getCosts("", users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { range: { from: string; to: string } };
    expect(typeof body.range.from).toBe("string");
    expect(typeof body.range.to).toBe("string");
    expect(new Date(body.range.from).getTime()).toBeLessThan(new Date(body.range.to).getTime());
  });
});
