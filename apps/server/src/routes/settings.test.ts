import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { automationRules, notificationSettings } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function getAutomation(cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/api/settings/automation",
    headers: cookie ? { cookie } : {},
  });
}

function putAutomation(payload: Record<string, unknown>, cookie?: string) {
  return app.inject({
    method: "PUT",
    url: "/api/settings/automation",
    headers: cookie ? { cookie } : {},
    payload,
  });
}

interface Rule {
  type: string;
  autoFix: boolean;
  maxEffort: number;
}

describe("GET /api/settings/automation", () => {
  it("senza sessione: 401", async () => {
    expect((await getAutomation()).statusCode).toBe(401);
  });

  it("member: 403 (riservato agli admin)", async () => {
    expect((await getAutomation(users.memberCookie)).statusCode).toBe(403);
  });

  it("admin: restituisce le 4 regole con i default seedati", async () => {
    const res = await getAutomation(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules).toHaveLength(4);
    const byType = new Map(rules.map((r) => [r.type, r]));
    // Default di seed della migrazione.
    expect(byType.get("bug")).toEqual({ type: "bug", autoFix: true, maxEffort: 3 });
    expect(byType.get("task")).toEqual({ type: "task", autoFix: true, maxEffort: 2 });
    expect(byType.get("feature")).toEqual({ type: "feature", autoFix: false, maxEffort: 3 });
    expect(byType.get("feedback")).toEqual({ type: "feedback", autoFix: false, maxEffort: 3 });
  });

  it("admin: una riga mancante nel DB viene riempita con il default", async () => {
    // Rimuove la riga 'feedback': la GET deve comunque restituirne 4.
    await testDb.db.delete(automationRules).where(eq(automationRules.type, "feedback"));
    const res = await getAutomation(users.adminCookie);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules).toHaveLength(4);
    const feedback = rules.find((r) => r.type === "feedback");
    // Default difensivo: auto-fix true, max 3.
    expect(feedback).toEqual({ type: "feedback", autoFix: true, maxEffort: 3 });
  });
});

describe("PUT /api/settings/automation", () => {
  it("member: 403", async () => {
    const res = await putAutomation(
      { rules: [{ type: "bug", autoFix: false, maxEffort: 1 }] },
      users.memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("admin: upsert delle regole e ritorna lo stato aggiornato", async () => {
    const res = await putAutomation(
      {
        rules: [
          { type: "bug", autoFix: false, maxEffort: 5 },
          { type: "feature", autoFix: true, maxEffort: 4 },
        ],
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    const byType = new Map(rules.map((r) => [r.type, r]));
    expect(byType.get("bug")).toEqual({ type: "bug", autoFix: false, maxEffort: 5 });
    expect(byType.get("feature")).toEqual({ type: "feature", autoFix: true, maxEffort: 4 });

    // Persistito: una GET successiva riflette l'upsert.
    const after = (await getAutomation(users.adminCookie)).json() as { rules: Rule[] };
    expect(after.rules.find((r) => r.type === "bug")).toEqual({
      type: "bug",
      autoFix: false,
      maxEffort: 5,
    });
  });

  it("maxEffort fuori scala 1–5 → 400", async () => {
    expect(
      (
        await putAutomation(
          { rules: [{ type: "bug", autoFix: true, maxEffort: 6 }] },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await putAutomation(
          { rules: [{ type: "bug", autoFix: true, maxEffort: 0 }] },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("tipo fuori enum → 400", async () => {
    const res = await putAutomation(
      { rules: [{ type: "banana", autoFix: true, maxEffort: 3 }] },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });
});

// --- Notifiche ---

function getNotifications(cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/api/settings/notifications",
    headers: cookie ? { cookie } : {},
  });
}

function putNotifications(payload: Record<string, unknown>, cookie?: string) {
  return app.inject({
    method: "PUT",
    url: "/api/settings/notifications",
    headers: cookie ? { cookie } : {},
    payload,
  });
}

function testNotification(cookie?: string) {
  return app.inject({
    method: "POST",
    url: "/api/settings/notifications/test",
    headers: cookie ? { cookie } : {},
  });
}

interface NotificationSettings {
  webhookUrl: string | null;
  format: "slack" | "discord" | "generic";
  enabled: boolean;
  notifyTicketCreated: boolean;
  notifyPrOpened: boolean;
  notifyJobHeld: boolean;
  notifyJobFailed: boolean;
}

describe("GET /api/settings/notifications", () => {
  it("senza sessione: 401", async () => {
    expect((await getNotifications()).statusCode).toBe(401);
  });

  it("member: 403", async () => {
    expect((await getNotifications(users.memberCookie)).statusCode).toBe(403);
  });

  it("admin: restituisce la riga singleton seedata dalla migrazione", async () => {
    const res = await getNotifications(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as NotificationSettings;
    expect(body.webhookUrl).toBeNull();
    expect(body.format).toBe("slack");
    expect(body.enabled).toBe(true);
    expect(body.notifyTicketCreated).toBe(true);
    expect(body.notifyJobFailed).toBe(true);
  });
});

describe("PUT /api/settings/notifications", () => {
  it("member: 403", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/x",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("admin: upsert della riga singleton e persistenza", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.slack.com/services/abc",
        format: "discord",
        enabled: false,
        notifyTicketCreated: false,
        notifyPrOpened: true,
        notifyJobHeld: false,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as NotificationSettings;
    expect(body.webhookUrl).toBe("https://hooks.slack.com/services/abc");
    expect(body.format).toBe("discord");
    expect(body.enabled).toBe(false);
    expect(body.notifyTicketCreated).toBe(false);

    // Persistito: una sola riga (id=1) e la GET la riflette.
    const rows = await testDb.db.select().from(notificationSettings);
    expect(rows).toHaveLength(1);
    const after = (await getNotifications(users.adminCookie)).json() as NotificationSettings;
    expect(after.format).toBe("discord");
    expect(after.notifyJobHeld).toBe(false);
  });

  it("webhookUrl vuoto è ammesso (disattiva il webhook) e salvato come null", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettings).webhookUrl).toBeNull();
  });

  it("webhookUrl non-https → 400", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "http://hooks.example.com/x",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });

  it("format fuori enum → 400", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/x",
        format: "telegram",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/settings/notifications/test", () => {
  it("member: 403", async () => {
    expect((await testNotification(users.memberCookie)).statusCode).toBe(403);
  });

  it("admin: ok=true quando il POST al webhook riesce", async () => {
    await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/ok",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await testNotification(users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://hooks.example.com/ok");
  });

  it("admin: ok=false con dettaglio quando il POST fallisce", async () => {
    await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/bad",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await testNotification(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain("500");
  });

  it("admin: ok=false quando nessun webhook è configurato", async () => {
    await putNotifications(
      {
        webhookUrl: "",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    const res = await testNotification(users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(false);
  });
});
