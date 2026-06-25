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
import { DOCS_QUERY_CALLBACK_ID } from "./docs-modal.js";

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

// Spie del client Slack iniettato (niente rete). emailToReturn e
// avatarToReturn pilotano getUserProfile (usato dall'attribuzione/auto-link).
const openView = vi.fn<SlackClient["openView"]>(async () => true);
let emailToReturn: string | null = null;
let avatarToReturn: string | null = null;
const getUserProfile = vi.fn<SlackClient["getUserProfile"]>(async () => ({
  email: emailToReturn,
  displayName: null,
  avatarUrl: avatarToReturn,
}));
const getUserEmail = vi.fn<SlackClient["getUserEmail"]>(async () => emailToReturn);
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
  getUserProfile.mockClear();
  emailToReturn = null;
  avatarToReturn = null;
  // Ripristina lo stato del reporter: i test di auto-link mutano slack_user_id
  // / slack_avatar_url, vanno azzerati per non sporcare i test successivi.
  await testDb.db
    .update(users)
    .set({ slackUserId: null, slackAvatarUrl: null })
    .where(eq(users.id, reporterUserId));
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

describe("POST /api/slack/commands — /docs", () => {
  /** Block Kit: cerca un element con il `type` dato in qualunque block della view. */
  function hasElementOfType(view: unknown, type: string): boolean {
    const blocks = (view as { blocks?: unknown[] }).blocks ?? [];
    return blocks.some((b) => (b as { element?: { type?: string } }).element?.type === type);
  }

  it("utente non collegato → 200 effimero, niente openView", async () => {
    // Nessuna riga users con slackUserId = Unotlinked.
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fdocs&trigger_id=TRIG&user_id=Unotlinked&channel_id=C1&response_url=https%3A%2F%2Fhooks.slack.com%2Fr1&text=ciao",
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { response_type: string }).response_type).toBe("ephemeral");
    expect(openView).not.toHaveBeenCalled();
  });

  it("utente collegato → openView con la view docs e private_metadata corretto", async () => {
    await testDb.db
      .update(users)
      .set({ slackUserId: "Udocslinked" })
      .where(eq(users.id, reporterUserId));

    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fdocs&trigger_id=TRIGDOCS&user_id=Udocslinked&channel_id=C42&response_url=https%3A%2F%2Fhooks.slack.com%2Fresp&text=Come+funziona%3F",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [triggerId, view] = openView.mock.calls[0]!;
    expect(triggerId).toBe("TRIGDOCS");
    expect((view as { callback_id: string }).callback_id).toBe(DOCS_QUERY_CALLBACK_ID);
    // Selettore progetto (external_select) + input domanda.
    expect(hasElementOfType(view, "external_select")).toBe(true);
    expect(hasElementOfType(view, "plain_text_input")).toBe(true);
    // private_metadata parsabile col contesto dello slash command.
    const meta = JSON.parse((view as { private_metadata: string }).private_metadata) as {
      responseUrl: string;
      channelId: string;
      slackUserId: string;
    };
    expect(meta.responseUrl).toBe("https://hooks.slack.com/resp");
    expect(meta.channelId).toBe("C42");
    expect(meta.slackUserId).toBe("Udocslinked");
  });

  it("firma non valida → 401", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fdocs&trigger_id=TRIG&user_id=Udocslinked",
      { sign: false },
    );
    expect(res.statusCode).toBe(401);
    expect(openView).not.toHaveBeenCalled();
  });

  it("/stubwise → comportamento invariato (apre il ticket modal)", async () => {
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise&trigger_id=TRIGTICKET&user_id=U1",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [, view] = openView.mock.calls[0]!;
    expect((view as { callback_id: string }).callback_id).toBe(CREATE_TICKET_CALLBACK_ID);
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
    // Lo Slack id non è linkato a nessun utente: si ripiega sul profilo (email).
    expect(getUserProfile).toHaveBeenCalledWith("Uxyz");

    const [created] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.title, "Con assegnatario"));
    expect(created!.assigneeId).toBe(reporterUserId);
    expect(created!.body).not.toContain("no Stubwise account");
  });

  it("attribuzione: match per Slack id linkato → assegnato senza usare l'email", async () => {
    // Pre-link del reporter a uno Slack id noto.
    await testDb.db
      .update(users)
      .set({ slackUserId: "Ulinked123" })
      .where(eq(users.id, reporterUserId));
    // Email "sbagliata": se venisse usata, il match fallirebbe.
    emailToReturn = "nessuno@example.com";
    const body = viewSubmissionBody({
      projectId,
      title: "Match per slack id",
      type: "bug",
      userId: "Ulinked123",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    // Match diretto: nessuna chiamata a Slack per il profilo.
    expect(getUserProfile).not.toHaveBeenCalled();

    const [created] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.title, "Match per slack id"));
    expect(created!.assigneeId).toBe(reporterUserId);
  });

  it("auto-link: match per email su utente non linkato → slack_user_id valorizzato", async () => {
    emailToReturn = "slack.reporter@example.com";
    avatarToReturn = "https://avatars.slack-edge.com/auto.png";
    const body = viewSubmissionBody({
      projectId,
      title: "Auto link",
      type: "task",
      userId: "Uauto999",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);

    const [linked] = await testDb.db
      .select({ slackUserId: users.slackUserId, slackAvatarUrl: users.slackAvatarUrl })
      .from(users)
      .where(eq(users.id, reporterUserId));
    expect(linked!.slackUserId).toBe("Uauto999");
    expect(linked!.slackAvatarUrl).toBe("https://avatars.slack-edge.com/auto.png");
  });

  it("slack id già di un altro utente → match diretto su quello, ticket creato, no 500", async () => {
    // Un secondo utente possiede già lo Slack id. Il match diretto per slack id
    // ha la precedenza: il ticket va a lui, l'auto-link per email non scatta e
    // non c'è alcun errore (men che meno una unique violation 500).
    const [other] = await testDb.db
      .insert(users)
      .values({
        email: `other-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
        slackUserId: "Ucollision",
      })
      .returning({ id: users.id });
    // Email che matcherebbe il reporter (non linkato): non deve essere usata.
    emailToReturn = "slack.reporter@example.com";
    const body = viewSubmissionBody({
      projectId,
      title: "Slack id altrui",
      type: "bug",
      userId: "Ucollision",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);

    const [created] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.title, "Slack id altrui"));
    expect(created!.assigneeId).toBe(other!.id);
    // Match diretto: nessuna chiamata al profilo, nessun auto-link.
    expect(getUserProfile).not.toHaveBeenCalled();
    // Il reporter (candidato per email) resta non linkato.
    const [reporter] = await testDb.db
      .select({ slackUserId: users.slackUserId })
      .from(users)
      .where(eq(users.id, reporterUserId));
    expect(reporter!.slackUserId).toBeNull();

    await testDb.db.delete(users).where(eq(users.id, other!.id));
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
