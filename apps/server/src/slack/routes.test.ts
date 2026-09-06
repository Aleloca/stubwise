import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildQuestionBlocks } from "@stubwise/notifications";
import {
  agentQuestions,
  aiJobs,
  comments,
  docChunks,
  docGenerations,
  docPages,
  encrypt,
  instanceSettings,
  notificationDeliveries,
  notifications,
  projects,
  repoGraphs,
  repositories,
  tickets,
  users,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm, ChatLlmInput } from "../routes/chat-llm.js";
import { createTicket } from "../db/tickets.js";
import { createFakeGraphMcpClient, seedUsers, type SeededUsers } from "../test/fixtures.js";
import type { SlackClient } from "./api.js";
import type { SlackClientFactory } from "./routes.js";
import {
  ACTION_IDS,
  BLOCK_IDS,
  CREATE_TICKET_CALLBACK_ID,
  INBOX_ANSWER_ACTION_ID,
  INBOX_ANSWER_BLOCK_ID,
  INBOX_ANSWER_CALLBACK_ID,
  INBOX_REJECT_ACTION_ID,
  INBOX_REJECT_BLOCK_ID,
  INBOX_REJECT_PLAN_CALLBACK_ID,
} from "./modal.js";
import {
  DOCS_ACTION_IDS,
  DOCS_BLOCK_IDS,
  DOCS_QUERY_CALLBACK_ID,
} from "./docs-modal.js";

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
let seeded: SeededUsers;
// Progetto bersaglio dei test di creazione ticket via Slack (il ticket modal
// seleziona un PROGETTO — Fase 3): è un projectId, usato come `tickets.projectId`.
let ticketProjectId: string;
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
  // Messaggistica: non usata da questo flusso (i DM dell'inbox sono del worker).
  postMessage: async () => {
    throw new Error("postMessage non previsto in questo test");
  },
  updateMessage: async () => {
    throw new Error("updateMessage non previsto in questo test");
  },
});

// Fake embedding client (deterministico): un testo identico → vettore identico,
// così il chunk seedato ranka primo nel retrieval RAG di /docs.
const embeddingClient = createFakeEmbeddingClient();

// Fake ChatLlm: emette delta canned (concatenati = la risposta). isAvailable
// pilotabile per-test via availabilityOverride; stream pilotabile via
// streamOverride (per il path d'errore: lancia).
const FAKE_DELTAS = ["Risposta ", "dai ", "docs."];
let availabilityOverride: ChatAvailability | null = null;
let streamOverride: ((input: ChatLlmInput) => AsyncIterable<string>) | null = null;
async function* defaultStream(): AsyncIterable<string> {
  for (const d of FAKE_DELTAS) yield d;
}
let lastChatInput: ChatLlmInput | null = null;
const fakeChatLlm: ChatLlm = {
  stream(input: ChatLlmInput): AsyncIterable<string> {
    lastChatInput = input;
    return (streamOverride ?? defaultStream)(input);
  },
  async isAvailable(): Promise<ChatAvailability> {
    return availabilityOverride ?? { available: true };
  },
};

// Client MCP finto verso graphify: /docs via Slack è una superficie INTERNA e
// riceve il blocco del grafo come le chat Docs della SPA (fase 2b).
const fakeGraphClient = createFakeGraphMcpClient();

// Spy della POST differita verso il response_url di Slack (niente rete).
const postResponse = vi.fn<(url: string, payload: unknown) => Promise<void>>(async () => {});

async function createGitAccount(name: string): Promise<string> {
  const accountRes = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: { name: `${name} — account`, provider: "github", credentials: { token: "t" } },
  });
  if (accountRes.statusCode !== 201) {
    throw new Error(`account git: ${accountRes.statusCode} ${accountRes.body}`);
  }
  return (accountRes.json() as { id: string }).id;
}

/**
 * Crea un repository dentro un progetto (gruppo) esistente e ne ritorna il
 * repositoryId. La generazione di docs e i ticket lavorano a livello di
 * repository: questo helper è il mattone dei test sia ticket sia /docs.
 */
async function createRepoInProject(projectGroupId: string, name: string): Promise<string> {
  const gitAccountId = await createGitAccount(name);
  const res = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: {
      projectId: projectGroupId,
      name,
      gitAccountId,
      repoUrl: `https://github.com/acme/${name}`,
    },
  });
  if (res.statusCode !== 201) throw new Error(`repository: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/** Crea un progetto (gruppo) e ritorna il suo projectId. */
async function createProjectGroup(name: string): Promise<string> {
  const [group] = await testDb.db
    .insert(projects)
    .values({
      name: `${name} — gruppo`,
      slug: `gruppo-${randomBytes(4).toString("hex")}`,
      ingestionKey: randomBytes(16).toString("hex"),
    })
    .returning({ id: projects.id });
  return group!.id;
}

/**
 * Crea un progetto con UN repository sotto di sé. Ritorna sia il projectId (valore
 * del selettore /docs, Fase 2) sia il repositoryId (ticket bersaglio, link delle
 * citazioni). I test ticket usano il repositoryId; i test /docs usano il projectId.
 */
async function createProject(
  name: string,
): Promise<{ projectId: string; repositoryId: string }> {
  const projectId = await createProjectGroup(name);
  const repositoryId = await createRepoInProject(projectId, name);
  return { projectId, repositoryId };
}

/**
 * Dota un REPOSITORY di documentazione: una generazione corrente `succeeded`, una
 * pagina e un chunk con embedding del suo contenuto. Così il progetto a cui il
 * repo appartiene compare come "con documentazione" e il retrieval RAG cross-repo
 * cita la pagina (con il repository d'origine).
 */
async function seedDocsForRepo(
  db: Db,
  repositoryId: string,
  page: { title: string; slug: string; content: string },
): Promise<void> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      repositoryId,
      status: "succeeded",
      commitSha: randomBytes(4).toString("hex"),
      trigger: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  if (!gen) throw new Error("insert generazione non ha restituito la riga");
  await db.update(repositories).set({ currentDocGenerationId: gen.id }).where(eq(repositories.id, repositoryId));

  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId: gen.id,
      kind: "technical",
      slug: page.slug,
      title: page.title,
      body: page.content,
      isManual: false,
    })
    .returning();
  if (!row) throw new Error("insert pagina non ha restituito la riga");

  const [vector] = await embeddingClient.embed([page.content]);
  await db.insert(docChunks).values({
    pageId: row.id,
    repositoryId,
    generationId: gen.id,
    content: page.content,
    embedding: vector,
  });
}

/** Costruisce il raw body urlencoded di un view_submission del modal /docs. */
function docsSubmissionBody(opts: {
  projectId?: string;
  question?: string;
  meta?: Record<string, unknown>;
}): string {
  const values: Record<string, Record<string, unknown>> = {};
  if (opts.projectId !== undefined) {
    values[DOCS_BLOCK_IDS.project] = {
      [DOCS_ACTION_IDS.project]: { selected_option: { value: opts.projectId } },
    };
  }
  if (opts.question !== undefined) {
    values[DOCS_BLOCK_IDS.question] = {
      [DOCS_ACTION_IDS.question]: { value: opts.question },
    };
  }
  const payload = {
    type: "view_submission",
    user: { id: "Usubmit", username: "slackuser" },
    view: {
      callback_id: DOCS_QUERY_CALLBACK_ID,
      private_metadata: JSON.stringify(opts.meta ?? {}),
      state: { values },
    },
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
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
    embeddingClient,
    chatLlm: fakeChatLlm,
    slackPostResponse: postResponse,
    graphMcpClient: fakeGraphClient,
  });
  seeded = await seedUsers(app);
  adminCookie = seeded.adminCookie;
  ({ projectId: ticketProjectId } = await createProject("slack-proj"));
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
  postResponse.mockClear();
  availabilityOverride = null;
  streamOverride = null;
  lastChatInput = null;
  fakeGraphClient.reset();
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

  // Almeno un progetto CON documentazione deve esistere, altrimenti il modal non
  // si apre (lo static_select non può avere zero option → messaggio effimero).
  beforeAll(async () => {
    const { repositoryId } = await createProject(`docscmd-${randomUUID().slice(0, 8)}`);
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "Pagina docs cmd",
      slug: `docscmd-page-${randomUUID().slice(0, 8)}`,
      content: "Documentazione per i test del comando /docs.",
    });
  });

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
    // Selettore progetto (static_select coi progetti con docs) + input domanda.
    expect(hasElementOfType(view, "static_select")).toBe(true);
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

  /** Estrae i `value` (projectId) delle option dello static_select progetto. */
  function selectOptionValues(view: unknown): string[] {
    const blocks = (view as { blocks?: unknown[] }).blocks ?? [];
    for (const b of blocks) {
      const el = (b as { element?: { type?: string; options?: { value: string }[] } }).element;
      if (el?.type === "static_select") return (el.options ?? []).map((o) => o.value);
    }
    return [];
  }

  it("il selettore elenca SOLO i progetti con documentazione (esclude quelli senza alcun repo documentato)", async () => {
    await testDb.db
      .update(users)
      .set({ slackUserId: "Udocslinked" })
      .where(eq(users.id, reporterUserId));

    // Progetto CON docs: un suo repository ha una pagina visibile → compare col
    // suo projectId. Il valore dell'option è il PROGETTO, non il repository.
    const projWithDocs = await createProjectGroup(`sel-with-${randomUUID().slice(0, 8)}`);
    const repoWithDocs = await createRepoInProject(
      projWithDocs,
      `sel-with-repo-${randomUUID().slice(0, 8)}`,
    );
    await seedDocsForRepo(testDb.db, repoWithDocs, {
      title: "Pagina sel",
      slug: `sel-page-${randomUUID().slice(0, 8)}`,
      content: "Contenuto del repository documentato.",
    });
    // Progetto SENZA alcun repo documentato (un repo, ma nessuna pagina): NON compare.
    const projWithoutDocs = await createProjectGroup(`sel-without-${randomUUID().slice(0, 8)}`);
    await createRepoInProject(projWithoutDocs, `sel-without-repo-${randomUUID().slice(0, 8)}`);

    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fdocs&trigger_id=TRIGSEL&user_id=Udocslinked&channel_id=C1&response_url=https%3A%2F%2Fhooks.slack.com%2Fsel",
    );
    expect(res.statusCode).toBe(200);
    const [, view] = openView.mock.calls[0]!;
    const values = selectOptionValues(view);
    expect(values).toContain(projWithDocs);
    expect(values).not.toContain(projWithoutDocs);
  });

  it("comando con namespace (/stubwise:docs) → apre comunque il modale Docs", async () => {
    await testDb.db
      .update(users)
      .set({ slackUserId: "Udocslinked" })
      .where(eq(users.id, reporterUserId));

    // command=/stubwise:docs urlencoded; il riconoscimento è per suffisso "docs".
    const res = await slackPost(
      "/api/slack/commands",
      "command=%2Fstubwise%3Adocs&trigger_id=TRIGNS&user_id=Udocslinked&channel_id=C7&response_url=https%3A%2F%2Fhooks.slack.com%2Fns&text=domanda",
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [, view] = openView.mock.calls[0]!;
    expect((view as { callback_id: string }).callback_id).toBe(DOCS_QUERY_CALLBACK_ID);
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
      projectId: ticketProjectId,
      title: "Bottone rotto",
      description: "Non funziona il submit",
      type: "bug",
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    const rows = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, ticketProjectId));
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
      projectId: ticketProjectId,
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
      projectId: ticketProjectId,
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
      projectId: ticketProjectId,
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
      projectId: ticketProjectId,
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
      projectId: ticketProjectId,
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
    const before = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, ticketProjectId));
    // Titolo assente.
    const body = viewSubmissionBody({ projectId: ticketProjectId, type: "bug" });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors[BLOCK_IDS.title]).toBeTruthy();

    const after = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, ticketProjectId));
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
    const body = viewSubmissionBody({ projectId: ticketProjectId, title: "x", type: "bug" });
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

describe("POST /api/slack/interactions — view_submission docs_query", () => {
  const META_USER = "Udocsubmit";
  const RESPONSE_URL = "https://hooks.slack.com/docs-resp";

  /** Link l'utente del submit a uno Stubwise user (ri-auth ok). */
  async function linkSubmitter(slackUserId = META_USER): Promise<void> {
    await testDb.db
      .update(users)
      .set({ slackUserId })
      .where(eq(users.id, reporterUserId));
  }

  it("progetto+domanda presenti, utente collegato → ack 200 e risposta postata in_channel con citazioni (link col repositoryId, nome repo nelle Fonti)", async () => {
    await linkSubmitter();
    const projectId = await createProjectGroup(`ask-${randomUUID().slice(0, 8)}`);
    const repoName = `ask-repo-${randomUUID().slice(0, 8)}`;
    const repositoryId = await createRepoInProject(projectId, repoName);
    const slug = `ask-page-${randomUUID().slice(0, 8)}`;
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "Come si configura",
      slug,
      content: "Per configurare il sistema apri le impostazioni.",
    });

    const body = docsSubmissionBody({
      // Il value del selettore è il PROGETTO (cross-repo), non il repository.
      projectId,
      question: "Come si configura il sistema?",
      meta: { responseUrl: RESPONSE_URL, channelId: "C9", slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    // Ack immediato (entro 3s): 200 vuoto, NON aspetta il RAG.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    // La POST differita è fire-and-forget: attendi che lo spy sia invocato.
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [url, payload] = postResponse.mock.calls[0]!;
    expect(url).toBe(RESPONSE_URL);
    const p = payload as { response_type: string; blocks: unknown[] };
    expect(p.response_type).toBe("in_channel");
    const flat = JSON.stringify(p.blocks);
    // La risposta canned del fake LLM + un link citazione verso la pagina, col
    // REPOSITORY id (non il projectId) e il NOME del repository nel testo.
    expect(flat).toContain("Risposta dai docs.");
    expect(flat).toContain(`${PUBLIC_URL}/docs/${repositoryId}/${slug}`);
    expect(flat).toContain("Come si configura");
    expect(flat).toContain(repoName);
  });

  it("progetto con DUE repository documentati: la risposta aggrega cross-repo e cita ogni fonte col SUO repositoryId/nome", async () => {
    await linkSubmitter();
    // Un solo progetto con due repo A e B, ciascuno con la propria pagina. Il
    // retrieval è cross-repo (answerProjectDocsQuestion): entrambe le pagine sono
    // candidate e ciascuna citazione linka il PROPRIO repository.
    const projectId = await createProjectGroup(`agg-${randomUUID().slice(0, 8)}`);
    const repoNameA = `agg-repoA-${randomUUID().slice(0, 8)}`;
    const repoA = await createRepoInProject(projectId, repoNameA);
    const slugA = `agg-a-${randomUUID().slice(0, 8)}`;
    await seedDocsForRepo(testDb.db, repoA, {
      title: "Pagina del repo A",
      slug: slugA,
      content: "Per configurare il deploy apri il pannello deploy del repo A.",
    });
    const repoNameB = `agg-repoB-${randomUUID().slice(0, 8)}`;
    const repoB = await createRepoInProject(projectId, repoNameB);
    const slugB = `agg-b-${randomUUID().slice(0, 8)}`;
    await seedDocsForRepo(testDb.db, repoB, {
      title: "Pagina del repo B",
      slug: slugB,
      content: "Per configurare il deploy apri il pannello deploy del repo B.",
    });

    const body = docsSubmissionBody({
      projectId,
      question: "Per configurare il deploy apri il pannello deploy.",
      meta: { responseUrl: RESPONSE_URL, channelId: "C9", slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const flat = JSON.stringify((payload as { blocks: unknown[] }).blocks);
    // Entrambe le fonti sono citate, ognuna col proprio repositoryId e nome repo.
    expect(flat).toContain(`${PUBLIC_URL}/docs/${repoA}/${slugA}`);
    expect(flat).toContain(`${PUBLIC_URL}/docs/${repoB}/${slugB}`);
    expect(flat).toContain(repoNameA);
    expect(flat).toContain(repoNameB);
  });

  it("domanda mancante → response_action errors, nessuna POST", async () => {
    await linkSubmitter();
    const { projectId } = await createProject(`noq-${randomUUID().slice(0, 8)}`);
    const body = docsSubmissionBody({
      projectId,
      meta: { responseUrl: RESPONSE_URL, slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors[DOCS_BLOCK_IDS.question]).toBeTruthy();
    expect(postResponse).not.toHaveBeenCalled();
  });

  it("utente non più collegato → nessuna risposta-answer, eventuale messaggio 'non collegato'", async () => {
    // Il reporter NON è linkato a META_USER: la ri-auth fallisce.
    const { projectId, repositoryId } = await createProject(`unlinked-${randomUUID().slice(0, 8)}`);
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "X",
      slug: `x-${randomUUID().slice(0, 8)}`,
      content: "y",
    });
    const body = docsSubmissionBody({
      projectId,
      question: "Domanda qualsiasi?",
      meta: { responseUrl: RESPONSE_URL, slackUserId: "Umai-collegato" },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    // Una sola POST (il "non collegato"), MAI la risposta RAG in_channel.
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const inChannel = postResponse.mock.calls.find(
      ([, payload]) => (payload as { response_type?: string }).response_type === "in_channel",
    );
    expect(inChannel).toBeUndefined();
    const [, payload] = postResponse.mock.calls[0]!;
    expect((payload as { text: string }).text).toContain("Non sei più collegato");
  });

  it("chatLlm non disponibile → messaggio d'errore 'non disponibile'", async () => {
    await linkSubmitter();
    availabilityOverride = { available: false, reason: "no_api_key_provider" };
    const { projectId, repositoryId } = await createProject(`unavail-${randomUUID().slice(0, 8)}`);
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "X",
      slug: `x-${randomUUID().slice(0, 8)}`,
      content: "y",
    });
    const body = docsSubmissionBody({
      projectId,
      question: "Domanda?",
      meta: { responseUrl: RESPONSE_URL, slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const p = payload as { response_type: string; text: string };
    expect(p.response_type).toBe("ephemeral");
    expect(p.text).toContain("non è disponibile");
  });

  it("answerProjectDocsQuestion che lancia → messaggio d'errore, nessun throw/5xx", async () => {
    await linkSubmitter();
    // Stream che lancia: simula un fallimento di generazione/retrieval. Yield
    // condizionale a `false` per soddisfare il tipo AsyncIterable<string> senza
    // codice irraggiungibile.
    streamOverride = async function* (): AsyncIterable<string> {
      if (Math.random() < 0) yield "";
      throw new Error("boom LLM");
    };
    const { projectId, repositoryId } = await createProject(`boom-${randomUUID().slice(0, 8)}`);
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "X",
      slug: `x-${randomUUID().slice(0, 8)}`,
      content: "y",
    });
    const body = docsSubmissionBody({
      projectId,
      question: "Domanda?",
      meta: { responseUrl: RESPONSE_URL, slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const p = payload as { response_type: string; text: string };
    expect(p.response_type).toBe("ephemeral");
    expect(p.text).toContain("Errore durante la ricerca");
  });

  it("repo del progetto col grafo done → il system contiene il blocco STRUTTURA DEL CODICE", async () => {
    // Slack /docs è una superficie INTERNA al team: riceve il retrieval dal
    // knowledge graph come le chat Docs della SPA (fase 2b).
    await linkSubmitter();
    const { projectId, repositoryId } = await createProject(`graph-${randomUUID().slice(0, 8)}`);
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "Sessioni",
      slug: `graph-page-${randomUUID().slice(0, 8)}`,
      content: "La sessione nasce al login.",
    });
    await testDb.db
      .update(repositories)
      .set({ graphEnabled: true })
      .where(eq(repositories.id, repositoryId));
    await testDb.db
      .insert(repoGraphs)
      .values({ repositoryId, status: "done", commitSha: "abcdef1234567890" });
    // Sottografo finto SENZA righe `NODE`: nessuna lettura dai mirror nei test.
    const subgraph = "TRAVERSAL da 'sessione'\nEDGE login() -> createSession()";
    fakeGraphClient.response = subgraph;

    const question = "Chi crea la sessione al login?";
    const body = docsSubmissionBody({
      projectId,
      question,
      meta: { responseUrl: RESPONSE_URL, slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());

    const system = lastChatInput!.system;
    expect(system).toContain("STRUTTURA DEL CODICE");
    expect(system).toContain(subgraph);
    // Il blocco resta in coda, dopo le pagine di documentazione.
    expect(system.indexOf("--- CONTESTO RECUPERATO ---")).toBeLessThan(
      system.indexOf("STRUTTURA DEL CODICE"),
    );
    // Una query, sulla domanda dell'utente e sul grafo del repo del progetto.
    expect(fakeGraphClient.calls.length).toBe(1);
    expect(fakeGraphClient.calls[0]!.question).toBe(question);
    expect(fakeGraphClient.calls[0]!.projectPath).toBe(`/graphs/${repositoryId}`);
  });

  it("nessun grafo nel progetto: nessuna query e system senza blocco (risposta invariata)", async () => {
    await linkSubmitter();
    const { projectId, repositoryId } = await createProject(`nograph-${randomUUID().slice(0, 8)}`);
    await seedDocsForRepo(testDb.db, repositoryId, {
      title: "Sessioni",
      slug: `nograph-page-${randomUUID().slice(0, 8)}`,
      content: "La sessione nasce al login.",
    });
    fakeGraphClient.response = "TRAVERSAL mai richiesto";

    const body = docsSubmissionBody({
      projectId,
      question: "Chi crea la sessione al login?",
      meta: { responseUrl: RESPONSE_URL, slackUserId: META_USER },
    });
    const res = await slackPost("/api/slack/interactions", body);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());

    expect(fakeGraphClient.calls.length).toBe(0);
    expect(lastChatInput!.system).not.toContain("STRUTTURA DEL CODICE");
    // La risposta è quella di sempre.
    const [, payload] = postResponse.mock.calls[0]!;
    expect(JSON.stringify(payload)).toContain("Risposta dai docs.");
  });
});

describe("POST /api/slack/interactions — block_actions dell'inbox", () => {
  const ADMIN_SLACK = "UADMINBOX";
  const MEMBER_SLACK = "UMEMBERBOX";
  const RESPONSE_URL = "https://hooks.slack.com/inbox-resp";

  /** Evento `job.plan_review` realistico (il kind con le azioni decisionali). */
  function planReviewEvent(): Record<string, unknown> {
    return {
      kind: "job.plan_review",
      ticketNumber: 7,
      ticketTitle: "Export CSV dello storico",
      projectName: "negozio-web",
      ticketUrl: `${PUBLIC_URL}/tickets/7`,
    };
  }

  /** Riga d'inbox di un utente, ancorata a ticket e job. */
  async function seedNotification(input: {
    userId: string;
    ticketId?: string;
    jobId?: string;
    kind?: "job.plan_review" | "job.failed" | "job.awaiting_input";
    event?: Record<string, unknown>;
    status?: "open" | "handled";
  }): Promise<string> {
    const kind = input.kind ?? "job.plan_review";
    const [row] = await testDb.db
      .insert(notifications)
      .values({
        userId: input.userId,
        kind,
        event: input.event ?? { ...planReviewEvent(), kind },
        ticketId: input.ticketId ?? null,
        jobId: input.jobId ?? null,
        projectId: ticketProjectId,
        status: input.status ?? "open",
        handledAt: input.status === "handled" ? new Date() : null,
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  /** Ticket del progetto di test, con piano opzionale. */
  async function seedTicket(plan?: string): Promise<string> {
    const ticket = await createTicket(testDb.db, {
      projectId: ticketProjectId,
      title: `Ticket ${randomUUID().slice(0, 8)}`,
      type: "bug",
      priority: "medium",
      source: "manual",
      ...(plan === undefined ? {} : { implementationPlan: plan }),
    });
    return ticket.id;
  }

  async function seedJob(
    ticketId: string,
    status: "awaiting_plan_approval" | "fixing" | "failed",
  ): Promise<string> {
    const [row] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status })
      .returning({ id: aiJobs.id });
    return row!.id;
  }

  async function readJob(jobId: string) {
    const [row] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  async function readNotification(id: string) {
    const [row] = await testDb.db.select().from(notifications).where(eq(notifications.id, id));
    return row;
  }

  /** Le consegne `slack_update` accodate (una per copia da riscrivere). */
  async function slackUpdates() {
    return testDb.db
      .select({
        notificationId: notificationDeliveries.notificationId,
        event: notificationDeliveries.event,
        status: notificationDeliveries.status,
      })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.channel, "slack_update"));
  }

  /** Raw body urlencoded di un `block_actions` sui bottoni del DM d'inbox. */
  function blockActionsBody(opts: {
    actionId: string;
    notificationId?: string;
    blockId?: string;
    selectedValue?: string;
    userId?: string;
    withResponseUrl?: boolean;
  }): string {
    const action: Record<string, unknown> = { action_id: opts.actionId };
    const blockId =
      opts.blockId ?? (opts.notificationId ? `inbox:${opts.notificationId}` : undefined);
    if (blockId !== undefined) action.block_id = blockId;
    if (opts.notificationId) action.value = opts.notificationId;
    if (opts.selectedValue) action.selected_option = { value: opts.selectedValue };
    const payload = {
      type: "block_actions",
      user: { id: opts.userId ?? ADMIN_SLACK },
      trigger_id: "TRIG-INBOX",
      ...(opts.withResponseUrl === false ? {} : { response_url: RESPONSE_URL }),
      actions: [action],
    };
    return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  }

  /** Raw body urlencoded del submit del modal di rifiuto. */
  function rejectSubmissionBody(opts: {
    notificationId?: string;
    instructions?: string;
    userId?: string;
  }): string {
    const values: Record<string, Record<string, unknown>> = {};
    if (opts.instructions !== undefined) {
      values[INBOX_REJECT_BLOCK_ID] = { [INBOX_REJECT_ACTION_ID]: { value: opts.instructions } };
    }
    const payload = {
      type: "view_submission",
      user: { id: opts.userId ?? ADMIN_SLACK },
      view: {
        callback_id: INBOX_REJECT_PLAN_CALLBACK_ID,
        private_metadata: opts.notificationId ?? "",
        state: { values },
      },
    };
    return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  }

  beforeEach(async () => {
    // Slack abilitato anche se questo describe gira da solo (`-t`): senza
    // credenziali /interactions risponderebbe 200 vuoto a tutto.
    await setSlackCreds(true);
    // Inbox e outbox puliti: i test contano righe e consegne.
    await testDb.db.delete(notifications);
    await testDb.db.delete(notificationDeliveries);
    // Admin e member collegati a Slack (il ramo inbox risolve l'identità dal DB).
    await testDb.db
      .update(users)
      .set({ slackUserId: ADMIN_SLACK })
      .where(eq(users.id, seeded.adminId));
    await testDb.db
      .update(users)
      .set({ slackUserId: MEMBER_SLACK })
      .where(eq(users.id, seeded.memberId));
  });

  it("firma non valida → 401, nessuna azione eseguita", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:approve_plan", notificationId: id }),
      { sign: false },
    );
    expect(res.statusCode).toBe(401);
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
    expect(postResponse).not.toHaveBeenCalled();
  });

  it("action_id non dell'inbox → ack vuoto e nient'altro", async () => {
    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "altro_flusso:qualcosa", blockId: "b1" }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(postResponse).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();
  });

  it("inbox:open → solo ack (è un bottone link)", async () => {
    const id = await seedNotification({ userId: seeded.adminId });
    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:open", notificationId: id }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(postResponse).not.toHaveBeenCalled();
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("utente Slack non collegato → ack + effimero 'collega l'account'", async () => {
    const id = await seedNotification({ userId: seeded.adminId });
    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({
        actionId: "inbox:handled",
        notificationId: id,
        userId: "Uestraneo",
      }),
    );
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [url, payload] = postResponse.mock.calls[0]!;
    expect(url).toBe(RESPONSE_URL);
    const p = payload as { response_type: string; text: string };
    expect(p.response_type).toBe("ephemeral");
    expect(p.text).toContain("not linked");
    // Nessuna azione eseguita per conto di nessuno.
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("inbox:approve_plan da admin → ack immediato, job in coda, messaggio riscritto e copie propagate", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const mine = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    const theirs = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:approve_plan", notificationId: mine }),
    );
    // Ack vuoto e immediato: il lavoro è tutto dopo.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [url, payload] = postResponse.mock.calls[0]!;
    expect(url).toBe(RESPONSE_URL);
    const p = payload as { replace_original: boolean; text: string; blocks: unknown[] };
    expect(p.replace_original).toBe(true);
    expect(p.text).toContain("✅");
    expect(p.text).toContain("admin@example.com");
    // Testo originale della notifica conservato sopra la nota.
    expect(p.text).toContain("Export CSV dello storico");
    // Nessun blocco `actions`: la notifica non è più azionabile da lì.
    expect(p.blocks.some((b) => (b as { type?: string }).type === "actions")).toBe(false);

    expect((await readJob(jobId))?.status).toBe("queued");
    expect((await readJob(jobId))?.resumeMode).toBe("execute");
    expect((await readNotification(mine))?.status).toBe("handled");

    // TUTTE le copie passano dalla coda, la propria inclusa: ad accodarle è il
    // servizio (`resolvePlan`), che lo fa per ogni superficie — anche per chi
    // decide dalla pagina ticket, che di Slack non sa nulla. La riscrittura via
    // response_url qui sopra è solo la scorciatoia per il feedback immediato, e
    // il passaggio del poller riscriverà lo stesso contenuto.
    await vi.waitFor(async () => expect(await slackUpdates()).toHaveLength(2));
    const updates = await slackUpdates();
    expect(updates.map((u) => u.notificationId).sort()).toEqual([mine, theirs].sort());
    for (const update of updates) {
      expect(update.status).toBe("pending");
      expect((update.event as { note: string }).note).toContain("admin@example.com");
    }
  });

  it("inbox:approve_plan da member → effimero forbidden, job intatto", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({
        actionId: "inbox:approve_plan",
        notificationId: id,
        userId: MEMBER_SLACK,
      }),
    );
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const p = payload as { response_type: string; replace_original: boolean; text: string };
    expect(p.response_type).toBe("ephemeral");
    // Il messaggio NON viene sostituito: i bottoni restano dov'erano.
    expect(p.replace_original).toBe(false);
    expect(p.text).toContain("Administrators only");
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
    expect(await slackUpdates()).toHaveLength(0);
  });

  it("notifica già gestita → effimero che dice CHI l'ha gestita", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    // Prima azione: la chiude.
    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:handled", notificationId: id }),
    );
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    postResponse.mockClear();

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:approve_plan", notificationId: id }),
    );
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const p = payload as { response_type: string; text: string };
    expect(p.response_type).toBe("ephemeral");
    expect(p.text).toContain("admin@example.com");
  });

  it("inbox:snooze dal menù → rinviata, messaggio riscritto e NESSUNA propagazione", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const mine = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    const theirs = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({
        actionId: "inbox:snooze",
        notificationId: mine,
        selectedValue: "1h",
      }),
    );
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const p = payload as { replace_original: boolean; text: string; blocks: unknown[] };
    expect(p.replace_original).toBe(true);
    expect(p.text).toContain("⏰");
    expect(p.blocks.some((b) => (b as { type?: string }).type === "actions")).toBe(false);

    const row = await readNotification(mine);
    expect(row?.status).toBe("snoozed");
    expect(row?.snoozedUntil).not.toBeNull();
    // Rinvio PERSONALE: la copia del collega resta aperta e non viene riscritta.
    expect((await readNotification(theirs))?.status).toBe("open");
    // In coda c'è solo il PROPRIO DM: i bottoni devono sparire anche quando a
    // rinviare è stata l'inbox web, quindi ad accodarlo è il servizio.
    await vi.waitFor(async () => expect(await slackUpdates()).toHaveLength(1));
    const updates = await slackUpdates();
    expect(updates[0]!.notificationId).toBe(mine);
  });

  it("inbox:snooze senza durata scelta → effimero invalid_action, notifica intatta", async () => {
    const id = await seedNotification({ userId: seeded.adminId });

    const res = await slackPost(
      "/api/slack/interactions",
      // Nessun `selected_option`: il servizio rifiuta la durata mancante.
      blockActionsBody({ actionId: "inbox:snooze", notificationId: id }),
    );
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const [, payload] = postResponse.mock.calls[0]!;
    const p = payload as { response_type: string; replace_original: boolean; text: string };
    expect(p.response_type).toBe("ephemeral");
    expect(p.replace_original).toBe(false);
    expect(p.text).toContain("not available");
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("block_actions con actions vuoto → ack secco, nessun effetto", async () => {
    const payload = {
      type: "block_actions",
      user: { id: ADMIN_SLACK },
      trigger_id: "TRIG-INBOX",
      response_url: RESPONSE_URL,
      actions: [],
    };
    const res = await slackPost(
      "/api/slack/interactions",
      new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(postResponse).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();
  });

  it("inbox:reject_plan → apre il modal col notificationId, senza eseguire nulla", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:reject_plan", notificationId: id }),
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [triggerId, view] = openView.mock.calls[0]!;
    expect(triggerId).toBe("TRIG-INBOX");
    const v = view as { callback_id: string; private_metadata: string };
    expect(v.callback_id).toBe(INBOX_REJECT_PLAN_CALLBACK_ID);
    expect(v.private_metadata).toBe(id);
    // Nessuna decisione: la prende il submit del modal.
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
    expect(postResponse).not.toHaveBeenCalled();
  });

  it("view_submission inbox_reject_plan con istruzioni → commento, job ripianificato e update anche per la PROPRIA copia", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const mine = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    const theirs = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await slackPost(
      "/api/slack/interactions",
      rejectSubmissionBody({
        notificationId: mine,
        instructions: "Usa il repository dei report, non quello del checkout",
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    const rows = await testDb.db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.ticketId, ticketId));
    expect(rows.some((r) => r.body.includes("repository dei report"))).toBe(true);
    expect((await readJob(jobId))?.status).toBe("queued");
    expect((await readJob(jobId))?.resumeMode).toBe("fix");

    // Senza response_url del messaggio, ANCHE la propria copia passa dalla coda.
    const updates = await slackUpdates();
    expect(updates.map((u) => u.notificationId).sort()).toEqual([mine, theirs].sort());
    for (const update of updates) {
      expect((update.event as { note: string }).note).toContain("🚫");
    }
  });

  // --- DOMANDA dell'agente: bottoni dinamici e modal "Altro…" ---------------

  /** Domanda aperta: job fermo su `awaiting_input`, riga in agent_questions, DM. */
  async function seedQuestion(
    opts: {
      requestedByUserId?: string;
      recipientId?: string;
      allowFreeText?: boolean;
      options?: { label: string; consequence?: string }[];
    } = {},
  ): Promise<{ ticketId: string; jobId: string; questionId: string; notificationId: string }> {
    const ticketId = await seedTicket();
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "awaiting_input",
        ...(opts.requestedByUserId ? { requestedByUserId: opts.requestedByUserId } : {}),
      })
      .returning({ id: aiJobs.id });
    // La riga persistita e il payload della notifica portano le STESSE opzioni:
    // è l'invariante su cui regge l'indice del bottone.
    const options = opts.options ?? [
      { label: "Colonne vecchie", consequence: "Gli export esistenti restano validi." },
      { label: "Colonne nuove", consequence: "Rompe gli script dei clienti." },
    ];
    const [question] = await testDb.db
      .insert(agentQuestions)
      .values({
        jobId: job!.id,
        ticketId,
        round: 1,
        question: "Quali colonne deve avere il CSV?",
        options,
        recommendedIndex: 0,
        allowFreeText: opts.allowFreeText ?? true,
      })
      .returning({ id: agentQuestions.id });
    const notificationId = await seedNotification({
      userId: opts.recipientId ?? seeded.adminId,
      ticketId,
      jobId: job!.id,
      kind: "job.awaiting_input",
      event: {
        kind: "job.awaiting_input",
        ticketNumber: 7,
        ticketTitle: "Export CSV dello storico",
        projectName: "negozio-web",
        ticketUrl: `${PUBLIC_URL}/tickets/7`,
        questionId: question!.id,
        round: 1,
        question: "Quali colonne deve avere il CSV?",
        options,
        recommendedIndex: 0,
        allowFreeText: opts.allowFreeText ?? true,
      },
    });
    return { ticketId, jobId: job!.id, questionId: question!.id, notificationId };
  }

  async function readQuestion(id: string) {
    const [row] = await testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, id));
    return row;
  }

  /** Raw body urlencoded del submit del modal "Altro…". */
  function answerSubmissionBody(opts: {
    notificationId?: string;
    text?: string;
    userId?: string;
  }): string {
    const values: Record<string, Record<string, unknown>> = {};
    if (opts.text !== undefined) {
      values[INBOX_ANSWER_BLOCK_ID] = { [INBOX_ANSWER_ACTION_ID]: { value: opts.text } };
    }
    const payload = {
      type: "view_submission",
      user: { id: opts.userId ?? ADMIN_SLACK },
      view: {
        callback_id: INBOX_ANSWER_CALLBACK_ID,
        private_metadata: opts.notificationId ?? "",
        state: { values },
      },
    };
    return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  }

  it("inbox:answer:1 → risposta scritta, job ripartito e messaggio riscritto con la risposta", async () => {
    const { jobId, questionId, notificationId } = await seedQuestion();

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer:1", notificationId }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    await vi.waitFor(async () => {
      expect((await readQuestion(questionId))?.answer).toEqual({ optionIndex: 1 });
    });
    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("plan_continue");
    expect((await readNotification(notificationId))?.status).toBe("handled");

    // La propria copia si riscrive subito, e la nota PORTA la risposta.
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const payload = postResponse.mock.calls.at(-1)![1] as {
      replace_original: boolean;
      text: string;
    };
    expect(payload.replace_original).toBe(true);
    expect(payload.text).toContain("Colonne nuove");
    expect(payload.text).toContain("admin@example.com");
  });

  it("end-to-end: il bottone premuto registra l'opzione LETTA, con 5 opzioni nel payload", async () => {
    // Il test parte dai blocchi VERI: si legge l'etichetta sul bottone, lo si
    // "preme" col suo action_id e si verifica che la riga persistita porti
    // quella stessa etichetta. È il giro completo che una compattazione degli
    // indici — nei blocchi o nella nota — romperebbe in silenzio.
    const options = [
      { label: "Colonne vecchie" },
      { label: "Colonne nuove", consequence: "Rompe gli script dei clienti." },
      { label: "Entrambe" },
      { label: "Nessuna delle due" },
      { label: "Chiedi al cliente" },
    ];
    const { questionId, notificationId } = await seedQuestion({ options });
    const [notification] = await testDb.db
      .select({ event: notifications.event })
      .from(notifications)
      .where(eq(notifications.id, notificationId));

    const blocks = buildQuestionBlocks({
      text: "❓ domanda",
      event: notification!.event,
      actions: ["answer", "open", "snooze"],
      notificationId,
      lang: "en",
    }) as { type: string; elements?: { action_id: string; text?: { text: string } }[] }[];
    const buttons = (blocks.find((b) => b.type === "actions")?.elements ?? []).filter((el) =>
      el.action_id.startsWith("inbox:answer:"),
    );
    // Il payload ne ha 5, i bottoni si fermano a 4: il taglio è di prefisso.
    expect(buttons).toHaveLength(4);
    const pressed = buttons.find((b) => b.text?.text.includes("Nessuna delle due"))!;
    expect(pressed.action_id).toBe("inbox:answer:3");

    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: pressed.action_id, notificationId }),
    );

    await vi.waitFor(async () => {
      expect((await readQuestion(questionId))?.answer).not.toBeNull();
    });
    const question = await readQuestion(questionId);
    const answer = question?.answer as { optionIndex: number };
    // L'indice registrato punta all'opzione la cui etichetta stava sul bottone.
    const persisted = (question?.options as { label: string }[])[answer.optionIndex];
    expect(persisted?.label).toBe("Nessuna delle due");
    // La scrittura su DB e la nota a Slack sono due `await` sequenziali nello
    // stesso handler asincrono (mai atteso dalla richiesta HTTP, che risponde
    // subito): il `vi.waitFor` sopra osserva solo il primo. Senza aspettare
    // ANCHE `postResponse` (come fanno gli altri test di questo file, es. la
    // riga con `expect(postResponse).toHaveBeenCalled()` più sopra), c'è una
    // finestra reale — fra i due `await` — in cui il DB è già scritto ma la
    // nota non è ancora partita: `.mock.calls.at(-1)` prende `undefined`.
    // Era esattamente questo il fallimento visto la prima volta che la CI ha
    // girato su questo branch (mai eseguita prima d'ora).
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    // E la nota parla della stessa opzione, non di un'altra.
    const payload = postResponse.mock.calls.at(-1)![1] as { text: string };
    expect(payload.text).toContain("Nessuna delle due");
    expect(payload.text).not.toContain("Colonne vecchie");
  });

  it("payload divergente dalla riga persistita: la nota immediata resta ancorata all'INDICE, non a un elenco filtrato", async () => {
    // Scenario difensivo: un messaggio vecchio il cui payload non combacia più
    // con `agent_questions` (i bottoni di un payload così oggi non esistono —
    // `readOptions` fa bail-out — ma l'action_id di un DM già inviato sì).
    // L'indice che arriva è quello delle opzioni PERSISTITE: chi rende la nota
    // deve leggerlo posizionalmente, o racconterà un'altra scelta.
    const persisted = [
      { label: "Alfa" },
      { label: "Bravo" },
      { label: "Charlie" },
      { label: "Delta" },
    ];
    const { questionId, notificationId } = await seedQuestion({ options: persisted });
    // Il payload della notifica ha la prima voce inutilizzabile: un elenco
    // FILTRATO farebbe scalare tutto di uno e l'indice 1 diventerebbe "Charlie".
    await testDb.db
      .update(notifications)
      .set({
        event: {
          ...((
            await testDb.db
              .select({ event: notifications.event })
              .from(notifications)
              .where(eq(notifications.id, notificationId))
          )[0]!.event as Record<string, unknown>),
          options: [{ label: "   " }, ...persisted.slice(1)],
        },
      })
      .where(eq(notifications.id, notificationId));

    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer:1", notificationId }),
    );

    await vi.waitFor(async () => {
      expect((await readQuestion(questionId))?.answer).toEqual({ optionIndex: 1 });
    });
    const payload = postResponse.mock.calls.at(-1)![1] as { text: string };
    expect(payload.text).toContain("Bravo");
    expect(payload.text).not.toContain("Charlie");
  });

  it("una risposta lunga non sfora la section: la nota è accorciata una volta sola", async () => {
    // Etichetta enorme (la scrive l'agente) sul percorso `response_url`: senza
    // troncatura la POST porterebbe una section oltre i 3000 caratteri e
    // fallirebbe in silenzio, lasciando chi ha risposto senza feedback.
    const huge = "A".repeat(4000);
    const { notificationId } = await seedQuestion({
      options: [{ label: huge, consequence: "B".repeat(4000) }, { label: "Corta" }],
    });

    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer:0", notificationId }),
    );
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const payload = postResponse.mock.calls.at(-1)![1] as {
      text: string;
      blocks: { type: string; text?: { text: string } }[];
    };
    for (const block of payload.blocks.filter((b) => b.type === "section")) {
      expect(block.text!.text.length).toBeLessThanOrEqual(3000);
    }
    expect(payload.text).toContain("…");
    expect(payload.text.length).toBeLessThanOrEqual(3000);
  });

  it("risposta libera lunghissima: persistita intera, accorciata SOLO nelle note dei DM", async () => {
    const { jobId, questionId, notificationId } = await seedQuestion();
    await seedNotification({ userId: seeded.memberId, kind: "job.awaiting_input", jobId });
    // 4000 caratteri: il massimo che il modal ammette, un'azione utente normale.
    const long = "parola ".repeat(570).trim();
    expect(long.length).toBeGreaterThan(3500);

    const res = await slackPost(
      "/api/slack/interactions",
      answerSubmissionBody({ notificationId, text: long }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    // Sul ticket e nella riga resta INTERA: è il DM che è una didascalia.
    expect((await readQuestion(questionId))?.answer).toEqual({ text: long });
    const updates = await slackUpdates();
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      const note = (update.event as { note: string }).note;
      expect(note.length).toBeLessThan(400);
      expect(note).toContain("…");
    }
  });

  it("indice fuori dalle opzioni → effimero, nessuna risposta scritta", async () => {
    const { jobId, questionId, notificationId } = await seedQuestion();

    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer:9", notificationId }),
    );
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const payload = postResponse.mock.calls[0]![1] as { response_type: string; text: string };
    expect(payload.response_type).toBe("ephemeral");
    expect(payload.text).toContain("not valid");
    expect((await readQuestion(questionId))?.answer).toBeNull();
    expect((await readJob(jobId))?.status).toBe("awaiting_input");
  });

  it("member che non ha chiesto il run → effimero forbidden, domanda intatta", async () => {
    const { questionId, notificationId } = await seedQuestion({
      requestedByUserId: seeded.adminId,
      recipientId: seeded.memberId,
    });

    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer:0", notificationId, userId: MEMBER_SLACK }),
    );
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const payload = postResponse.mock.calls[0]![1] as { response_type: string; text: string };
    expect(payload.response_type).toBe("ephemeral");
    expect(payload.text).toContain("Administrators only");
    expect((await readQuestion(questionId))?.answer).toBeNull();
  });

  it("domanda già risposta da un altro → effimero che ne dice l'email", async () => {
    const { questionId, notificationId } = await seedQuestion();
    await testDb.db
      .update(agentQuestions)
      .set({ answer: { optionIndex: 0 }, answeredAt: new Date(), answeredByUserId: seeded.memberId })
      .where(eq(agentQuestions.id, questionId));

    await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer:1", notificationId }),
    );
    await vi.waitFor(() => expect(postResponse).toHaveBeenCalled());
    const payload = postResponse.mock.calls[0]![1] as { response_type: string; text: string };
    expect(payload.response_type).toBe("ephemeral");
    expect(payload.text).toContain("member@example.com");
    // La risposta di chi è arrivato primo resta.
    expect((await readQuestion(questionId))?.answer).toEqual({ optionIndex: 0 });
  });

  it("inbox:answer_free → apre il modal col notificationId, senza rispondere", async () => {
    const { questionId, notificationId } = await seedQuestion();

    const res = await slackPost(
      "/api/slack/interactions",
      blockActionsBody({ actionId: "inbox:answer_free", notificationId }),
    );
    expect(res.statusCode).toBe(200);
    expect(openView).toHaveBeenCalledTimes(1);
    const [triggerId, view] = openView.mock.calls[0]!;
    expect(triggerId).toBe("TRIG-INBOX");
    const v = view as { callback_id: string; private_metadata: string };
    expect(v.callback_id).toBe(INBOX_ANSWER_CALLBACK_ID);
    expect(v.private_metadata).toBe(notificationId);
    expect((await readQuestion(questionId))?.answer).toBeNull();
    expect(postResponse).not.toHaveBeenCalled();
  });

  it("view_submission inbox_answer_free → testo libero scritto, job ripartito e copie aggiornate", async () => {
    const { jobId, questionId, notificationId } = await seedQuestion();
    const theirs = await seedNotification({
      userId: seeded.memberId,
      kind: "job.awaiting_input",
      jobId,
    });

    const res = await slackPost(
      "/api/slack/interactions",
      answerSubmissionBody({ notificationId, text: "  Colonne nuove, senza header  " }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    expect((await readQuestion(questionId))?.answer).toEqual({
      text: "Colonne nuove, senza header",
    });
    expect((await readJob(jobId))?.status).toBe("queued");

    // Senza response_url, ANCHE la propria copia passa dalla coda.
    const updates = await slackUpdates();
    expect(updates.map((u) => u.notificationId).sort()).toEqual([notificationId, theirs].sort());
    for (const update of updates) {
      expect((update.event as { note: string }).note).toContain("Colonne nuove, senza header");
    }
  });

  it("la risposta finisce nella nota ESCAPATA: nessun markup iniettato nei DM altrui", async () => {
    const { jobId, notificationId } = await seedQuestion();
    await seedNotification({ userId: seeded.memberId, kind: "job.awaiting_input", jobId });

    await slackPost(
      "/api/slack/interactions",
      answerSubmissionBody({
        notificationId,
        text: "A & B, vedi <https://evil.test|questo link>",
      }),
    );

    const updates = await slackUpdates();
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      const note = (update.event as { note: string }).note;
      expect(note).not.toContain("<https://evil.test|");
      expect(note).toContain("A &amp; B, vedi &lt;https://evil.test|questo link&gt;");
      // Una volta sola: nessuna entità doppia.
      expect(note).not.toContain("&amp;amp;");
    }
  });

  it("view_submission inbox_answer_free col testo vuoto → errore NEL MODAL, nessuna risposta", async () => {
    const { questionId, notificationId } = await seedQuestion();

    const res = await slackPost(
      "/api/slack/interactions",
      answerSubmissionBody({ notificationId, text: "   " }),
    );
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors[INBOX_ANSWER_BLOCK_ID]).toContain("not valid");
    expect((await readQuestion(questionId))?.answer).toBeNull();
  });

  it("view_submission inbox_answer_free da un utente non collegato → errore nel modal", async () => {
    const { questionId, notificationId } = await seedQuestion();

    const res = await slackPost(
      "/api/slack/interactions",
      answerSubmissionBody({ notificationId, text: "Colonne nuove", userId: "Uestraneo" }),
    );
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.errors[INBOX_ANSWER_BLOCK_ID]).toContain("not linked");
    expect((await readQuestion(questionId))?.answer).toBeNull();
    expect(await slackUpdates()).toHaveLength(0);
  });

  it("view_submission inbox_reject_plan da un utente non collegato → errore nel modal, nessuna esecuzione", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });

    const res = await slackPost(
      "/api/slack/interactions",
      rejectSubmissionBody({ notificationId: id, userId: "Uestraneo" }),
    );
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors[INBOX_REJECT_BLOCK_ID]).toContain("not linked");
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
    expect(await slackUpdates()).toHaveLength(0);
  });
});
