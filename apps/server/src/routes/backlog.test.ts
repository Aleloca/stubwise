import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  aiJobs,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  backlogRefineSessions,
  projects,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm } from "./chat-llm.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Fake ChatLlm per il merge (chiamata one-shot che integra i due documenti).
// `mergeOutput` è il markdown emesso; `availabilityOverride` esercita il 503.
let mergeOutput = "# Documento fuso";
let availabilityOverride: ChatAvailability | null = null;
const fakeChatLlm: ChatLlm = {
  async *stream(): AsyncIterable<string> {
    yield mergeOutput;
  },
  async isAvailable(): Promise<ChatAvailability> {
    return availabilityOverride ?? { available: true };
  },
};

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
    chatLlm: fakeChatLlm,
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  mergeOutput = "# Documento fuso";
  availabilityOverride = null;
  ({ projectId } = await seedRepository(testDb.db));
});

afterEach(async () => {
  await testDb.db.delete(backlogItemTickets);
  await testDb.db.delete(backlogJobs);
  await testDb.db.delete(backlogItems);
  await testDb.db.delete(aiJobs);
  await testDb.db.delete(tickets);
  await testDb.db.delete(projects);
});

/** Inserisce una voce di backlog nel progetto corrente e ne restituisce la riga. */
async function insertItem(
  overrides: Partial<typeof backlogItems.$inferInsert> = {},
): Promise<typeof backlogItems.$inferSelect> {
  const [row] = await testDb.db
    .insert(backlogItems)
    .values({ projectId, title: "Voce di test", source: "manual", ...overrides })
    .returning();
  return row!;
}

/** Inserisce un ticket nel progetto corrente (numero per-progetto). */
async function insertTicket(number: number, title: string): Promise<string> {
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId, number, title, type: "feedback", priority: "medium", source: "manual" })
    .returning({ id: tickets.id });
  return row!.id;
}

describe("GET /api/backlog", () => {
  it("senza sessione → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backlog" });
    expect(res.statusCode).toBe(401);
  });

  it("default: esclude converted e archived quando status è assente", async () => {
    await insertItem({ title: "attiva-new", status: "new" });
    await insertItem({ title: "attiva-ready", status: "ready" });
    await insertItem({ title: "conv", status: "converted" });
    await insertItem({ title: "arch", status: "archived" });

    const res = await app.inject({
      method: "GET",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { title: string }[] };
    expect(body.items.map((i) => i.title).sort()).toEqual(["attiva-new", "attiva-ready"]);
  });

  it("con status esplicito include lo stato terminale", async () => {
    await insertItem({ title: "conv", status: "converted" });
    const res = await app.inject({
      method: "GET",
      url: "/api/backlog?status=converted",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: { title: string; status: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.status).toBe("converted");
  });

  it("filtra per projectId, urgency e risk", async () => {
    await insertItem({ title: "match", urgency: "urgent", risk: "high" });
    await insertItem({ title: "no-urg", urgency: "low", risk: "high" });
    await insertItem({ title: "no-risk", urgency: "urgent", risk: "low" });
    // Progetto diverso: non deve comparire con il filtro projectId.
    const { projectId: other } = await seedRepository(testDb.db);
    await insertItem({ projectId: other, title: "altro", urgency: "urgent", risk: "high" });

    const res = await app.inject({
      method: "GET",
      url: `/api/backlog?projectId=${projectId}&urgency=urgent&risk=high`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: { title: string }[] };
    expect(body.items.map((i) => i.title)).toEqual(["match"]);
  });

  it("q filtra il titolo (ILIKE, case-insensitive)", async () => {
    await insertItem({ title: "Login con Google" });
    await insertItem({ title: "Esporta PDF" });
    const res = await app.inject({
      method: "GET",
      url: "/api/backlog?q=login",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: { title: string }[] };
    expect(body.items.map((i) => i.title)).toEqual(["Login con Google"]);
  });

  it("q con metacaratteri LIKE è escapato: '%' non matcha tutto", async () => {
    await insertItem({ title: "Sconto 50% sul piano" });
    await insertItem({ title: "Titolo senza percento" });
    const res = await app.inject({
      method: "GET",
      url: `/api/backlog?q=${encodeURIComponent("%")}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: { title: string }[] };
    // Solo il titolo che contiene LETTERALMENTE '%', non tutti.
    expect(body.items.map((i) => i.title)).toEqual(["Sconto 50% sul piano"]);
  });

  it("similarTo risolto dal similarToId", async () => {
    const target = await insertItem({ title: "Voce originale" });
    await insertItem({ title: "Voce simile", similarToId: target.id });

    const res = await app.inject({
      method: "GET",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as {
      items: { title: string; similarTo: { id: string; title: string } | null }[];
    };
    const simile = body.items.find((i) => i.title === "Voce simile")!;
    expect(simile.similarTo).toEqual({ id: target.id, title: "Voce originale" });
    const originale = body.items.find((i) => i.title === "Voce originale")!;
    expect(originale.similarTo).toBeNull();
  });

  it("ticketCount conta solo i ticket con role=origin", async () => {
    const item = await insertItem({ title: "Voce con ticket" });
    const t1 = await insertTicket(1, "origine 1");
    const t2 = await insertTicket(2, "origine 2");
    const t3 = await insertTicket(3, "convertito");
    await testDb.db.insert(backlogItemTickets).values([
      { itemId: item.id, ticketId: t1, role: "origin" },
      { itemId: item.id, ticketId: t2, role: "origin" },
      { itemId: item.id, ticketId: t3, role: "converted_to" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: { title: string; ticketCount: number }[] };
    expect(body.items[0]!.ticketCount).toBe(2);
  });

  it("non espone document né embedding nella lista", async () => {
    await insertItem({ title: "Con documento", document: "# Contenuto lungo del documento" });
    const res = await app.inject({
      method: "GET",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("document");
    expect(body.items[0]).not.toHaveProperty("embedding");
  });

  it("paginazione per cursor", async () => {
    // Tre voci con createdAt crescente e distinto (ordine DESC nella risposta).
    for (let i = 0; i < 3; i++) {
      await testDb.db.insert(backlogItems).values({
        projectId,
        title: `voce-${i}`,
        source: "manual",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const first = await app.inject({
      method: "GET",
      url: "/api/backlog?limit=2",
      headers: { cookie: memberCookie },
    });
    const firstBody = first.json() as {
      items: { title: string }[];
      nextCursor: string | null;
      total?: number;
    };
    expect(firstBody.items.map((i) => i.title)).toEqual(["voce-2", "voce-1"]);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/api/backlog?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      headers: { cookie: memberCookie },
    });
    const secondBody = second.json() as {
      items: { title: string }[];
      nextCursor: string | null;
      total?: number;
    };
    expect(secondBody.items.map((i) => i.title)).toEqual(["voce-0"]);
    expect(secondBody.nextCursor).toBeNull();

    // `total` è lo stesso sulle due pagine: il cursore è paginazione, non un
    // filtro — vedi il docblock di `ticketPageSchema.total` e il gemello in
    // `tickets.test.ts`.
    expect(firstBody.total).toBe(secondBody.total);
    expect(firstBody.total).toBeGreaterThanOrEqual(3);
  });

  it("`total` segue i filtri, non la pagina", async () => {
    const { projectId: soloProgetto } = await seedRepository(testDb.db);
    for (const title of ["alfa", "beta", "gamma"]) {
      await testDb.db.insert(backlogItems).values({ projectId: soloProgetto, title, source: "manual" });
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/backlog?projectId=${soloProgetto}&limit=1`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { items: unknown[]; total?: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
  });

  it("cursor malformato → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/backlog?cursor=spazzatura",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/backlog/:id", () => {
  it("404 se inesistente", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/${crypto.randomUUID()}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("dettaglio completo con document, suggested, tickets, similarTo", async () => {
    const target = await insertItem({ title: "Originale" });
    const item = await insertItem({
      title: "Idea",
      document: "# Documento",
      status: "refining",
      effort: 3,
      similarToId: target.id,
      suggested: { effort: 4, risk: "high", reason: "grande" },
    });
    const t1 = await insertTicket(1, "ticket origine");
    const t2 = await insertTicket(2, "ticket convertito");
    await testDb.db.insert(backlogItemTickets).values([
      { itemId: item.id, ticketId: t1, role: "origin" },
      { itemId: item.id, ticketId: t2, role: "converted_to" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      document: string;
      suggested: { effort: number; risk: string; reason: string } | null;
      similarTo: { id: string; title: string } | null;
      tickets: { id: string; number: number; title: string; role: string }[];
    };
    expect(body.document).toBe("# Documento");
    expect(body.suggested).toEqual({ effort: 4, risk: "high", reason: "grande" });
    expect(body.similarTo).toEqual({ id: target.id, title: "Originale" });
    expect(body.tickets).toHaveLength(2);
    expect(body.tickets.find((t) => t.role === "origin")!.number).toBe(1);
    expect(body.tickets.find((t) => t.role === "converted_to")!.number).toBe(2);
    // Dismessi chat, sessione di analisi, domande e deep dive (19 ott 2026):
    // i loro campi non escono più, senza segnaposto.
    for (const gone of ["messages", "deepDivePending", "codeSession", "pendingTurn", "openQuestion"]) {
      expect(body).not.toHaveProperty(gone);
    }
  });
});

describe("PATCH /api/backlog/:id", () => {
  it("member (non admin) può modificare i metadati", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: memberCookie },
      payload: { title: "nuovo" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { title: string }).title).toBe("nuovo");
  });

  it("404 se inesistente", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${crypto.randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { title: "nuovo" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("una metadata modifica a mano azzera il campo corrispondente in suggested", async () => {
    const item = await insertItem({
      effort: 2,
      suggested: { effort: 4, risk: "high", reason: "motivo" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: { effort: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effort: number; suggested: Record<string, unknown> | null };
    expect(body.effort).toBe(5);
    // effort rimosso da suggested; risk e reason restano.
    expect(body.suggested).toEqual({ risk: "high", reason: "motivo" });
  });

  it("suggested diventa null quando resta vuoto", async () => {
    const item = await insertItem({ suggested: { effort: 4 } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: { effort: 1 },
    });
    const body = res.json() as { suggested: unknown };
    expect(body.suggested).toBeNull();
  });

  it("suggested diventa null anche se resta solo un reason orfano", async () => {
    // `reason` è la motivazione dei metadati, non un metadato: coprendo effort
    // e risk non resta nulla di azionabile → suggested null.
    const item = await insertItem({
      suggested: { effort: 4, risk: "high", reason: "motivazione dei suggerimenti" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: { effort: 2, risk: "low" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effort: number; risk: string; suggested: unknown };
    expect(body.effort).toBe(2);
    expect(body.risk).toBe("low");
    expect(body.suggested).toBeNull();
  });

  it("azzeramento esplicito con null (effort: null)", async () => {
    const item = await insertItem({ effort: 3 });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: { effort: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { effort: number | null }).effort).toBeNull();
  });

  it("body vuoto {} → 200 no-op", async () => {
    const item = await insertItem({ title: "Invariata", effort: 2 });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { title: string; effort: number };
    expect(body.title).toBe("Invariata");
    expect(body.effort).toBe(2);
  });

  it("transizione verso converted vietata → errore", async () => {
    const item = await insertItem({ status: "ready" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "converted" },
    });
    expect(res.statusCode).toBe(409);
    // Lo stato non è cambiato.
    const [row] = await testDb.db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("ready");
  });

  it("id inesistente con status converted → 404 (non 409)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${crypto.randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { status: "converted" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("altre transizioni di stato sono ammesse", async () => {
    const item = await insertItem({ status: "new" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("archived");
  });
});

describe("POST /api/backlog", () => {
  it("senza sessione → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog",
      payload: { projectId, title: "Idea", body: "descrizione" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
      payload: { projectId: crypto.randomUUID(), title: "Idea", body: "descrizione" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("creazione manuale → 202 e job intake con payload title/body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
      payload: { projectId, title: "Idea manuale", body: "corpo della richiesta" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.queued).toBe(true);
    expect(typeof body.jobId).toBe("string");

    const jobs = await testDb.db
      .select()
      .from(backlogJobs)
      .where(eq(backlogJobs.projectId, projectId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(body.jobId);
    expect(jobs[0]!.kind).toBe("intake");
    expect(jobs[0]!.status).toBe("queued");
    expect(jobs[0]!.payload).toEqual({ title: "Idea manuale", body: "corpo della richiesta" });
  });
});

describe("POST /api/backlog/from-design", () => {
  it("senza sessione → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog/from-design",
      payload: { projectId, title: "Design pronto", design: "# Design\ncorpo" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog/from-design",
      headers: { cookie: memberCookie },
      payload: { projectId: crypto.randomUUID(), title: "Design", design: "corpo" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("design vuoto → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog/from-design",
      headers: { cookie: memberCookie },
      payload: { projectId, title: "Design", design: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("design oltre 200_000 caratteri → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog/from-design",
      headers: { cookie: memberCookie },
      payload: { projectId, title: "Design", design: "x".repeat(200_001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("title mancante → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog/from-design",
      headers: { cookie: memberCookie },
      payload: { projectId, design: "corpo" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("crea la voce SINCRONA (document verbatim) e accoda un job estimate", async () => {
    const design = "# Design pronto\n\nParagrafo con **markdown** e dettagli tecnici.\n";
    const res = await app.inject({
      method: "POST",
      url: "/api/backlog/from-design",
      headers: { cookie: memberCookie },
      payload: { projectId, title: "Voce da design", design },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.itemId).toBe("string");
    expect(body.url).toBe(`https://stubwise.example.com/backlog/${body.itemId}`);

    const [item] = await testDb.db
      .select()
      .from(backlogItems)
      .where(eq(backlogItems.id, body.itemId));
    expect(item).toBeDefined();
    expect(item!.projectId).toBe(projectId);
    expect(item!.title).toBe("Voce da design");
    expect(item!.document).toBe(design);
    expect(item!.source).toBe("manual");
    expect(item!.status).toBe("new");
    expect(item!.effort).toBeNull();
    expect(item!.risk).toBeNull();
    expect(item!.urgency).toBeNull();
    expect(item!.embedding).toBeNull();

    const jobs = await testDb.db
      .select()
      .from(backlogJobs)
      .where(eq(backlogJobs.projectId, projectId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("estimate");
    expect(jobs[0]!.status).toBe("queued");
    expect(jobs[0]!.payload).toEqual({ itemId: body.itemId });
  });
});

describe("GET /api/backlog/jobs/:jobId", () => {
  it("senza sessione → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/jobs/${crypto.randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("job appena accodato → 200 status queued, resultItemId/error null", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
      payload: { projectId, title: "Idea", body: "corpo" },
    });
    const { jobId } = created.json() as { jobId: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/jobs/${jobId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "queued", resultItemId: null, error: null });
  });

  it("riflette status done + resultItemId dopo l'intake", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/backlog",
      headers: { cookie: memberCookie },
      payload: { projectId, title: "Idea", body: "corpo" },
    });
    const { jobId } = created.json() as { jobId: string };
    const item = await insertItem();
    await testDb.db
      .update(backlogJobs)
      .set({ status: "done", resultItemId: item.id })
      .where(eq(backlogJobs.id, jobId));

    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/jobs/${jobId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "done", resultItemId: item.id, error: null });
  });

  it("404 se il job non esiste", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/jobs/${crypto.randomUUID()}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 se jobId non è un uuid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/backlog/jobs/non-un-uuid",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/backlog/:id/suggested/accept", () => {
  it("member (non admin) può accettare i valori suggeriti", async () => {
    const item = await insertItem({ suggested: { effort: 4 } });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/accept`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { effort: number }).effort).toBe(4);
  });

  it("404 se inesistente", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${crypto.randomUUID()}/suggested/accept`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409 se suggested è null", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/accept`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409 se suggested ha solo un reason orfano (nulla da accettare)", async () => {
    const item = await insertItem({ suggested: { reason: "solo la motivazione" } });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/accept`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("applica tutti i metadati suggeriti e azzera suggested", async () => {
    const item = await insertItem({
      effort: 1,
      risk: "low",
      suggested: { effort: 4, risk: "high", riskNote: "attenzione", urgency: "urgent" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/accept`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      effort: number;
      risk: string;
      riskNote: string;
      urgency: string;
      suggested: unknown;
    };
    expect(body.effort).toBe(4);
    expect(body.risk).toBe("high");
    expect(body.riskNote).toBe("attenzione");
    expect(body.urgency).toBe("urgent");
    expect(body.suggested).toBeNull();
  });
});

describe("POST /api/backlog/:id/suggested/dismiss", () => {
  it("member (non admin) può scartare i valori suggeriti", async () => {
    const item = await insertItem({ suggested: { effort: 4 } });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/dismiss`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { suggested: unknown }).suggested).toBeNull();
  });

  it("409 se suggested è null", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/dismiss`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("azzera suggested senza applicare i metadati", async () => {
    const item = await insertItem({ effort: 1, suggested: { effort: 4, risk: "high" } });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/suggested/dismiss`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effort: number; suggested: unknown };
    // I metadati reali NON cambiano; solo suggested è azzerato.
    expect(body.effort).toBe(1);
    expect(body.suggested).toBeNull();
  });
});

describe("POST /api/backlog/:id/convert", () => {
  it("senza sessione → 401", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/convert`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 se inesistente", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${crypto.randomUUID()}/convert`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("crea un task col numero sequenziale reale, link converted_to, voce→converted, nessun aiJob", async () => {
    const item = await insertItem({
      title: "Idea da convertire",
      document: "# Design\n\nCorpo del documento.",
      implementationPlan: "## Piano\n1. Step",
      originContent: "Testo di partenza",
      effort: 3,
      urgency: "high",
      status: "ready",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/convert`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ticketId: string; ticketNumber: number };
    // Progetto nuovo: nextTicketNumber parte da 1.
    expect(body.ticketNumber).toBe(1);

    const [ticket] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, body.ticketId));
    expect(ticket!.type).toBe("task");
    expect(ticket!.status).toBe("open");
    expect(ticket!.title).toBe("Idea da convertire");
    expect(ticket!.body).toBe("# Design\n\nCorpo del documento.");
    expect(ticket!.priority).toBe("high"); // dall'urgency
    expect(ticket!.effort).toBe(3);
    expect(ticket!.source).toBe("manual");
    // Il ticket eredita design (originContent) e piano di implementazione.
    expect(ticket!.implementationPlan).toBe("## Piano\n1. Step");
    expect(ticket!.originContent).toBe("Testo di partenza");

    // Link converted_to.
    const links = await testDb.db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.role).toBe("converted_to");
    expect(links[0]!.ticketId).toBe(body.ticketId);

    // Voce → converted.
    const [row] = await testDb.db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("converted");

    // NESSUN aiJob accodato.
    const jobs = await testDb.db.select().from(aiJobs);
    expect(jobs).toHaveLength(0);
  });

  it("il numero prosegue la sequenza del progetto (rispetta i ticket esistenti)", async () => {
    // Un ticket già esistente porta nextTicketNumber a 2.
    await testDb.db
      .update(projects)
      .set({ nextTicketNumber: 5 })
      .where(eq(projects.id, projectId));
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/convert`,
      headers: { cookie: adminCookie },
    });
    expect((res.json() as { ticketNumber: number }).ticketNumber).toBe(5);
  });

  it("409 se già converted", async () => {
    const item = await insertItem({ status: "converted" });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/convert`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("urgency null → priority medium", async () => {
    const item = await insertItem({ urgency: null });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/convert`,
      headers: { cookie: adminCookie },
    });
    const body = res.json() as { ticketId: string };
    const [ticket] = await testDb.db.select().from(tickets).where(eq(tickets.id, body.ticketId));
    expect(ticket!.priority).toBe("medium");
  });

  it("member (operator) → 200: convertire è lavoro quotidiano, non un privilegio admin", async () => {
    const item = await insertItem({ status: "ready" });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/convert`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await testDb.db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("converted");
  });
});

describe("PUT/DELETE /api/backlog/:id/design", () => {
  it("senza sessione → 401", async () => {
    const item = await insertItem({ document: "# Vecchio" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/design`,
      payload: { content: "# Nuovo design" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 se la voce non esiste", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${crypto.randomUUID()}/design`,
      headers: { cookie: memberCookie },
      payload: { content: "# Nuovo design" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 se content è vuoto", async () => {
    const item = await insertItem({ document: "# Vecchio" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
      payload: { content: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 se content supera i 200k caratteri", async () => {
    const item = await insertItem({ document: "# Vecchio" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
      payload: { content: "x".repeat(200_001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT design: document diventa content, originContent preserva il vecchio document", async () => {
    const item = await insertItem({ document: "# Documento originale" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
      payload: { content: "# Design generato" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { document: string; originContent: string | null };
    expect(body.document).toBe("# Design generato");
    expect(body.originContent).toBe("# Documento originale");

    // Un SECONDO PUT aggiorna il document ma NON tocca originContent.
    const res2 = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
      payload: { content: "# Design rivisto" },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as { document: string; originContent: string | null };
    expect(body2.document).toBe("# Design rivisto");
    // originContent INVARIATO: si preserva una sola volta.
    expect(body2.originContent).toBe("# Documento originale");
  });

  it("DELETE design: document torna a originContent, originContent → null", async () => {
    const item = await insertItem({ document: "# Originale" });
    await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
      payload: { content: "# Design" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { document: string; originContent: string | null };
    expect(body.document).toBe("# Originale");
    expect(body.originContent).toBeNull();
  });

  it("DELETE design senza design attivo (originContent null) → 404", async () => {
    const item = await insertItem({ document: "# Solo documento" });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/backlog/${item.id}/design`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT/DELETE /api/backlog/:id/plan", () => {
  it("senza sessione → 401", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/plan`,
      payload: { content: "## Piano" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 se la voce non esiste", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${crypto.randomUUID()}/plan`,
      headers: { cookie: memberCookie },
      payload: { content: "## Piano" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 se content supera i 200k caratteri", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/plan`,
      headers: { cookie: memberCookie },
      payload: { content: "x".repeat(200_001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 se content è vuoto (setContentSchema min(1))", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/plan`,
      headers: { cookie: memberCookie },
      payload: { content: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT plan: implementationPlan = content", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "PUT",
      url: `/api/backlog/${item.id}/plan`,
      headers: { cookie: memberCookie },
      payload: { content: "## Piano\n1. Uno\n2. Due" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { implementationPlan: string | null }).implementationPlan).toBe(
      "## Piano\n1. Uno\n2. Due",
    );
  });

  it("DELETE plan: implementationPlan → null", async () => {
    const item = await insertItem({ implementationPlan: "## Piano esistente" });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/backlog/${item.id}/plan`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { implementationPlan: string | null }).implementationPlan).toBeNull();
  });

  it("DELETE plan 404 se la voce non esiste", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/backlog/${crypto.randomUUID()}/plan`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE plan idempotente: 200 anche se implementationPlan è già null (no-op)", async () => {
    // Nessun piano mai impostato: la DELETE è un no-op ma l'UPDATE matcha comunque
    // la riga esistente → 200 idempotente, NON 404.
    const item = await insertItem();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/backlog/${item.id}/plan`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { implementationPlan: string | null }).implementationPlan).toBeNull();
  });
});

describe("GET /api/backlog/:id espone implementationPlan e originContent", () => {
  it("ritorna i due campi valorizzati", async () => {
    const item = await insertItem({
      document: "# Design attivo",
      implementationPlan: "## Piano di implementazione",
      originContent: "Corpo originale",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { implementationPlan: string | null; originContent: string | null };
    expect(body.implementationPlan).toBe("## Piano di implementazione");
    expect(body.originContent).toBe("Corpo originale");
  });
});

describe("POST /api/backlog/:id/merge", () => {
  it("member (non admin) può fondere due voci", async () => {
    const a = await insertItem();
    const b = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${a.id}/merge`,
      headers: { cookie: memberCookie },
      payload: { targetId: b.id },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }).id).toBe(b.id);
  });

  it("400 se id === targetId", async () => {
    const a = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${a.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: a.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 se il target non esiste", async () => {
    const a = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${a.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 se i due sono di progetti diversi", async () => {
    const a = await insertItem();
    const { projectId: other } = await seedRepository(testDb.db);
    const b = await insertItem({ projectId: other });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${a.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: b.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 se il target è archived o converted", async () => {
    const a = await insertItem();
    const b = await insertItem({ status: "archived" });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${a.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: b.id },
    });
    expect(res.statusCode).toBe(409);
  });

  it("503 se la chat non è servibile", async () => {
    const a = await insertItem();
    const b = await insertItem();
    availabilityOverride = { available: false };
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${a.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: b.id },
    });
    expect(res.statusCode).toBe(503);
  });

  it("fonde: somma requestCount, sposta i link (upsert), documento AI, assorbito archived", async () => {
    mergeOutput = "# Documento integrato";
    const absorbed = await insertItem({ title: "Assorbito", requestCount: 2 });
    const target = await insertItem({ title: "Destinazione", requestCount: 3, document: "# Vecchio target" });

    // Ticket: t1 solo sull'assorbito, tShared su entrambi (testa l'upsert).
    const t1 = await insertTicket(1, "solo assorbito");
    const tShared = await insertTicket(2, "condiviso");
    await testDb.db.insert(backlogItemTickets).values([
      { itemId: absorbed.id, ticketId: t1, role: "origin" },
      { itemId: absorbed.id, ticketId: tShared, role: "origin" },
      { itemId: target.id, ticketId: tShared, role: "origin" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${absorbed.id}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: target.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; requestCount: number; document: string; status: string };
    // Risposta = target aggiornato.
    expect(body.id).toBe(target.id);
    expect(body.requestCount).toBe(5); // 3 + 2
    expect(body.document).toBe("# Documento integrato");

    // Link spostati sul target: t1 (nuovo) + tShared (già presente, non duplicato).
    const targetLinks = await testDb.db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, target.id));
    expect(targetLinks.map((l) => l.ticketId).sort()).toEqual([t1, tShared].sort());
    // I link dell'assorbito sono stati rimossi.
    const absorbedLinks = await testDb.db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, absorbed.id));
    expect(absorbedLinks).toHaveLength(0);

    // Assorbito → archived con mergedIntoId.
    const [absorbedRow] = await testDb.db
      .select({ status: backlogItems.status, mergedIntoId: backlogItems.mergedIntoId })
      .from(backlogItems)
      .where(eq(backlogItems.id, absorbed.id));
    expect(absorbedRow!.status).toBe("archived");
    expect(absorbedRow!.mergedIntoId).toBe(target.id);
  });
});

describe("POST/DELETE /api/backlog/:id/refine-session", () => {
  it("un member avvia (200, agentSessionId) e col messaggio riceve inputId", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refine-session`,
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agentSessionId: expect.any(String), inputId: expect.any(String) });
  });

  it("voce convertita: 409 item_closed", async () => {
    const item = await insertItem({ status: "converted" });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refine-session`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    expect([res.statusCode, res.json().code]).toEqual([409, "item_closed"]);
  });

  it("messaggio vuoto: 400; voce inesistente: 404", async () => {
    const item = await insertItem();
    const empty = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refine-session`,
      headers: { cookie: memberCookie },
      payload: { message: "  " },
    });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: `/api/backlog/7f1c2a1e-0000-4000-8000-0000000000ff/refine-session`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });

  it("DELETE: 204 due volte di fila; voce inesistente 404", async () => {
    const item = await insertItem();
    await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refine-session`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/backlog/${item.id}/refine-session`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(204);
    }
    const missing = await app.inject({
      method: "DELETE",
      url: `/api/backlog/7f1c2a1e-0000-4000-8000-0000000000ff/refine-session`,
      headers: { cookie: memberCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("senza login: 401", async () => {
    const item = await insertItem();
    const res = await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, payload: {} });
    expect(res.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: `/api/backlog/${item.id}/refine-session` });
    expect(del.statusCode).toBe(401);
  });
});

describe("la voce chiusa chiude la sessione di refinement (Review Focus #6)", () => {
  async function started() {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refine-session`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    return { itemId: item.id, agentSessionId: res.json().agentSessionId as string };
  }
  const refineOf = async (itemId: string) =>
    (await testDb.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId)))[0]!;

  it("conversione in ticket", async () => {
    const { itemId } = await started();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${itemId}/convert`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
  });

  it("archiviazione via PATCH", async () => {
    const { itemId } = await started();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/backlog/${itemId}`,
      headers: { cookie: adminCookie },
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
  });

  it("un PATCH che non archivia lascia la sessione attiva", async () => {
    const { itemId } = await started();
    await app.inject({
      method: "PATCH",
      url: `/api/backlog/${itemId}`,
      headers: { cookie: adminCookie },
      payload: { title: "Nuovo titolo" },
    });
    expect(await refineOf(itemId)).toMatchObject({ status: "active", closedReason: null });
  });

  it("fusione: si chiude quella della voce ASSORBITA", async () => {
    const { itemId } = await started();
    const target = await started();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${itemId}/merge`,
      headers: { cookie: adminCookie },
      payload: { targetId: target.itemId },
    });
    expect(res.statusCode).toBe(200);
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
    expect(await refineOf(target.itemId)).toMatchObject({ status: "active" });
  });
});

describe("GET /api/backlog/:id refineSession", () => {
  it("null senza sessione, la vista con una sessione", async () => {
    const item = await insertItem();
    const before = await app.inject({
      method: "GET",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: memberCookie },
    });
    expect(before.json().refineSession).toBeNull();
    await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refine-session`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/backlog/${item.id}`,
      headers: { cookie: memberCookie },
    });
    expect(after.json().refineSession).toMatchObject({ status: "active", closedReason: null });
  });
});
