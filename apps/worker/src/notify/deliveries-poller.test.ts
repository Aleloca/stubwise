import {
  notificationDeliveries,
  notificationSettings,
  notifications,
  users,
  type Db,
  type NotificationDelivery,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { NotificationEvent } from "@stubwise/notifications/format";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  processDeliveriesOnce,
  startDeliveriesPoller,
  type DeliveriesPollerDeps,
  type SendWebhookFn,
} from "./deliveries-poller.js";

/**
 * Test del poller dell'outbox (`notification_deliveries`) su un Postgres reale
 * (testcontainers, pattern di `backlog/chat-turn-poller.test.ts`): il claim usa
 * `FOR UPDATE SKIP LOCKED` e i CHECK di forma della riga vivono nel DB, quindi
 * un fake `Db` non direbbe granché. L'INVIO è invece iniettato (`sendWebhook`):
 * qui si verifica la macchina a stati della consegna, non il POST HTTP (coperto
 * dai test di `packages/notifications`).
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;

const silentLogger = { warn: () => {}, error: () => {} };

/** Evento di prova: qualunque `NotificationEvent` va bene, il poller lo rigira. */
function sampleEvent(title = "Ticket di prova"): NotificationEvent {
  return {
    kind: "ticket.created",
    ticketNumber: 1,
    ticketTitle: title,
    projectName: "P",
    source: "sdk_error",
    ticketUrl: "https://example.test/tickets/1",
  };
}

/** Consegna per-evento del canale webhook (nessuna notifica dietro). */
async function insertWebhookDelivery(
  opts: { attempts?: number; nextAttemptAt?: Date; title?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(notificationDeliveries)
    .values({
      channel: "webhook",
      event: sampleEvent(opts.title) as unknown as Record<string, unknown>,
      attempts: opts.attempts ?? 0,
      ...(opts.nextAttemptAt ? { nextAttemptAt: opts.nextAttemptAt } : {}),
    })
    .returning({ id: notificationDeliveries.id });
  return row!.id;
}

/** Consegna per-destinatario (canali Slack): serve una notifica in inbox. */
async function insertSlackDelivery(channel: "slack_dm" | "slack_update"): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: "hash", role: "admin" })
    .returning({ id: users.id });
  const [notification] = await db
    .insert(notifications)
    .values({
      userId: user!.id,
      kind: "ticket.created",
      event: sampleEvent() as unknown as Record<string, unknown>,
    })
    .returning({ id: notifications.id });
  const [row] = await db
    .insert(notificationDeliveries)
    .values({ channel, notificationId: notification!.id })
    .returning({ id: notificationDeliveries.id });
  return row!.id;
}

async function readDelivery(id: string): Promise<NotificationDelivery> {
  const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
  return row!;
}

function deps(sendWebhook: SendWebhookFn): DeliveriesPollerDeps {
  return { db, logger: silentLogger, sendWebhook };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

beforeEach(async () => {
  // Le consegne per-destinatario cascatano con l'utente; quelle webhook no.
  await db.delete(users);
  await db.delete(notificationDeliveries);
  // Webhook CONFIGURATO di default: il poller distingue "invio fallito" (retry)
  // da "webhook non più configurato" (skipped) guardando la config.
  await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.test/x" });
});

afterAll(async () => {
  await testDb.stop();
});

describe("processDeliveriesOnce", () => {
  it("invia una consegna webhook dovuta e la marca sent", async () => {
    const id = await insertWebhookDelivery({ title: "Da inviare" });
    const seen: NotificationEvent[] = [];
    const processed = await processDeliveriesOnce(
      deps(async (_db, event) => {
        seen.push(event);
      }),
    );

    expect(processed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "ticket.created", ticketTitle: "Da inviare" });

    const row = await readDelivery(id);
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("un invio fallito resta pending, incrementa i tentativi e rinvia di 30s", async () => {
    const id = await insertWebhookDelivery();
    const before = Date.now();
    const processed = await processDeliveriesOnce(
      deps(async () => {
        throw new Error("boom di rete");
      }),
    );

    expect(processed).toBe(1);
    const row = await readDelivery(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.error).toContain("boom di rete");
    expect(row.sentAt).toBeNull();
    // ≈ now + 30s (backoff del primo tentativo), con tolleranza generosa.
    const delayMs = row.nextAttemptAt.getTime() - before;
    expect(delayMs).toBeGreaterThan(20_000);
    expect(delayMs).toBeLessThan(45_000);
  });

  it("al quinto fallimento la consegna diventa failed", async () => {
    const id = await insertWebhookDelivery({ attempts: 4 });
    await processDeliveriesOnce(
      deps(async () => {
        throw new Error("ultimo tentativo");
      }),
    );

    const row = await readDelivery(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
    expect(row.error).toContain("ultimo tentativo");
  });

  it("due esecuzioni concorrenti non processano mai la stessa consegna", async () => {
    await insertWebhookDelivery({ title: "a" });
    await insertWebhookDelivery({ title: "b" });
    await insertWebhookDelivery({ title: "c" });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const slowSend: SendWebhookFn = async (_db, event) => {
      seen.push((event as { ticketTitle: string }).ticketTitle);
      await gate;
    };

    const both = Promise.all([
      processDeliveriesOnce(deps(slowSend)),
      processDeliveriesOnce(deps(slowSend)),
    ]);
    setTimeout(release, 200);
    const [first, second] = await both;

    expect(first + second).toBe(3);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    const rows = await db.select().from(notificationDeliveries);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it("i canali Slack sono ancora skipped (channel_not_implemented)", async () => {
    const dmId = await insertSlackDelivery("slack_dm");
    const updateId = await insertSlackDelivery("slack_update");
    let calls = 0;
    const processed = await processDeliveriesOnce(
      deps(async () => {
        calls += 1;
      }),
    );

    expect(processed).toBe(2);
    expect(calls).toBe(0);
    for (const id of [dmId, updateId]) {
      const row = await readDelivery(id);
      expect(row.status).toBe("skipped");
      expect(row.error).toBe("channel_not_implemented");
    }
  });

  it("webhook non più configurato: skipped senza ritentare", async () => {
    await db.update(notificationSettings).set({ webhookUrl: null });
    const id = await insertWebhookDelivery();

    await processDeliveriesOnce(
      deps(async () => {
        // Esattamente ciò che lancia sendWebhookEvent senza webhook configurato.
        throw new Error("Nessun webhook configurato.");
      }),
    );

    const row = await readDelivery(id);
    expect(row.status).toBe("skipped");
    expect(row.sentAt).toBeNull();
  });

  it("non reclama una consegna con next_attempt_at nel futuro", async () => {
    const id = await insertWebhookDelivery({ nextAttemptAt: new Date(Date.now() + 60_000) });
    let calls = 0;
    const processed = await processDeliveriesOnce(
      deps(async () => {
        calls += 1;
      }),
    );

    expect(processed).toBe(0);
    expect(calls).toBe(0);
    const row = await readDelivery(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });
});

describe("startDeliveriesPoller", () => {
  it("intervalSeconds ≤ 0 non avvia nulla", async () => {
    const id = await insertWebhookDelivery();
    let calls = 0;
    const controller = new AbortController();
    const stop = startDeliveriesPoller({
      db,
      logger: silentLogger,
      intervalSeconds: 0,
      signal: controller.signal,
      sendWebhook: async () => {
        calls += 1;
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    stop();
    controller.abort();

    expect(calls).toBe(0);
    const row = await readDelivery(id);
    expect(row.status).toBe("pending");
  });

  it("avviato, processa le consegne dovute a ogni tick", async () => {
    const id = await insertWebhookDelivery();
    let calls = 0;
    const controller = new AbortController();
    startDeliveriesPoller({
      db,
      logger: silentLogger,
      intervalSeconds: 1,
      signal: controller.signal,
      sendWebhook: async () => {
        calls += 1;
      },
    });

    // Un tick (1s) + margine per l'invio.
    await new Promise((r) => setTimeout(r, 1_800));
    controller.abort();

    expect(calls).toBe(1);
    const row = await readDelivery(id);
    expect(row.status).toBe("sent");
  });
});
