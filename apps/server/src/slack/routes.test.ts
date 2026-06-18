import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encrypt, instanceSettings, tickets, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";
import type { SlackClient } from "./api.js";
import type { SlackClientFactory } from "./routes.js";
import { ACTION_IDS, BLOCK_IDS, CREATE_TICKET_CALLBACK_ID } from "./modal.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PUBLIC_URL = "https://stubwise.example.com";
const SIGNING_SECRET = "slack-signing-secret-di-test-1234567890";
const BOT_TOKEN = "xoxb-test-token";
// Timestamp fisso e `now` corrispondente: la firma resta dentro la finestra.
const TIMESTAMP = "1700000000";
const NOW = 1_700_000_000_000;

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let projectId: string;
let reporterUserId: string;

// Spie del client Slack iniettato (niente rete). emailToReturn pilota
// getUserEmail per i test di attribuzione.
const openView = vi.fn<SlackClient["openView"]>(async () => true);
let emailToReturn: string | null = null;
const getUserEmail = vi.fn<SlackClient["getUserEmail"]>(async () => emailToReturn);
const getUserProfile = vi.fn<SlackClient["getUserProfile"]>(async () => ({
  email: emailToReturn,
  displayName: null,
  avatarUrl: null,
}));
const listWorkspaceUsers = vi.fn<SlackClient["listWorkspaceUsers"]>(async () => []);
const slackClientFactory: SlackClientFactory = () => ({
  openView,
  getUserEmail,
  getUserProfile,
  listWorkspaceUsers,
});

async function createProject(name: string): Promise<string> {
  const accountRes = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: { name: `${name} — account`, provider: "github", credentials: { token: "t" } },
  });
  if (accountRes.statusCode !== 201) {
    throw new Error(`account git: ${accountRes.statusCode} ${accountRes.body}`);
  }
  const gitAccountId = (accountRes.json() as { id: string }).id;
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: adminCookie },
    payload: { name, gitAccountId, repoUrl: `https://github.com/acme/${name}` },
  });
  if (res.statusCode !== 201) throw new Error(`progetto: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/** Imposta (o azzera) i segreti Slack cifrati sul singleton instance settings. */
async function setSlackCreds(enabled: boolean): Promise<void> {
  await testDb.db
    .insert(instanceSettings)
    .values({
      id: 1,
      slackSigningSecretEncrypted: enabled ? encrypt(SIGNING_SECRET, ENCRYPTION_KEY) : null,
      slackBotTokenEncrypted: enabled ? encrypt(BOT_TOKEN, ENCRYPTION_KEY) : null,
    })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: {
        slackSigningSecretEncrypted: enabled ? encrypt(SIGNING_SECRET, ENCRYPTION_KEY) : null,
        slackBotTokenEncrypted: enabled ? encrypt(BOT_TOKEN, ENCRYPTION_KEY) : null,
      },
    });
}

/** Inietta una POST Slack firmando il raw body urlencoded. */
function slackPost(
  path: string,
  rawBody: string,
  { sign = true, timestamp = TIMESTAMP }: { sign?: boolean; timestamp?: string } = {},
) {
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(sign
        ? { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp }
        : {}),
    },
    payload: rawBody,
  });
}

/** Estrae l'initial_value dell'input del titolo dalla view passata a openView. */
function titleInitialValue(view: unknown): string | undefined {
  const blocks = (view as { blocks?: unknown[] }).blocks ?? [];
  for (const block of blocks) {
    const b = block as { block_id?: string; element?: { initial_value?: string } };
    if (b.block_id === BLOCK_IDS.title) return b.element?.initial_value;
  }
  return undefined;
}

/** Costruisce il raw body urlencoded di un view_submission con i campi dati. */
function viewSubmissionBody(opts: {
  projectId?: string;
  title?: string;
  description?: string;
  type?: string;
  userId?: string;
  username?: string;
}): string {
  const values: Record<string, Record<string, unknown>> = {};
  if (opts.projectId !== undefined) {
    values[BLOCK_IDS.project] = {
      [ACTION_IDS.project]: { selected_option: { value: opts.projectId } },
    };
  }
  if (opts.title !== undefined) {
    values[BLOCK_IDS.title] = { [ACTION_IDS.title]: { value: opts.title } };
  }
  if (opts.description !== undefined) {
    values[BLOCK_IDS.description] = {
      [ACTION_IDS.description]: { value: opts.description },
    };
  }
  if (opts.type !== undefined) {
    values[BLOCK_IDS.type] = {
      [ACTION_IDS.type]: { selected_option: { value: opts.type } },
    };
  }
  const payload = {
    type: "view_submission",
    user: { id: opts.userId ?? "U123", username: opts.username ?? "slackuser" },
    view: { callback_id: CREATE_TICKET_CALLBACK_ID, state: { values } },
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: PUBLIC_URL,
    slackClientFactory,
    slackNow: () => NOW,
  });
  ({ adminCookie } = await seedUsers(app));
  projectId = await createProject("slack-proj");
  const [u] = await testDb.db
    .insert(users)
    .values({ email: "Slack.Reporter@Example.com", passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  reporterUserId = u!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  openView.mockClear();
  getUserEmail.mockClear();
  emailToReturn = null;
  // Lascia i segreti Slack abilitati come stato di default tra i test.
  await setSlackCreds(true);
});

describe("POST /api/slack/commands", () => {
  it("Slack non configurato → 200 effimero, niente 500", async () => {
    await setSlackCreds(false);
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=T1&user_id=U1",
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { response_type: string }).response_type).toBe("ephemeral");
    expect(openView).not.toHaveBeenCalled();
  });

  it("firma non valida → 401", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=T1",
      { sign: false },
    );
    expect(res.statusCode).toBe(401);
    expect(openView).not.toHaveBeenCalled();
  });

  it("firma valida → openView col modal e 200", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=TRIG123&user_id=U1",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [triggerId, view] = openView.mock.calls[0]!;
    expect(triggerId).toBe("TRIG123");
    expect((view as { callback_id: string }).callback_id).toBe(CREATE_TICKET_CALLBACK_ID);
  });

  it("text non vuoto → titolo precompilato con initial_value", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=TRIG123&text=Ticket+di+prova",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [, view] = openView.mock.calls[0]!;
    expect(titleInitialValue(view)).toBe("Ticket di prova");
  });

  it("text vuoto → nessun initial_value sul titolo (comportamento attuale)", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=TRIG123&text=",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [, view] = openView.mock.calls[0]!;
    expect(titleInitialValue(view)).toBeUndefined();
  });

  it("text assente → nessun initial_value sul titolo", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=TRIG123",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [, view] = openView.mock.calls[0]!;
    expect(titleInitialValue(view)).toBeUndefined();
  });

  it("text > 300 caratteri → titolo troncato a 300", async () => {
    const longText = "a".repeat(400);
    const res = await slackPost(
      "/api/slack/commands",
      `command=%2Fstubwise&trigger_id=TRIG123&text=${longText}`,
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [, view] = openView.mock.calls[0]!;
    // Il prefill è troncato a 300; il modal builder limita ulteriormente
    // initial_value a 150 (limite di rendering Slack), quindi il prefill
    // passato a buildTicketModal non deve eccedere i 300 caratteri.
    const initial = titleInitialValue(view);
    expect(initial).toBeDefined();
    expect(initial!.length).toBeLessThanOrEqual(300);
    expect(initial).toBe("a".repeat(initial!.length));
  });
});

describe("POST /api/slack/interactions — view_submission", () => {
  it("crea ticket source=slack con progetto/titolo scelti", async () => {
    const body = viewSubmissionBody({
      projectId,
      title: "Bottone rotto",
      description: "Non funziona il submit",
      type: "bug",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    const rows = await testDb.db.select().from(tickets).where(eq(tickets.projectId, projectId));
    const created = rows.find((t) => t.title === "Bottone rotto");
    expect(created).toBeDefined();
    expect(created!.source).toBe("slack");
    expect(created!.type).toBe("bug");
    expect(created!.body).toContain("Reported via Slack by @slackuser");
    expect(created!.body).toContain("Non funziona il submit");
  });

  it("attribuzione: email che matcha un utente → assigneeId settato", async () => {
    emailToReturn = "slack.reporter@example.com";
    const body = viewSubmissionBody({
      projectId,
      title: "Con assegnatario",
      type: "feature",
      userId: "Uxyz",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    expect(getUserEmail).toHaveBeenCalledWith("Uxyz");

    const [created] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.title, "Con assegnatario"));
    expect(created!.assigneeId).toBe(reporterUserId);
    expect(created!.body).not.toContain("no Stubwise account");
  });

  it("email no-match → assigneeId null + nota provenienza", async () => {
    emailToReturn = "nessuno@example.com";
    const body = viewSubmissionBody({
      projectId,
      title: "Senza account",
      type: "task",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);

    const [created] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.title, "Senza account"));
    expect(created!.assigneeId).toBeNull();
    expect(created!.body).toContain("no Stubwise account");
  });

  it("campi mancanti → response_action errors, nessun ticket creato", async () => {
    const before = await testDb.db.select().from(tickets).where(eq(tickets.projectId, projectId));
    // Titolo assente.
    const body = viewSubmissionBody({ projectId, type: "bug" });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors[BLOCK_IDS.title]).toBeTruthy();

    const after = await testDb.db.select().from(tickets).where(eq(tickets.projectId, projectId));
    expect(after.length).toBe(before.length);
  });

  it("progetto inesistente → response_action errors sul block progetto, nessun ticket creato, no 500", async () => {
    const before = await testDb.db.select().from(tickets);
    const missingProjectId = randomUUID();
    const body = viewSubmissionBody({
      projectId: missingProjectId,
      title: "Progetto sparito",
      type: "bug",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors[BLOCK_IDS.project]).toBeTruthy();

    const after = await testDb.db.select().from(tickets);
    expect(after.length).toBe(before.length);
  });

  it("firma non valida → 401", async () => {
    const body = viewSubmissionBody({ projectId, title: "x", type: "bug" });
    const res = await slackPost("/api/slack/interactions", body, { sign: false });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/slack/interactions — message_action", () => {
  it("apre il modal precompilato dal testo del messaggio", async () => {
    const payload = {
      type: "message_action",
      trigger_id: "TRIGMSG",
      user: { id: "U1", username: "u" },
      message: { text: "Prima riga del bug\nDettagli ulteriori" },
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [triggerId, view] = openView.mock.calls[0]!;
    expect(triggerId).toBe("TRIGMSG");
    // Il modal precompilato porta titolo (prima riga) e descrizione (testo intero).
    const json = JSON.stringify(view);
    expect(json).toContain("Prima riga del bug");
    expect(json).toContain("Dettagli ulteriori");
  });
});
