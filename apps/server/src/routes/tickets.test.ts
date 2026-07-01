import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiJobs, comments, ticketEvents, ticketLinks, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedTicketRepository, startTestDb } from "@stubwise/db/testing";
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
  projectId = await createProject();
  otherProjectId = await createProject();
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/**
 * Mappa progetto (gruppo) → repository di default, popolata da
 * {@link createProject}. Dalla Fase 3 i ticket NON hanno più un repository
 * bersaglio (sono product-level puri), ma le milestone lo richiedono ancora:
 * questa mappa serve ai payload di milestone dei test.
 */
const repoForProject = new Map<string, string>();

/**
 * Crea un progetto (gruppo) con un repository sotto e restituisce l'id del
 * GRUPPO (è quello usato come `projectId` da ticket/milestone/filtri). Registra
 * il repository di default in {@link repoForProject}.
 */
async function createProject(): Promise<string> {
  const { projectId: pid, repositoryId } = await seedRepository(testDb.db);
  repoForProject.set(pid, repositoryId);
  return pid;
}

function postTicket(payload: Record<string, unknown>, cookie = users.memberCookie) {
  // Dalla Fase 3 il POST ticket è a livello di progetto: nessun repositoryId.
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
  milestoneId: string | null;
  effort: number | null;
  labels: string[];
  technicalPayload: unknown;
  occurrences: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  // Presente solo nel dettaglio (GET /:id): stato PR per-repo (Fase 3).
  repositories: {
    repositoryId: string;
    repositorySlug: string;
    repositoryName?: string;
    branch: string;
    prUrl: string | null;
    prState: string;
  }[];
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
      milestoneId: null,
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

  it("progetto inesistente: 404 (il numero è per-progetto, Fase 3)", async () => {
    const res = await postTicket({
      projectId: randomUUID(),
      title: "Orfano",
      type: "bug",
    });
    expect(res.statusCode).toBe(404);
  });

  it("il ticket non ha più un repositoryId nella risposta (Fase 3)", async () => {
    const res = await postTicket({ projectId, title: "Senza repo bersaglio", type: "bug" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty("repositoryId");
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
      payload: {
        projectId,
        repositoryId: repoForProject.get(projectId),
        title: "Anonimo",
        type: "bug",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/tickets — filtri", () => {
  let filterProjectId: string;
  let bugId: string;

  beforeAll(async () => {
    filterProjectId = await createProject();

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

  it("filtro milestoneId: solo i ticket della milestone", async () => {
    const ms = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: { cookie: users.memberCookie },
      payload: { projectId: filterProjectId, repositoryId: repoForProject.get(filterProjectId), name: "filtro-milestone" },
    });
    expect(ms.statusCode).toBe(201);
    const milestoneId = (ms.json() as { id: string }).id;
    await testDb.db.update(tickets).set({ milestoneId }).where(eq(tickets.id, bugId));

    const res = await listTickets({ projectId: filterProjectId, milestoneId });
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
    pageProjectId = await createProject();
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

describe("GET /api/tickets — ricerca full-text q", () => {
  let ftsProjectId: string;
  // Ticket con la parola chiave solo nel BODY (non nel titolo).
  let bodyMatchId: string;
  // Ticket con la parola chiave solo in un COMMENTO.
  let commentMatchId: string;
  // Ticket con "crashes" nel body, per il test di stemming.
  let stemmingId: string;

  beforeAll(async () => {
    ftsProjectId = await createProject();

    const bodyMatch = await postTicket({
      projectId: ftsProjectId,
      title: "Titolo generico senza parole utili",
      body: "Here we describe a kubernetes deployment problem in detail.",
      type: "bug",
    });
    expect(bodyMatch.statusCode).toBe(201);
    bodyMatchId = (bodyMatch.json() as TicketBody).id;

    const commentMatch = await postTicket({
      projectId: ftsProjectId,
      title: "Un altro titolo qualunque",
      body: "Body senza la parola speciale.",
      type: "task",
    });
    expect(commentMatch.statusCode).toBe(201);
    commentMatchId = (commentMatch.json() as TicketBody).id;
    await testDb.db.insert(comments).values({
      ticketId: commentMatchId,
      authorType: "user",
      authorId: users.memberId,
      body: "I think this is related to the elasticsearch indexer.",
    });

    const stemming = await postTicket({
      projectId: ftsProjectId,
      title: "Titolo neutro",
      body: "The application crashes on startup repeatedly.",
      type: "bug",
    });
    expect(stemming.statusCode).toBe(201);
    stemmingId = (stemming.json() as TicketBody).id;
  });

  it("matcha una parola presente solo nel body", async () => {
    const res = await listTickets({ projectId: ftsProjectId, q: "kubernetes" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([bodyMatchId]);
  });

  it("matcha una parola presente solo in un commento del ticket", async () => {
    const res = await listTickets({ projectId: ftsProjectId, q: "elasticsearch" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([commentMatchId]);
  });

  it("stemming: 'crashing' matcha il body che contiene 'crashes'", async () => {
    const res = await listTickets({ projectId: ftsProjectId, q: "crashing" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([stemmingId]);
  });

  it("caratteri speciali nel q: 200 (websearch tollerante), nessun crash", async () => {
    for (const q of ["foo & bar", "a:b", "!x", '"unclosed quote', "and/or & |"]) {
      const res = await listTickets({ projectId: ftsProjectId, q });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray((res.json() as ListBody).items)).toBe(true);
    }
  });

  it("caratteri speciali con un token reale: matcha comunque il ticket", async () => {
    // websearch_to_tsquery ignora gli operatori spuri e tiene il termine vero.
    const res = await listTickets({ projectId: ftsProjectId, q: "kubernetes & !@#" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.items.map((t) => t.id)).toEqual([bodyMatchId]);
  });

  it("nessun match: array vuoto", async () => {
    const res = await listTickets({ projectId: ftsProjectId, q: "wordthatdoesnotexistanywhere" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ListBody).items).toHaveLength(0);
  });

  it("filtri combinati: projectId + q restringono insieme", async () => {
    // 'kubernetes' è nel progetto ftsProjectId; con un altro projectId → vuoto.
    const inProject = await listTickets({ projectId: ftsProjectId, q: "kubernetes" });
    expect((inProject.json() as ListBody).items.map((t) => t.id)).toEqual([bodyMatchId]);

    const otherProject = await listTickets({ projectId: otherProjectId, q: "kubernetes" });
    expect((otherProject.json() as ListBody).items).toHaveLength(0);
  });

  it("paginazione: q che matcha > limit ticket impagina senza sovrapposizioni", async () => {
    const pagingProjectId = await createProject();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await postTicket({
        projectId: pagingProjectId,
        title: `Ticket ${i}`,
        body: "shared searchtoken in every body here",
        type: "task",
      });
      expect(res.statusCode).toBe(201);
      ids.push((res.json() as TicketBody).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string> = {
        projectId: pagingProjectId,
        q: "searchtoken",
        limit: "2",
      };
      if (cursor) query.cursor = cursor;
      const res = await listTickets(query);
      expect(res.statusCode).toBe(200);
      const body = res.json() as ListBody;
      seen.push(...body.items.map((t) => t.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(ids));
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
    // Prima dell'esecuzione dell'agente lo stato per-repo è vuoto.
    expect(body.repositories).toEqual([]);
  });

  it("espone lo stato PR per-repo dalle righe ticket_repositories (Fase 3)", async () => {
    const created = await postTicket({ projectId, title: "Con PR per-repo", type: "task" });
    const id = (created.json() as TicketBody).id;
    const repositoryId = repoForProject.get(projectId)!;
    await seedTicketRepository(testDb.db, {
      ticketId: id,
      repositoryId,
      branch: "stubwise/ticket-42",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${id}`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TicketBody;
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0]).toMatchObject({
      repositoryId,
      repositorySlug: expect.any(String),
      branch: "stubwise/ticket-42",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
  });

  it("espone milestoneId: null di default, l'id della milestone dopo l'assegnazione", async () => {
    const created = await postTicket({ projectId, title: "Con milestone", type: "task" });
    const id = (created.json() as TicketBody).id;

    const beforeRes = await app.inject({
      method: "GET",
      url: `/api/tickets/${id}`,
      headers: { cookie: users.memberCookie },
    });
    expect((beforeRes.json() as TicketBody).milestoneId).toBeNull();

    const ms = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: { cookie: users.memberCookie },
      payload: { projectId, repositoryId: repoForProject.get(projectId), name: "Sprint dettaglio" },
    });
    const milestoneId = (ms.json() as { id: string }).id;
    await testDb.db.update(tickets).set({ milestoneId }).where(eq(tickets.id, id));

    const afterRes = await app.inject({
      method: "GET",
      url: `/api/tickets/${id}`,
      headers: { cookie: users.memberCookie },
    });
    expect(afterRes.statusCode).toBe(200);
    expect((afterRes.json() as TicketBody).milestoneId).toBe(milestoneId);
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

describe("PATCH /api/tickets/:id — ticket_events", () => {
  // Ogni test usa un ticket fresco: gli eventi vengono confrontati per conteggio
  // esatto, quindi non devono accumularsi tra i casi.
  async function freshTicket(): Promise<string> {
    const res = await postTicket({ projectId, title: "Evento", type: "bug", labels: ["a", "b"] });
    expect(res.statusCode).toBe(201);
    return (res.json() as TicketBody).id;
  }

  function patch(id: string, payload: Record<string, unknown>, cookie = users.memberCookie) {
    return app.inject({ method: "PATCH", url: `/api/tickets/${id}`, headers: { cookie }, payload });
  }

  function eventsOf(id: string) {
    return testDb.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, id));
  }

  it("status + assigneeId → 2 eventi con kind/from/to corretti e actorId del loggato", async () => {
    const id = await freshTicket();
    const res = await patch(id, { status: "in_progress", assigneeId: users.memberId });
    expect(res.statusCode).toBe(200);

    const rows = await eventsOf(id);
    expect(rows).toHaveLength(2);
    const byKind = new Map(rows.map((r) => [r.kind, r]));

    const statusEvent = byKind.get("status_changed");
    expect(statusEvent?.payload).toEqual({ from: "open", to: "in_progress" });
    expect(statusEvent?.actorId).toBe(users.memberId);

    const assigneeEvent = byKind.get("assignee_changed");
    expect(assigneeEvent?.payload).toEqual({ from: null, to: users.memberId });
    expect(assigneeEvent?.actorId).toBe(users.memberId);
  });

  it("stessi valori correnti → 0 eventi", async () => {
    const id = await freshTicket();
    // status open è il default alla creazione: ripeterlo non è un cambio.
    const res = await patch(id, { status: "open", type: "bug", priority: "medium" });
    expect(res.statusCode).toBe(200);
    expect(await eventsOf(id)).toHaveLength(0);
  });

  it("PATCH vuota → 0 eventi e stato corrente", async () => {
    const id = await freshTicket();
    const res = await patch(id, {});
    expect(res.statusCode).toBe(200);
    expect((res.json() as TicketBody).status).toBe("open");
    expect(await eventsOf(id)).toHaveLength(0);
  });

  it("labels cambiate → 1 evento labels_changed con from/to", async () => {
    const id = await freshTicket();
    const res = await patch(id, { labels: ["a", "c"] });
    expect(res.statusCode).toBe(200);
    const rows = await eventsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("labels_changed");
    expect(rows[0]?.payload).toEqual({ from: ["a", "b"], to: ["a", "c"] });
  });

  it("labels identiche con ordine diverso → 0 eventi", async () => {
    const id = await freshTicket();
    const res = await patch(id, { labels: ["b", "a"] });
    expect(res.statusCode).toBe(200);
    expect(await eventsOf(id)).toHaveLength(0);
  });
});

describe("PATCH /api/tickets/:id — milestone", () => {
  let msA: string;
  let msB: string;

  beforeAll(async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: { cookie: users.memberCookie },
      payload: { projectId, repositoryId: repoForProject.get(projectId), name: "patch-ms-a" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: { cookie: users.memberCookie },
      payload: { projectId, repositoryId: repoForProject.get(projectId), name: "patch-ms-b" },
    });
    msA = (a.json() as { id: string }).id;
    msB = (b.json() as { id: string }).id;
  });

  async function freshTicket(): Promise<string> {
    const res = await postTicket({ projectId, title: "Milestone evento", type: "bug" });
    expect(res.statusCode).toBe(201);
    return (res.json() as TicketBody).id;
  }

  function patch(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/tickets/${id}`,
      headers: { cookie: users.memberCookie },
      payload,
    });
  }

  function eventsOf(id: string) {
    return testDb.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, id));
  }

  it("assegna milestone (null → id): 1 evento milestone_changed", async () => {
    const id = await freshTicket();
    const res = await patch(id, { milestoneId: msA });
    expect(res.statusCode).toBe(200);
    const rows = await eventsOf(id);
    const event = rows.find((r) => r.kind === "milestone_changed");
    expect(event?.payload).toEqual({ from: null, to: msA });
  });

  it("cambio milestone (old → new): from old to new", async () => {
    const id = await freshTicket();
    expect((await patch(id, { milestoneId: msA })).statusCode).toBe(200);
    const res = await patch(id, { milestoneId: msB });
    expect(res.statusCode).toBe(200);
    const rows = await eventsOf(id);
    const events = rows.filter((r) => r.kind === "milestone_changed");
    expect(events.at(-1)?.payload).toEqual({ from: msA, to: msB });
  });

  it("azzeramento (id → null): from id to null", async () => {
    const id = await freshTicket();
    expect((await patch(id, { milestoneId: msA })).statusCode).toBe(200);
    const res = await patch(id, { milestoneId: null });
    expect(res.statusCode).toBe(200);
    const rows = await eventsOf(id);
    const events = rows.filter((r) => r.kind === "milestone_changed");
    expect(events.at(-1)?.payload).toEqual({ from: msA, to: null });
  });

  it("invariato (stessa milestone): nessun evento milestone_changed nuovo", async () => {
    const id = await freshTicket();
    expect((await patch(id, { milestoneId: msA })).statusCode).toBe(200);
    expect((await patch(id, { milestoneId: msA })).statusCode).toBe(200);
    const events = (await eventsOf(id)).filter((r) => r.kind === "milestone_changed");
    expect(events).toHaveLength(1);
  });

  it("milestone di un altro progetto: 400 milestone_cross_project, ticket invariato", async () => {
    const otherMs = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: { cookie: users.memberCookie },
      payload: { projectId: otherProjectId, repositoryId: repoForProject.get(otherProjectId), name: "cross-ms" },
    });
    const crossId = (otherMs.json() as { id: string }).id;
    const id = await freshTicket();
    const res = await patch(id, { milestoneId: crossId });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("milestone_cross_project");

    const [row] = await testDb.db.select().from(tickets).where(eq(tickets.id, id));
    expect(row?.milestoneId).toBeNull();
  });

  it("milestone inesistente: 400 milestone_cross_project", async () => {
    const id = await freshTicket();
    const res = await patch(id, { milestoneId: randomUUID() });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("milestone_cross_project");
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

describe("GET /api/tickets/:id/activity", () => {
  interface ActivityItem {
    kind: string;
    id: string;
    createdAt: string;
    // comment
    authorType?: string;
    authorId?: string | null;
    body?: string;
    // event
    eventKind?: string;
    actorId?: string | null;
    payload?: Record<string, unknown> | null;
    // ai_job
    status?: string;
    prUrl?: string | null;
    finishedAt?: string | null;
  }

  function getActivity(id: string, cookie = users.memberCookie) {
    return app.inject({
      method: "GET",
      url: `/api/tickets/${id}/activity`,
      headers: { cookie },
    });
  }

  it("fonde commenti, eventi e job in un unico array ordinato per createdAt", async () => {
    const created = (await postTicket({ projectId, title: "Feed", type: "bug" })).json() as {
      id: string;
    };
    const ticketId = created.id;
    // Timestamp espliciti e distinti per asserire l'ordine cronologico.
    const t = (offsetMs: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + offsetMs);

    // Inserimento volutamente fuori ordine: il merge+sort deve riordinare.
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "pr_opened",
        prUrl: "https://github.com/acme/repo/pull/7",
        createdAt: t(3000),
        finishedAt: t(4000),
      })
      .returning();
    const [comment2] = await testDb.db
      .insert(comments)
      .values({ ticketId, authorType: "user", authorId: users.memberId, body: "Secondo", createdAt: t(2000) })
      .returning();
    const [event] = await testDb.db
      .insert(ticketEvents)
      .values({
        ticketId,
        actorId: users.adminId,
        kind: "status_changed",
        payload: { from: "open", to: "in_progress" },
        createdAt: t(1000),
      })
      .returning();
    const [comment1] = await testDb.db
      .insert(comments)
      .values({ ticketId, authorType: "ai", authorId: null, body: "Primo", createdAt: t(0) })
      .returning();

    const res = await getActivity(ticketId);
    expect(res.statusCode).toBe(200);
    const items = res.json() as ActivityItem[];
    expect(items).toHaveLength(4);

    // Ordine cronologico: comment1(0) → event(1000) → comment2(2000) → job(3000).
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["comment", comment1!.id],
      ["event", event!.id],
      ["comment", comment2!.id],
      ["ai_job", job!.id],
    ]);

    const [c1, ev, c2, j] = items;
    expect(c1).toMatchObject({ kind: "comment", authorType: "ai", authorId: null, body: "Primo" });
    expect(ev).toMatchObject({
      kind: "event",
      eventKind: "status_changed",
      actorId: users.adminId,
      payload: { from: "open", to: "in_progress" },
    });
    // Il discriminante `kind` vale "event" e NON è stato sovrascritto dalla colonna
    // `kind` della tabella ticketEvents (che vale "status_changed", esposta come `eventKind`).
    expect(ev!.kind).toBe("event");
    expect(ev).not.toHaveProperty("kind", "status_changed");
    expect(c2).toMatchObject({ kind: "comment", authorType: "user", authorId: users.memberId, body: "Secondo" });
    expect(j).toMatchObject({
      kind: "ai_job",
      status: "pr_opened",
      prUrl: "https://github.com/acme/repo/pull/7",
      finishedAt: expect.any(String),
    });
    // Il marker del job non porta i log/consumi.
    expect(j).not.toHaveProperty("log");
  });

  it("ticket senza attività: array vuoto", async () => {
    const created = (await postTicket({ projectId, title: "Feed vuoto", type: "task" })).json() as {
      id: string;
    };
    const res = await getActivity(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("ticket inesistente: 404", async () => {
    const res = await getActivity(randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const created = (await postTicket({ projectId, title: "Feed 401", type: "bug" })).json() as {
      id: string;
    };
    const res = await app.inject({ method: "GET", url: `/api/tickets/${created.id}/activity` });
    expect(res.statusCode).toBe(401);
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

describe("relazioni tra ticket — /api/tickets/:id/links", () => {
  let linksProjectId: string;

  /** Crea un ticket nel progetto delle relazioni e ne ritorna { id, number }. */
  async function freshTicket(
    projectIdForTicket = linksProjectId,
  ): Promise<{ id: string; number: number }> {
    const res = await postTicket({ projectId: projectIdForTicket, title: "Relazione", type: "task" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as TicketBody;
    return { id: body.id, number: body.number };
  }

  function createLink(
    id: string,
    payload: Record<string, unknown>,
    cookie = users.memberCookie,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/tickets/${id}/links`,
      headers: { cookie },
      payload,
    });
  }

  function getLinks(id: string, cookie = users.memberCookie) {
    return app.inject({ method: "GET", url: `/api/tickets/${id}/links`, headers: { cookie } });
  }

  function eventsOf(id: string) {
    return testDb.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, id));
  }

  beforeAll(async () => {
    linksProjectId = await createProject();
  });

  it("crea un link: 201, link presente, DUE eventi relation_added (outgoing/incoming) con otherNumber e actorId corretti", async () => {
    const a = await freshTicket();
    const b = await freshTicket();

    const res = await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });
    expect(res.statusCode).toBe(201);
    const link = res.json() as {
      id: string;
      sourceTicketId: string;
      targetTicketId: string;
      kind: string;
      createdAt: string;
    };
    expect(link).toEqual({
      id: expect.any(String),
      sourceTicketId: a.id,
      targetTicketId: b.id,
      kind: "blocks",
      createdAt: expect.any(String),
    });

    // Link persistito.
    const rows = await testDb.db.select().from(ticketLinks).where(eq(ticketLinks.id, link.id));
    expect(rows).toHaveLength(1);

    // Evento outgoing sul source.
    const aEvents = (await eventsOf(a.id)).filter((e) => e.kind === "relation_added");
    expect(aEvents).toHaveLength(1);
    expect(aEvents[0]?.actorId).toBe(users.memberId);
    expect(aEvents[0]?.payload).toEqual({
      kind: "blocks",
      direction: "outgoing",
      otherTicketId: b.id,
      otherNumber: b.number,
    });

    // Evento incoming sul target.
    const bEvents = (await eventsOf(b.id)).filter((e) => e.kind === "relation_added");
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]?.actorId).toBe(users.memberId);
    expect(bEvents[0]?.payload).toEqual({
      kind: "blocks",
      direction: "incoming",
      otherTicketId: a.id,
      otherNumber: a.number,
    });
  });

  it("self-link: 400 self_link", async () => {
    const a = await freshTicket();
    const res = await createLink(a.id, { targetTicketId: a.id, kind: "relates_to" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("self_link");
  });

  it("ticket :id inesistente: 404 ticket_not_found", async () => {
    const b = await freshTicket();
    const res = await createLink(randomUUID(), { targetTicketId: b.id, kind: "blocks" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("ticket_not_found");
  });

  it("target inesistente: 404 target_not_found", async () => {
    const a = await freshTicket();
    const res = await createLink(a.id, { targetTicketId: randomUUID(), kind: "blocks" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("target_not_found");
  });

  it("cross-project: 400 cross_project_link", async () => {
    const a = await freshTicket();
    const other = await freshTicket(otherProjectId);
    const res = await createLink(a.id, { targetTicketId: other.id, kind: "blocks" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("cross_project_link");
  });

  it("duplicato (stessa source/target/kind): 409 link_exists", async () => {
    const a = await freshTicket();
    const b = await freshTicket();
    const first = await createLink(a.id, { targetTicketId: b.id, kind: "relates_to" });
    expect(first.statusCode).toBe(201);
    const dup = await createLink(a.id, { targetTicketId: b.id, kind: "relates_to" });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { code: string }).code).toBe("link_exists");
  });

  it("kind diverse tra gli stessi ticket sono ammesse (no duplicato)", async () => {
    const a = await freshTicket();
    const b = await freshTicket();
    expect((await createLink(a.id, { targetTicketId: b.id, kind: "blocks" })).statusCode).toBe(201);
    expect((await createLink(a.id, { targetTicketId: b.id, kind: "parent" })).statusCode).toBe(201);
  });

  it("kind non valida: 400", async () => {
    const a = await freshTicket();
    const b = await freshTicket();
    const res = await createLink(a.id, { targetTicketId: b.id, kind: "duplicates" });
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401 (POST, GET, DELETE)", async () => {
    const a = await freshTicket();
    const b = await freshTicket();
    const created = await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });
    const linkId = (created.json() as { id: string }).id;

    const post = await app.inject({
      method: "POST",
      url: `/api/tickets/${a.id}/links`,
      payload: { targetTicketId: b.id, kind: "relates_to" },
    });
    expect(post.statusCode).toBe(401);
    const get = await app.inject({ method: "GET", url: `/api/tickets/${a.id}/links` });
    expect(get.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: `/api/tickets/${a.id}/links/${linkId}` });
    expect(del.statusCode).toBe(401);
  });

  describe("GET /api/tickets/:id/links — mapping della relazione", () => {
    it("dal lato SOURCE mostra la kind canonica e risolve number/title/status dell'altro", async () => {
      const a = await freshTicket();
      const b = await freshTicket();
      // Stato del target impostato direttamente: il GET deve risolverlo.
      await testDb.db.update(tickets).set({ status: "triaged" }).where(eq(tickets.id, b.id));

      const created = await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });
      const linkId = (created.json() as { id: string }).id;

      const res = await getLinks(a.id);
      expect(res.statusCode).toBe(200);
      const items = res.json() as {
        linkId: string;
        relation: string;
        otherTicketId: string;
        otherNumber: number;
        otherTitle: string;
        otherStatus: string;
      }[];
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        linkId,
        relation: "blocks",
        otherTicketId: b.id,
        otherNumber: b.number,
        otherTitle: "Relazione",
        otherStatus: "triaged",
        createdAt: expect.any(String),
      });
    });

    it("dal lato TARGET mostra l'inversa: A blocks B → GET su B relation blocked_by, otherNumber = A", async () => {
      const a = await freshTicket();
      const b = await freshTicket();
      await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });

      const res = await getLinks(b.id);
      const items = res.json() as { relation: string; otherTicketId: string; otherNumber: number }[];
      expect(items).toHaveLength(1);
      expect(items[0]?.relation).toBe("blocked_by");
      expect(items[0]?.otherTicketId).toBe(a.id);
      expect(items[0]?.otherNumber).toBe(a.number);
    });

    it("parent: source→parent, target→child; relates_to è simmetrica da entrambi i lati", async () => {
      const a = await freshTicket();
      const b = await freshTicket();
      await createLink(a.id, { targetTicketId: b.id, kind: "parent" });

      const fromSource = (await getLinks(a.id)).json() as { relation: string }[];
      expect(fromSource[0]?.relation).toBe("parent");
      const fromTarget = (await getLinks(b.id)).json() as { relation: string }[];
      expect(fromTarget[0]?.relation).toBe("child");

      const c = await freshTicket();
      const d = await freshTicket();
      await createLink(c.id, { targetTicketId: d.id, kind: "relates_to" });
      expect(((await getLinks(c.id)).json() as { relation: string }[])[0]?.relation).toBe("relates_to");
      expect(((await getLinks(d.id)).json() as { relation: string }[])[0]?.relation).toBe("relates_to");
    });

    it("ticket inesistente: 404", async () => {
      const res = await getLinks(randomUUID());
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/tickets/:id/links/:linkId", () => {
    it("204, link sparito, DUE eventi relation_removed sui due ticket", async () => {
      const a = await freshTicket();
      const b = await freshTicket();
      const created = await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });
      const linkId = (created.json() as { id: string }).id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tickets/${a.id}/links/${linkId}`,
        headers: { cookie: users.memberCookie },
      });
      expect(res.statusCode).toBe(204);

      const rows = await testDb.db.select().from(ticketLinks).where(eq(ticketLinks.id, linkId));
      expect(rows).toHaveLength(0);

      const aRemoved = (await eventsOf(a.id)).filter((e) => e.kind === "relation_removed");
      expect(aRemoved).toHaveLength(1);
      expect(aRemoved[0]?.actorId).toBe(users.memberId);
      expect(aRemoved[0]?.payload).toMatchObject({
        kind: "blocks",
        direction: "outgoing",
        otherTicketId: b.id,
        otherNumber: b.number,
      });
      const bRemoved = (await eventsOf(b.id)).filter((e) => e.kind === "relation_removed");
      expect(bRemoved).toHaveLength(1);
      expect(bRemoved[0]?.payload).toMatchObject({
        kind: "blocks",
        direction: "incoming",
        otherTicketId: a.id,
        otherNumber: a.number,
      });
    });

    it("DELETE dal lato TARGET (il link coinvolge :id come target): 204", async () => {
      const a = await freshTicket();
      const b = await freshTicket();
      const created = await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });
      const linkId = (created.json() as { id: string }).id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tickets/${b.id}/links/${linkId}`,
        headers: { cookie: users.memberCookie },
      });
      expect(res.statusCode).toBe(204);
      expect(
        await testDb.db.select().from(ticketLinks).where(eq(ticketLinks.id, linkId)),
      ).toHaveLength(0);
    });

    it("linkId che non coinvolge :id: 404 link_not_found, link intatto", async () => {
      const a = await freshTicket();
      const b = await freshTicket();
      const c = await freshTicket();
      const created = await createLink(a.id, { targetTicketId: b.id, kind: "blocks" });
      const linkId = (created.json() as { id: string }).id;

      // c non è né source né target del link.
      const res = await app.inject({
        method: "DELETE",
        url: `/api/tickets/${c.id}/links/${linkId}`,
        headers: { cookie: users.memberCookie },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { code: string }).code).toBe("link_not_found");
      expect(
        await testDb.db.select().from(ticketLinks).where(eq(ticketLinks.id, linkId)),
      ).toHaveLength(1);
    });

    it("linkId inesistente: 404", async () => {
      const a = await freshTicket();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/tickets/${a.id}/links/${randomUUID()}`,
        headers: { cookie: users.memberCookie },
      });
      expect(res.statusCode).toBe(404);
    });
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
