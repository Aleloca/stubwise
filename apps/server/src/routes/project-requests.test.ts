import { randomBytes } from "node:crypto";
import { backlogItemRequesters, backlogItemTickets, backlogItems, backlogJobs, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { projectRequestViewSchema, requestJobViewSchema } from "@stubwise/shared";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";
import type { ChatAvailability, ChatLlm, ChatLlmInput } from "./chat-llm.js";

/**
 * Le richieste dell'app nuova (integrazione area 2, fetta 4): la vista
 * `ProjectRequest` del prototipo (codice R<n> vero, richiedenti, task nate,
 * taglia, urgenza), l'esito dell'intake (nuova o fusa, e in quale), i
 * metadati, archivia/riapri/ripristina, e «Fondi in…» con la riscrittura AI
 * che, se il modello non risponde, non cambia niente.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let mergeOutput: string | Error = "# Documento fuso";
/** Gira mentre il «modello» lavora: ciò che succede qui succede DURANTE l'AI. */
let duringAi: (() => Promise<void>) | null = null;
const fakeChatLlm: ChatLlm = {
  async *stream(input: ChatLlmInput): AsyncIterable<string> {
    void input;
    if (duringAi) await duringAi();
    if (mergeOutput instanceof Error) throw mergeOutput;
    yield mergeOutput;
  },
  async isAvailable(): Promise<ChatAvailability> {
    return { available: true };
  },
};

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let projectCode: string;
let contributor: { id: string; headers: { cookie: string } };
let minutes = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
    chatLlm: fakeChatLlm,
  });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  await testDb.db.update(projects).set({ backlogEnabled: true }).where(eq(projects.id, projectId));
  [{ code: projectCode }] = (await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId))) as [
    { code: string },
  ];
  contributor = await createUserWithSession(app, "contrib@example.com");
  await addMember(app, projectId, contributor.id, "contributor");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function item(over: Partial<typeof backlogItems.$inferInsert> = {}) {
  minutes += 1;
  const [row] = await testDb.db
    .insert(backlogItems)
    .values({
      projectId,
      title: `Richiesta ${minutes}`,
      document: "Il testo della richiesta",
      source: "manual",
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, minutes)),
      ...over,
    })
    .returning({ id: backlogItems.id, number: backlogItems.number });
  return row!;
}

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, cookie = users.adminCookie) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const view = async (url: string, cookie = users.adminCookie) => {
  const res = await call("GET", url, undefined, cookie);
  expect(res.statusCode, res.body).toBe(200);
  return projectRequestViewSchema.parse(res.json());
};

describe("la vista ProjectRequest", () => {
  it("codice R<n> vero, richiedenti tutti, task nate, taglia dall'effort, urgent come high + urgent, descrizione e design", async () => {
    const a = await item({ effort: 4, urgency: "urgent", originContent: "La richiesta originale", document: "# Design", implementationPlan: "Piano" });
    await testDb.db.insert(backlogItemRequesters).values([
      { itemId: a.id, userId: users.memberId, requestedAt: new Date("2026-10-01T00:00:00Z") },
      { itemId: a.id, userId: contributor.id, requestedAt: new Date("2026-10-02T00:00:00Z") },
    ]);
    const [t] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 900, title: "Nata", type: "task", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    await testDb.db.insert(backlogItemTickets).values({ itemId: a.id, ticketId: t!.id, role: "converted_to" });
    const v = await view(`/api/requests/${a.id}`);
    expect(v).toMatchObject({
      code: `${projectCode}-R${a.number}`,
      requesterIds: [users.memberId, contributor.id],
      taskIds: [t!.id],
      size: "L",
      urgency: "high",
      urgent: true,
      description: "La richiesta originale",
      design: "# Design",
      plan: "Piano",
      webHref: `/backlog/${a.id}`,
    });
    // Per codice, anche in minuscolo; un codice che non c'è → 404.
    expect((await view(`/api/requests/by-code/${projectCode.toLowerCase()}-R${a.number}`)).id).toBe(a.id);
    expect((await call("GET", `/api/requests/by-code/${projectCode}-R9999`)).statusCode).toBe(404);
    // L'elenco del progetto la contiene.
    const list = z.array(projectRequestViewSchema).parse((await call("GET", `/api/requests?projectId=${projectId}`)).json());
    expect(list.some((r) => r.id === a.id)).toBe(true);
  });

  it("senza backlog.view_all si vedono solo le proprie, anche per codice", async () => {
    const others = await item();
    const own = await item();
    await testDb.db.insert(backlogItemRequesters).values({ itemId: own.id, userId: contributor.id });
    const list = z
      .array(projectRequestViewSchema)
      .parse((await call("GET", `/api/requests?projectId=${projectId}`, undefined, contributor.headers.cookie)).json());
    expect(list.map((r) => r.id)).toContain(own.id);
    expect(list.map((r) => r.id)).not.toContain(others.id);
    expect((await call("GET", `/api/requests/${others.id}`, undefined, contributor.headers.cookie)).statusCode).toBe(404);
    expect(
      (await call("GET", `/api/requests/by-code/${projectCode}-R${others.number}`, undefined, contributor.headers.cookie)).statusCode,
    ).toBe(404);
  });
});

describe("creazione: l'intake decide se è nuova o fusa", () => {
  it("POST accoda l'intake (202); il job dice «created» con la voce nuova, o «merged» con quella in cui si è fusa — mai una richiesta fantasma", async () => {
    const res = await call("POST", "/api/requests", { projectId, title: "Esportare in CSV", description: "Per il report" });
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = z.object({ jobId: z.uuid() }).parse(res.json());
    const job = (id: string) => call("GET", `/api/requests/jobs/${id}`);
    expect(requestJobViewSchema.parse((await job(jobId)).json())).toEqual({ status: "queued", outcome: null, request: null });
    // Il worker fonde la richiesta in una che c'era già.
    const existing = await item({ title: "Export CSV", createdAt: new Date("2026-01-01T00:00:00Z") });
    await testDb.db.update(backlogJobs).set({ status: "done", resultItemId: existing.id }).where(eq(backlogJobs.id, jobId));
    const merged = requestJobViewSchema.parse((await job(jobId)).json());
    expect(merged).toMatchObject({ status: "done", outcome: "merged", request: { id: existing.id, code: `${projectCode}-R${existing.number}` } });
    // Un'altra richiesta: il worker ne crea una nuova (dopo il job).
    const second = z.object({ jobId: z.uuid() }).parse((await call("POST", "/api/requests", { projectId, title: "Tema scuro" })).json());
    const fresh = await item({ title: "Tema scuro", createdAt: new Date(Date.now() + 60_000) });
    await testDb.db.update(backlogJobs).set({ status: "done", resultItemId: fresh.id }).where(eq(backlogJobs.id, second.jobId));
    expect(requestJobViewSchema.parse((await job(second.jobId)).json())).toMatchObject({ outcome: "created", request: { id: fresh.id } });
  });
});

describe("metadati e stati", () => {
  it("PATCH metadati con backlog.edit; trasformata o archiviata → 409 sui metadati, il titolo sì", async () => {
    const a = await item();
    const ok = await call("PATCH", `/api/requests/${a.id}`, { urgency: "low", size: "S", risk: "high", riskNote: " Il DB " });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(projectRequestViewSchema.parse(ok.json())).toMatchObject({ urgency: "low", size: "S", risk: "high", riskNote: "Il DB" });
    expect((await call("PATCH", `/api/requests/${a.id}`, { urgency: "low" }, contributor.headers.cookie)).statusCode).toBe(404);
    const done = await item({ status: "archived" });
    expect((await call("PATCH", `/api/requests/${done.id}`, { size: "M" })).statusCode).toBe(409);
    expect((await call("PATCH", `/api/requests/${done.id}`, { title: "Nuovo titolo" })).statusCode).toBe(200);
  });

  it("archivia → riapri (torna nuova, non più fusa) e ripristina (lo stato di prima; non una fusa)", async () => {
    const a = await item({ status: "ready" });
    const archived = projectRequestViewSchema.parse((await call("POST", `/api/requests/${a.id}/archive`)).json());
    expect(archived.status).toBe("archived");
    expect((await call("POST", `/api/requests/${a.id}/archive`)).statusCode).toBe(409);
    const restored = projectRequestViewSchema.parse((await call("POST", `/api/requests/${a.id}/restore`, { status: "ready" })).json());
    expect(restored.status).toBe("ready");
    const target = await item();
    const fused = await item({ status: "archived", mergedIntoId: target.id });
    expect((await call("POST", `/api/requests/${fused.id}/restore`, { status: "new" })).statusCode).toBe(409);
    const reopened = projectRequestViewSchema.parse((await call("POST", `/api/requests/${fused.id}/reopen`)).json());
    expect(reopened).toMatchObject({ status: "new", mergedIntoId: null });
  });
});

describe("descrizione e proposte dell'intake", () => {
  it("la descrizione si modifica (il corpo, o il testo originale se c'è un design); trasformata o archiviata → 409", async () => {
    const plain = await item({ document: "Prima" });
    const res = await call("PATCH", `/api/requests/${plain.id}`, { description: "Dopo" });
    expect(res.statusCode, res.body).toBe(200);
    expect(projectRequestViewSchema.parse(res.json())).toMatchObject({ description: "Dopo", design: null });
    const designed = await item({ originContent: "La richiesta", document: "# Design" });
    const v = projectRequestViewSchema.parse((await call("PATCH", `/api/requests/${designed.id}`, { description: "La richiesta, riscritta" })).json());
    expect(v).toMatchObject({ description: "La richiesta, riscritta", design: "# Design" });
    const archived = await item({ status: "archived" });
    const refused = await call("PATCH", `/api/requests/${archived.id}`, { description: "No" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "request_read_only" });
    expect((await call("PATCH", `/api/requests/${plain.id}`, { description: "x" }, contributor.headers.cookie)).statusCode).toBe(404);
  });

  it("accetta le proposte (diventano i metadati) o le scarta; senza proposte 409; su un'archiviata 409", async () => {
    const a = await item({ suggested: { effort: 2, urgency: "urgent", risk: "low", reason: "Perché sì" } });
    const before = await view(`/api/requests/${a.id}`);
    expect(before.suggestions).toEqual({ size: "S", urgency: "high", risk: "low", reason: "Perché sì" });
    const accepted = await call("POST", `/api/requests/${a.id}/suggestions/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(projectRequestViewSchema.parse(accepted.json())).toMatchObject({ size: "S", urgency: "high", urgent: true, risk: "low", suggestions: null });
    expect((await call("POST", `/api/requests/${a.id}/suggestions/accept`)).statusCode).toBe(409);
    const b = await item({ suggested: { effort: 5, reason: "No" } });
    const dismissed = projectRequestViewSchema.parse((await call("POST", `/api/requests/${b.id}/suggestions/dismiss`)).json());
    expect(dismissed).toMatchObject({ size: null, suggestions: null });
    expect((await call("POST", `/api/requests/${b.id}/suggestions/dismiss`)).statusCode).toBe(409);
    const c = await item({ status: "archived", suggested: { effort: 1 } });
    const refused = await call("POST", `/api/requests/${c.id}/suggestions/accept`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "request_read_only" });
  });
});

describe("«Fondi in…» con la riscrittura AI", () => {
  it("fonde: la destinazione ha il documento del modello e i richiedenti di entrambe; la sorgente è archiviata e fusa", async () => {
    mergeOutput = "# Documento fuso dal modello";
    const source = await item();
    const target = await item();
    await testDb.db.insert(backlogItemRequesters).values([
      { itemId: source.id, userId: contributor.id },
      { itemId: target.id, userId: users.memberId },
    ]);
    const res = await call("POST", `/api/requests/${source.id}/merge`, { intoId: target.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(projectRequestViewSchema.parse(res.json()).requesterIds.sort()).toEqual([contributor.id, users.memberId].sort());
    const after = await view(`/api/requests/${source.id}`);
    expect(after).toMatchObject({ status: "archived", mergedIntoId: target.id, mergedIntoCode: `${projectCode}-R${target.number}` });
    const [t] = await testDb.db.select({ d: backlogItems.document }).from(backlogItems).where(eq(backlogItems.id, target.id));
    expect(t!.d).toBe("# Documento fuso dal modello");
  });

  it("se il modello non risponde: 502 merge_failed e NESSUNA delle due voci cambia", async () => {
    const source = await item();
    const target = await item();
    await testDb.db.insert(backlogItemRequesters).values({ itemId: source.id, userId: contributor.id });
    const before = await testDb.db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    for (const failure of [new Error("il modello non risponde"), "   "]) {
      mergeOutput = failure;
      const res = await call("POST", `/api/requests/${source.id}/merge`, { intoId: target.id });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: "merge_failed" });
    }
    const after = await testDb.db.select().from(backlogItems).where(eq(backlogItems.projectId, projectId));
    const pick = (rows: typeof before) =>
      rows
        .filter((r) => r.id === source.id || r.id === target.id)
        .map((r) => ({ id: r.id, status: r.status, mergedIntoId: r.mergedIntoId, document: r.document, requestCount: r.requestCount }));
    expect(pick(after)).toEqual(pick(before));
    expect(await testDb.db.select().from(backlogItemRequesters).where(eq(backlogItemRequesters.itemId, target.id))).toHaveLength(0);
    mergeOutput = "# Documento fuso";
  });

  it("fusioni incrociate A→B e B→A: una sola riesce, l'altra 409 request_changed", async () => {
    const a = await item();
    const b = await item();
    // Una barriera: le due fusioni leggono entrambe PRIMA che una delle due scriva.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    duringAi = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    try {
      const [ab, ba] = await Promise.all([
        call("POST", `/api/requests/${a.id}/merge`, { intoId: b.id }),
        call("POST", `/api/requests/${b.id}/merge`, { intoId: a.id }),
      ]);
      expect([ab.statusCode, ba.statusCode].sort()).toEqual([200, 409]);
      expect([ab, ba].find((r) => r.statusCode === 409)!.json()).toMatchObject({ code: "request_changed" });
    } finally {
      duringAi = null;
    }
    const rows = await testDb.db
      .select({ id: backlogItems.id, status: backlogItems.status, mergedIntoId: backlogItems.mergedIntoId })
      .from(backlogItems)
      .where(inArray(backlogItems.id, [a.id, b.id]));
    // Mai le due fuse l'una nell'altra: una archiviata, l'altra aperta.
    expect(rows.filter((r) => r.status === "archived")).toHaveLength(1);
    expect(rows.filter((r) => r.mergedIntoId !== null)).toHaveLength(1);
  });

  it("destinazione modificata durante l'AI → 409 request_changed e niente sovrascritto", async () => {
    mergeOutput = "# Documento fuso";
    const source = await item();
    const target = await item();
    duringAi = async () => {
      await testDb.db.update(backlogItems).set({ document: "Scritto da un altro nel frattempo" }).where(eq(backlogItems.id, target.id));
    };
    try {
      const res = await call("POST", `/api/requests/${source.id}/merge`, { intoId: target.id });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: "request_changed" });
    } finally {
      duringAi = null;
    }
    const rows = await testDb.db
      .select({ id: backlogItems.id, status: backlogItems.status, document: backlogItems.document, mergedIntoId: backlogItems.mergedIntoId })
      .from(backlogItems)
      .where(inArray(backlogItems.id, [source.id, target.id]));
    expect(rows.find((r) => r.id === target.id)).toMatchObject({ document: "Scritto da un altro nel frattempo" });
    expect(rows.find((r) => r.id === source.id)).toMatchObject({ status: "new", mergedIntoId: null });
  });

  it("in sé stessa, in un'archiviata o da una trasformata: rifiutato", async () => {
    const a = await item();
    const archived = await item({ status: "archived" });
    const converted = await item({ status: "converted" });
    expect((await call("POST", `/api/requests/${a.id}/merge`, { intoId: a.id })).statusCode).toBe(400);
    expect((await call("POST", `/api/requests/${a.id}/merge`, { intoId: archived.id })).statusCode).toBe(409);
    expect((await call("POST", `/api/requests/${converted.id}/merge`, { intoId: a.id })).statusCode).toBe(409);
  });
});
