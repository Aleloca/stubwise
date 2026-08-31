import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  docChunks,
  docGenerations,
  docPages,
  encrypt,
  instanceSettings,
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
import { createFakeGraphMcpClient, seedUsers } from "../test/fixtures.js";
import type { SlackClient } from "./api.js";
import type { SlackClientFactory } from "./routes.js";
import { ACTION_IDS, BLOCK_IDS, CREATE_TICKET_CALLBACK_ID } from "./modal.js";
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
  ({ adminCookie } = await seedUsers(app));
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
