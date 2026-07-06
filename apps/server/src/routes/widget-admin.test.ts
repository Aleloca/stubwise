import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { widgetConversations, widgetMessages, widgets } from "@stubwise/db";
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

/** Corpo `widgetUpsertBodySchema` completo, con override opzionali. */
function upsertBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Widget",
    enabled: true,
    enabledRepositoryIds: [],
    title: "Supporto",
    welcomeMessage: "Benvenuto!",
    accentColor: "#3366ff",
    language: "it",
    dailyMessageCap: null,
    dailyTicketCap: null,
    ...overrides,
  };
}

describe("GET /api/projects/:projectId/widgets", () => {
  it("senza sessione: 401", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/widgets` });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widgets",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("progetto vergine: lista vuota", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ widgets: [] });
  });

  it("conversationCount: aggregato corretto per widget", async () => {
    const { projectId } = await seedRepository(testDb.db);
    // Due widget: al primo lego 2 conversazioni, al secondo nessuna.
    const [withConv] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Con conversazioni", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Vuoto", key: randomBytes(16).toString("hex") });
    await seedConversation(testDb.db, { projectId, widgetId: withConv!.id });
    await seedConversation(testDb.db, { projectId, widgetId: withConv!.id });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { widgets: list } = res.json();
    expect(list).toHaveLength(2);
    // Ordinati per createdAt asc: "Con conversazioni" prima.
    expect(list[0].name).toBe("Con conversazioni");
    expect(list[0].conversationCount).toBe(2);
    expect(list[0].key).toMatch(/^[0-9a-f]{32}$/);
    expect(list[1].name).toBe("Vuoto");
    expect(list[1].conversationCount).toBe(0);
  });
});

describe("POST /api/projects/:projectId/widgets", () => {
  it("da member (non admin): 403", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
      payload: upsertBody(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widgets",
      headers: { cookie: adminCookie },
      payload: upsertBody(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("solo name: widget coi default dello schema + key 32 hex, conversationCount 0", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: { name: "Solo nome" },
    });
    expect(res.statusCode).toBe(200);
    const { widget } = res.json();
    expect(widget).toMatchObject({
      name: "Solo nome",
      enabled: false,
      enabledRepositoryIds: [],
      title: "Assistenza",
      welcomeMessage: "Ciao! Come posso aiutarti?",
      accentColor: "#22c55e",
      language: "it",
      dailyMessageCap: null,
      dailyTicketCap: null,
      conversationCount: 0,
    });
    expect(widget.key).toMatch(/^[0-9a-f]{32}$/);
    expect(widget.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("config completa incl. cap: riflessa nel widget creato", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const payload = upsertBody({
      name: "Completo",
      enabled: true,
      enabledRepositoryIds: [repositoryId],
      title: "Supporto",
      welcomeMessage: "Benvenuto nel supporto!",
      accentColor: "#3366ff",
      language: "en",
      dailyMessageCap: 500,
      dailyTicketCap: 20,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().widget).toMatchObject({
      name: "Completo",
      enabled: true,
      enabledRepositoryIds: [repositoryId],
      title: "Supporto",
      welcomeMessage: "Benvenuto nel supporto!",
      accentColor: "#3366ff",
      language: "en",
      dailyMessageCap: 500,
      dailyTicketCap: 20,
    });
  });

  it("instructions: round-trip nel widget creato; default \"\" se omesse", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const withInstr = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({ name: "Istruito", instructions: "Sii sintetico e cita il piano Pro." }),
    });
    expect(withInstr.statusCode).toBe(200);
    expect(withInstr.json().widget).toMatchObject({
      name: "Istruito",
      instructions: "Sii sintetico e cita il piano Pro.",
    });

    // Omesse nel body → default "" dello schema.
    const withoutInstr = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({ name: "Muto" }),
    });
    expect(withoutInstr.statusCode).toBe(200);
    expect(withoutInstr.json().widget.instructions).toBe("");
  });

  it("più repo dello stesso progetto: 200", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondRepo = await seedRepositoryInProject(testDb.db, projectId);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({ enabledRepositoryIds: [repositoryId, secondRepo] }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("repositoryId di un ALTRO progetto: 422", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({ enabledRepositoryIds: [other.repositoryId] }),
    });
    expect(res.statusCode).toBe(422);
  });

  it("repositoryFilters per un repo abilitato → 200 e round-trip del filtro", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: { [repositoryId]: { paths: ["apps/webapp"], slugs: ["faq"] } },
      }),
    });
    expect(res.statusCode).toBe(200);
    // `kinds: []` è materializzato dal default dello schema anche se il body lo omette.
    expect(res.json().widget.repositoryFilters).toEqual({
      [repositoryId]: { paths: ["apps/webapp"], slugs: ["faq"], kinds: [] },
    });
  });

  it("repositoryFilters con kinds → 200 e round-trip del gruppo", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: {
          [repositoryId]: { paths: [], slugs: [], kinds: ["functional", "manual"] },
        },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().widget.repositoryFilters).toEqual({
      [repositoryId]: { paths: [], slugs: [], kinds: ["functional", "manual"] },
    });
  });

  it("repositoryFilters con chiave NON in enabledRepositoryIds → 422 invalid_repository_filter", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondRepo = await seedRepositoryInProject(testDb.db, projectId);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      // secondRepo è dello stesso progetto ma NON è tra gli abilitati.
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: { [secondRepo]: { paths: ["apps/webapp"], slugs: [] } },
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_repository_filter" });
  });

  it("riga LEGACY con entry {paths,slugs} SENZA kinds: GET lista serializza 200 e kinds []", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    // Insert diretto in DB nella forma vecchia del jsonb (nessun campo `kinds`),
    // come le righe già in prod salvate prima della feature.
    await testDb.db.insert(widgets).values({
      projectId,
      name: "Legacy",
      key: randomBytes(16).toString("hex"),
      enabledRepositoryIds: [repositoryId],
      repositoryFilters: { [repositoryId]: { paths: ["apps/webapp"], slugs: [] } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const legacy = res.json().widgets.find((w: { name: string }) => w.name === "Legacy");
    expect(legacy.repositoryFilters).toEqual({
      [repositoryId]: { paths: ["apps/webapp"], slugs: [], kinds: [] },
    });
  });

  it("repositoryFilters per un repo di un ALTRO progetto → 422 invalid_repository_filter", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: { [other.repositoryId]: { paths: ["apps/webapp"], slugs: [] } },
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_repository_filter" });
  });
});

describe("PUT /api/projects/:projectId/widgets/:widgetId", () => {
  /** Crea un widget via POST e ne restituisce l'id. */
  async function createWidget(projectId: string, name = "Base"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: { name },
    });
    return res.json().widget.id as string;
  }

  it("da member (non admin): 403", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: memberCookie },
      payload: upsertBody(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin: 200 e la GET riflette i valori aggiornati (config completa incl. cap)", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const payload = upsertBody({
      name: "Aggiornato",
      enabled: true,
      enabledRepositoryIds: [repositoryId],
      title: "Nuovo titolo",
      welcomeMessage: "Nuovo messaggio",
      instructions: "Dai priorità ai problemi di fatturazione.",
      accentColor: "#123456",
      language: "en",
      dailyMessageCap: 1000,
      dailyTicketCap: 50,
    });
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      payload,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().widget).toMatchObject({ id: widgetId, ...payload });

    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
    });
    const found = get.json().widgets.find((w: { id: string }) => w.id === widgetId);
    expect(found).toMatchObject(payload);
  });

  it("la key NON è modificabile dalla PUT", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const before = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
    });
    const originalKey = before.json().widgets[0].key as string;

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      // `key` nel body è ignorata (non è nello schema): la key resta invariata.
      payload: upsertBody({ name: "Rinominato", key: "0".repeat(32) }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().widget.key).toBe(originalKey);
  });

  it("repositoryId di un ALTRO progetto: 422", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      payload: upsertBody({ enabledRepositoryIds: [other.repositoryId] }),
    });
    expect(res.statusCode).toBe(422);
  });

  it("widget di un altro progetto: 404", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const widgetId = await createWidget(other.projectId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      payload: upsertBody(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("repositoryFilters per un repo abilitato → 200 e round-trip del filtro", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: { [repositoryId]: { paths: ["apps/webapp"], slugs: [] } },
      }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().widget.repositoryFilters).toEqual({
      [repositoryId]: { paths: ["apps/webapp"], slugs: [], kinds: [] },
    });

    // La GET riflette il filtro persistito.
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: memberCookie },
    });
    const found = get.json().widgets.find((w: { id: string }) => w.id === widgetId);
    expect(found.repositoryFilters).toEqual({
      [repositoryId]: { paths: ["apps/webapp"], slugs: [], kinds: [] },
    });
  });

  it("repositoryFilters con chiave NON in enabledRepositoryIds → 422 invalid_repository_filter", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondRepo = await seedRepositoryInProject(testDb.db, projectId);
    const widgetId = await createWidget(projectId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: { [secondRepo]: { paths: ["apps/webapp"], slugs: [] } },
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_repository_filter" });
  });

  it("repositoryFilters per un repo di un ALTRO progetto → 422 invalid_repository_filter", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
      payload: upsertBody({
        enabledRepositoryIds: [repositoryId],
        repositoryFilters: { [other.repositoryId]: { paths: ["apps/webapp"], slugs: [] } },
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_repository_filter" });
  });
});

describe("DELETE /api/projects/:projectId/widgets/:widgetId", () => {
  async function createWidget(projectId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/widgets`,
      headers: { cookie: adminCookie },
      payload: { name: "Da eliminare" },
    });
    return res.json().widget.id as string;
  }

  it("da member (non admin): 403", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("widget di un altro progetto: 404", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);
    const widgetId = await createWidget(other.projectId);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("admin: 204 e le conversazioni collegate hanno widgetId null (FK SET NULL)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const conversationId = await seedConversation(testDb.db, { projectId, widgetId });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/widgets/${widgetId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    // Il widget è sparito; la conversazione resta con widgetId null.
    const remaining = await testDb.db
      .select({ id: widgets.id })
      .from(widgets)
      .where(eq(widgets.id, widgetId));
    expect(remaining).toHaveLength(0);
    const [conv] = await testDb.db
      .select({ widgetId: widgetConversations.widgetId })
      .from(widgetConversations)
      .where(eq(widgetConversations.id, conversationId));
    expect(conv?.widgetId).toBeNull();
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
    widgetId?: string;
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
      widgetId: opts.widgetId ?? null,
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

  it("widgetId/widgetName: conversazioni di due widget diversi hanno il nome giusto", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const [wa] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget A", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    const [wb] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget B", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });

    const convA = await seedConversation(testDb.db, {
      projectId,
      widgetId: wa!.id,
      externalUserId: "user-a",
      lastMessageAt: new Date("2026-07-02T10:00:00Z"),
      messages: [{ role: "user", content: "ciao a" }],
    });
    const convB = await seedConversation(testDb.db, {
      projectId,
      widgetId: wb!.id,
      externalUserId: "user-b",
      lastMessageAt: new Date("2026-07-01T10:00:00Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(2);
    // Ordinate per lastMessageAt desc: convA (widget A) prima.
    expect(conversations[0].id).toBe(convA);
    expect(conversations[0].widgetId).toBe(wa!.id);
    expect(conversations[0].widgetName).toBe("Widget A");
    expect(conversations[0].messageCount).toBe(1);
    expect(conversations[1].id).toBe(convB);
    expect(conversations[1].widgetId).toBe(wb!.id);
    expect(conversations[1].widgetName).toBe("Widget B");
  });

  it("filtro widgetId: solo le conversazioni di quel widget", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const [wa] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget A", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    const [wb] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget B", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    const convA = await seedConversation(testDb.db, { projectId, widgetId: wa!.id });
    await seedConversation(testDb.db, { projectId, widgetId: wb!.id });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations?widgetId=${wa!.id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(convA);
    expect(conversations[0].widgetName).toBe("Widget A");
  });

  it("filtro widgetId inesistente: lista vuota", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const [wa] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget A", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    await seedConversation(testDb.db, { projectId, widgetId: wa!.id });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations?widgetId=00000000-0000-0000-0000-000000000000`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversations).toEqual([]);
  });

  it("conversazione orfana (widget eliminato): widgetId/widgetName null", async () => {
    const { projectId } = await seedRepository(testDb.db);
    // widgetId null simula una conversazione il cui widget è stato eliminato (SET NULL).
    const orphan = await seedConversation(testDb.db, { projectId, externalUserId: "orfana" });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(orphan);
    expect(conversations[0].widgetId).toBeNull();
    expect(conversations[0].widgetName).toBeNull();
  });

  it("filtro widgetId + ticketId combinati", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { ticketId } = await seedTicket(testDb.db, { projectId });
    const [wa] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget A", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    const [wb] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget B", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });

    // Conversazione target: widget A + messaggio con quel ticket.
    const target = await seedConversation(testDb.db, {
      projectId,
      widgetId: wa!.id,
      messages: [{ role: "assistant", content: "segnalato", ticketId }],
    });
    // Stesso ticket ma widget B: escluso dal filtro widgetId.
    await seedConversation(testDb.db, {
      projectId,
      widgetId: wb!.id,
      messages: [{ role: "assistant", content: "altro", ticketId }],
    });
    // Stesso widget A ma senza quel ticket: escluso dal filtro ticketId.
    await seedConversation(testDb.db, {
      projectId,
      widgetId: wa!.id,
      messages: [{ role: "user", content: "niente ticket" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations?widgetId=${wa!.id}&ticketId=${ticketId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const { conversations } = res.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(target);
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

  it("conversazione di un widget: widgetName nell'oggetto conversation", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const [wa] = await testDb.db
      .insert(widgets)
      .values({ projectId, name: "Widget Nome", key: randomBytes(16).toString("hex") })
      .returning({ id: widgets.id });
    const conversationId = await seedConversation(testDb.db, {
      projectId,
      widgetId: wa!.id,
      messages: [{ role: "user", content: "ciao" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations/${conversationId}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation).toMatchObject({
      id: conversationId,
      widgetName: "Widget Nome",
    });
  });

  it("conversazione orfana (widget eliminato): widgetName null nel dettaglio", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const conversationId = await seedConversation(testDb.db, { projectId });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget/conversations/${conversationId}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.widgetName).toBeNull();
  });
});
