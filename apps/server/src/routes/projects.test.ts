import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  aiJobs,
  aiProviders,
  notifications,
  prReviews,
  projectBriefs,
  projectFollows,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers, sessionCookie } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, adminId, memberId } = await seedUsers(app));
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
      backlogEnabled: false,
      // Pulse proattivo: spento, con la cadenza di default di 3 giorni.
      pulseEnabled: false,
      pulseEveryDays: 3,
      // Brief settimanale (fase 5): spento, e indipendente dal backlog.
      weeklyBriefEnabled: false,
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

  it("attiva backlogEnabled e lo persiste/ritorna", async () => {
    const created = await createProject({ name: "Con Backlog" });
    const id = (created.json() as { id: string }).id;
    // Default false alla creazione.
    expect((created.json() as { backlogEnabled: boolean }).backlogEnabled).toBe(false);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { backlogEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { backlogEnabled: boolean }).backlogEnabled).toBe(true);

    // Persistito: una GET successiva lo riflette.
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
    });
    expect((get.json() as { backlogEnabled: boolean }).backlogEnabled).toBe(true);
  });

  it("attiva il pulse e ne cambia la cadenza", async () => {
    const created = await createProject({ name: "Con Pulse" });
    const id = (created.json() as { id: string }).id;
    expect(created.json()).toMatchObject({ pulseEnabled: false, pulseEveryDays: 3 });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { pulseEnabled: true, pulseEveryDays: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pulseEnabled: true, pulseEveryDays: 7 });

    // Persistito: una GET successiva lo riflette.
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(get.json()).toMatchObject({ pulseEnabled: true, pulseEveryDays: 7 });
  });

  it("cadenza fuori dal range 1..30: 400 di validazione, niente CHECK del DB", async () => {
    const created = await createProject({ name: "Pulse Fuori Range" });
    const id = (created.json() as { id: string }).id;

    for (const pulseEveryDays of [0, 31, 2.5]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        headers: { cookie: adminCookie },
        payload: { pulseEveryDays },
      });
      expect(res.statusCode).toBe(400);
    }

    // Nessuna delle richieste rifiutate ha toccato la riga.
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(get.json()).toMatchObject({ pulseEveryDays: 3 });
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

describe("GET /api/projects/pulse", () => {
  async function seedTicketRow(
    projectId: string,
    opts: { number?: number; title?: string } = {},
  ): Promise<string> {
    const [row] = await testDb.db
      .insert(tickets)
      .values({
        projectId,
        number: opts.number ?? 1,
        title: opts.title ?? "Ticket",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning({ id: tickets.id });
    return row!.id;
  }

  async function seedJob(
    ticketId: string,
    status: "awaiting_input" | "awaiting_plan_approval" | "triaging" | "fixing" | "failed" | "pr_merged" | "queued",
    extra: { requestedByUserId?: string | null; startedAt?: Date; lastActivityAt?: Date } = {},
  ): Promise<string> {
    const [row] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status, ...extra })
      .returning({ id: aiJobs.id });
    return row!.id;
  }

  it("è raggiungibile: 200 con un array, non il 400 di validazione UUID di /:projectId", async () => {
    // Se questa rotta fosse registrata DOPO "/:projectId", Fastify leggerebbe
    // "pulse" come projectId e fallirebbe la validazione zod dei params (400)
    // prima ancora di arrivare a questo handler.
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/pulse",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  /**
   * Invita e registra un member DEDICATO (email nuova, mai usata altrove nel
   * file), distinto dal `memberCookie`/`memberId` condivisi da tutto il
   * `beforeAll`: un test che deve vedere "zero follow" non può appoggiarsi
   * all'unico member del file, la cui riga in `project_follows` un altro test
   * di questo stesso describe può tranquillamente popolare. Stesso identico
   * flusso HTTP di `seedUsers` in `../test/fixtures.js`, solo ripetuto con
   * un'email diversa.
   */
  async function seedMember(email: string): Promise<{ cookie: string; id: string }> {
    const invite = await app.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: adminCookie },
      payload: { email },
    });
    if (invite.statusCode !== 201) {
      throw new Error(`invito fallito: ${invite.statusCode} ${invite.body}`);
    }
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: (invite.json() as { token: string }).token,
        email,
        password: "password-dedicata-al-test",
      },
    });
    if (register.statusCode !== 201) {
      throw new Error(`registrazione fallita: ${register.statusCode} ${register.body}`);
    }
    const id = (register.json() as { user: { id: string } }).user.id;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "password-dedicata-al-test" },
    });
    if (login.statusCode !== 200) {
      throw new Error(`login fallito: ${login.statusCode} ${login.body}`);
    }
    return { cookie: sessionCookie(login), id };
  }

  it("un member senza nessun progetto seguito vede un array vuoto", async () => {
    // Member dedicato: nessun altro test di questo file gli fa seguire un
    // progetto, quindi il risultato non dipende dall'ordine di esecuzione.
    const { cookie } = await seedMember("member-senza-follow@example.com");
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/pulse",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("un member vede solo i progetti che segue; un admin li vede tutti", async () => {
    const { projectId: followedId } = await seedRepository(testDb.db);
    const { projectId: unfollowedId } = await seedRepository(testDb.db);
    await testDb.db.insert(projectFollows).values({ userId: memberId, projectId: followedId });

    const memberRes = await app.inject({
      method: "GET",
      url: "/api/projects/pulse",
      headers: { cookie: memberCookie },
    });
    expect(memberRes.statusCode).toBe(200);
    const memberIds = (memberRes.json() as { projectId: string }[]).map((s) => s.projectId);
    expect(memberIds).toContain(followedId);
    expect(memberIds).not.toContain(unfollowedId);

    const adminRes = await app.inject({
      method: "GET",
      url: "/api/projects/pulse",
      headers: { cookie: adminCookie },
    });
    expect(adminRes.statusCode).toBe(200);
    const adminIds = (adminRes.json() as { projectId: string }[]).map((s) => s.projectId);
    expect(adminIds).toContain(followedId);
    expect(adminIds).toContain(unfollowedId);
  });

  it("ordina: prima chi ha waitingForYou, poi chi ha running, poi idleDays decrescente", async () => {
    const { projectId: waitingProjectId } = await seedRepository(testDb.db);
    const { projectId: runningProjectId } = await seedRepository(testDb.db);
    const { projectId: idleProjectId } = await seedRepository(testDb.db);
    const { projectId: idleProjectId2 } = await seedRepository(testDb.db);

    // waitingForYou (admin è sempre nel pubblico di un piano da approvare) —
    // serve anche la riga di notifica: senza, `summarizeProject` OMETTE la
    // voce da `waitingForYou` (nessun modo di agirci), e il progetto finirebbe
    // nel gruppo "né in attesa né in corso" invece che in cima.
    const waitingTicket = await seedTicketRow(waitingProjectId);
    const waitingJobId = await seedJob(waitingTicket, "awaiting_plan_approval", {
      requestedByUserId: memberId,
    });
    await testDb.db
      .insert(notifications)
      .values({ userId: adminId, jobId: waitingJobId, kind: "job.plan_review", event: {} });

    // running.
    const runningTicket = await seedTicketRow(runningProjectId);
    await seedJob(runningTicket, "fixing", { startedAt: new Date() });

    // fermo da 10 giorni.
    const idleTicket = await seedTicketRow(idleProjectId);
    await seedJob(idleTicket, "pr_merged", {
      lastActivityAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    // fermo da 1 giorno: deve stare DOPO quello fermo da 10 (idleDays desc).
    const idleTicket2 = await seedTicketRow(idleProjectId2);
    await seedJob(idleTicket2, "pr_merged", {
      lastActivityAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/projects/pulse",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const order = (res.json() as { projectId: string }[]).map((s) => s.projectId);
    const indexOf = (id: string) => order.indexOf(id);

    expect(indexOf(waitingProjectId)).toBeGreaterThanOrEqual(0);
    expect(indexOf(runningProjectId)).toBeGreaterThanOrEqual(0);
    expect(indexOf(idleProjectId)).toBeGreaterThanOrEqual(0);
    expect(indexOf(idleProjectId2)).toBeGreaterThanOrEqual(0);
    expect(indexOf(waitingProjectId)).toBeLessThan(indexOf(runningProjectId));
    expect(indexOf(runningProjectId)).toBeLessThan(indexOf(idleProjectId));
    expect(indexOf(idleProjectId)).toBeLessThan(indexOf(idleProjectId2));
  });
});

/**
 * Rotte di narrativa della Fase 5. Il grosso della logica di fusione è coperto
 * da `services/project-timeline.test.ts`: qui si sorveglia ciò che solo la
 * ROTTA può sbagliare — l'ordine di registrazione, l'ACL, i 400 sulla finestra
 * e sui `kinds`, e il fatto che l'errore interno di una review non esca.
 */
describe("GET /api/projects/:projectId/timeline", () => {
  async function seedProjectWithTicket(): Promise<{ projectId: string; ticketId: string }> {
    const created = await createProject({ name: `Roadmap ${randomBytes(4).toString("hex")}` });
    const projectId = created.json().id as string;
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Ticket in timeline",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning({ id: tickets.id });
    return { projectId, ticketId: ticket!.id };
  }

  it("l'admin legge la timeline: finestra di default e voci del progetto", async () => {
    const { projectId } = await seedProjectWithTicket();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/timeline`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.from).toBe("string");
    expect(typeof body.to).toBe("string");
    // Il ticket appena creato è dentro le ultime 4 settimane.
    expect(body.entries.map((entry: { kind: string }) => entry.kind)).toContain("ticket_opened");
  });

  it("finestra oltre 180 giorni: 400 window_too_large", async () => {
    const { projectId } = await seedProjectWithTicket();
    const to = new Date();
    const from = new Date(to.getTime() - 181 * 24 * 60 * 60 * 1000);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/timeline?from=${from.toISOString()}&to=${to.toISOString()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("window_too_large");
  });

  it("un kind sconosciuto è un 400, non un filtro che non filtra niente", async () => {
    const { projectId } = await seedProjectWithTicket();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/timeline?kinds=pr_merged,ticket_esploso`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_kinds");
  });

  it("`kinds` filtra le voci", async () => {
    const { projectId } = await seedProjectWithTicket();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/timeline?kinds=pr_merged`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([]);
  });

  it("un member che NON segue il progetto: 404, come se non esistesse", async () => {
    const { projectId } = await seedProjectWithTicket();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/timeline`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("project_not_found");
  });

  it("lo stesso member, dopo aver seguito il progetto: 200", async () => {
    const { projectId } = await seedProjectWithTicket();
    await testDb.db.insert(projectFollows).values({ userId: memberId, projectId });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/timeline`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/11111111-1111-4111-8111-111111111111/timeline",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:projectId/reviews", () => {
  it("elenca le review del progetto senza mai l'errore interno dell'agente", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    await testDb.db.insert(prReviews).values({
      repositoryId,
      prNumber: 11,
      prUrl: "https://git.example.com/pr/11",
      prTitle: "Titolo PR",
      headSha: "sha",
      status: "completed",
      verdict: "approve",
      summary: "analisi lunga",
      prSummary: "In breve: sistema il login.",
      error: "/worker/tmp/percorso-interno: boom",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/reviews`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      prNumber: 11,
      verdict: "approve",
      prSummary: "In breve: sistema il login.",
    });
    expect(res.payload).not.toContain("percorso-interno");
    expect(res.payload).not.toContain("analisi lunga");
  });

  it("un member che non segue il progetto: 404", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/reviews`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("brief settimanale", () => {
  /** Un progetto col brief acceso e, opzionalmente, un brief già in tabella. */
  async function seedProjectWithBrief(
    brief?: Partial<typeof projectBriefs.$inferInsert>,
  ): Promise<{ projectId: string; briefId?: string }> {
    const created = await createProject({ name: `Brief ${randomBytes(4).toString("hex")}` });
    const projectId = created.json().id as string;
    if (!brief) return { projectId };
    const [row] = await testDb.db
      .insert(projectBriefs)
      .values({
        projectId,
        periodStart: "2026-08-31",
        periodEnd: "2026-09-06",
        status: "done",
        summary: "## Dove siamo\n\nTutto bene.",
        sections: { whereWeAre: "Tutto bene." },
        ...brief,
      })
      .returning({ id: projectBriefs.id });
    return { projectId, briefId: row!.id };
  }

  describe("PATCH weeklyBriefEnabled", () => {
    it("l'admin accende il brief e il valore torna nella risposta e nella GET", async () => {
      const { projectId } = await seedProjectWithBrief();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        headers: { cookie: adminCookie },
        payload: { weeklyBriefEnabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { weeklyBriefEnabled: boolean }).weeklyBriefEnabled).toBe(true);

      const get = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}`,
        headers: { cookie: adminCookie },
      });
      expect((get.json() as { weeklyBriefEnabled: boolean }).weeklyBriefEnabled).toBe(true);
    });

    it("il brief NON dipende dal backlog: si accende su un progetto che non ce l'ha", async () => {
      const { projectId } = await seedProjectWithBrief();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        headers: { cookie: adminCookie },
        payload: { weeklyBriefEnabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { backlogEnabled: boolean }).backlogEnabled).toBe(false);
    });
  });

  describe("GET /api/projects/:projectId/briefs", () => {
    it("elenca i brief dal periodo più recente, senza mai l'errore interno", async () => {
      const { projectId } = await seedProjectWithBrief({ error: "/worker/tmp/segreto: boom" });
      await testDb.db.insert(projectBriefs).values({
        projectId,
        periodStart: "2026-08-24",
        periodEnd: "2026-08-30",
        status: "done",
        summary: "Vecchio",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/briefs`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { periodStart: string; summary: string | null }[];
      expect(rows.map((r) => r.periodStart)).toEqual(["2026-08-31", "2026-08-24"]);
      expect(JSON.stringify(rows)).not.toContain("segreto");
    });

    it("rispetta `limit`", async () => {
      const { projectId } = await seedProjectWithBrief();
      await testDb.db.insert(projectBriefs).values({
        projectId,
        periodStart: "2026-08-24",
        periodEnd: "2026-08-30",
        status: "done",
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/briefs?limit=1`,
        headers: { cookie: adminCookie },
      });
      expect(res.json()).toHaveLength(1);
    });

    it("un member che NON segue il progetto: 404, come le altre rotte di progetto", async () => {
      const { projectId } = await seedProjectWithBrief();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/briefs`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("un member che SEGUE il progetto lo legge", async () => {
      const { projectId } = await seedProjectWithBrief();
      await testDb.db.insert(projectFollows).values({ projectId, userId: memberId });
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/briefs`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /api/projects/:projectId/briefs/generate", () => {
    it("brief `done` senza force: 409, non si butta via un brief già scritto", async () => {
      const { projectId } = await seedProjectWithBrief({});
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/briefs/generate`,
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { code: string }).code).toBe("brief_already_done");
    });

    it("con `force`: il brief torna in coda, azzerando i tentativi", async () => {
      const { projectId, briefId } = await seedProjectWithBrief({ attempts: 3 });
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/briefs/generate`,
        headers: { cookie: adminCookie },
        payload: { force: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; status: string };
      expect(body.id).toBe(briefId);
      expect(body.status).toBe("queued");
      const [row] = await testDb.db
        .select()
        .from(projectBriefs)
        .where(eq(projectBriefs.projectId, projectId));
      expect(row).toMatchObject({ status: "queued", attempts: 0, error: null });
    });

    it("un brief `failed` si rigenera SENZA force: non c'è niente da preservare", async () => {
      const { projectId } = await seedProjectWithBrief({ status: "failed", error: "boom" });
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/briefs/generate`,
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe("queued");
    });

    it("nessun brief ancora: ne crea uno `queued` per l'ultima settimana chiusa", async () => {
      const { projectId } = await seedProjectWithBrief();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/briefs/generate`,
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { status: string; periodStart: string; periodEnd: string };
      expect(body.status).toBe("queued");
      // Sette giorni di calendario, estremi inclusi.
      const days =
        (Date.parse(`${body.periodEnd}T00:00:00Z`) - Date.parse(`${body.periodStart}T00:00:00Z`)) /
        86_400_000;
      expect(days).toBe(6);
    });

    it("un member non rigenera: 403 (è un run AI, lo decide un maintainer)", async () => {
      const { projectId } = await seedProjectWithBrief();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/briefs/generate`,
        headers: { cookie: memberCookie },
        payload: { force: true },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/briefs/:briefId", () => {
    it("l'admin legge un brief per id", async () => {
      const { projectId, briefId } = await seedProjectWithBrief({});
      const res = await app.inject({
        method: "GET",
        url: `/api/briefs/${briefId}`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: briefId,
        projectId,
        periodStart: "2026-08-31",
        status: "done",
        sections: { whereWeAre: "Tutto bene." },
      });
    });

    it("brief inesistente: 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/briefs/11111111-1111-4111-8111-111111111111",
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("un member che non segue il progetto: 404, come se il brief non esistesse", async () => {
      const { briefId } = await seedProjectWithBrief({});
      const res = await app.inject({
        method: "GET",
        url: `/api/briefs/${briefId}`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
