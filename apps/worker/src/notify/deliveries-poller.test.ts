import {
  aiJobs,
  deviceTokens,
  notificationDeliveries,
  notificationSettings,
  notifications,
  outgoingWebhooks,
  encrypt,
  projectMembers,
  roles,
  tickets,
  users,
  type Db,
  type NotificationDelivery,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  PushRelayRejected,
  PushRelayUnavailable,
  type NotificationEvent,
  type PushRelayClient,
} from "@stubwise/notifications";
import type {
  PushPayload,
  PushRelaySendResponse,
  PushRelayToken,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  processDeliveriesOnce,
  PUSH_RELAY_TIMEOUT_MS,
  startDeliveriesPoller,
  type DeliveriesLogger,
  type DeliveriesPollerDeps,
  type SendWebhookFn,
} from "./deliveries-poller.js";

/**
 * Test del poller dell'outbox (`notification_deliveries`) su un Postgres reale
 * (testcontainers, pattern di `backlog/poller.test.ts`): il claim usa
 * `FOR UPDATE SKIP LOCKED` e i CHECK di forma della riga vivono nel DB, quindi
 * un fake `Db` non direbbe granché. L'INVIO è invece iniettato (`sendWebhook`):
 * qui si verifica la macchina a stati della consegna, non il POST HTTP (coperto
 * dai test di `packages/notifications`).
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;
let projectId: string;

/** Chiave di cifratura fittizia: nei test il bot token è iniettato, non decifrato. */
const encryptionKey = Buffer.alloc(32);

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

interface SlackDeliveryOpts {
  /** Ruolo d'istanza del destinatario (`admin` = full admin). */
  role?: "admin" | "member";
  /**
   * Ruolo di progetto (chiave del preset) del destinatario nel progetto di
   * test, a cui la notifica è ancorata: decide le azioni offerte dai bottoni.
   * Default `legacy_member`; `null` = non membro.
   */
  projectRole?: string | null;
  /** `false` = card vecchia con `project_id` NULL (R34): il progetto è quello del ticket. */
  cardWithProject?: boolean;
  language?: "en" | "it";
  event?: NotificationEvent;
  /** Se dato, ancora la notifica a un ticket con un job in questo stato. */
  jobStatus?: "queued" | "awaiting_plan_approval" | "awaiting_input";
  /** Payload della riga (usato dal canale `slack_update`: `{ note }`). */
  deliveryEvent?: Record<string, unknown>;
  status?: "pending" | "sent";
}

/** Consegna per-destinatario (canali Slack): serve una notifica in inbox. */
async function insertSlackDelivery(
  channel: "slack_dm" | "slack_update",
  opts: SlackDeliveryOpts = {},
): Promise<{ deliveryId: string; notificationId: string; userId: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      passwordHash: "hash",
      role: opts.role ?? "admin",
      language: opts.language ?? "it",
    })
    .returning({ id: users.id });

  let ticketId: string | null = null;
  if (opts.jobStatus) {
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: Math.floor(Math.random() * 1_000_000),
        title: "Ticket di prova",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning({ id: tickets.id });
    ticketId = ticket!.id;
    await db.insert(aiJobs).values({ ticketId, status: opts.jobStatus });
  }
  const projectRole = opts.projectRole === undefined ? "legacy_member" : opts.projectRole;
  if (projectRole !== null) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, projectRole));
    await db.insert(projectMembers).values({ projectId, userId: user!.id, roleId: role!.id });
  }

  const [notification] = await db
    .insert(notifications)
    .values({
      userId: user!.id,
      // Ancorata al progetto di test: i bottoni dipendono dai permessi del
      // destinatario lì.
      projectId: opts.cardWithProject === false ? null : projectId,
      ticketId,
      kind: (opts.event ?? sampleEvent()).kind,
      event: (opts.event ?? sampleEvent()) as unknown as Record<string, unknown>,
    })
    .returning({ id: notifications.id });
  const [row] = await db
    .insert(notificationDeliveries)
    .values({
      channel,
      notificationId: notification!.id,
      ...(opts.deliveryEvent ? { event: opts.deliveryEvent } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning({ id: notificationDeliveries.id });
  return { deliveryId: row!.id, notificationId: notification!.id, userId: user!.id };
}

async function readDelivery(id: string): Promise<NotificationDelivery> {
  const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
  return row!;
}

function deps(sendWebhook: SendWebhookFn, logger: DeliveriesLogger = silentLogger): DeliveriesPollerDeps {
  return { db, logger, encryptionKey, sendWebhook };
}

/** Logger che raccoglie le chiamate, per asserire sugli esiti terminali loggati. */
function collectingLogger(): DeliveriesLogger & { warns: { obj: unknown; msg?: string }[] } {
  const warns: { obj: unknown; msg?: string }[] = [];
  return {
    warns,
    warn: (obj: unknown, msg?: string) => {
      warns.push({ obj, msg });
    },
    error: () => {},
  };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
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

  it("al quinto fallimento la consegna diventa failed e l'esito finisce nei log", async () => {
    const id = await insertWebhookDelivery({ attempts: 4 });
    const logger = collectingLogger();
    await processDeliveriesOnce(
      deps(async () => {
        throw new Error("ultimo tentativo");
      }, logger),
    );

    const row = await readDelivery(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
    expect(row.error).toContain("ultimo tentativo");

    // Una notifica persa per sempre non deve restare solo nella colonna `error`.
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]!.msg).toContain("MAX_ATTEMPTS");
    expect(logger.warns[0]!.obj).toMatchObject({
      deliveryId: id,
      channel: "webhook",
      attempts: 5,
      error: expect.stringContaining("ultimo tentativo") as unknown as string,
    });
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

  it("webhook non più configurato: skipped senza ritentare", async () => {
    await db.update(notificationSettings).set({ webhookUrl: null });
    const id = await insertWebhookDelivery();

    const logger = collectingLogger();
    await processDeliveriesOnce(
      deps(async () => {
        // Esattamente ciò che lancia sendWebhookEvent senza webhook configurato.
        throw new Error("Nessun webhook configurato.");
      }, logger),
    );

    const row = await readDelivery(id);
    expect(row.status).toBe("skipped");
    expect(row.sentAt).toBeNull();
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]!.msg).toContain("webhook non configurato");
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

describe("canali Slack, dopo il ritiro (R2)", () => {
  it.each(["slack_dm", "slack_update"] as const)(
    "una consegna %s rimasta in coda si chiude skipped, senza invio e senza ritentare",
    async (channel) => {
      const { deliveryId } = await insertSlackDelivery(channel);
      await processDeliveriesOnce(deps(async () => {
        throw new Error("nessun invio");
      }));
      const row = await readDelivery(deliveryId);
      expect(row.status).toBe("skipped");
      expect(row.error).toBe("channel_not_implemented");
    },
  );
});

describe("webhook in uscita (area 9, F3)", () => {
  async function hook(opts: { url: string; secret?: string; enabled?: boolean; format?: "slack" | "discord" | "generic" }) {
    const [row] = await db
      .insert(outgoingWebhooks)
      .values({
        name: `W ${randomUUID().slice(0, 4)}`,
        url: opts.url,
        format: opts.format ?? "generic",
        events: ["ticket.created"],
        enabled: opts.enabled ?? true,
        secretEncrypted: opts.secret ? encrypt(opts.secret, encryptionKey) : null,
      })
      .returning({ id: outgoingWebhooks.id });
    return row!.id;
  }
  async function deliveryFor(webhookId: string) {
    const [row] = await db
      .insert(notificationDeliveries)
      .values({ channel: "webhook", event: sampleEvent("Per webhook") as unknown as Record<string, unknown>, webhookId })
      .returning({ id: notificationDeliveries.id });
    return row!.id;
  }

  it("ogni consegna parte verso il SUO webhook, firmata col suo segreto; uno che fallisce non ferma l'altro", async () => {
    const good = await hook({ url: "https://good.example.test/in", secret: "segreto-buono" });
    const bad = await hook({ url: "https://bad.example.test/in", secret: "segreto-altro" });
    const goodId = await deliveryFor(good);
    const badId = await deliveryFor(bad);
    const seen: { url: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      return new Response(null, { status: url.includes("bad") ? 500 : 200 });
    });
    try {
      const legacy = vi.fn(async () => {});
      await processDeliveriesOnce(deps(legacy));
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await readDelivery(goodId)).status).toBe("sent");
    const failed = await readDelivery(badId);
    expect(failed.status).toBe("pending");
    expect(failed.attempts).toBe(1);
    const sent = seen.find((s) => s.url.includes("good"))!;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sent.headers.get("x-stubwise-signature")!)!;
    expect(createHmac("sha256", "segreto-buono").update(`${t}.${sent.body}`).digest("hex")).toBe(v1);
    await db.delete(outgoingWebhooks);
  });

  it("review F3: un segreto che non si decifra NON lascia la consegna pending per sempre — ritenta, e al tetto è failed", async () => {
    const id0 = await hook({ url: "https://broken.example.test/in" });
    await db.update(outgoingWebhooks).set({ secretEncrypted: "non-decifrabile" }).where(eq(outgoingWebhooks.id, id0));
    const [d] = await db
      .insert(notificationDeliveries)
      .values({ channel: "webhook", event: sampleEvent("Rotto") as unknown as Record<string, unknown>, webhookId: id0, attempts: 4 })
      .returning({ id: notificationDeliveries.id });
    await processDeliveriesOnce(deps(async () => {}));
    const row = await readDelivery(d!.id);
    expect(row.status).toBe("failed");
    expect(row.error).not.toBeNull();
    await db.delete(outgoingWebhooks);
  });

  it("rimandi, lotto 4: un webhook che nel frattempo ha TOLTO l'evento — la consegna già in coda si chiude `skipped` senza invio", async () => {
    const id0 = await hook({ url: "https://changed.example.test/in" });
    const id = await deliveryFor(id0);
    await db.update(outgoingWebhooks).set({ events: ["job.failed"] }).where(eq(outgoingWebhooks.id, id0));
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await processDeliveriesOnce(deps(async () => {}));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readDelivery(id)).toMatchObject({ status: "skipped", error: "event_not_selected" });
    await db.delete(outgoingWebhooks);
  });

  it("un webhook spento nel frattempo: la consegna si chiude senza invio", async () => {
    const off = await hook({ url: "https://off.example.test/in", enabled: false });
    const id = await deliveryFor(off);
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await processDeliveriesOnce(deps(async () => {}));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readDelivery(id)).toMatchObject({ status: "skipped", error: "webhook_disabled" });
    await db.delete(outgoingWebhooks);
  });
});

// --- canale push (fase 4) --------------------------------------------------

interface PushDeliveryOpts {
  language?: "en" | "it";
  /** Device del destinatario. Default: un solo iOS attivo. */
  devices?: { platform: "ios" | "android"; token: string; disabled?: boolean }[];
  event?: NotificationEvent;
  /** Notifiche APERTE in più nell'inbox del destinatario: alimentano il badge. */
  extraOpen?: number;
  /** Se false la notifica non ha progetto (niente `threadId` nel payload). */
  withProject?: boolean;
  /** Tentativi già bruciati sulla riga: serve a raggiungere MAX_ATTEMPTS. */
  attempts?: number;
  /** Se false il destinatario NON è membro del progetto (uscito dopo la publish). */
  member?: boolean;
  /** Il `event` della CONSEGNA (registro, A4 r.169: il gruppo di una menzione di gruppo). */
  deliveryEvent?: Record<string, unknown>;
}

interface PushDeliverySeed {
  deliveryId: string;
  notificationId: string;
  userId: string;
  /** Id dei device NELLO STESSO ORDINE di `opts.devices`. */
  deviceIds: string[];
  tokens: string[];
}

/** Consegna push: un destinatario, i suoi device e la notifica in inbox. */
async function insertPushDelivery(opts: PushDeliveryOpts = {}): Promise<PushDeliverySeed> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      passwordHash: "hash",
      role: "member",
      language: opts.language ?? "it",
    })
    .returning({ id: users.id });

  // Membro del progetto, come dopo la conversione: le card di un progetto che
  // il destinatario non vede non contano nel badge (revoca a lettura).
  const [legacyRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.presetKey, "legacy_member"));
  if (opts.member !== false) {
    await db.insert(projectMembers).values({ projectId, userId: user!.id, roleId: legacyRole!.id });
  }

  const devices = opts.devices ?? [{ platform: "ios" as const, token: `tok-${randomUUID()}` }];
  const deviceIds: string[] = [];
  for (const device of devices) {
    const [row] = await db
      .insert(deviceTokens)
      .values({
        userId: user!.id,
        platform: device.platform,
        token: device.token,
        ...(device.disabled
          ? { disabledAt: new Date(), disabledReason: "pat_revoked" }
          : {}),
      })
      .returning({ id: deviceTokens.id });
    deviceIds.push(row!.id);
  }

  const event = opts.event ?? sampleEvent();
  const [notification] = await db
    .insert(notifications)
    .values({
      userId: user!.id,
      projectId: opts.withProject === false ? null : projectId,
      kind: event.kind,
      event: event as unknown as Record<string, unknown>,
    })
    .returning({ id: notifications.id });

  for (let i = 0; i < (opts.extraOpen ?? 0); i += 1) {
    await db.insert(notifications).values({
      userId: user!.id,
      kind: "ticket.created",
      event: sampleEvent(`Altra ${i}`) as unknown as Record<string, unknown>,
    });
  }

  const [row] = await db
    .insert(notificationDeliveries)
    .values({
      channel: "push",
      notificationId: notification!.id,
      ...(opts.attempts ? { attempts: opts.attempts } : {}),
      ...(opts.deliveryEvent ? { event: opts.deliveryEvent } : {}),
    })
    .returning({ id: notificationDeliveries.id });
  return {
    deliveryId: row!.id,
    notificationId: notification!.id,
    userId: user!.id,
    deviceIds,
    tokens: devices.map((device) => device.token),
  };
}

/** Client del relay fake: registra le chiamate, o lancia l'errore programmato. */
function fakeRelay(
  opts: {
    throws?: unknown;
    /** Esito per token spedito. Default: tutti `ok`. */
    results?: (tokens: PushRelayToken[]) => PushRelaySendResponse["results"];
  } = {},
): PushRelayClient & { calls: { tokens: PushRelayToken[]; payload: PushPayload }[] } {
  const calls: { tokens: PushRelayToken[]; payload: PushPayload }[] = [];
  return {
    calls,
    send: async (tokens, payload) => {
      if (opts.throws) throw opts.throws;
      calls.push({ tokens, payload });
      return {
        results:
          opts.results?.(tokens) ??
          tokens.map((entry) => ({ token: entry.token, status: "ok" as const })),
      };
    },
  };
}

function pushDeps(
  relay: PushRelayClient | null,
  logger: DeliveriesLogger = silentLogger,
): DeliveriesPollerDeps {
  return { db, logger, encryptionKey, sendWebhook: async () => {}, pushRelay: relay };
}

async function readDevice(id: string) {
  const [row] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, id));
  return row!;
}

describe("processDeliveriesOnce — canale push", () => {
  it("push spente (nessun relay configurato) → skipped push_disabled", async () => {
    const seed = await insertPushDelivery();

    await processDeliveriesOnce(pushDeps(null));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("push_disabled");
  });

  it("due device → UNA chiamata al relay con entrambi i token, delivery sent", async () => {
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-ios" },
        { platform: "android", token: "tok-android" },
      ],
    });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]!.tokens).toEqual([
      { platform: "ios", token: "tok-ios" },
      { platform: "android", token: "tok-android" },
    ]);
    // Il payload è quello di `buildPushPayload`, col progetto della notifica.
    expect(relay.calls[0]!.payload).toMatchObject({
      category: "ticket.created",
      data: { notificationId: seed.notificationId },
      collapseId: seed.notificationId,
      threadId: projectId,
    });

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
  });

  it("l'esito salvato nomina i DEVICE, mai i token", async () => {
    // I token push finirebbero in chiaro nel DB e nei log: da un token ci si
    // intesta il device di qualcun altro.
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-segreto-ios" },
        { platform: "android", token: "tok-segreto-android" },
      ],
    });
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry, index) =>
          index === 0
            ? { token: entry.token, status: "ok" as const }
            : { token: entry.token, status: "failed" as const, reason: "PayloadTooLarge" },
        ),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("sent");
    // Prefisso fisso: `error LIKE 'devices:%'` separa la lista del relay dalle
    // frasi libere delle eccezioni e dai codici snake_case.
    expect(row.error).toMatch(/^devices: /);
    expect(row.error).toContain(seed.deviceIds[0]!);
    expect(row.error).toContain(seed.deviceIds[1]!);
    expect(row.error).toContain("failed");
    expect(row.error).toContain("PayloadTooLarge");
    for (const token of seed.tokens) {
      expect(row.error ?? "").not.toContain(token);
    }
  });

  it("invalid_token disabilita QUEL device; con un altro ok la delivery resta sent", async () => {
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-morto" },
        { platform: "android", token: "tok-vivo" },
      ],
    });
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) =>
          entry.token === "tok-morto"
            ? { token: entry.token, status: "invalid_token" as const, reason: "BadDeviceToken" }
            : { token: entry.token, status: "ok" as const },
        ),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const morto = await readDevice(seed.deviceIds[0]!);
    expect(morto.disabledAt).not.toBeNull();
    expect(morto.disabledReason).toBe("invalid_token");
    const vivo = await readDevice(seed.deviceIds[1]!);
    expect(vivo.disabledAt).toBeNull();

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("sent");
  });

  it("appaia gli esiti per VALORE del token, non per indice", async () => {
    // Un relay che riordina la risposta farebbe disabilitare il device
    // SBAGLIATO: un telefono sano spento e uno morto tenuto attivo, senza
    // errori. Qui gli esiti tornano al contrario dei token spediti.
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-primo" },
        { platform: "android", token: "tok-secondo" },
      ],
    });
    const relay = fakeRelay({
      results: (tokens) =>
        [...tokens]
          .reverse()
          .map((entry) =>
            entry.token === "tok-primo"
              ? { token: entry.token, status: "invalid_token" as const }
              : { token: entry.token, status: "ok" as const },
          ),
    });

    await processDeliveriesOnce(pushDeps(relay));

    expect((await readDevice(seed.deviceIds[0]!)).disabledAt).not.toBeNull();
    expect((await readDevice(seed.deviceIds[1]!)).disabledAt).toBeNull();
  });

  it("tutti invalid_token → failed senza ritentativo, tutti i device disabilitati", async () => {
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-a" },
        { platform: "android", token: "tok-b" },
      ],
    });
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) => ({ token: entry.token, status: "invalid_token" as const })),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("failed");
    for (const id of seed.deviceIds) {
      expect((await readDevice(id)).disabledAt).not.toBeNull();
    }
  });

  it("`failed` NON disabilita il device: il token resta valido", async () => {
    const seed = await insertPushDelivery({ devices: [{ platform: "ios", token: "tok-sano" }] });
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) => ({
          token: entry.token,
          status: "failed" as const,
          reason: "unknown status teapot",
        })),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("failed");
    expect((await readDevice(seed.deviceIds[0]!)).disabledAt).toBeNull();
  });

  it("tutti retry → resta pending e riprova col backoff", async () => {
    const seed = await insertPushDelivery();
    const before = Date.now();
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) => ({ token: entry.token, status: "retry" as const })),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    // Backoff del claim: 30s × 2^0.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before + backoffMs(0) - 5_000);
  });

  it("PushRelayUnavailable → resta pending (ritentabile)", async () => {
    const seed = await insertPushDelivery();
    const relay = fakeRelay({ throws: new PushRelayUnavailable("relay push ha risposto 503") });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("pending");
    expect(row.error).toContain("503");
  });

  it("PushRelayRejected → failed senza ritentativo", async () => {
    const seed = await insertPushDelivery();
    const relay = fakeRelay({
      throws: new PushRelayRejected("risposta del relay push fuori contratto (campi: results.0)"),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("fuori contratto");
    expect(row.attempts).toBe(1);
  });

  it("registro, A4 r.169: il gruppo scritto nella consegna arriva al testo della push; senza, la menzione resta a nome", async () => {
    const mention = { kind: "chat.mention", chatMessageId: randomUUID(), channelId: randomUUID(), channelName: "general", projectId: null, authorUserId: null, authorName: "Ada" } as unknown as NotificationEvent;
    await insertPushDelivery({ event: mention, language: "en", deliveryEvent: { pushGroup: "@channel" } });
    const relay = fakeRelay();
    await processDeliveriesOnce(pushDeps(relay));
    expect(relay.calls[0]!.payload).toMatchObject({ title: "@channel was mentioned in the chat", body: "Ada mentioned @channel in #general" });
    await insertPushDelivery({ event: mention, language: "en" });
    await processDeliveriesOnce(pushDeps(relay));
    expect(relay.calls[1]!.payload).toMatchObject({ title: "You were mentioned in the chat", body: "Ada mentioned you in #general" });
  });

  it("il badge è l'unread count del destinatario, non delle sue push", async () => {
    // 1 notifica di questa consegna + 2 altre aperte = 3.
    await insertPushDelivery({ extraOpen: 2 });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls[0]!.payload.badge).toBe(3);
    // Ed è il conteggio di QUEL destinatario: un'altra persona con la sua
    // inbox piena non deve alterarlo.
    await insertPushDelivery({ extraOpen: 5 });
    await processDeliveriesOnce(pushDeps(relay));
    expect(relay.calls[1]!.payload.badge).toBe(6);
  });

  it("nessun device attivo al momento dell'invio → skipped no_active_device", async () => {
    // Fra la creazione della consegna e l'invio l'utente può aver revocato il
    // PAT: i suoi device sono disattivati e non c'è più dove consegnare.
    const seed = await insertPushDelivery({
      devices: [{ platform: "ios", token: "tok-revocato", disabled: true }],
    });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls).toHaveLength(0);
    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("no_active_device");
  });

  it("un destinatario uscito dal progetto dopo la publish non riceve la push", async () => {
    const seed = await insertPushDelivery({ member: false });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls).toHaveLength(0);
    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("recipient_cannot_see");
  });

  it("il testo è nella lingua del destinatario (users.language)", async () => {
    const it = await insertPushDelivery({ language: "it" });
    const en = await insertPushDelivery({ language: "en" });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    const byNotification = new Map(
      relay.calls.map((call) => [call.payload.data.notificationId, call.payload]),
    );
    const itPayload = byNotification.get(it.notificationId)!;
    const enPayload = byNotification.get(en.notificationId)!;
    expect(itPayload.title).not.toBe(enPayload.title);
  });

  it("l'avviso di sicurezza parte con titolo e frase sua, verso la riga d'inbox", async () => {
    const seed = await insertPushDelivery({
      withProject: false,
      member: false,
      event: { kind: "security.alert", subject: "locked", actorEmail: null },
    });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect((await readDelivery(seed.deliveryId)).status).toBe("sent");
    const payload = relay.calls[0]!.payload;
    expect(payload.title).toBe("Avviso di sicurezza sul tuo account");
    expect(payload.body).toContain("bloccato per 15 minuti");
    expect(payload.data.deepLink).toBe(`stubwise://inbox/${seed.notificationId}`);
  });

  it("una notifica senza progetto non porta threadId", async () => {
    await insertPushDelivery({ withProject: false });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls[0]!.payload.threadId).toBeUndefined();
  });

  it("tutti i device raggiunti → `error` NULL, come su ogni altro canale", async () => {
    // Se il push fosse l'unico canale a valorizzare `error` su una consegna
    // `sent`, `error IS NOT NULL` smetterebbe di significare la stessa cosa
    // nella stessa colonna.
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-1" },
        { platform: "android", token: "tok-2" },
      ],
    });

    await processDeliveriesOnce(pushDeps(fakeRelay()));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("sent");
    expect(row.error).toBeNull();
  });

  it("retry + invalid_token insieme: disabilita QUEL device E resta pending", async () => {
    // È l'unico caso in cui la transazione fa entrambe le cose non banali. Al
    // giro dopo il device morto non è più del gruppo: il relay vede UN token.
    const seed = await insertPushDelivery({
      devices: [
        { platform: "ios", token: "tok-da-riprovare" },
        { platform: "android", token: "tok-morto" },
      ],
    });
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) =>
          entry.token === "tok-morto"
            ? { token: entry.token, status: "invalid_token" as const }
            : { token: entry.token, status: "retry" as const },
        ),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("pending");
    expect(row.error).toMatch(/^devices: /);
    expect((await readDevice(seed.deviceIds[0]!)).disabledAt).toBeNull();
    expect((await readDevice(seed.deviceIds[1]!)).disabledAt).not.toBeNull();

    // Secondo giro: la consegna è di nuovo dovuta.
    await db
      .update(notificationDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(notificationDeliveries.id, seed.deliveryId));
    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1]!.tokens).toEqual([{ platform: "ios", token: "tok-da-riprovare" }]);
  });

  it("all'ultimo tentativo una push ritentabile diventa failed, e finisce nei log", async () => {
    const seed = await insertPushDelivery({ attempts: 4 });
    const logger = collectingLogger();
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) => ({ token: entry.token, status: "retry" as const })),
    });

    await processDeliveriesOnce(pushDeps(relay, logger));

    const row = await readDelivery(seed.deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
    expect(row.error).toMatch(/^devices: /);
    // Una notifica persa per sempre non deve restare solo nella colonna.
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]!.msg).toContain("MAX_ATTEMPTS");
  });

  it("oltre il tetto, gli esiti in più diventano un `+N`", async () => {
    const devices = Array.from({ length: 21 }, (_, index) => ({
      platform: "ios" as const,
      token: `tok-${index}`,
    }));
    const seed = await insertPushDelivery({ devices });
    const relay = fakeRelay({
      results: (tokens) =>
        tokens.map((entry) => ({ token: entry.token, status: "failed" as const })),
    });

    await processDeliveriesOnce(pushDeps(relay));

    const row = await readDelivery(seed.deliveryId);
    const detail = row.error ?? "";
    expect(detail).toMatch(/, \+1$/);
    // Esattamente 20 esiti elencati, non 19 né 21.
    expect(detail.match(/=failed/g)).toHaveLength(20);
    expect(seed.deviceIds.filter((id) => detail.includes(id))).toHaveLength(20);
  });

  it("push spente: UNA riga di log per tick, non una per consegna", async () => {
    // `PUSH_RELAY_URL=` è uno stato STABILE (l'interruttore del rollback): un
    // warn per consegna sarebbe rumore perpetuo.
    await insertPushDelivery();
    await insertPushDelivery();
    const logger = collectingLogger();

    const processed = await processDeliveriesOnce(pushDeps(null, logger));

    expect(processed).toBe(2);
    expect(logger.warns).toHaveLength(1);
  });

  it("il timeout del relay è corto: un relay morto non blocca il tick per minuti", () => {
    // 20 consegne per tick IN SEQUENZA con guardia anti-rientro: col default da
    // 10s del client un relay morto allungherebbe il tick a 200s, e in quel
    // tick non partono nemmeno i DM Slack e i webhook.
    expect(PUSH_RELAY_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    expect(PUSH_RELAY_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
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
      encryptionKey,
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
      encryptionKey,
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
