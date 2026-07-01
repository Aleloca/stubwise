import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  aiJobs,
  comments,
  docAutoUpdateJobs,
  docGenerations,
  instanceSettings,
  notificationSettings,
  projects,
  repositories,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedGitAccount, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PUBLIC_URL = "https://stubwise.example.com";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    // publicUrl configurato: senza, il getter instance.publicUrl lancerebbe e
    // il try/catch best-effort della route inghiottirebbe l'eccezione PRIMA di
    // raggiungere dispatchNotification — il dispatch non verrebbe mai esercitato.
    publicUrl: PUBLIC_URL,
  });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Riporta il singleton di notifica allo stato seedato (webhookUrl null =
  // dispatch no-op), così la configurazione di un test non perde nei successivi.
  await testDb.db
    .update(notificationSettings)
    .set({ webhookUrl: null })
    .where(eq(notificationSettings.id, 1));
  // Ripristina la lingua d'istanza al default 'en' (riga singleton id=1
  // condivisa tra i test): un test che la porta a 'it' non deve influenzare i
  // successivi.
  await testDb.db
    .update(instanceSettings)
    .set({ contentLanguage: "en" })
    .where(eq(instanceSettings.id, 1));
});

/** Porta la lingua dei contenuti d'istanza (singleton id=1) a `lang`. */
async function setContentLanguage(lang: "en" | "it"): Promise<void> {
  await testDb.db
    .update(instanceSettings)
    .set({ contentLanguage: lang })
    .where(eq(instanceSettings.id, 1));
}

interface CreatedProject {
  /** Id del repository (ex "progetto"): è quello usato dal webhook git. */
  id: string;
  /** Id del progetto (gruppo) sotto cui vive il repository. */
  projectId: string;
  slug: string;
  provider: string;
  webhookSecret: string;
}

/**
 * Crea un progetto via API e ne legge il webhookSecret reale dall'endpoint
 * admin dedicato (la proiezione pubblica del progetto non lo espone più).
 * Le credenziali e il provider, passati nel payload in forma "legacy", vengono
 * tradotti nella creazione di un account git dedicato, a cui il progetto si
 * collega: lo shape della creazione progetto è ora { name, gitAccountId, ... }.
 */
async function createProject(payload: Record<string, unknown>): Promise<CreatedProject> {
  const { provider, credentials, name, ...rest } = payload as {
    provider: string;
    credentials: unknown;
    name: string;
    repoUrl?: string;
    defaultBranch?: string;
  };
  const accountRes = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: { name: `${name} — account`, provider, credentials },
  });
  if (accountRes.statusCode !== 201) {
    throw new Error(`creazione account git fallita: ${accountRes.statusCode} ${accountRes.body}`);
  }
  const gitAccountId = (accountRes.json() as { id: string }).id;

  // Progetto (gruppo) sotto cui creare il repository: seedato direttamente.
  const [group] = await testDb.db
    .insert(projects)
    .values({
      name: `${name} — gruppo`,
      slug: `gruppo-${randomBytes(4).toString("hex")}`,
      ingestionKey: randomBytes(16).toString("hex"),
    })
    .returning({ id: projects.id });

  const res = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: { projectId: group!.id, name, gitAccountId, ...rest },
  });
  if (res.statusCode !== 201) {
    throw new Error(`creazione repository fallita: ${res.statusCode} ${res.body}`);
  }
  const repository = res.json() as { id: string; slug: string; provider: string };

  const webhookRes = await app.inject({
    method: "GET",
    url: `/api/repositories/${repository.slug}/webhook`,
    headers: { cookie: adminCookie },
  });
  if (webhookRes.statusCode !== 200) {
    throw new Error(`lettura webhookSecret fallita: ${webhookRes.statusCode} ${webhookRes.body}`);
  }
  const { webhookSecret } = webhookRes.json() as { webhookSecret: string };
  return { ...repository, projectId: group!.id, webhookSecret };
}

/**
 * Aggiunge un SECONDO repository allo stesso progetto (gruppo) di `project`,
 * creandolo via API con lo stesso gitAccount. Restituisce id/slug/secret del
 * nuovo repo: serve ai test multi-repo, dove un ticket ha PR su più repo del
 * medesimo progetto e ogni webhook (per-repo) risolve lo STESSO ticket.
 */
async function addRepository(
  project: CreatedProject,
  payload: Record<string, unknown>,
): Promise<CreatedProject> {
  const { provider, credentials, name, ...rest } = payload as {
    provider: string;
    credentials: unknown;
    name: string;
    repoUrl?: string;
    defaultBranch?: string;
  };
  const accountRes = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: { name: `${name} — account`, provider, credentials },
  });
  if (accountRes.statusCode !== 201) {
    throw new Error(`creazione account git fallita: ${accountRes.statusCode} ${accountRes.body}`);
  }
  const gitAccountId = (accountRes.json() as { id: string }).id;

  const res = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: { projectId: project.projectId, name, gitAccountId, ...rest },
  });
  if (res.statusCode !== 201) {
    throw new Error(`creazione repository fallita: ${res.statusCode} ${res.body}`);
  }
  const repository = res.json() as { id: string; slug: string; provider: string };

  const webhookRes = await app.inject({
    method: "GET",
    url: `/api/repositories/${repository.slug}/webhook`,
    headers: { cookie: adminCookie },
  });
  if (webhookRes.statusCode !== 200) {
    throw new Error(`lettura webhookSecret fallita: ${webhookRes.statusCode} ${webhookRes.body}`);
  }
  const { webhookSecret } = webhookRes.json() as { webhookSecret: string };
  return { ...repository, projectId: project.projectId, webhookSecret };
}

/**
 * Inserisce un ticket con numero e stato espliciti, restituendone l'id. Riceve
 * il repositoryId del repo del webhook: dalla Fase 3 il ticket appartiene solo
 * al PROGETTO (niente repositoryId), e il webhook lo risolve per (progetto del
 * repo, numero). Il progetto del ticket è derivato dal repo passato.
 */
async function insertTicket(
  repositoryId: string,
  number: number,
  status: "in_review" | "done" | "triaged",
): Promise<string> {
  const [repository] = await testDb.db
    .select({ projectId: repositories.projectId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId: repository!.projectId,
      number,
      title: `Ticket ${number}`,
      type: "bug",
      priority: "medium",
      status,
      source: "manual",
    })
    .returning({ id: tickets.id });
  if (!row) throw new Error("insert ticket non ha restituito la riga");
  return row.id;
}

/** Inserisce un job AI con stato esplicito per un ticket, restituendone l'id. */
async function insertJob(ticketId: string, status: "pr_opened" | "failed"): Promise<string> {
  const [row] = await testDb.db
    .insert(aiJobs)
    .values({ ticketId, status, prUrl: "https://github.com/acme/repo/pull/7" })
    .returning({ id: aiJobs.id });
  if (!row) throw new Error("insert job non ha restituito la riga");
  return row.id;
}

/** Legge un job AI per id (status, finishedAt, ...). */
async function jobById(jobId: string) {
  const [row] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
  return row!;
}

/**
 * Inserisce una riga ticket_repositories (stato PR per-repo di un ticket),
 * con prState esplicito (default `open`). Modella l'insieme di PR aperte dal
 * fix multi-repo: una riga per repo effettivamente modificato.
 */
async function seedTicketRepository(
  ticketId: string,
  repositoryId: string,
  prState: "open" | "merged" | "closed_unmerged" = "open",
): Promise<void> {
  await testDb.db.insert(ticketRepositories).values({
    ticketId,
    repositoryId,
    branch: "stubwise/ticket-1",
    prUrl: "https://example.com/pr/1",
    prState,
  });
}

/** Legge lo stato PR (prState) della riga (ticket, repo), o undefined se assente. */
async function repoState(ticketId: string, repositoryId: string): Promise<string | undefined> {
  const [row] = await testDb.db
    .select({ prState: ticketRepositories.prState })
    .from(ticketRepositories)
    .where(
      and(
        eq(ticketRepositories.ticketId, ticketId),
        eq(ticketRepositories.repositoryId, repositoryId),
      ),
    );
  return row?.prState;
}

/** Header firma HMAC-SHA256 (sha256=<hex>) sul raw body, schema condiviso da entrambi i provider. */
function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

const NOTIFY_WEBHOOK_URL = "https://hooks.example.com/stubwise";

/**
 * Configura il singleton `notification_settings` (id=1, seedato dalla
 * migrazione) per il dispatch reale: webhook URL + formato `generic`
 * (payload a campi piatti, comodo da asserire) e gating del solo toggle
 * `notifyPrClosed`. enabled=true, gli altri toggle off (irrilevanti qui).
 */
async function configureNotifications(notifyPrClosed: boolean): Promise<void> {
  await testDb.db
    .update(notificationSettings)
    .set({
      webhookUrl: NOTIFY_WEBHOOK_URL,
      format: "generic",
      enabled: true,
      notifyPrClosed,
    })
    .where(eq(notificationSettings.id, 1));
}

/**
 * Intercetta il POST del webhook di notifica sostituendo il `fetch` globale
 * (quello che dispatchNotification usa di default): cattura url e body parsato
 * e risponde 200. Restituisce l'array delle chiamate catturate, popolato in
 * modo asincrono dal dispatch best-effort. vi.restoreAllMocks (afterEach)
 * ripristina il fetch originale.
 */
function captureNotificationPosts(): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(null, { status: 200 });
    },
  );
  return calls;
}

function bitbucketPayload(branch: string, prUrl = "https://bitbucket.org/acme/repo/pull-requests/7") {
  return JSON.stringify({
    pullrequest: { id: 7, source: { branch: { name: branch } }, links: { html: { href: prUrl } } },
  });
}

function githubPayload(branch: string, prUrl = "https://github.com/acme/repo/pull/7") {
  return JSON.stringify({
    action: "closed",
    pull_request: { number: 7, merged: true, head: { ref: branch }, html_url: prUrl },
  });
}

/**
 * Payload di push GitHub (X-GitHub-Event: push). `ref` è refs/heads/<branch>,
 * `before`/`after` le head pre/post push. parsePushEvent del provider lo
 * riconosce come push (e ritorna null per le PR), distinto dal flusso PR.
 */
function githubPushPayload(branch: string, before: string, after: string) {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    before,
    after,
    commits: [{ id: after, message: "commit di push" }],
  });
}

/** GitHub PR chiusa SENZA merge (closed_unmerged): action=closed, merged=false. */
function githubClosedUnmergedPayload(
  branch: string,
  prUrl = "https://github.com/acme/repo/pull/7",
) {
  return JSON.stringify({
    action: "closed",
    pull_request: { number: 7, merged: false, head: { ref: branch }, html_url: prUrl },
  });
}

/** Bitbucket PR rifiutata (closed_unmerged): x-event-key pullrequest:rejected. */
function bitbucketRejectedPayload(
  branch: string,
  prUrl = "https://bitbucket.org/acme/repo/pull-requests/7",
) {
  return JSON.stringify({
    pullrequest: { id: 7, source: { branch: { name: branch } }, links: { html: { href: prUrl } } },
  });
}

async function ticketStatus(ticketId: string): Promise<string> {
  const [row] = await testDb.db
    .select({ status: tickets.status })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return row!.status;
}

async function ticketComments(ticketId: string) {
  return testDb.db
    .select()
    .from(comments)
    .where(eq(comments.ticketId, ticketId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

describe("POST /webhooks/git/:projectSlug", () => {
  it("Bitbucket pullrequest:fulfilled firmato per stubwise/ticket-N → ticket done + commento di sistema", async () => {
    const project = await createProject({
      name: "Webhook BB",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/webhook-bb",
      credentials: { username: "acme-bot", token: "tok" },
    });
    // content_language='it': il commento di sistema deve risultare in italiano.
    await setContentLanguage("it");
    const ticketId = await insertTicket(project.id, 1, "in_review");
    // La pipeline ha aperto una PR: il job è in pr_opened, va portato a pr_merged.
    const jobId = await insertJob(ticketId, "pr_opened");
    const body = bitbucketPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-event-key": "pullrequest:fulfilled",
        "x-hub-signature": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
    // Il commento riporta la prUrl presa dal payload del webhook.
    expect(cmts[0]!.body).toContain("https://bitbucket.org/acme/repo/pull-requests/7");
    expect(cmts[0]!.body).toContain("ticket chiuso automaticamente");
    // Il job AI riflette il merge: pr_opened → pr_merged, con finishedAt valorizzato.
    const job = await jobById(jobId);
    expect(job.status).toBe("pr_merged");
    expect(job.finishedAt).not.toBeNull();
  });

  it("content_language='en' (default): il commento di sistema del merge è in inglese", async () => {
    const project = await createProject({
      name: "Webhook EN Merge",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-en-merge",
      credentials: { token: "tok" },
    });
    // Nessun setContentLanguage: l'afterEach del test precedente ha già
    // ripristinato il default 'en'.
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const body = githubPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
    expect(cmts[0]!.body).toContain("https://github.com/acme/repo/pull/7");
    // Testo inglese del catalogo i18n (comment.prMerged).
    expect(cmts[0]!.body).toBe(
      "PR merged: https://github.com/acme/repo/pull/7 — ticket closed automatically",
    );
  });

  it("content_language='en': il commento di sistema della PR chiusa senza merge è in inglese", async () => {
    const project = await createProject({
      name: "Webhook EN Closed",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-en-closed",
      credentials: { token: "tok" },
    });
    await setContentLanguage("en");
    const ticketId = await insertTicket(project.id, 1, "in_review");
    await insertJob(ticketId, "pr_opened");
    const body = githubClosedUnmergedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("triaged");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    // Testo inglese del catalogo i18n (comment.prClosed).
    expect(cmts[0]!.body).toBe(
      "PR closed without merging: https://github.com/acme/repo/pull/7 — ticket reopened, relaunch the fix whenever you want",
    );
  });

  it("GitHub pull_request closed+merged firmato per stubwise/ticket-N → ticket done", async () => {
    const project = await createProject({
      name: "Webhook GH",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-gh",
      credentials: { username: "acme-bot", token: "tok" },
    });
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const body = githubPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
  });

  it("firma non valida → 401, ticket intatto", async () => {
    const project = await createProject({
      name: "Webhook Firma",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-firma",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const body = githubPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign("segreto-sbagliato", body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(await ticketStatus(ticketId)).toBe("in_review");
    expect(await ticketComments(ticketId)).toHaveLength(0);
  });

  it("firma assente → 401", async () => {
    const project = await createProject({
      name: "Webhook NoFirma",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-nofirma",
      credentials: { token: "tok" },
    });
    const body = githubPayload("stubwise/ticket-1");
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("branch non-stubwise (firmato) → 204 ignorato, ticket intatto", async () => {
    const project = await createProject({
      name: "Webhook Branch",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-branch",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const body = githubPayload("feature/altro");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("in_review");
    expect(await ticketComments(ticketId)).toHaveLength(0);
  });

  it("closed_unmerged senza ticket → 204", async () => {
    const project = await createProject({
      name: "Webhook NonMerge",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-nonmerge",
      credentials: { token: "tok" },
    });
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 7, merged: false, head: { ref: "stubwise/ticket-1" }, html_url: "x" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(204);
  });

  it("slug sconosciuto → 401 (niente enumerazione)", async () => {
    const body = githubPayload("stubwise/ticket-1");
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/non-esiste`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign("qualsiasi", body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto con segreto vuoto (legacy) → 401", async () => {
    const gitAccountId = await seedGitAccount(testDb.db);
    const [group] = await testDb.db
      .insert(projects)
      .values({
        name: "Legacy",
        slug: `legacy-gruppo-${randomBytes(4).toString("hex")}`,
        ingestionKey: randomBytes(16).toString("hex"),
      })
      .returning({ id: projects.id });
    const [row] = await testDb.db
      .insert(repositories)
      .values({
        projectId: group!.id,
        name: "Legacy",
        slug: "legacy-no-secret",
        provider: "github",
        gitAccountId,
        repoUrl: "https://github.com/acme/legacy",
        defaultBranch: "main",
        webhookSecret: "",
      })
      .returning({ id: repositories.id, slug: repositories.slug });
    const body = githubPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${row!.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        // Firma calcolata col segreto vuoto: deve comunque essere rifiutata.
        "x-hub-signature-256": sign("", body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("ticket già done → 204 idempotente, nessun secondo commento", async () => {
    const project = await createProject({
      name: "Webhook Idem",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-idem",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(project.id, 1, "done");
    const body = githubPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    expect(await ticketComments(ticketId)).toHaveLength(0);
  });

  it("merge poi ri-consegna: job pr_merged una volta sola, no errori, altri stati intatti", async () => {
    const project = await createProject({
      name: "Webhook Job Idem",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-job-idem",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const prJobId = await insertJob(ticketId, "pr_opened");
    // Un job fallito sullo stesso ticket NON deve essere toccato dal merge.
    const failedJobId = await insertJob(ticketId, "failed");
    const body = githubPayload("stubwise/ticket-1");
    const headers = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(project.webhookSecret, body),
    };

    const first = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    expect((await jobById(prJobId)).status).toBe("pr_merged");
    expect((await jobById(failedJobId)).status).toBe("failed");

    // Ri-consegna: il ticket è già done → 204, nessun secondo commento, e il
    // job resta pr_merged (la query aggiorna solo pr_opened, ormai assenti).
    const second = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers,
      payload: body,
    });
    expect(second.statusCode).toBe(204);
    expect(await ticketComments(ticketId)).toHaveLength(1);
    expect((await jobById(prJobId)).status).toBe("pr_merged");
    expect((await jobById(failedJobId)).status).toBe("failed");
  });

  it("ticket inesistente per N → 204 (niente da chiudere)", async () => {
    const project = await createProject({
      name: "Webhook NoTicket",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-noticket",
      credentials: { token: "tok" },
    });
    const body = githubPayload("stubwise/ticket-999");
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(204);
  });

  it("firma valida ma JSON malformato → 400", async () => {
    const project = await createProject({
      name: "Webhook BadJson",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-badjson",
      credentials: { token: "tok" },
    });
    const body = "{ questo non è json";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("il ticket chiuso è quello del progetto giusto: stesso numero su due progetti non interferisce", async () => {
    const projectA = await createProject({
      name: "Webhook Iso A",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-iso-a",
      credentials: { token: "tok" },
    });
    const projectB = await createProject({
      name: "Webhook Iso B",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-iso-b",
      credentials: { token: "tok" },
    });
    const ticketA = await insertTicket(projectA.id, 5, "in_review");
    const ticketB = await insertTicket(projectB.id, 5, "in_review");
    const body = githubPayload("stubwise/ticket-5");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${projectA.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(projectA.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketA)).toBe("done");
    expect(await ticketStatus(ticketB)).toBe("in_review");
    // Sanity: il ticket di B non ha ricevuto commenti.
    expect(await ticketComments(ticketB)).toHaveLength(0);
  });

  // --- PR chiusa senza merge: riapertura del ticket ---

  it("GitHub pull_request closed+merged:false firmato per ticket in_review → ticket triaged, job pr_closed, commento di sistema", async () => {
    const project = await createProject({
      name: "Webhook GH Riapri",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-gh-riapri",
      credentials: { token: "tok" },
    });
    // content_language='it': il commento di sistema deve risultare in italiano.
    await setContentLanguage("it");
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const jobId = await insertJob(ticketId, "pr_opened");
    const body = githubClosedUnmergedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    // Il ticket torna a triaged: pronto per un nuovo tentativo di fix.
    expect(await ticketStatus(ticketId)).toBe("triaged");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
    expect(cmts[0]!.body).toContain("https://github.com/acme/repo/pull/7");
    expect(cmts[0]!.body).toContain("PR chiusa senza merge");
    // Il job pr_opened diventa pr_closed con finishedAt valorizzato.
    const job = await jobById(jobId);
    expect(job.status).toBe("pr_closed");
    expect(job.finishedAt).not.toBeNull();
  });

  it("PR chiusa senza merge su ticket in_review → dispatch reale job.pr_closed con i campi corretti", async () => {
    const project = await createProject({
      name: "Webhook Notify Dispatch",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-notify-dispatch",
      credentials: { token: "tok" },
    });
    await configureNotifications(true);
    const calls = captureNotificationPosts();
    const ticketId = await insertTicket(project.id, 1, "in_review");
    await insertJob(ticketId, "pr_opened");
    const body = githubClosedUnmergedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    // Il dispatch reale è stato esercitato: un solo POST al webhook configurato.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(NOTIFY_WEBHOOK_URL);
    const payload = calls[0]!.body;
    // Formato generic: campi piatti, ben asseribili.
    expect(payload.event).toBe("job.pr_closed");
    expect(payload.ticketNumber).toBe(1);
    expect(payload.title).toBe("Ticket 1");
    expect(payload.projectName).toBe("Webhook Notify Dispatch");
    expect(payload.prUrl).toBe("https://github.com/acme/repo/pull/7");
    // ticketUrl assoluto e ben formato a partire dal PUBLIC_URL dell'istanza.
    expect(payload.ticketUrl).toBe(`${PUBLIC_URL}/tickets/${ticketId}`);
  });

  it("toggle notifyPrClosed off → riapertura avviene ma nessun dispatch", async () => {
    const project = await createProject({
      name: "Webhook Notify Off",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-notify-off",
      credentials: { token: "tok" },
    });
    // Gating: toggle del singolo evento disattivato.
    await configureNotifications(false);
    const calls = captureNotificationPosts();
    const ticketId = await insertTicket(project.id, 1, "in_review");
    await insertJob(ticketId, "pr_opened");
    const body = githubClosedUnmergedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    // La riapertura avviene comunque...
    expect(await ticketStatus(ticketId)).toBe("triaged");
    // ...ma il toggle off taglia il POST: nessun dispatch.
    expect(calls).toHaveLength(0);
  });

  it("Bitbucket pullrequest:rejected firmato per ticket in_review → ticket triaged + job pr_closed", async () => {
    const project = await createProject({
      name: "Webhook BB Rejected",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/webhook-bb-rejected",
      credentials: { username: "acme-bot", token: "tok" },
    });
    // content_language='it': il commento di sistema deve risultare in italiano.
    await setContentLanguage("it");
    const ticketId = await insertTicket(project.id, 1, "in_review");
    const jobId = await insertJob(ticketId, "pr_opened");
    const body = bitbucketRejectedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-event-key": "pullrequest:rejected",
        "x-hub-signature": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("triaged");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.body).toContain("PR chiusa senza merge");
    const job = await jobById(jobId);
    expect(job.status).toBe("pr_closed");
    expect(job.finishedAt).not.toBeNull();
  });

  it("PR chiusa senza merge su ticket NON in_review (triaged) → 204 idempotente, nessun commento, job intatto", async () => {
    const project = await createProject({
      name: "Webhook Riapri Idem",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-riapri-idem",
      credentials: { token: "tok" },
    });
    // Ticket già triaged (es. seconda consegna del webhook, o riaperto a mano).
    const ticketId = await insertTicket(project.id, 1, "triaged");
    const jobId = await insertJob(ticketId, "pr_opened");
    const body = githubClosedUnmergedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect(await ticketComments(ticketId)).toHaveLength(0);
    // Il job non viene toccato: resta pr_opened.
    expect((await jobById(jobId)).status).toBe("pr_opened");
  });

  it("PR chiusa senza merge su ticket done → 204 idempotente, nessun cambiamento", async () => {
    const project = await createProject({
      name: "Webhook Riapri Done",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-riapri-done",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(project.id, 1, "done");
    const body = githubClosedUnmergedPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    expect(await ticketComments(ticketId)).toHaveLength(0);
  });
});

describe("POST /webhooks/git/:projectSlug — chiusura aggregata multi-repo", () => {
  /** POST di un merge GitHub firmato per il repo `repo`, branch `stubwise/ticket-N`. */
  function postMerge(repo: CreatedProject, ticketNumber: number, prUrl?: string) {
    const body = githubPayload(`stubwise/ticket-${ticketNumber}`, prUrl);
    return app.inject({
      method: "POST",
      url: `/webhooks/git/${repo.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(repo.webhookSecret, body),
      },
      payload: body,
    });
  }

  /** POST di una PR chiusa senza merge (GitHub) firmata per `repo`. */
  function postClosedUnmerged(repo: CreatedProject, ticketNumber: number, prUrl?: string) {
    const body = githubClosedUnmergedPayload(`stubwise/ticket-${ticketNumber}`, prUrl);
    return app.inject({
      method: "POST",
      url: `/webhooks/git/${repo.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(repo.webhookSecret, body),
      },
      payload: body,
    });
  }

  it("due repo, ticket con 2 PR: il primo merge non chiude; il secondo porta a done", async () => {
    const repoA = await createProject({
      name: "Agg A",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-a",
      credentials: { token: "tok" },
    });
    const repoB = await addRepository(repoA, {
      name: "Agg B",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-b",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(repoA.id, 1, "in_review");
    const jobId = await insertJob(ticketId, "pr_opened");
    // Due PR aperte, una per repo del progetto.
    await seedTicketRepository(ticketId, repoA.id, "open");
    await seedTicketRepository(ticketId, repoB.id, "open");

    // Merge del PRIMO repo: la sua riga → merged, ma il ticket resta in_review
    // (riga B ancora open) e il job resta pr_opened.
    const first = await postMerge(repoA, 1);
    expect(first.statusCode).toBe(204);
    expect(await repoState(ticketId, repoA.id)).toBe("merged");
    expect(await repoState(ticketId, repoB.id)).toBe("open");
    expect(await ticketStatus(ticketId)).toBe("in_review");
    expect((await jobById(jobId)).status).toBe("pr_opened");
    // Un commento di sistema per la PR mergiata di A.
    expect(await ticketComments(ticketId)).toHaveLength(1);

    // Merge del SECONDO repo: ora TUTTE le righe sono merged → ticket done,
    // job pr_merged.
    const second = await postMerge(repoB, 1);
    expect(second.statusCode).toBe(204);
    expect(await repoState(ticketId, repoB.id)).toBe("merged");
    expect(await ticketStatus(ticketId)).toBe("done");
    expect((await jobById(jobId)).status).toBe("pr_merged");
    // Due commenti totali (uno per PR mergiata).
    expect(await ticketComments(ticketId)).toHaveLength(2);
  });

  it("closed_unmerged di un repo non chiude gli altri; ri-merge dopo un nuovo fix → done", async () => {
    const repoA = await createProject({
      name: "Agg Reopen A",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-reopen-a",
      credentials: { token: "tok" },
    });
    const repoB = await addRepository(repoA, {
      name: "Agg Reopen B",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-reopen-b",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(repoA.id, 1, "in_review");
    const jobId = await insertJob(ticketId, "pr_opened");
    await seedTicketRepository(ticketId, repoA.id, "open");
    await seedTicketRepository(ticketId, repoB.id, "open");

    // Merge di A: riga A merged, ticket ancora in_review (B open).
    expect((await postMerge(repoA, 1)).statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("in_review");

    // La PR di B viene CHIUSA senza merge: riga B → closed_unmerged, la riga A
    // NON è toccata (resta merged), il ticket rientra in lavorazione (triaged).
    expect((await postClosedUnmerged(repoB, 1)).statusCode).toBe(204);
    expect(await repoState(ticketId, repoA.id)).toBe("merged");
    expect(await repoState(ticketId, repoB.id)).toBe("closed_unmerged");
    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect((await jobById(jobId)).status).toBe("pr_closed");

    // Un nuovo fix riapre la PR su B (la riga torna open): il ticket torna in
    // review. Simuliamo lo stato: riga B → open, ticket → in_review, nuovo job.
    await testDb.db
      .update(ticketRepositories)
      .set({ prState: "open" })
      .where(
        and(
          eq(ticketRepositories.ticketId, ticketId),
          eq(ticketRepositories.repositoryId, repoB.id),
        ),
      );
    await testDb.db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
    const jobId2 = await insertJob(ticketId, "pr_opened");

    // Re-merge di B: tutte le righe merged → done.
    expect((await postMerge(repoB, 1)).statusCode).toBe(204);
    expect(await repoState(ticketId, repoB.id)).toBe("merged");
    expect(await ticketStatus(ticketId)).toBe("done");
    expect((await jobById(jobId2)).status).toBe("pr_merged");
  });

  it("idempotenza: doppio webhook merged sullo stesso repo → una sola transizione, nessun errore", async () => {
    const repoA = await createProject({
      name: "Agg Idem A",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-idem-a",
      credentials: { token: "tok" },
    });
    const repoB = await addRepository(repoA, {
      name: "Agg Idem B",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-idem-b",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(repoA.id, 1, "in_review");
    await seedTicketRepository(ticketId, repoA.id, "open");
    await seedTicketRepository(ticketId, repoB.id, "open");

    // Primo merge di A.
    expect((await postMerge(repoA, 1)).statusCode).toBe(204);
    expect(await ticketComments(ticketId)).toHaveLength(1);
    expect(await ticketStatus(ticketId)).toBe("in_review");

    // Ri-consegna dello STESSO merge di A (ticket ancora in_review perché B è
    // open): idempotente → nessun secondo commento, riga A ancora merged.
    expect((await postMerge(repoA, 1)).statusCode).toBe(204);
    expect(await ticketComments(ticketId)).toHaveLength(1);
    expect(await repoState(ticketId, repoA.id)).toBe("merged");
    expect(await ticketStatus(ticketId)).toBe("in_review");
  });

  it("single-repo (una sola riga): merge → done immediato", async () => {
    const repo = await createProject({
      name: "Agg Single",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-single",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(repo.id, 1, "in_review");
    const jobId = await insertJob(ticketId, "pr_opened");
    await seedTicketRepository(ticketId, repo.id, "open");

    expect((await postMerge(repo, 1)).statusCode).toBe(204);
    expect(await repoState(ticketId, repo.id)).toBe("merged");
    expect(await ticketStatus(ticketId)).toBe("done");
    expect((await jobById(jobId)).status).toBe("pr_merged");
  });

  it("merge con riga mancante: la crea merged e (single-repo) chiude il ticket", async () => {
    const repo = await createProject({
      name: "Agg Riga Mancante",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-riga-mancante",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(repo.id, 1, "in_review");
    // Nessuna riga ticket_repositories seedata: caso limite (PR mergiata ma
    // riga assente). Il webhook la crea `merged`, e — essendo l'unica riga —
    // porta il ticket a done.
    expect((await postMerge(repo, 1)).statusCode).toBe(204);
    expect(await repoState(ticketId, repo.id)).toBe("merged");
    expect(await ticketStatus(ticketId)).toBe("done");
  });

  it("numero univoco per progetto: due repo dello stesso progetto risolvono lo STESSO ticket; un altro progetto non è toccato", async () => {
    const repoA = await createProject({
      name: "Agg Univoco A",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-univoco-a",
      credentials: { token: "tok" },
    });
    const repoB = await addRepository(repoA, {
      name: "Agg Univoco B",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-univoco-b",
      credentials: { token: "tok" },
    });
    // Ticket con lo stesso numero su un ALTRO progetto: non deve essere toccato.
    const other = await createProject({
      name: "Agg Univoco Altro",
      provider: "github",
      repoUrl: "https://github.com/acme/agg-univoco-altro",
      credentials: { token: "tok" },
    });
    const ticketId = await insertTicket(repoA.id, 7, "in_review");
    const otherTicketId = await insertTicket(other.id, 7, "in_review");
    await seedTicketRepository(ticketId, repoA.id, "open");
    await seedTicketRepository(ticketId, repoB.id, "open");

    // Merge su repoA e repoB (stesso progetto) risolvono lo STESSO ticket (N=7),
    // marcando righe diverse; il ticket dell'altro progetto resta intatto.
    expect((await postMerge(repoA, 7)).statusCode).toBe(204);
    expect((await postMerge(repoB, 7)).statusCode).toBe(204);
    expect(await repoState(ticketId, repoA.id)).toBe("merged");
    expect(await repoState(ticketId, repoB.id)).toBe("merged");
    expect(await ticketStatus(ticketId)).toBe("done");
    // L'altro progetto con lo stesso numero: non toccato.
    expect(await ticketStatus(otherTicketId)).toBe("in_review");
    expect(await ticketComments(otherTicketId)).toHaveLength(0);
    expect(await repoState(otherTicketId, other.id)).toBeUndefined();
  });
});

describe("POST /webhooks/git/:projectSlug — push (auto-aggiornamento Docs)", () => {
  const SHA = (c: string) => c.repeat(40);

  /**
   * Porta a true (o false) il toggle docAutoUpdate. Il toggle è salito al
   * PROGETTO (gruppo): qui riceviamo il repositoryId e aggiorniamo il progetto
   * del repository, coerente con come il webhook lo legge (join repo→progetto).
   */
  async function setDocAutoUpdate(repositoryId: string, value: boolean): Promise<void> {
    const [repository] = await testDb.db
      .select({ projectId: repositories.projectId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    await testDb.db
      .update(projects)
      .set({ docAutoUpdate: value })
      .where(eq(projects.id, repository!.projectId));
  }

  /**
   * Crea una generazione Docs con `commitSha`, la imposta come corrente del
   * repository e ne restituisce il commitSha (base attesa del diff all'insert).
   */
  async function seedCurrentGeneration(repositoryId: string, commitSha: string): Promise<string> {
    const [gen] = await testDb.db
      .insert(docGenerations)
      .values({ repositoryId, status: "succeeded", commitSha })
      .returning({ id: docGenerations.id });
    await testDb.db
      .update(repositories)
      .set({ currentDocGenerationId: gen!.id })
      .where(eq(repositories.id, repositoryId));
    return commitSha;
  }

  /** Legge l'unico job pending di auto-update del progetto (o undefined). */
  async function pendingJob(projectId: string) {
    const [row] = await testDb.db
      .select()
      .from(docAutoUpdateJobs)
      .where(eq(docAutoUpdateJobs.repositoryId, projectId));
    return row;
  }

  function postPush(slug: string, secret: string, body: string) {
    return app.inject({
      method: "POST",
      url: `/webhooks/git/${slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": sign(secret, body),
      },
      payload: body,
    });
  }

  it("push sul defaultBranch con docAutoUpdate=true → crea il pending (from=commit generazione corrente)", async () => {
    const project = await createProject({
      name: "Push Crea",
      provider: "github",
      repoUrl: "https://github.com/acme/push-crea",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDocAutoUpdate(project.id, true);
    const genSha = await seedCurrentGeneration(project.id, SHA("9"));
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const before = Date.now();
    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);

    const job = await pendingJob(project.id);
    expect(job).toBeDefined();
    // from = commitSha della generazione corrente (NON il before del push).
    expect(job!.fromSha).toBe(genSha);
    expect(job!.toSha).toBe(SHA("b"));
    // not_before futuro (finestra di debounce).
    expect(job!.notBefore.getTime()).toBeGreaterThan(before);
  });

  it("senza generazione corrente: from = beforeSha del push", async () => {
    const project = await createProject({
      name: "Push No Gen",
      provider: "github",
      repoUrl: "https://github.com/acme/push-no-gen",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDocAutoUpdate(project.id, true);
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);
    const job = await pendingJob(project.id);
    expect(job!.fromSha).toBe(SHA("a"));
    expect(job!.toSha).toBe(SHA("b"));
  });

  it("secondo push → stesso pending aggiornato (from invariato, to/not_before aggiornati, nessun duplicato)", async () => {
    const project = await createProject({
      name: "Push Debounce",
      provider: "github",
      repoUrl: "https://github.com/acme/push-debounce",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDocAutoUpdate(project.id, true);
    const body1 = githubPushPayload("main", SHA("a"), SHA("b"));
    const r1 = await postPush(project.slug, project.webhookSecret, body1);
    expect(r1.statusCode).toBe(204);
    const first = await pendingJob(project.id);
    const firstNotBefore = first!.notBefore.getTime();

    // Secondo push: nuova head, before diverso (non deve cambiare from).
    const body2 = githubPushPayload("main", SHA("b"), SHA("c"));
    const r2 = await postPush(project.slug, project.webhookSecret, body2);
    expect(r2.statusCode).toBe(204);

    // Un solo job per progetto (unique).
    const all = await testDb.db
      .select()
      .from(docAutoUpdateJobs)
      .where(eq(docAutoUpdateJobs.repositoryId, project.id));
    expect(all).toHaveLength(1);
    const second = all[0]!;
    // from accumula dal primo push: invariato.
    expect(second.fromSha).toBe(SHA("a"));
    // to e not_before avanzano.
    expect(second.toSha).toBe(SHA("c"));
    expect(second.notBefore.getTime()).toBeGreaterThanOrEqual(firstNotBefore);
  });

  it("push su branch != defaultBranch → nessun pending (204)", async () => {
    const project = await createProject({
      name: "Push Altro Branch",
      provider: "github",
      repoUrl: "https://github.com/acme/push-altro-branch",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDocAutoUpdate(project.id, true);
    const body = githubPushPayload("feature/x", SHA("a"), SHA("b"));

    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);
    expect(await pendingJob(project.id)).toBeUndefined();
  });

  it("docAutoUpdate=false → nessun pending (204)", async () => {
    const project = await createProject({
      name: "Push Toggle Off",
      provider: "github",
      repoUrl: "https://github.com/acme/push-toggle-off",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    // toggle lasciato a false (default).
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);
    expect(await pendingJob(project.id)).toBeUndefined();
  });

  it("HMAC errato su un push → 401, nessun pending", async () => {
    const project = await createProject({
      name: "Push Firma KO",
      provider: "github",
      repoUrl: "https://github.com/acme/push-firma-ko",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDocAutoUpdate(project.id, true);
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": sign("segreto-sbagliato", body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(await pendingJob(project.id)).toBeUndefined();
  });

  it("evento PR (non push) → comportamento PR invariato, nessun pending creato", async () => {
    const project = await createProject({
      name: "Push Non PR",
      provider: "github",
      repoUrl: "https://github.com/acme/push-non-pr",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDocAutoUpdate(project.id, true);
    const ticketId = await insertTicket(project.id, 1, "in_review");
    // Un vero evento PR (merge) col suo header: NON deve creare un pending.
    const body = githubPayload("stubwise/ticket-1");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(204);
    // Flusso PR invariato: il ticket è stato chiuso.
    expect(await ticketStatus(ticketId)).toBe("done");
    // E nessun job di auto-update è stato creato.
    expect(await pendingJob(project.id)).toBeUndefined();
  });
});
