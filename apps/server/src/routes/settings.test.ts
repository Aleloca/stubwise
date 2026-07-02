import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { automationRules, decrypt, instanceSettings, notificationSettings } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY,
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
  planApprovalMinEffort: number | null;
  maxCostUsd: number | null;
}

describe("GET /api/settings/automation", () => {
  it("senza sessione: 401", async () => {
    expect((await getAutomation()).statusCode).toBe(401);
  });

  it("member: 403 (riservato agli admin)", async () => {
    expect((await getAutomation(users.memberCookie)).statusCode).toBe(403);
  });

  it("admin: restituisce le 5 regole con i default seedati", async () => {
    const res = await getAutomation(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules).toHaveLength(5);
    const byType = new Map(rules.map((r) => [r.type, r]));
    // Default di seed della migrazione. planApprovalMinEffort null = mai.
    expect(byType.get("bug")).toEqual({
      type: "bug",
      autoFix: true,
      maxEffort: 3,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
    expect(byType.get("task")).toEqual({
      type: "task",
      autoFix: true,
      maxEffort: 2,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
    expect(byType.get("feature")).toEqual({
      type: "feature",
      autoFix: false,
      maxEffort: 3,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
    expect(byType.get("feedback")).toEqual({
      type: "feedback",
      autoFix: false,
      maxEffort: 3,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
    // Seed anti-loop dell'automazione PR Review: auto-fix SPENTO.
    expect(byType.get("review")).toEqual({
      type: "review",
      autoFix: false,
      maxEffort: 3,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
  });

  it("admin: una riga mancante nel DB viene riempita con il default", async () => {
    // Rimuove le righe 'feedback' e 'review': la GET deve comunque restituirne 5.
    await testDb.db.delete(automationRules).where(eq(automationRules.type, "feedback"));
    await testDb.db.delete(automationRules).where(eq(automationRules.type, "review"));
    const res = await getAutomation(users.adminCookie);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules).toHaveLength(5);
    const feedback = rules.find((r) => r.type === "feedback");
    // Default difensivo: auto-fix true, max 3, nessuna soglia di approvazione.
    expect(feedback).toEqual({
      type: "feedback",
      autoFix: true,
      maxEffort: 3,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
    // Per 'review' il fallback resta con auto-fix SPENTO (anti-loop, anche pre-seed).
    const review = rules.find((r) => r.type === "review");
    expect(review).toEqual({
      type: "review",
      autoFix: false,
      maxEffort: 3,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });
  });

  it("GET /automation include prReview (default: disabilitata, nessun cap)", async () => {
    const res = await getAutomation(users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().prReview).toEqual({ enabled: false, maxCostUsd: null });
  });
});

describe("PUT /api/settings/automation", () => {
  // prReview è obbligatoria nel body del PUT: default "spenta" per i test
  // che esercitano solo le rules.
  const PR_REVIEW_OFF = { enabled: false, maxCostUsd: null };

  it("member: 403", async () => {
    const res = await putAutomation(
      { rules: [{ type: "bug", autoFix: false, maxEffort: 1 }], prReview: PR_REVIEW_OFF },
      users.memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("admin: upsert delle regole e ritorna lo stato aggiornato", async () => {
    const res = await putAutomation(
      {
        rules: [
          { type: "bug", autoFix: false, maxEffort: 5, planApprovalMinEffort: 4, maxCostUsd: 1.5 },
          { type: "feature", autoFix: true, maxEffort: 4, planApprovalMinEffort: null },
        ],
        prReview: PR_REVIEW_OFF,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    const byType = new Map(rules.map((r) => [r.type, r]));
    expect(byType.get("bug")).toEqual({
      type: "bug",
      autoFix: false,
      maxEffort: 5,
      planApprovalMinEffort: 4,
      maxCostUsd: 1.5,
    });
    expect(byType.get("feature")).toEqual({
      type: "feature",
      autoFix: true,
      maxEffort: 4,
      planApprovalMinEffort: null,
      maxCostUsd: null,
    });

    // Persistito: una GET successiva riflette l'upsert, soglia e tetto inclusi.
    const after = (await getAutomation(users.adminCookie)).json() as { rules: Rule[] };
    expect(after.rules.find((r) => r.type === "bug")).toEqual({
      type: "bug",
      autoFix: false,
      maxEffort: 5,
      planApprovalMinEffort: 4,
      maxCostUsd: 1.5,
    });
  });

  it("maxCostUsd: round-trip number e null resta null", async () => {
    // Valore positivo per 'task', null esplicito per 'feature'.
    const res = await putAutomation(
      {
        rules: [
          { type: "task", autoFix: true, maxEffort: 2, maxCostUsd: 0.5 },
          { type: "feature", autoFix: true, maxEffort: 3, maxCostUsd: null },
        ],
        prReview: PR_REVIEW_OFF,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const after = (await getAutomation(users.adminCookie)).json() as { rules: Rule[] };
    const task = after.rules.find((r) => r.type === "task");
    const feature = after.rules.find((r) => r.type === "feature");
    expect(task?.maxCostUsd).toBe(0.5);
    expect(typeof task?.maxCostUsd).toBe("number");
    expect(feature?.maxCostUsd).toBeNull();
  });

  it("maxCostUsd negativo → 400", async () => {
    const res = await putAutomation(
      { rules: [{ type: "bug", autoFix: true, maxEffort: 3, maxCostUsd: -1 }], prReview: PR_REVIEW_OFF },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });

  it("maxCostUsd omesso → null (compatibilità client legacy)", async () => {
    const res = await putAutomation(
      { rules: [{ type: "bug", autoFix: true, maxEffort: 3 }], prReview: PR_REVIEW_OFF },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules.find((r) => r.type === "bug")?.maxCostUsd).toBeNull();
  });

  it("planApprovalMinEffort fuori scala 1–5 → 400", async () => {
    expect(
      (
        await putAutomation(
          {
            rules: [{ type: "bug", autoFix: true, maxEffort: 3, planApprovalMinEffort: 6 }],
            prReview: PR_REVIEW_OFF,
          },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await putAutomation(
          {
            rules: [{ type: "bug", autoFix: true, maxEffort: 3, planApprovalMinEffort: 0 }],
            prReview: PR_REVIEW_OFF,
          },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("planApprovalMinEffort omesso → trattato come null (compatibilità client legacy)", async () => {
    const res = await putAutomation(
      { rules: [{ type: "task", autoFix: true, maxEffort: 2 }], prReview: PR_REVIEW_OFF },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules.find((r) => r.type === "task")?.planApprovalMinEffort).toBeNull();
  });

  it("maxEffort fuori scala 1–5 → 400", async () => {
    expect(
      (
        await putAutomation(
          { rules: [{ type: "bug", autoFix: true, maxEffort: 6 }], prReview: PR_REVIEW_OFF },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await putAutomation(
          { rules: [{ type: "bug", autoFix: true, maxEffort: 0 }], prReview: PR_REVIEW_OFF },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("tipo fuori enum → 400", async () => {
    const res = await putAutomation(
      { rules: [{ type: "banana", autoFix: true, maxEffort: 3 }], prReview: PR_REVIEW_OFF },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });

  it("PUT /automation salva prReview e la restituisce", async () => {
    const current = (await getAutomation(users.adminCookie)).json() as { rules: Rule[] };
    const res = await putAutomation(
      { rules: current.rules, prReview: { enabled: true, maxCostUsd: 2.5 } },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().prReview).toEqual({ enabled: true, maxCostUsd: 2.5 });

    // Persistito: un GET successivo la rilegge dal singleton instance_settings.
    const after = await getAutomation(users.adminCookie);
    expect(after.json().prReview).toEqual({ enabled: true, maxCostUsd: 2.5 });
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
  notifyPrClosed: boolean;
  notifyJobHeld: boolean;
  notifyPlanReview: boolean;
  notifyBudgetHeld: boolean;
  notifyReviewCompleted: boolean;
  notifyDocsLimitPaused: boolean;
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
    expect(body.notifyPrClosed).toBe(true);
    expect(body.notifyPlanReview).toBe(true);
    expect(body.notifyBudgetHeld).toBe(true);
    expect(body.notifyReviewCompleted).toBe(true);
    expect(body.notifyDocsLimitPaused).toBe(true);
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
        notifyPrClosed: false,
        notifyJobHeld: false,
        notifyPlanReview: false,
        notifyBudgetHeld: false,
        notifyReviewCompleted: false,
        notifyDocsLimitPaused: false,
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
    expect(body.notifyPrClosed).toBe(false);
    expect(body.notifyPlanReview).toBe(false);
    expect(body.notifyBudgetHeld).toBe(false);
    expect(body.notifyReviewCompleted).toBe(false);
    expect(body.notifyDocsLimitPaused).toBe(false);

    // Persistito: una sola riga (id=1) e la GET la riflette.
    const rows = await testDb.db.select().from(notificationSettings);
    expect(rows).toHaveLength(1);
    const after = (await getNotifications(users.adminCookie)).json() as NotificationSettings;
    expect(after.format).toBe("discord");
    expect(after.notifyJobHeld).toBe(false);
    expect(after.notifyPrClosed).toBe(false);
    expect(after.notifyPlanReview).toBe(false);
    expect(after.notifyBudgetHeld).toBe(false);
    expect(after.notifyReviewCompleted).toBe(false);
    expect(after.notifyDocsLimitPaused).toBe(false);
  });

  it("admin: notifyPrClosed omesso → default true (compatibilità client legacy)", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/legacy",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        // notifyPrClosed volutamente assente: deve defaultare a true.
        notifyJobHeld: true,
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettings).notifyPrClosed).toBe(true);
  });

  it("admin: notifyPlanReview omesso → default true (compatibilità client legacy)", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/legacy-plan",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyPrClosed: true,
        notifyJobHeld: true,
        // notifyPlanReview volutamente assente: deve defaultare a true.
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettings).notifyPlanReview).toBe(true);
  });

  it("admin: notifyBudgetHeld omesso → default true (compatibilità client legacy)", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/legacy-budget",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyPrClosed: true,
        notifyJobHeld: true,
        notifyPlanReview: true,
        // notifyBudgetHeld volutamente assente: deve defaultare a true.
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettings).notifyBudgetHeld).toBe(true);
  });

  it("admin: notifyReviewCompleted omesso → default true (compatibilità client legacy)", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/legacy-review",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyPrClosed: true,
        notifyJobHeld: true,
        notifyPlanReview: true,
        notifyBudgetHeld: true,
        // notifyReviewCompleted volutamente assente: deve defaultare a true.
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettings).notifyReviewCompleted).toBe(true);
  });

  it("admin: notifyDocsLimitPaused omesso → default true (compatibilità client legacy)", async () => {
    const res = await putNotifications(
      {
        webhookUrl: "https://hooks.example.com/legacy-docs-limit",
        format: "slack",
        enabled: true,
        notifyTicketCreated: true,
        notifyPrOpened: true,
        notifyPrClosed: true,
        notifyJobHeld: true,
        notifyPlanReview: true,
        notifyBudgetHeld: true,
        notifyReviewCompleted: true,
        // notifyDocsLimitPaused volutamente assente: deve defaultare a true.
        notifyJobFailed: true,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationSettings).notifyDocsLimitPaused).toBe(true);
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

// --- Impostazioni d'istanza: lingua dei contenuti ---

function getInstance(cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/api/settings/instance",
    headers: cookie ? { cookie } : {},
  });
}

function putInstance(payload: Record<string, unknown>, cookie?: string) {
  return app.inject({
    method: "PUT",
    url: "/api/settings/instance",
    headers: cookie ? { cookie } : {},
    payload,
  });
}

describe("GET /api/settings/instance", () => {
  it("senza sessione: 401", async () => {
    expect((await getInstance()).statusCode).toBe(401);
  });

  it("member: 403", async () => {
    expect((await getInstance(users.memberCookie)).statusCode).toBe(403);
  });

  it("admin: restituisce la riga singleton seedata (default 'en', monthlyBudgetUsd null)", async () => {
    const res = await getInstance(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contentLanguage: string; monthlyBudgetUsd: number | null };
    expect(body.contentLanguage).toBe("en");
    expect(body.monthlyBudgetUsd).toBeNull();
  });
});

describe("PUT /api/settings/instance", () => {
  it("member: 403", async () => {
    const res = await putInstance({ contentLanguage: "it" }, users.memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("admin: upsert della riga singleton e persistenza", async () => {
    const res = await putInstance(
      { contentLanguage: "it", monthlyBudgetUsd: 100 },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contentLanguage: string; monthlyBudgetUsd: number | null };
    expect(body.contentLanguage).toBe("it");
    expect(body.monthlyBudgetUsd).toBe(100);

    // Persistito: una sola riga (id=1) e la GET la riflette.
    const rows = await testDb.db.select().from(instanceSettings);
    expect(rows).toHaveLength(1);
    expect((await getInstance(users.adminCookie)).json()).toEqual({
      contentLanguage: "it",
      monthlyBudgetUsd: 100,
      s3Endpoint: null,
      s3Region: null,
      s3Bucket: null,
      s3AccessKey: null,
      s3SecretKeySet: false,
      attachmentsEnabled: false,
      slackSigningSecretSet: false,
      slackBotTokenSet: false,
      slackEnabled: false,
    });

    // Ripristina il default per non sporcare gli altri test.
    await putInstance({ contentLanguage: "en", monthlyBudgetUsd: null }, users.adminCookie);
  });

  it("monthlyBudgetUsd: round-trip number (type number) e null lo azzera", async () => {
    const set = await putInstance(
      { contentLanguage: "en", monthlyBudgetUsd: 250.75 },
      users.adminCookie,
    );
    expect(set.statusCode).toBe(200);
    const setBody = (await getInstance(users.adminCookie)).json() as {
      monthlyBudgetUsd: number | null;
    };
    expect(setBody.monthlyBudgetUsd).toBe(250.75);
    expect(typeof setBody.monthlyBudgetUsd).toBe("number");

    // null azzera il tetto.
    await putInstance({ contentLanguage: "en", monthlyBudgetUsd: null }, users.adminCookie);
    expect(
      (
        (await getInstance(users.adminCookie)).json() as { monthlyBudgetUsd: number | null }
      ).monthlyBudgetUsd,
    ).toBeNull();
  });

  it("monthlyBudgetUsd omesso → null (compatibilità client legacy)", async () => {
    const res = await putInstance({ contentLanguage: "en" }, users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { monthlyBudgetUsd: number | null }).monthlyBudgetUsd).toBeNull();
  });

  it("monthlyBudgetUsd negativo → 400", async () => {
    const res = await putInstance(
      { contentLanguage: "en", monthlyBudgetUsd: -5 },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });

  it("lingua fuori enum → 400", async () => {
    const res = await putInstance({ contentLanguage: "fr" }, users.adminCookie);
    expect(res.statusCode).toBe(400);
  });
});

// --- Impostazioni d'istanza: storage S3 ---

interface InstanceS3 {
  contentLanguage: string;
  monthlyBudgetUsd: number | null;
  s3Endpoint: string | null;
  s3Region: string | null;
  s3Bucket: string | null;
  s3AccessKey: string | null;
  s3SecretKeySet: boolean;
  attachmentsEnabled: boolean;
}

const FULL_S3 = {
  contentLanguage: "en",
  s3Endpoint: "https://s3.example.com",
  s3Region: "eu-central",
  s3Bucket: "my-bucket",
  s3AccessKey: "AKIA",
  s3SecretKey: "super-secret",
} as const;

describe("GET /api/settings/instance — storage S3", () => {
  it("admin: di default i campi S3 sono null/false (storage non configurato)", async () => {
    // Ripristina lo stato pulito (azzera ogni residuo S3 dei test precedenti).
    await putInstance(
      {
        contentLanguage: "en",
        s3Endpoint: "",
        s3Region: "",
        s3Bucket: "",
        s3AccessKey: "",
        s3SecretKey: "",
      },
      users.adminCookie,
    );
    const body = (await getInstance(users.adminCookie)).json() as InstanceS3;
    expect(body.s3Endpoint).toBeNull();
    expect(body.s3Region).toBeNull();
    expect(body.s3Bucket).toBeNull();
    expect(body.s3AccessKey).toBeNull();
    expect(body.s3SecretKeySet).toBe(false);
    expect(body.attachmentsEnabled).toBe(false);
  });
});

describe("PUT /api/settings/instance — storage S3", () => {
  it("member: 403 anche sui campi S3", async () => {
    const res = await putInstance({ ...FULL_S3 }, users.memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("admin: salva i campi S3, cifra la secret, non la espone e abilita gli allegati", async () => {
    const res = await putInstance({ ...FULL_S3 }, users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceS3;
    expect(body.s3Endpoint).toBe("https://s3.example.com");
    expect(body.s3Region).toBe("eu-central");
    expect(body.s3Bucket).toBe("my-bucket");
    expect(body.s3AccessKey).toBe("AKIA");
    expect(body.s3SecretKeySet).toBe(true);
    expect(body.attachmentsEnabled).toBe(true);
    // La secret non deve MAI comparire in nessuna forma nel JSON.
    expect(JSON.stringify(body)).not.toContain("super-secret");
    expect((body as unknown as Record<string, unknown>).s3SecretKey).toBeUndefined();
    expect((body as unknown as Record<string, unknown>).s3SecretKeyEncrypted).toBeUndefined();

    // Persistito: la colonna è cifrata (≠ plaintext) e decifra al plaintext.
    const [row] = await testDb.db.select().from(instanceSettings);
    expect(row?.s3SecretKeyEncrypted).toBeTruthy();
    expect(row?.s3SecretKeyEncrypted).not.toBe("super-secret");
    expect(decrypt(row!.s3SecretKeyEncrypted!, Buffer.from(ENCRYPTION_KEY, "base64"))).toBe(
      "super-secret",
    );
  });

  it("admin: PUT senza s3SecretKey NON sovrascrive la secret esistente", async () => {
    await putInstance({ ...FULL_S3 }, users.adminCookie);
    const [before] = await testDb.db.select().from(instanceSettings);
    // Cambia solo il bucket, omette s3SecretKey.
    const res = await putInstance(
      {
        contentLanguage: "en",
        s3Endpoint: FULL_S3.s3Endpoint,
        s3Region: FULL_S3.s3Region,
        s3Bucket: "other-bucket",
        s3AccessKey: FULL_S3.s3AccessKey,
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceS3;
    expect(body.s3Bucket).toBe("other-bucket");
    expect(body.s3SecretKeySet).toBe(true);
    expect(body.attachmentsEnabled).toBe(true);
    const [after] = await testDb.db.select().from(instanceSettings);
    expect(after?.s3SecretKeyEncrypted).toBe(before?.s3SecretKeyEncrypted);
  });

  it("admin: PUT con s3SecretKey:'' azzera la secret e disabilita gli allegati", async () => {
    await putInstance({ ...FULL_S3 }, users.adminCookie);
    const res = await putInstance(
      {
        contentLanguage: "en",
        s3Endpoint: FULL_S3.s3Endpoint,
        s3Region: FULL_S3.s3Region,
        s3Bucket: FULL_S3.s3Bucket,
        s3AccessKey: FULL_S3.s3AccessKey,
        s3SecretKey: "",
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceS3;
    expect(body.s3SecretKeySet).toBe(false);
    expect(body.attachmentsEnabled).toBe(false);
    const [row] = await testDb.db.select().from(instanceSettings);
    expect(row?.s3SecretKeyEncrypted).toBeNull();
  });

  it("admin: stringa vuota su un campo non-secret lo azzera (null)", async () => {
    await putInstance({ ...FULL_S3 }, users.adminCookie);
    const res = await putInstance(
      {
        contentLanguage: "en",
        s3Endpoint: "",
        s3Region: "",
        s3Bucket: "",
        s3AccessKey: "",
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceS3;
    expect(body.s3Endpoint).toBeNull();
    expect(body.s3Region).toBeNull();
    expect(body.s3Bucket).toBeNull();
    expect(body.s3AccessKey).toBeNull();
    // Secret ancora presente (non toccata) ma config incompleta → disabilitata.
    expect(body.s3SecretKeySet).toBe(true);
    expect(body.attachmentsEnabled).toBe(false);
  });

  it("admin: attachmentsEnabled è true solo con config completa", async () => {
    // Manca il bucket → false.
    const partial = await putInstance(
      {
        contentLanguage: "en",
        s3Endpoint: FULL_S3.s3Endpoint,
        s3Region: FULL_S3.s3Region,
        s3Bucket: "",
        s3AccessKey: FULL_S3.s3AccessKey,
        s3SecretKey: "secret",
      },
      users.adminCookie,
    );
    expect((partial.json() as InstanceS3).attachmentsEnabled).toBe(false);

    // Config completa → true.
    const full = await putInstance({ ...FULL_S3 }, users.adminCookie);
    expect((full.json() as InstanceS3).attachmentsEnabled).toBe(true);
  });

  it("admin: non altera i campi esistenti (contentLanguage/monthlyBudgetUsd)", async () => {
    await putInstance(
      { contentLanguage: "it", monthlyBudgetUsd: 42, ...stripLanguage(FULL_S3) },
      users.adminCookie,
    );
    const body = (await getInstance(users.adminCookie)).json() as InstanceS3;
    expect(body.contentLanguage).toBe("it");
    expect(body.monthlyBudgetUsd).toBe(42);
    expect(body.s3SecretKeySet).toBe(true);
    // Ripristina i default per non sporcare gli altri test.
    await putInstance(
      {
        contentLanguage: "en",
        monthlyBudgetUsd: null,
        s3Endpoint: "",
        s3Region: "",
        s3Bucket: "",
        s3AccessKey: "",
        s3SecretKey: "",
      },
      users.adminCookie,
    );
  });
});

/** I campi S3 di FULL_S3 senza contentLanguage (per i casi che lo impostano a parte). */
function stripLanguage(full: typeof FULL_S3) {
  return {
    s3Endpoint: full.s3Endpoint,
    s3Region: full.s3Region,
    s3Bucket: full.s3Bucket,
    s3AccessKey: full.s3AccessKey,
    s3SecretKey: full.s3SecretKey,
  };
}

// --- Impostazioni d'istanza: credenziali Slack ---

interface InstanceSlack {
  slackSigningSecretSet: boolean;
  slackBotTokenSet: boolean;
  slackEnabled: boolean;
}

describe("PUT /api/settings/instance — credenziali Slack", () => {
  it("member: 403 anche sui campi Slack", async () => {
    const res = await putInstance(
      { contentLanguage: "en", slackSigningSecret: "sig", slackBotToken: "tok" },
      users.memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("admin: salva entrambi i segreti cifrati, non li espone e abilita Slack", async () => {
    const res = await putInstance(
      { contentLanguage: "en", slackSigningSecret: "my-signing-secret", slackBotToken: "xoxb-token" },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceSlack;
    expect(body.slackSigningSecretSet).toBe(true);
    expect(body.slackBotTokenSet).toBe(true);
    expect(body.slackEnabled).toBe(true);
    // I segreti non devono MAI comparire in nessuna forma nel JSON.
    expect(JSON.stringify(body)).not.toContain("my-signing-secret");
    expect(JSON.stringify(body)).not.toContain("xoxb-token");
    expect((body as unknown as Record<string, unknown>).slackSigningSecret).toBeUndefined();
    expect((body as unknown as Record<string, unknown>).slackBotToken).toBeUndefined();

    // Persistito: le colonne sono cifrate (≠ plaintext) e decifrano al plaintext.
    const [row] = await testDb.db.select().from(instanceSettings);
    expect(row?.slackSigningSecretEncrypted).toBeTruthy();
    expect(row?.slackSigningSecretEncrypted).not.toBe("my-signing-secret");
    expect(row?.slackBotTokenEncrypted).not.toBe("xoxb-token");
    expect(
      decrypt(row!.slackSigningSecretEncrypted!, Buffer.from(ENCRYPTION_KEY, "base64")),
    ).toBe("my-signing-secret");
    expect(decrypt(row!.slackBotTokenEncrypted!, Buffer.from(ENCRYPTION_KEY, "base64"))).toBe(
      "xoxb-token",
    );

    // Ripristina lo stato pulito per non sporcare gli altri test.
    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "", slackBotToken: "" },
      users.adminCookie,
    );
  });

  it("admin: solo uno dei due segreti → slackEnabled false finché manca l'altro", async () => {
    // Pulisce eventuali residui.
    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "", slackBotToken: "" },
      users.adminCookie,
    );
    const res = await putInstance(
      { contentLanguage: "en", slackSigningSecret: "only-signing" },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceSlack;
    expect(body.slackSigningSecretSet).toBe(true);
    expect(body.slackBotTokenSet).toBe(false);
    expect(body.slackEnabled).toBe(false);

    // Aggiunge il bot token → ora abilitato.
    const full = await putInstance(
      { contentLanguage: "en", slackBotToken: "now-the-token" },
      users.adminCookie,
    );
    expect((full.json() as InstanceSlack).slackEnabled).toBe(true);

    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "", slackBotToken: "" },
      users.adminCookie,
    );
  });

  it("admin: PUT senza i campi Slack NON sovrascrive i segreti esistenti", async () => {
    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "keep-sig", slackBotToken: "keep-tok" },
      users.adminCookie,
    );
    const [before] = await testDb.db.select().from(instanceSettings);
    // PUT che tocca solo contentLanguage, omette i campi Slack.
    const res = await putInstance({ contentLanguage: "it" }, users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as InstanceSlack).slackEnabled).toBe(true);
    const [after] = await testDb.db.select().from(instanceSettings);
    expect(after?.slackSigningSecretEncrypted).toBe(before?.slackSigningSecretEncrypted);
    expect(after?.slackBotTokenEncrypted).toBe(before?.slackBotTokenEncrypted);

    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "", slackBotToken: "" },
      users.adminCookie,
    );
  });

  it("admin: stringa vuota '' azzera il segreto e disabilita Slack", async () => {
    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "sig", slackBotToken: "tok" },
      users.adminCookie,
    );
    const res = await putInstance(
      { contentLanguage: "en", slackSigningSecret: "" },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceSlack;
    expect(body.slackSigningSecretSet).toBe(false);
    expect(body.slackBotTokenSet).toBe(true);
    expect(body.slackEnabled).toBe(false);
    const [row] = await testDb.db.select().from(instanceSettings);
    expect(row?.slackSigningSecretEncrypted).toBeNull();

    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "", slackBotToken: "" },
      users.adminCookie,
    );
  });
});

describe("GET /api/settings/instance — credenziali Slack", () => {
  it("admin: non espone mai i segreti, solo i flag *Set + slackEnabled", async () => {
    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "secret-sig", slackBotToken: "secret-tok" },
      users.adminCookie,
    );
    const res = await getInstance(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceSlack;
    expect(body.slackSigningSecretSet).toBe(true);
    expect(body.slackBotTokenSet).toBe(true);
    expect(body.slackEnabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-sig");
    expect(JSON.stringify(body)).not.toContain("secret-tok");

    await putInstance(
      { contentLanguage: "en", slackSigningSecret: "", slackBotToken: "" },
      users.adminCookie,
    );
  });
});
