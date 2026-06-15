import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiJobs, comments, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
/** Progetto principale dei test di creazione/dettaglio/patch/commenti. */
let projectId: string;
/** Secondo progetto: verifica numerazione e filtro per progetto indipendenti. */
let otherProjectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  projectId = await createProject("Progetto Alfa");
  otherProjectId = await createProject("Progetto Beta");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function createGitAccount(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: users.adminCookie },
    payload: { name: "Account di test", provider: "github", credentials: { token: "token-di-test" } },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createProject(name: string): Promise<string> {
  const gitAccountId = await createGitAccount();
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: users.adminCookie },
    payload: {
      name,
      gitAccountId,
      repoUrl: `https://github.com/acme/${name.toLowerCase().replace(/\s+/g, "-")}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

function postTicket(payload: Record<string, unknown>, cookie = users.memberCookie) {
  return app.inject({ method: "POST", url: "/api/tickets", headers: { cookie }, payload });
}

function listTickets(query: Record<string, string>, cookie = users.memberCookie) {
  return app.inject({
    method: "GET",
    url: "/api/tickets",
    query,
    headers: { cookie },
  });
}

interface TicketBody {
  id: string;
  projectId: string;
  number: number;
  title: string;
  body: string;
  type: string;
  priority: string;
  status: string;
  source: string;
  assigneeId: string | null;
  effort: number | null;
  labels: string[];
  technicalPayload: unknown;
  occurrences: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ListBody {
  items: TicketBody[];
  nextCursor: string | null;
}

describe("POST /api/tickets", () => {
  it("crea un ticket manuale: 201, numero 1, stato open, source manual e default applicati", async () => {
    const res = await postTicket({
      projectId,
      title: "Login rotto su Safari",
      type: "bug",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as TicketBody;
    expect(body).toEqual({
      id: expect.any(String),
      projectId,
      number: 1,
      title: "Login rotto su Safari",
      body: "",
      type: "bug",
      priority: "medium",
      status: "open",
      source: "manual",
      assigneeId: null,
      effort: null,
      labels: [],
      technicalPayload: null,
      occurrences: 1,
      lastSeenAt: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("la numerazione è sequenziale per progetto: il secondo ticket è #2, l'altro progetto riparte da #1", async () => {
    const second = await postTicket({ projectId, title: "Secondo ticket", type: "task" });
    expect(second.statusCode).toBe(201);
    expect((second.json() as TicketBody).number).toBe(2);

    const other = await postTicket({
      projectId: otherProjectId,
      title: "Primo dell'altro progetto",
      type: "task",
    });
    expect(other.statusCode).toBe(201);
    expect((other.json() as TicketBody).number).toBe(1);
  });

  it("source dal client viene ignorato: è sempre manual", async () => {
    const res = await postTicket({
      projectId,
      title: "Tentativo di spoofing del source",
      type: "task",
      source: "sdk_error",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as TicketBody).source).toBe("manual");
  });

  it("accetta body, priority, labels e assigneeId espliciti", async () => {
    const res = await postTicket({
      projectId,
      title: "Ticket completo",
      body: "Descrizione dettagliata del problema",
      type: "feature",
      priority: "urgent",
      labels: ["frontend", "checkout"],
      assigneeId: users.memberId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as TicketBody;
    expect(body.body).toBe("Descrizione dettagliata del problema");
    expect(body.priority).toBe("urgent");
    expect(body.labels).toEqual(["frontend", "checkout"]);
    expect(body.assigneeId).toBe(users.memberId);
  });

  it("progetto inesistente: 404", async () => {
    const res = await postTicket({ projectId: randomUUID(), title: "Orfano", type: "bug" });
    expect(res.statusCode).toBe(404);
  });

  it("assigneeId che non corrisponde a nessun utente: 400", async () => {
    const res = await postTicket({
      projectId,
      title: "Assegnatario fantasma",
      type: "bug",
      assigneeId: randomUUID(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("validazione: type sconosciuto, titolo vuoto, titolo troppo lungo, troppe label → 400", async () => {
    const badType = await postTicket({ projectId, title: "Tipo rotto", type: "epic" });
    expect(badType.statusCode).toBe(400);

    const emptyTitle = await postTicket({ projectId, title: "", type: "bug" });
    expect(emptyTitle.statusCode).toBe(400);

    const longTitle = await postTicket({ projectId, title: "x".repeat(301), type: "bug" });
    expect(longTitle.statusCode).toBe(400);

    const tooManyLabels = await postTicket({
      projectId,
      title: "Troppe label",
      type: "bug",
      labels: Array.from({ length: 21 }, (_, i) => `label-${i}`),
    });
    expect(tooManyLabels.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets",
      payload: { projectId, title: "Anonimo", type: "bug" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/tickets — filtri", () => {
  let filterProjectId: string;
  let bugId: string;

  beforeAll(async () => {
    filterProjectId = await createProject("Progetto Filtri");

    const bug = await postTicket({
      projectId: filterProjectId,
      title: "Crash sul pagamento del carrello",
      type: "bug",
      priority: "high",
      assigneeId: users.adminId,
    });
    expect(bug.statusCode).toBe(201);
    bugId = (bug.json() as TicketBody).id;

    const feature = await postTicket({
      projectId: filterProjectId,
      title: "Richiesta dark mode",
      type: "feature",
      priority: "low",
    });
    expect(feature.statusCode).toBe(201);

    const task = await postTicket({
      projectId: filterProjectId,
      title: "Refactor del modulo Pagamento",
      type: "task",
    });
    expect(task.statusCode).toBe(201);

    // Stato impostato direttamente nel DB: il filtro per stato non deve
    // dipendere dalla PATCH, testata a parte.
    await testDb.db
      .update(tickets)
      .set({ status: "triaged" })
      .where(eq(tickets.id, (feature.json() as TicketBody).id));
  });

  it("filtro projectId: solo i ticket del progetto", async () => {
    const res = await listTickets({ projectId: filterProjectId });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.items).toHaveLength(3);
    expect(body.items.every((t) => t.projectId === filterProjectId)).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it("filtro status", async () => {
    const res = await listTickets({ projectId: filterProjectId, status: "triaged" });
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.title)).toEqual(["Richiesta dark mode"]);
  });

  it("filtro type", async () => {
    const res = await listTickets({ projectId: filterProjectId, type: "bug" });
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([bugId]);
  });

  it("filtro priority", async () => {
    const res = await listTickets({ projectId: filterProjectId, priority: "high" });
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([bugId]);
  });

  it("filtro assigneeId", async () => {
    const res = await listTickets({ projectId: filterProjectId, assigneeId: users.adminId });
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([bugId]);
  });

  it("ricerca q sul titolo, case-insensitive", async () => {
    const res = await listTickets({ projectId: filterProjectId, q: "PAGAMENTO" });
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.title).sort()).toEqual([
      "Crash sul pagamento del carrello",
      "Refactor del modulo Pagamento",
    ]);
  });

  it("q non interpreta i caratteri jolly di LIKE", async () => {
    const res = await listTickets({ projectId: filterProjectId, q: "%" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ListBody).items).toHaveLength(0);
  });

  it("filtri combinabili: type + priority senza riscontri → lista vuota", async () => {
    const res = await listTickets({
      projectId: filterProjectId,
      type: "bug",
      priority: "low",
    });
    expect((res.json() as ListBody).items).toHaveLength(0);
  });

  it("valore di filtro non valido: 400", async () => {
    const res = await listTickets({ projectId: filterProjectId, status: "archiviato" });
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tickets" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/tickets — paginazione cursor", () => {
  let pageProjectId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    pageProjectId = await createProject("Progetto Paginazione");
    for (let i = 1; i <= 30; i++) {
      const res = await postTicket({
        projectId: pageProjectId,
        title: `Ticket di paginazione ${i}`,
        type: "task",
      });
      expect(res.statusCode).toBe(201);
      createdIds.push((res.json() as TicketBody).id);
    }
  });

  it("attraversa le pagine senza duplicati né buchi, ordinata dal più recente", async () => {
    const seen: TicketBody[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string> = { projectId: pageProjectId, limit: "12" };
      if (cursor) query.cursor = cursor;
      const res = await listTickets(query);
      expect(res.statusCode).toBe(200);
      const body = res.json() as ListBody;
      seen.push(...body.items);
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen.map((t) => t.id)).toHaveLength(30);
    expect(new Set(seen.map((t) => t.id)).size).toBe(30);
    expect(new Set(seen.map((t) => t.id))).toEqual(new Set(createdIds));
    // Ordine: dal più recente al più vecchio, su tutte le pagine.
    expect(seen.map((t) => t.number)).toEqual(
      Array.from({ length: 30 }, (_, i) => 30 - i),
    );
  });

  it("il limit di default è 25", async () => {
    const res = await listTickets({ projectId: pageProjectId });
    const body = res.json() as ListBody;
    expect(body.items).toHaveLength(25);
    expect(body.nextCursor).not.toBeNull();
  });

  it("limit oltre il massimo: 400", async () => {
    const res = await listTickets({ projectId: pageProjectId, limit: "101" });
    expect(res.statusCode).toBe(400);
  });

  it("cursor malformato: 400", async () => {
    const res = await listTickets({ projectId: pageProjectId, cursor: "non-un-cursore" });
    expect(res.statusCode).toBe(400);
  });

  it("cursor con data impossibile: 400, non un errore di cast Postgres", async () => {
    // Rispetta il pattern sintattico ma è una data che Postgres non sa castare:
    // senza validazione dei range diventerebbe un 500 dal driver.
    const crafted = Buffer.from(
      `9999-99-99 99:99:99+00|${createdIds[0]}`,
      "utf8",
    ).toString("base64url");
    const res = await listTickets({ projectId: pageProjectId, cursor: crafted });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/tickets/:id", () => {
  it("restituisce il ticket", async () => {
    const created = await postTicket({ projectId, title: "Da rileggere", type: "task" });
    const id = (created.json() as TicketBody).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${id}`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TicketBody;
    expect(body.id).toBe(id);
    expect(body.title).toBe("Da rileggere");
  });

  it("ticket inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${randomUUID()}`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("id non uuid: 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tickets/non-un-uuid",
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/tickets/:id", () => {
  let ticketId: string;

  beforeAll(async () => {
    const res = await postTicket({ projectId, title: "Da aggiornare", type: "bug" });
    expect(res.statusCode).toBe(201);
    ticketId = (res.json() as TicketBody).id;
  });

  function patchTicket(payload: Record<string, unknown>, id = ticketId) {
    return app.inject({
      method: "PATCH",
      url: `/api/tickets/${id}`,
      headers: { cookie: users.memberCookie },
      payload,
    });
  }

  it("transizione di stato valida: open → in_progress", async () => {
    const res = await patchTicket({ status: "in_progress" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as TicketBody).status).toBe("in_progress");
  });

  it("transizione verso uno stato inesistente: 400 e il ticket resta invariato", async () => {
    const res = await patchTicket({ status: "archiviato" });
    expect(res.statusCode).toBe(400);
    const check = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: users.memberCookie },
    });
    expect((check.json() as TicketBody).status).toBe("in_progress");
  });

  it("aggiorna priorità, titolo, body, type e label in una sola PATCH", async () => {
    const res = await patchTicket({
      priority: "urgent",
      title: "Titolo aggiornato",
      body: "Body aggiornato",
      type: "task",
      labels: ["backend"],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TicketBody;
    expect(body.priority).toBe("urgent");
    expect(body.title).toBe("Titolo aggiornato");
    expect(body.body).toBe("Body aggiornato");
    expect(body.type).toBe("task");
    expect(body.labels).toEqual(["backend"]);
  });

  it("assegna e poi rimuove l'assegnatario (null)", async () => {
    const assigned = await patchTicket({ assigneeId: users.adminId });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as TicketBody).assigneeId).toBe(users.adminId);

    const cleared = await patchTicket({ assigneeId: null });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as TicketBody).assigneeId).toBeNull();
  });

  it("assigneeId che non corrisponde a nessun utente: 400", async () => {
    const res = await patchTicket({ assigneeId: randomUUID() });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH vuota restituisce il ticket invariato", async () => {
    const res = await patchTicket({});
    expect(res.statusCode).toBe(200);
    expect((res.json() as TicketBody).title).toBe("Titolo aggiornato");
  });

  it("ticket inesistente: 404", async () => {
    const res = await patchTicket({ status: "done" }, randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tickets/${ticketId}`,
      payload: { status: "done" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("commenti — /api/tickets/:ticketId/comments", () => {
  let ticketId: string;

  beforeAll(async () => {
    const res = await postTicket({ projectId, title: "Ticket commentato", type: "bug" });
    expect(res.statusCode).toBe(201);
    ticketId = (res.json() as TicketBody).id;
  });

  it("crea un commento: 201 con authorType user e authorId dell'utente in sessione", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/comments`,
      headers: { cookie: users.memberCookie },
      payload: { body: "Riprodotto anche su Firefox" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      ticketId,
      authorType: "user",
      authorId: users.memberId,
      body: "Riprodotto anche su Firefox",
      createdAt: expect.any(String),
    });
  });

  it("la lista è ordinata per data crescente", async () => {
    const second = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/comments`,
      headers: { cookie: users.adminCookie },
      payload: { body: "Fix in arrivo" },
    });
    expect(second.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}/comments`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { body: string; authorId: string }[];
    expect(body.map((c) => c.body)).toEqual(["Riprodotto anche su Firefox", "Fix in arrivo"]);
    expect(body.map((c) => c.authorId)).toEqual([users.memberId, users.adminId]);
  });

  it("ticket inesistente: 404 sia in creazione che in lettura", async () => {
    const missing = randomUUID();
    const post = await app.inject({
      method: "POST",
      url: `/api/tickets/${missing}/comments`,
      headers: { cookie: users.memberCookie },
      payload: { body: "Nel vuoto" },
    });
    expect(post.statusCode).toBe(404);
    const get = await app.inject({
      method: "GET",
      url: `/api/tickets/${missing}/comments`,
      headers: { cookie: users.memberCookie },
    });
    expect(get.statusCode).toBe(404);
  });

  it("body vuoto: 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/comments`,
      headers: { cookie: users.memberCookie },
      payload: { body: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const post = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/comments`,
      payload: { body: "Anonimo" },
    });
    expect(post.statusCode).toBe(401);
    const get = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}/comments`,
    });
    expect(get.statusCode).toBe(401);
  });
});

describe("effort nella risposta del ticket", () => {
  it("GET /:id include effort (null finché non triagiato, valorizzato dopo)", async () => {
    const created = (await postTicket({ projectId, title: "Con effort", type: "bug" })).json() as {
      id: string;
    };
    // Appena creato: effort null.
    const before = await app.inject({
      method: "GET",
      url: `/api/tickets/${created.id}`,
      headers: { cookie: users.memberCookie },
    });
    expect((before.json() as TicketBody).effort).toBeNull();

    // Il triage valorizza effort sul ticket: lo simuliamo via DB.
    await testDb.db.update(tickets).set({ effort: 4 }).where(eq(tickets.id, created.id));
    const after = await app.inject({
      method: "GET",
      url: `/api/tickets/${created.id}`,
      headers: { cookie: users.memberCookie },
    });
    expect((after.json() as TicketBody).effort).toBe(4);
  });
});

describe("POST /api/tickets/:id/run-ai", () => {
  it("ticket inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${randomUUID()}/run-ai`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const created = (await postTicket({ projectId, title: "Run AI 401", type: "bug" })).json() as {
      id: string;
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("member (requireAuth, non admin): 202 e crea un job queued+manuale se non ne esistono", async () => {
    const created = (await postTicket({ projectId, title: "Run AI nuovo", type: "bug" })).json() as {
      id: string;
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.ticketId).toBe(created.id);
    expect(job?.status).toBe("queued");
    expect(job?.manualTrigger).toBe(true);
  });

  it("rimette in coda l'ultimo job con manual_trigger, azzerando started/finished/error", async () => {
    const created = (await postTicket({ projectId, title: "Run AI esistente", type: "bug" })).json() as {
      id: string;
    };
    // Un job concluso (es. held o failed) già presente sul ticket.
    const [existing] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId: created.id,
        status: "held",
        startedAt: new Date(),
        finishedAt: new Date(),
        error: "vecchio errore",
        manualTrigger: false,
      })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { jobId: string }).jobId).toBe(existing!.id);

    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, existing!.id));
    expect(job?.status).toBe("queued");
    expect(job?.manualTrigger).toBe(true);
    expect(job?.startedAt).toBeNull();
    expect(job?.finishedAt).toBeNull();
    expect(job?.error).toBeNull();
  });

  it("withInstructions:true sull'ultimo job imposta resumeMode=fix e azzera planText", async () => {
    const created = (await postTicket({ projectId, title: "Run AI fix", type: "bug" })).json() as {
      id: string;
    };
    // Un job fermo in attesa di approvazione, con un piano già prodotto.
    const [existing] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId: created.id,
        status: "awaiting_plan_approval",
        planText: "vecchio piano",
        manualTrigger: false,
      })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
      headers: { cookie: users.memberCookie },
      payload: { withInstructions: true },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { jobId: string }).jobId).toBe(existing!.id);

    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, existing!.id));
    expect(job?.status).toBe("queued");
    expect(job?.manualTrigger).toBe(true);
    expect(job?.resumeMode).toBe("fix");
    expect(job?.planText).toBeNull();
  });

  it("senza body (re-triage) imposta resumeMode=null e azzera planText", async () => {
    const created = (await postTicket({ projectId, title: "Run AI re-triage", type: "bug" })).json() as {
      id: string;
    };
    // Un job che aveva un resumeMode/planText residui da un run precedente.
    const [existing] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId: created.id,
        status: "awaiting_plan_approval",
        resumeMode: "execute",
        planText: "vecchio piano",
        manualTrigger: false,
      })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(202);

    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, existing!.id));
    expect(job?.status).toBe("queued");
    expect(job?.manualTrigger).toBe(true);
    expect(job?.resumeMode).toBeNull();
    expect(job?.planText).toBeNull();
  });

  it("withInstructions:false è equivalente al re-triage (resumeMode=null)", async () => {
    const created = (await postTicket({ projectId, title: "Run AI no fix", type: "bug" })).json() as {
      id: string;
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
      headers: { cookie: users.memberCookie },
      payload: { withInstructions: false },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.resumeMode).toBeNull();
  });

  it("creazione ex-novo con withInstructions:true: job queued+manuale con resumeMode=fix", async () => {
    const created = (await postTicket({ projectId, title: "Run AI nuovo fix", type: "bug" })).json() as {
      id: string;
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/run-ai`,
      headers: { cookie: users.memberCookie },
      payload: { withInstructions: true },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("queued");
    expect(job?.manualTrigger).toBe(true);
    expect(job?.resumeMode).toBe("fix");
    expect(job?.planText).toBeNull();
  });
});

describe("POST /api/tickets/:id/approve-plan", () => {
  /** Inserisce un job in awaiting_plan_approval con un piano e residui da azzerare. */
  async function seedAwaitingJob(ticketId: string) {
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "awaiting_plan_approval",
        planText: "## Piano\n1. fai questo\n2. poi quello",
        startedAt: new Date(),
        finishedAt: new Date(),
        error: "vecchio errore",
      })
      .returning();
    return job!;
  }

  it("ticket inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${randomUUID()}/approve-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const created = (
      await postTicket({ projectId, title: "Approve 401", type: "bug" })
    ).json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/approve-plan`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("approva il piano: 202, job queued+execute, planText CONSERVATO, started/finished/error azzerati, commento system", async () => {
    const created = (
      await postTicket({ projectId, title: "Approve ok", type: "bug" })
    ).json() as { id: string };
    const job = await seedAwaitingJob(created.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/approve-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { jobId: string }).jobId).toBe(job.id);

    const [updated] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(updated?.status).toBe("queued");
    expect(updated?.resumeMode).toBe("execute");
    // Il piano approvato è ciò che il worker eseguirà: NON va azzerato.
    expect(updated?.planText).toBe("## Piano\n1. fai questo\n2. poi quello");
    expect(updated?.startedAt).toBeNull();
    expect(updated?.finishedAt).toBeNull();
    expect(updated?.error).toBeNull();

    const cmts = await testDb.db.select().from(comments).where(eq(comments.ticketId, created.id));
    const systemComment = cmts.find((c) => c.authorType === "system");
    expect(systemComment).toBeDefined();
    expect(systemComment?.body).toMatch(/approvat/i);
  });

  it("agisce sull'ultimo job AWAITING anche se ne esiste uno più recente in altro stato", async () => {
    const created = (
      await postTicket({ projectId, title: "Approve awaiting più vecchio", type: "bug" })
    ).json() as { id: string };
    // Job awaiting più vecchio…
    const awaiting = await seedAwaitingJob(created.id);
    // …e un job queued più recente (createdAt successivo): non deve mascherare
    // il piano genuinamente in attesa rendendolo irraggiungibile (409).
    const [newer] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId: created.id,
        status: "queued",
        createdAt: new Date(awaiting.createdAt.getTime() + 60_000),
      })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/approve-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { jobId: string }).jobId).toBe(awaiting.id);

    const [updatedAwaiting] = await testDb.db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.id, awaiting.id));
    expect(updatedAwaiting?.status).toBe("queued");
    expect(updatedAwaiting?.resumeMode).toBe("execute");
    // Il job queued più recente resta intatto.
    const [untouched] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, newer!.id));
    expect(untouched?.resumeMode).toBeNull();
  });

  it("job NON in awaiting_plan_approval: 409, nessuna modifica e nessun commento", async () => {
    const created = (
      await postTicket({ projectId, title: "Approve conflitto", type: "bug" })
    ).json() as { id: string };
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId: created.id, status: "queued", planText: "piano" })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/approve-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(409);

    const [unchanged] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, job!.id));
    expect(unchanged?.status).toBe("queued");
    expect(unchanged?.resumeMode).toBeNull();
    const cmts = await testDb.db.select().from(comments).where(eq(comments.ticketId, created.id));
    expect(cmts).toHaveLength(0);
  });
});

describe("POST /api/tickets/:id/reject-plan", () => {
  async function seedAwaitingJob(ticketId: string) {
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "awaiting_plan_approval",
        planText: "## Piano scartato",
        startedAt: new Date(),
        finishedAt: new Date(),
        error: "vecchio errore",
      })
      .returning();
    return job!;
  }

  it("ticket inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${randomUUID()}/reject-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const created = (
      await postTicket({ projectId, title: "Reject 401", type: "bug" })
    ).json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/reject-plan`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rifiuta il piano: 202, job queued+fix, planText=null, started/finished/error azzerati, commento system", async () => {
    const created = (
      await postTicket({ projectId, title: "Reject ok", type: "bug" })
    ).json() as { id: string };
    const job = await seedAwaitingJob(created.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/reject-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { jobId: string }).jobId).toBe(job.id);

    const [updated] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(updated?.status).toBe("queued");
    expect(updated?.resumeMode).toBe("fix");
    // Piano rifiutato: il worker ri-pianifica, quindi planText va azzerato.
    expect(updated?.planText).toBeNull();
    expect(updated?.startedAt).toBeNull();
    expect(updated?.finishedAt).toBeNull();
    expect(updated?.error).toBeNull();

    const cmts = await testDb.db.select().from(comments).where(eq(comments.ticketId, created.id));
    const systemComment = cmts.find((c) => c.authorType === "system");
    expect(systemComment).toBeDefined();
    expect(systemComment?.body).toMatch(/rifiutat/i);
  });

  it("job NON in awaiting_plan_approval: 409, nessuna modifica e nessun commento", async () => {
    const created = (
      await postTicket({ projectId, title: "Reject conflitto", type: "bug" })
    ).json() as { id: string };
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId: created.id, status: "fixing", planText: "piano" })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${created.id}/reject-plan`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(409);

    const [unchanged] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, job!.id));
    expect(unchanged?.status).toBe("fixing");
    expect(unchanged?.planText).toBe("piano");
    const cmts = await testDb.db.select().from(comments).where(eq(comments.ticketId, created.id));
    expect(cmts).toHaveLength(0);
  });
});
