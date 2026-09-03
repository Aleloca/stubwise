import {
  aiJobs,
  deviceTokens,
  notificationDeliveries,
  notificationSettings,
  notifications,
  tickets,
  users,
  type Db,
  type NotificationDelivery,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  PushRelayRejected,
  PushRelayUnavailable,
  SlackApiError,
  type NotificationEvent,
  type PushRelayClient,
  type SlackBlock,
  type SlackMessenger,
} from "@stubwise/notifications";
import type {
  PushPayload,
  PushRelaySendResponse,
  PushRelayToken,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  parseExternalRef,
  processDeliveriesOnce,
  PUSH_RELAY_TIMEOUT_MS,
  startDeliveriesPoller,
  type DeliveriesLogger,
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

/** Evento di piano da approvare: è il kind con le azioni decisionali. */
function planReviewEvent(): NotificationEvent {
  return {
    kind: "job.plan_review",
    ticketNumber: 7,
    ticketTitle: "Piano da approvare",
    projectName: "P",
    ticketUrl: "https://example.test/tickets/7",
  };
}

/** Domanda dell'agente: il kind con i bottoni DINAMICI (uno per opzione). */
function awaitingInputEvent(): NotificationEvent {
  return {
    kind: "job.awaiting_input",
    ticketNumber: 9,
    ticketTitle: "Export CSV",
    projectName: "P",
    ticketUrl: "https://example.test/tickets/9",
    questionId: "11111111-2222-3333-4444-555555555555",
    round: 1,
    question: "Quali colonne deve avere il CSV?",
    options: [
      { label: "Colonne vecchie", consequence: "Gli export esistenti restano validi." },
      { label: "Colonne nuove", consequence: "Rompe gli script dei clienti." },
    ],
    recommendedIndex: 0,
    allowFreeText: true,
  };
}

/**
 * Pulse proattivo: il SECONDO kind con opzioni. Non ha ticket né job, quindi i
 * bottoni delle scelte non possono dipendere dallo stato di un job.
 */
function pulseEvent(): NotificationEvent {
  return {
    kind: "project.pulse",
    pulseId: "1c9e4f70-5555-4666-8777-888899990000",
    projectName: "negozio-web",
    projectUrl: "https://example.test/projects/p1/backlog",
    idleDays: 4,
    question: "Da quale proposta partiamo?",
    options: [
      { label: "Export CSV degli ordini", consequence: "urgenza alta · effort 2" },
      { label: "Filtro per stato", consequence: "urgenza media · effort 1" },
    ],
    recommendedIndex: 0,
    allowFreeText: false,
    proposals: [
      {
        backlogItemId: "aa11bb22-1111-4222-8333-444455556666",
        title: "Export CSV degli ordini",
        urgency: "high",
        effort: 2,
        hasAnalysis: true,
      },
      {
        backlogItemId: "bb22cc33-2222-4333-8444-555566667777",
        title: "Filtro per stato",
        urgency: "medium",
        effort: 1,
        hasAnalysis: false,
      },
    ],
  };
}

interface SlackDeliveryOpts {
  /** Ruolo del destinatario: decide le azioni offerte dai bottoni. */
  role?: "admin" | "member";
  /** Identità Slack del destinatario. `null` = utente non linkato. */
  slackUserId?: string | null;
  language?: "en" | "it";
  event?: NotificationEvent;
  /** Se dato, ancora la notifica a un ticket con un job in questo stato. */
  jobStatus?: "queued" | "awaiting_plan_approval" | "awaiting_input";
  /** Payload della riga (usato dal canale `slack_update`: `{ note }`). */
  deliveryEvent?: Record<string, unknown>;
  externalRef?: string;
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
      slackUserId: opts.slackUserId === undefined ? `U${randomUUID().slice(0, 8)}` : opts.slackUserId,
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

  const [notification] = await db
    .insert(notifications)
    .values({
      userId: user!.id,
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
      ...(opts.externalRef ? { externalRef: opts.externalRef } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning({ id: notificationDeliveries.id });
  return { deliveryId: row!.id, notificationId: notification!.id, userId: user!.id };
}

/** Client Slack fake: registra le chiamate, o lancia l'errore programmato. */
function fakeSlack(opts: { throws?: unknown } = {}): SlackMessenger & {
  posted: { channel: string; text: string; blocks?: SlackBlock[] }[];
  updated: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }[];
} {
  const posted: { channel: string; text: string; blocks?: SlackBlock[] }[] = [];
  const updated: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }[] = [];
  return {
    posted,
    updated,
    postMessage: async ({ channel, text, blocks }) => {
      if (opts.throws) throw opts.throws;
      posted.push({ channel, text, blocks: blocks as SlackBlock[] | undefined });
      return { ts: "1723.4567", channel: "D0999" };
    },
    updateMessage: async ({ channel, ts, text, blocks }) => {
      if (opts.throws) throw opts.throws;
      updated.push({ channel, ts, text, blocks: blocks as SlackBlock[] | undefined });
      return { ts, channel };
    },
  };
}

/** Deps con i canali Slack attivi (token e client iniettati: niente rete, niente decifratura). */
function slackDeps(
  slack: SlackMessenger,
  opts: { botToken?: string | null; logger?: DeliveriesLogger } = {},
): DeliveriesPollerDeps {
  return {
    db,
    logger: opts.logger ?? silentLogger,
    encryptionKey,
    sendWebhook: async () => {},
    loadSlackBotToken: async () => (opts.botToken === undefined ? "xoxb-test" : opts.botToken),
    slackClientFactory: () => slack,
  };
}

/** Gli `action_id` del blocco `actions` dei blocchi inviati (vuoto se non c'è). */
function actionIdsOf(blocks: SlackBlock[] | undefined): string[] {
  const actions = blocks?.find((b) => b.type === "actions") as
    | { elements: { action_id: string }[] }
    | undefined;
  return actions?.elements.map((el) => el.action_id) ?? [];
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

describe("canale slack_dm", () => {
  it("posta il DM al destinatario e salva `channel|ts` in external_ref", async () => {
    const slack = fakeSlack();
    const { deliveryId } = await insertSlackDelivery("slack_dm", {
      slackUserId: "U0ALICE",
      language: "it",
    });

    const processed = await processDeliveriesOnce(slackDeps(slack));

    expect(processed).toBe(1);
    expect(slack.posted).toHaveLength(1);
    // Si posta sullo USER id: Slack apre da sé il DM (scope im:write).
    expect(slack.posted[0]!.channel).toBe("U0ALICE");
    expect(slack.posted[0]!.text).toContain("Ticket di prova");

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
    // Formato documentato: `<canale risolto>|<ts>` — è ciò che serve a chat.update.
    expect(row.externalRef).toBe("D0999|1723.4567");
    expect(parseExternalRef(row.externalRef)).toEqual({ channel: "D0999", ts: "1723.4567" });
  });

  it("i bottoni sono quelli del RUOLO del destinatario (admin approva, member no)", async () => {
    const slack = fakeSlack();
    await insertSlackDelivery("slack_dm", {
      role: "admin",
      event: planReviewEvent(),
      jobStatus: "awaiting_plan_approval",
    });
    await processDeliveriesOnce(slackDeps(slack));
    expect(actionIdsOf(slack.posted[0]!.blocks)).toEqual([
      "inbox:approve_plan",
      "inbox:reject_plan",
      "inbox:open",
      "inbox:snooze",
      "inbox:handled",
    ]);

    const slack2 = fakeSlack();
    await insertSlackDelivery("slack_dm", {
      role: "member",
      event: planReviewEvent(),
      jobStatus: "awaiting_plan_approval",
    });
    await processDeliveriesOnce(slackDeps(slack2));
    expect(actionIdsOf(slack2.posted[0]!.blocks)).toEqual([
      "inbox:open",
      "inbox:snooze",
      "inbox:handled",
    ]);
  });

  it("la DOMANDA dell'agente ha un bottone per opzione (e l'igiene in coda)", async () => {
    const slack = fakeSlack();
    await insertSlackDelivery("slack_dm", {
      role: "admin",
      event: awaitingInputEvent(),
      jobStatus: "awaiting_input",
    });
    await processDeliveriesOnce(slackDeps(slack));
    // I bottoni della domanda sostituiscono il generico "Rispondi": l'indice
    // dell'opzione viaggia nell'action_id.
    expect(actionIdsOf(slack.posted[0]!.blocks)).toEqual([
      "inbox:answer:0",
      "inbox:answer:1",
      "inbox:answer_free",
      "inbox:open",
      "inbox:snooze",
    ]);
    // Le conseguenze stanno nella sezione, non nei bottoni.
    const sections = slack.posted[0]!.blocks!.filter((b) => b.type === "section");
    expect(JSON.stringify(sections)).toContain("Rompe gli script dei clienti");
  });

  it("anche il PULSE ha un bottone per proposta, senza nessun job dietro", async () => {
    const slack = fakeSlack();
    // Nessun `jobStatus`: il pulse non è ancorato a un ticket. Se i blocchi
    // domanda fossero ancora legati al kind `job.awaiting_input`, qui
    // arriverebbe il "Rispondi" generico — un bottone che non può portarsi
    // dietro la proposta scelta.
    await insertSlackDelivery("slack_dm", { role: "member", event: pulseEvent() });
    await processDeliveriesOnce(slackDeps(slack));
    expect(actionIdsOf(slack.posted[0]!.blocks)).toEqual([
      "inbox:answer:0",
      "inbox:answer:1",
      // `allowFreeText: false`: dal pulse si sceglie, non si scrive.
      "inbox:open",
      "inbox:snooze",
      // Il pulse è archiviabile: ignorare una proposta è una risposta.
      "inbox:handled",
    ]);
    const sections = slack.posted[0]!.blocks!.filter((b) => b.type === "section");
    expect(JSON.stringify(sections)).toContain("Export CSV degli ordini");
  });

  it("gli altri kind restano coi blocchi standard", async () => {
    const slack = fakeSlack();
    await insertSlackDelivery("slack_dm", {
      role: "admin",
      event: planReviewEvent(),
      jobStatus: "awaiting_plan_approval",
    });
    await processDeliveriesOnce(slackDeps(slack));
    expect(actionIdsOf(slack.posted[0]!.blocks)).toContain("inbox:approve_plan");
    expect(slack.posted[0]!.blocks!.filter((b) => b.type === "section")).toHaveLength(1);
  });

  it("il testo segue la lingua del DESTINATARIO", async () => {
    const slack = fakeSlack();
    await insertSlackDelivery("slack_dm", { language: "en" });
    await processDeliveriesOnce(slackDeps(slack));
    expect(slack.posted[0]!.text).toContain("New");
  });

  it("bot Slack non configurato → skipped, senza bruciare tentativi", async () => {
    const logger = collectingLogger();
    const slack = fakeSlack();
    const { deliveryId } = await insertSlackDelivery("slack_dm");

    await processDeliveriesOnce(slackDeps(slack, { botToken: null, logger }));

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("slack_not_configured");
    expect(slack.posted).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
  });

  it("destinatario senza identità Slack → skipped", async () => {
    const slack = fakeSlack();
    const { deliveryId } = await insertSlackDelivery("slack_dm", { slackUserId: null });

    await processDeliveriesOnce(slackDeps(slack));

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("user_without_slack_id");
    expect(slack.posted).toHaveLength(0);
  });

  it("channel_not_found → failed SUBITO (ritentare non cambierebbe nulla)", async () => {
    const logger = collectingLogger();
    const slack = fakeSlack({ throws: new SlackApiError("chat.postMessage", "channel_not_found") });
    const { deliveryId } = await insertSlackDelivery("slack_dm");

    await processDeliveriesOnce(slackDeps(slack, { logger }));

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.error).toContain("channel_not_found");
    expect(logger.warns).toHaveLength(1);
  });

  it("ratelimited e errori di rete restano pending (ritentabili)", async () => {
    const rateLimited = fakeSlack({ throws: new SlackApiError("chat.postMessage", "ratelimited") });
    const { deliveryId } = await insertSlackDelivery("slack_dm");
    await processDeliveriesOnce(slackDeps(rateLimited));
    let row = await readDelivery(deliveryId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.error).toContain("ratelimited");

    const offline = fakeSlack({ throws: new Error("ECONNRESET") });
    const second = await insertSlackDelivery("slack_dm");
    await processDeliveriesOnce(slackDeps(offline));
    row = await readDelivery(second.deliveryId);
    expect(row.status).toBe("pending");
    expect(row.error).toContain("ECONNRESET");
  });

  it("all'ultimo tentativo un errore ritentabile chiude comunque failed", async () => {
    const slack = fakeSlack({ throws: new SlackApiError("chat.postMessage", "ratelimited") });
    const { deliveryId } = await insertSlackDelivery("slack_dm");
    await db
      .update(notificationDeliveries)
      .set({ attempts: 4 })
      .where(eq(notificationDeliveries.id, deliveryId));

    await processDeliveriesOnce(slackDeps(slack));

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
  });
});

describe("canale slack_update", () => {
  /** Consegna `slack_dm` GIÀ inviata + la `slack_update` che la aggiorna. */
  async function seedUpdate(note: string | undefined): Promise<string> {
    const dm = await insertSlackDelivery("slack_dm", {
      status: "sent",
      externalRef: "D0777|100.5",
      slackUserId: "U0BOB",
    });
    const [row] = await db
      .insert(notificationDeliveries)
      .values({
        channel: "slack_update",
        notificationId: dm.notificationId,
        ...(note === undefined ? {} : { event: { note } }),
      })
      .returning({ id: notificationDeliveries.id });
    return row!.id;
  }

  it("riscrive il messaggio con testo + nota e SENZA bottoni", async () => {
    const slack = fakeSlack();
    const id = await seedUpdate("✅ Gestita da alice@example.com");

    await processDeliveriesOnce(slackDeps(slack));

    expect(slack.updated).toHaveLength(1);
    expect(slack.updated[0]!.channel).toBe("D0777");
    expect(slack.updated[0]!.ts).toBe("100.5");
    expect(slack.updated[0]!.text).toContain("Ticket di prova");
    expect(slack.updated[0]!.text).toContain("✅ Gestita da alice@example.com");
    // Nessun blocco `actions`: la notifica non è più azionabile da qui.
    expect(actionIdsOf(slack.updated[0]!.blocks)).toEqual([]);

    const row = await readDelivery(id);
    expect(row.status).toBe("sent");
    // L'aggiornamento eredita il riferimento del messaggio riscritto.
    expect(row.externalRef).toBe("D0777|100.5");
  });

  it("senza nota rimuove solo i bottoni (caso snooze)", async () => {
    const slack = fakeSlack();
    await seedUpdate(undefined);
    await processDeliveriesOnce(slackDeps(slack));
    expect(slack.updated[0]!.text).toContain("Ticket di prova");
    expect(actionIdsOf(slack.updated[0]!.blocks)).toEqual([]);
  });

  it("nessun DM sorella da aggiornare → skipped (niente da riscrivere)", async () => {
    const slack = fakeSlack();
    const { deliveryId } = await insertSlackDelivery("slack_update", {
      deliveryEvent: { note: "✅ Gestita" },
    });

    await processDeliveriesOnce(slackDeps(slack));

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("no_slack_message");
    expect(slack.updated).toHaveLength(0);
  });

  it("DM sorella ancora pending → l'update resta pending (arriveremo dopo)", async () => {
    const slack = fakeSlack();
    // Il DM è in coda ma non ancora dovuto in questo tick: l'update lo trova
    // `pending` e deve aspettarlo invece di rinunciare.
    const dm = await insertSlackDelivery("slack_dm", { slackUserId: "U0BOB" });
    await db
      .update(notificationDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(notificationDeliveries.id, dm.deliveryId));
    const [update] = await db
      .insert(notificationDeliveries)
      .values({
        channel: "slack_update",
        notificationId: dm.notificationId,
        event: { note: "✅ Gestita" },
      })
      .returning({ id: notificationDeliveries.id });

    await processDeliveriesOnce(slackDeps(slack));

    const row = await readDelivery(update!.id);
    expect(row.status).toBe("pending");
    expect(row.error).toBe("slack_dm_pending");
    expect(row.attempts).toBe(1);
    expect(slack.updated).toHaveLength(0);
    // Il DM non è stato toccato: non era dovuto.
    expect(slack.posted).toHaveLength(0);
  });

  it("DM sorella fallito → skipped (nessun messaggio, e non ce ne sarà)", async () => {
    const slack = fakeSlack();
    const dm = await insertSlackDelivery("slack_dm", { slackUserId: "U0BOB" });
    await db
      .update(notificationDeliveries)
      .set({ status: "failed", error: "account_inactive" })
      .where(eq(notificationDeliveries.id, dm.deliveryId));
    const [update] = await db
      .insert(notificationDeliveries)
      .values({
        channel: "slack_update",
        notificationId: dm.notificationId,
        event: { note: "✅ Gestita" },
      })
      .returning({ id: notificationDeliveries.id });

    await processDeliveriesOnce(slackDeps(slack));

    const row = await readDelivery(update!.id);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe("no_slack_message");
    expect(slack.updated).toHaveLength(0);
  });

  it("message_not_found → failed subito", async () => {
    const slack = fakeSlack({ throws: new SlackApiError("chat.update", "message_not_found") });
    const id = await seedUpdate("✅ Gestita");

    await processDeliveriesOnce(slackDeps(slack));

    const row = await readDelivery(id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("message_not_found");
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
    .values({ channel: "push", notificationId: notification!.id })
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

  it("il badge è l'unread count del destinatario, non delle sue push", async () => {
    // 1 notifica di questa consegna + 2 altre aperte = 3.
    const seed = await insertPushDelivery({ extraOpen: 2 });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls[0]!.payload.badge).toBe(3);
    // Ed è il conteggio di QUEL destinatario: un'altra persona con la sua
    // inbox piena non deve alterarlo.
    const seedAltri = await insertPushDelivery({ extraOpen: 5 });
    await processDeliveriesOnce(pushDeps(relay));
    expect(relay.calls[1]!.payload.badge).toBe(6);
    expect(seedAltri.userId).not.toBe(seed.userId);
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

  it("una notifica senza progetto non porta threadId", async () => {
    await insertPushDelivery({ withProject: false });
    const relay = fakeRelay();

    await processDeliveriesOnce(pushDeps(relay));

    expect(relay.calls[0]!.payload.threadId).toBeUndefined();
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
