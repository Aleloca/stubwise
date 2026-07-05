import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { widgetConversations, widgetMessages } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import {
  seedRepository,
  seedRepositoryInProject,
  seedTicket,
  startTestDb,
} from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

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
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("GET /api/projects/:projectId/widget-settings", () => {
  it("senza sessione: 401", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widget-settings",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("progetto vergine: 200 con i default dello schema, senza creare la riga", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: false,
      enabledRepositoryIds: [],
      title: "Assistenza",
      welcomeMessage: "Ciao! Come posso aiutarti?",
      accentColor: "#22c55e",
      language: "it",
    });
  });
});

describe("PUT /api/projects/:projectId/widget-settings", () => {
  it("admin con un repo del progetto: 200 e la GET riflette i valori", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const payload = {
      enabled: true,
      enabledRepositoryIds: [repositoryId],
      title: "Supporto",
      welcomeMessage: "Benvenuto nel supporto!",
      accentColor: "#3366ff",
      language: "en",
    };

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject(payload);

    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject(payload);
  });

  it("upsert: una seconda PUT aggiorna la riga esistente", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const base = {
      enabled: true,
      enabledRepositoryIds: [],
      title: "Primo",
      welcomeMessage: "Prima versione",
      accentColor: "#111111",
      language: "it",
    };
    const first = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: base,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: { ...base, title: "Secondo", enabled: false },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ title: "Secondo", enabled: false });

    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
    });
    expect(get.json()).toMatchObject({ title: "Secondo", enabled: false });
  });

  it("repositoryId di un ALTRO progetto: 422", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        enabledRepositoryIds: [other.repositoryId],
        title: "Supporto",
        welcomeMessage: "Benvenuto!",
        accentColor: "#3366ff",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(422);
  });

  it("più repo dello stesso progetto: 200", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondRepo = await seedRepositoryInProject(testDb.db, projectId);

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        enabledRepositoryIds: [repositoryId, secondRepo],
        title: "Supporto",
        welcomeMessage: "Benvenuto!",
        accentColor: "#3366ff",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(200);
  });

  it("progetto inesistente: 404", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widget-settings",
      headers: { cookie: adminCookie },
      payload: {
        enabled: false,
        enabledRepositoryIds: [],
        title: "Assistenza",
        welcomeMessage: "Ciao!",
        accentColor: "#22c55e",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(404);
  });

  it("da member (non admin): 403", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
      payload: {
        enabled: true,
        enabledRepositoryIds: [],
        title: "Supporto",
        welcomeMessage: "Benvenuto!",
        accentColor: "#3366ff",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(403);
  });
});

/**
 * Crea una conversazione widget per un progetto e vi appende i messaggi dati,
 * fissando createdAt/lastMessageAt in modo deterministico per i test di
 * ordinamento e conteggio. Restituisce l'id della conversazione.
 */
async function seedConversation(
  db: Db,
  opts: {
    projectId: string;
    externalUserId?: string;
    externalUserEmail?: string | null;
    externalUserName?: string | null;
    createdAt?: Date;
    lastMessageAt?: Date;
    messages?: { role: string; content: string; ticketId?: string; createdAt?: Date }[];
  },
): Promise<string> {
  const [conversation] = await db
    .insert(widgetConversations)
    .values({
      projectId: opts.projectId,
      externalUserId: opts.externalUserId ?? "ext-user",
      externalUserEmail: opts.externalUserEmail ?? null,
      externalUserName: opts.externalUserName ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.lastMessageAt ? { lastMessageAt: opts.lastMessageAt } : {}),
    })
    .returning({ id: widgetConversations.id });
  const conversationId = conversation!.id;
  for (const m of opts.messages ?? []) {
    await db.insert(widgetMessages).values({
      conversationId,
      role: m.role,
      content: m.content,
      ticketId: m.ticketId ?? null,
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    });
  }
  return conversationId;
}

describe("GET /api/projects/:projectId/widget/conversations", () => {
  it("senza sessione: 401", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widget/conversations",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("nessuna conversazione: lista vuota", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ conversations: [] });
  });

  it("due conversazioni: ordinate per lastMessageAt desc, con messageCount/ticketCount corretti", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { ticketId } = await seedTicket(testDb.db, { projectId });

    // Più vecchia: 3 messaggi, 1 con ticketId.
    const older = await seedConversation(testDb.db, {
      projectId,
      externalUserId: "user-old",
      externalUserEmail: "old@example.com",
      externalUserName: "Vecchia",
      lastMessageAt: new Date("2026-07-01T10:00:00Z"),
      messages: [
        { role: "user", content: "ciao" },
        { role: "assistant", content: "ecco" },
        { role: "assistant", content: "segnalato", ticketId },
      ],
    });

    // Più recente: 1 messaggio, nessun ticket.
    const newer = await seedConversation(testDb.db, {
      projectId,
      externalUserId: "user-new",
      lastMessageAt: new Date("2026-07-02T10:00:00Z"),
      messages: [{ role: "user", content: "domanda" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(2);
    expect(conversations[0].id).toBe(newer);
    expect(conversations[0].messageCount).toBe(1);
    expect(conversations[0].ticketCount).toBe(0);
    expect(conversations[1].id).toBe(older);
    expect(conversations[1].externalUserEmail).toBe("old@example.com");
    expect(conversations[1].externalUserName).toBe("Vecchia");
    expect(conversations[1].messageCount).toBe(3);
    expect(conversations[1].ticketCount).toBe(1);
  });

  it("conversazione senza messaggi: messageCount e ticketCount = 0 (inclusa)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const empty = await seedConversation(testDb.db, { projectId, externalUserId: "solo" });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
      headers: { cookie: memberCookie },
    });
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(empty);
    expect(conversations[0].messageCount).toBe(0);
    expect(conversations[0].ticketCount).toBe(0);
  });

  it("solo le conversazioni del progetto (isolamento)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    await seedConversation(testDb.db, { projectId, externalUserId: "mio" });
    await seedConversation(testDb.db, { projectId: other.projectId, externalUserId: "altrui" });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
      headers: { cookie: memberCookie },
    });
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].externalUserId).toBe("mio");
  });

  it("filtro ticketId: solo la conversazione che contiene un messaggio con quel ticket", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { ticketId } = await seedTicket(testDb.db, { projectId });

    const withTicket = await seedConversation(testDb.db, {
      projectId,
      externalUserId: "con-ticket",
      lastMessageAt: new Date("2026-07-01T10:00:00Z"),
      messages: [{ role: "assistant", content: "segnalato", ticketId }],
    });
    // Un'altra conversazione più recente ma senza quel ticket: NON deve comparire.
    await seedConversation(testDb.db, {
      projectId,
      externalUserId: "senza-ticket",
      lastMessageAt: new Date("2026-07-02T10:00:00Z"),
      messages: [{ role: "user", content: "altro" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations?ticketId=${ticketId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(withTicket);
  });

  it("limit rispettato", async () => {
    const { projectId } = await seedRepository(testDb.db);
    for (let i = 0; i < 3; i++) {
      await seedConversation(testDb.db, {
        projectId,
        externalUserId: `u-${i}`,
        lastMessageAt: new Date(`2026-07-0${i + 1}T10:00:00Z`),
      });
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations?limit=2`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversations).toHaveLength(2);
  });
});

describe("GET /api/projects/:projectId/widget/conversations/:conversationId/messages", () => {
  it("senza sessione: 401", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const conversationId = await seedConversation(testDb.db, { projectId });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations/${conversationId}/messages`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widget/conversations/00000000-0000-0000-0000-000000000000/messages",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("conversazione di un altro progetto: 404 (cross-progetto)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const conversationId = await seedConversation(testDb.db, {
      projectId: other.projectId,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations/${conversationId}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("filo completo cronologico con conversazione e messaggi", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { ticketId } = await seedTicket(testDb.db, { projectId });
    const base = new Date("2026-07-01T10:00:00Z");
    const conversationId = await seedConversation(testDb.db, {
      projectId,
      externalUserId: "u-filo",
      externalUserEmail: "filo@example.com",
      externalUserName: "Filo",
      messages: [
        { role: "user", content: "primo", createdAt: new Date(base.getTime() + 1000) },
        { role: "assistant", content: "secondo", createdAt: new Date(base.getTime() + 2000) },
        {
          role: "assistant",
          content: "terzo",
          ticketId,
          createdAt: new Date(base.getTime() + 3000),
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations/${conversationId}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversation).toMatchObject({
      id: conversationId,
      externalUserId: "u-filo",
      externalUserEmail: "filo@example.com",
      externalUserName: "Filo",
    });
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      "primo",
      "secondo",
      "terzo",
    ]);
    expect(body.messages[0]).toMatchObject({ role: "user", ticketId: null });
    expect(body.messages[2]).toMatchObject({ role: "assistant", ticketId });
  });
});
