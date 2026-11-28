import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { widgetConversations, widgetMessages, widgets } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import {
  seedRepository as seedRepositoryRaw,
  seedRepositoryInProject,
  startTestDb,
} from "@stubwise/db/testing";
import { seedUsers, addMember } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/**
 * Come `seedRepository`, e il member del file diventa Legacy Member del
 * progetto (quello che ogni `member` ha dopo la conversione): un progetto di
 * cui non è membro gli risponderebbe 404.
 */
async function seedRepository(db: TestDb["db"]) {
  const seeded = await seedRepositoryRaw(db);
  await addMember(app, seeded.projectId, memberId);
  return seeded;
}

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
    // Area 8, F3: `canManage` dice se chi guarda può gestirli (il Legacy Member no).
    expect(res.json()).toEqual({ widgets: [], canManage: false });
  });

  it("area 8, F3: `canManage` vero per chi ha widget.manage (il full admin)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/widgets`, headers: { cookie: adminCookie } });
    expect(res.json()).toMatchObject({ canManage: true });
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

  it("area 8, F3, S16: i siti ammessi — vuoti alla creazione, normalizzati; una PUT senza `origins` non li tocca, con [] li svuota; uno storto 400", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const widgetId = await createWidget(projectId);
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: "PUT", url: `/api/projects/${projectId}/widgets/${widgetId}`, headers: { cookie: adminCookie }, payload });
    const list = async () =>
      (await app.inject({ method: "GET", url: `/api/projects/${projectId}/widgets`, headers: { cookie: memberCookie } })).json().widgets.find((w: { id: string }) => w.id === widgetId);
    expect((await list()).origins).toEqual([]);
    const set = await put(upsertBody({ origins: ["https://Shop.example.com/", "https://shop.example.com"] }));
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().widget.origins).toEqual(["https://shop.example.com"]);
    // Un client che non conosce `origins` (la web di oggi) non li azzera.
    expect((await put(upsertBody({ name: "Senza origins" }))).statusCode).toBe(200);
    expect((await list()).origins).toEqual(["https://shop.example.com"]);
    expect((await put(upsertBody({ origins: ["https://shop.example.com/negozio"] }))).statusCode).toBe(400);
    expect((await list()).origins).toEqual(["https://shop.example.com"]);
    expect((await put(upsertBody({ origins: [] }))).json().widget.origins).toEqual([]);
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
