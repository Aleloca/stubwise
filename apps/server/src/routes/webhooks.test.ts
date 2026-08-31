import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  activityRecountJobs,
  aiJobs,
  comments,
  docAutoUpdateJobs,
  docGenerations,
  graphJobs,
  instanceSettings,
  notificationDeliveries,
  notifications,
  notificationSettings,
  prReviewJobs,
  prReviews,
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
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    // publicUrl configurato: senza, il getter instance.publicUrl lancerebbe e
    // il try/catch best-effort della route inghiottirebbe l'eccezione PRIMA di
    // raggiungere publishNotification — la publish non verrebbe mai esercitata.
    publicUrl: PUBLIC_URL,
  });
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Riporta il singleton di notifica allo stato seedato (webhookUrl null =
  // nessuna consegna webhook), così la configurazione di un test non perde nei
  // successivi.
  await testDb.db
    .update(notificationSettings)
    .set({ webhookUrl: null })
    .where(eq(notificationSettings.id, 1));
  // Ripristina le impostazioni d'istanza ai default (riga singleton id=1
  // condivisa tra i test): un test che cambia lingua o toggle PR review non
  // deve influenzare i successivi.
  await testDb.db
    .update(instanceSettings)
    .set({ contentLanguage: "en", prReviewEnabled: false })
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
 * migrazione): webhook URL + formato `generic` e gating del solo toggle
 * `notifyPrClosed`, che decide se la publish scrive la consegna webhook in
 * outbox. enabled=true, gli altri toggle off (irrilevanti qui).
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
 * Intercetta il POST del webhook di notifica sostituendo il `fetch` globale.
 * Dalla Fase 0 la rotta PUBBLICA soltanto (inbox + outbox) e l'invio è del
 * poller: l'array deve restare VUOTO — è la prova che nessuna chiamata di rete
 * parte più dalla richiesta HTTP. vi.restoreAllMocks (afterEach) ripristina il
 * fetch originale.
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

/** Notifiche in inbox per un ticket, dalla più vecchia. */
async function notificationsOfTicket(ticketId: string) {
  return testDb.db
    .select()
    .from(notifications)
    .where(eq(notifications.ticketId, ticketId))
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
}

/**
 * Consegne webhook d'istanza (outbox) relative a UN ticket. La riga webhook non
 * punta a una notifica (l'evento è copiato sulla riga, vedi i CHECK della
 * tabella): il legame col ticket si ricava dal `ticketUrl` dell'evento — che
 * contiene l'id — e serve a non contare le righe lasciate dagli altri test.
 */
async function webhookDeliveriesForTicket(ticketId: string) {
  const rows = await testDb.db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.channel, "webhook"));
  return rows.filter((r) => String((r.event as { ticketUrl?: string })?.ticketUrl ?? "").includes(ticketId));
}

/** Progetto (gruppo) a cui appartiene un repository. */
async function projectIdOfRepository(repositoryId: string): Promise<string> {
  const [row] = await testDb.db
    .select({ projectId: repositories.projectId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return row!.projectId;
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

  it("PR chiusa senza merge su ticket in_review → job.pr_closed pubblicato in inbox e in outbox", async () => {
    const project = await createProject({
      name: "Webhook Notify Dispatch",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-notify-dispatch",
      credentials: { token: "tok" },
    });
    await configureNotifications(true);
    // Nessun POST parte più da qui: la publish scrive soltanto, l'invio è del
    // poller. Il fetch resta intercettato per dimostrarlo.
    const calls = captureNotificationPosts();
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
    expect(calls).toHaveLength(0);

    // INBOX: una riga per l'admin, ancorata a progetto, ticket e job riallineato.
    const inbox = await notificationsOfTicket(ticketId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.userId).toBe(adminId);
    expect(inbox[0]!.kind).toBe("job.pr_closed");
    expect(inbox[0]!.projectId).toBe(await projectIdOfRepository(project.id));
    expect(inbox[0]!.jobId).toBe(jobId);
    expect(inbox[0]!.event).toMatchObject({
      kind: "job.pr_closed",
      ticketNumber: 1,
      ticketTitle: "Ticket 1",
      projectName: "Webhook Notify Dispatch",
      prUrl: "https://github.com/acme/repo/pull/7",
      // ticketUrl assoluto e ben formato a partire dal PUBLIC_URL dell'istanza.
      ticketUrl: `${PUBLIC_URL}/tickets/${ticketId}`,
    });

    // OUTBOX: col toggle acceso nasce la consegna webhook d'istanza (una per
    // evento, con l'evento copiato sulla riga).
    const webhookDeliveries = await webhookDeliveriesForTicket(ticketId);
    expect(webhookDeliveries).toHaveLength(1);
    expect(webhookDeliveries[0]!.event).toMatchObject({ kind: "job.pr_closed" });
  });

  it("toggle notifyPrClosed off → inbox comunque scritta, nessuna consegna webhook", async () => {
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
    expect(calls).toHaveLength(0);
    // ...e l'inbox pure: il toggle governa SOLO il webhook d'istanza, non le
    // notifiche delle persone.
    const inbox = await notificationsOfTicket(ticketId);
    expect(inbox).toHaveLength(1);
    expect(await webhookDeliveriesForTicket(ticketId)).toHaveLength(0);
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

describe("POST /webhooks/git/:projectSlug — push (recount report attività)", () => {
  const SHA = (c: string) => c.repeat(40);

  /** Porta il toggle dailyReportEnabled del progetto (gruppo) del repository. */
  async function setDailyReportEnabled(repositoryId: string, value: boolean): Promise<void> {
    const [repository] = await testDb.db
      .select({ projectId: repositories.projectId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    await testDb.db
      .update(projects)
      .set({ dailyReportEnabled: value })
      .where(eq(projects.id, repository!.projectId));
  }

  /** Legge l'unico job di recount del progetto (o undefined). */
  async function recountJob(projectId: string) {
    const [row] = await testDb.db
      .select()
      .from(activityRecountJobs)
      .where(eq(activityRecountJobs.projectId, projectId));
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

  it("push con dailyReportEnabled=true → accoda un recount (not_before ~ now+60s)", async () => {
    const project = await createProject({
      name: "Recount On",
      provider: "github",
      repoUrl: "https://github.com/acme/recount-on",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDailyReportEnabled(project.id, true);
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const before = Date.now();
    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);

    const job = await recountJob(project.projectId);
    expect(job).toBeDefined();
    // not_before nella finestra di debounce (~ now + 60s), con un margine ampio.
    expect(job!.notBefore.getTime()).toBeGreaterThan(before);
    expect(job!.notBefore.getTime()).toBeLessThanOrEqual(before + 60_000 + 5_000);
  });

  it("secondo push ravvicinato → un solo job (upsert), not_before spostato avanti", async () => {
    const project = await createProject({
      name: "Recount Debounce",
      provider: "github",
      repoUrl: "https://github.com/acme/recount-debounce",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setDailyReportEnabled(project.id, true);

    const r1 = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("a"), SHA("b")),
    );
    expect(r1.statusCode).toBe(204);
    const first = await recountJob(project.projectId);
    const firstNotBefore = first!.notBefore.getTime();

    const r2 = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("b"), SHA("c")),
    );
    expect(r2.statusCode).toBe(204);

    // Una sola riga per progetto (PK project_id).
    const all = await testDb.db
      .select()
      .from(activityRecountJobs)
      .where(eq(activityRecountJobs.projectId, project.projectId));
    expect(all).toHaveLength(1);
    // not_before avanza (debounce).
    expect(all[0]!.notBefore.getTime()).toBeGreaterThanOrEqual(firstNotBefore);
  });

  it("push con dailyReportEnabled=false → nessun recount", async () => {
    const project = await createProject({
      name: "Recount Off",
      provider: "github",
      repoUrl: "https://github.com/acme/recount-off",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    // toggle lasciato a false (default).
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);
    expect(await recountJob(project.projectId)).toBeUndefined();
  });
});

describe("POST /webhooks/git/:projectSlug — push (build del grafo)", () => {
  const SHA = (c: string) => c.repeat(40);

  /** Porta il toggle graphEnabled del REPOSITORY (non del progetto). */
  async function setGraphEnabled(repositoryId: string, value: boolean): Promise<void> {
    await testDb.db
      .update(repositories)
      .set({ graphEnabled: value })
      .where(eq(repositories.id, repositoryId));
  }

  /** Tutti i job del grafo del repository, dal più vecchio. */
  async function graphJobsOf(repositoryId: string) {
    return testDb.db
      .select()
      .from(graphJobs)
      .where(eq(graphJobs.repositoryId, repositoryId))
      .orderBy(asc(graphJobs.createdAt));
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

  it("push sul defaultBranch con graphEnabled=true → job build queued (not_before ~ now+60s)", async () => {
    const project = await createProject({
      name: "Graph On",
      provider: "github",
      repoUrl: "https://github.com/acme/graph-on",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setGraphEnabled(project.id, true);
    const body = githubPushPayload("main", SHA("a"), SHA("b"));

    const before = Date.now();
    const res = await postPush(project.slug, project.webhookSecret, body);
    expect(res.statusCode).toBe(204);

    const jobs = await graphJobsOf(project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("build");
    expect(jobs[0]!.status).toBe("queued");
    // Il payload del push non dice quali file sono stati cancellati: il webhook
    // non chiede mai `--force` (lo fa la generazione manuale).
    expect(jobs[0]!.force).toBe(false);
    expect(jobs[0]!.notBefore!.getTime()).toBeGreaterThan(before);
    expect(jobs[0]!.notBefore!.getTime()).toBeLessThanOrEqual(before + 60_000 + 5_000);
  });

  it("secondo push ravvicinato → STESSO job, not_before spostato avanti", async () => {
    const project = await createProject({
      name: "Graph Debounce",
      provider: "github",
      repoUrl: "https://github.com/acme/graph-debounce",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setGraphEnabled(project.id, true);

    const r1 = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("a"), SHA("b")),
    );
    expect(r1.statusCode).toBe(204);
    const first = (await graphJobsOf(project.id))[0]!;

    const r2 = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("b"), SHA("c")),
    );
    expect(r2.statusCode).toBe(204);

    const jobs = await graphJobsOf(project.id);
    expect(jobs).toHaveLength(1);
    // Stesso job (nessun secondo insert), finestra di debounce spostata avanti.
    expect(jobs[0]!.id).toBe(first.id);
    expect(jobs[0]!.notBefore!.getTime()).toBeGreaterThanOrEqual(first.notBefore!.getTime());
    expect(jobs[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("job running esistente → nessun nuovo job, il running resta intatto", async () => {
    const project = await createProject({
      name: "Graph Running",
      provider: "github",
      repoUrl: "https://github.com/acme/graph-running",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setGraphEnabled(project.id, true);
    const [running] = await testDb.db
      .insert(graphJobs)
      .values({ repositoryId: project.id, kind: "build", status: "running" })
      .returning();

    const res = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("a"), SHA("b")),
    );
    expect(res.statusCode).toBe(204);

    const jobs = await graphJobsOf(project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(running!.id);
    expect(jobs[0]!.status).toBe("running");
    // La build in corso non viene toccata (né not_before né updated_at).
    expect(jobs[0]!.notBefore).toBeNull();
    expect(jobs[0]!.updatedAt.getTime()).toBe(running!.updatedAt.getTime());
  });

  it("graphEnabled=false → nessun job", async () => {
    const project = await createProject({
      name: "Graph Off",
      provider: "github",
      repoUrl: "https://github.com/acme/graph-off",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    // toggle lasciato a false (default).
    const res = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("a"), SHA("b")),
    );
    expect(res.statusCode).toBe(204);
    expect(await graphJobsOf(project.id)).toHaveLength(0);
  });

  it("push su branch != defaultBranch → nessun job (il grafo è del default branch)", async () => {
    const project = await createProject({
      name: "Graph Altro Branch",
      provider: "github",
      repoUrl: "https://github.com/acme/graph-altro-branch",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setGraphEnabled(project.id, true);

    const res = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("feature/x", SHA("a"), SHA("b")),
    );
    expect(res.statusCode).toBe(204);
    expect(await graphJobsOf(project.id)).toHaveLength(0);
  });

  it("errore nell'accodamento → il webhook risponde comunque 204 (best-effort)", async () => {
    const project = await createProject({
      name: "Graph Errore",
      provider: "github",
      repoUrl: "https://github.com/acme/graph-errore",
      defaultBranch: "main",
      credentials: { token: "tok" },
    });
    await setGraphEnabled(project.id, true);
    // docAutoUpdate e dailyReport restano spenti: l'unico insert del ramo push
    // è quello del job del grafo, quindi il mock colpisce solo lui.
    const spy = vi.spyOn(testDb.db, "insert").mockImplementationOnce(() => {
      throw new Error("db giù");
    });

    const res = await postPush(
      project.slug,
      project.webhookSecret,
      githubPushPayload("main", SHA("a"), SHA("b")),
    );
    expect(res.statusCode).toBe(204);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(await graphJobsOf(project.id)).toHaveLength(0);
  });
});

describe("webhook PR Review (accodamento)", () => {
  /**
   * Porta il toggle d'istanza prReviewEnabled (singleton id=1, seedato dalla
   * migrazione) al valore richiesto.
   */
  async function setPrReviewEnabled(enabled: boolean): Promise<void> {
    await testDb.db
      .insert(instanceSettings)
      .values({ id: 1, prReviewEnabled: enabled })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { prReviewEnabled: enabled } });
  }

  /** Payload GitHub pull_request opened/synchronize per la PR #42. */
  function githubPrOpenedPayload(overrides: Partial<{ action: string; sha: string }> = {}): string {
    return JSON.stringify({
      action: overrides.action ?? "opened",
      pull_request: {
        number: 42,
        title: "Add login",
        body: "desc",
        html_url: "https://github.com/acme/repo/pull/42",
        head: { ref: "feature/login", sha: overrides.sha ?? "a".repeat(40) },
        base: { ref: "main" },
      },
    });
  }

  /** Payload Bitbucket pullrequest:created per la PR #42. */
  function bitbucketPrCreatedPayload(): string {
    return JSON.stringify({
      pullrequest: {
        id: 42,
        title: "Add login",
        description: "desc",
        source: { branch: { name: "feature/login" }, commit: { hash: "abc123def456" } },
        destination: { branch: { name: "main" } },
        links: { html: { href: "https://bitbucket.org/acme/repo/pull-requests/42" } },
      },
    });
  }

  /** Le righe pr_review_jobs del repository (attese: 0 o 1 per il vincolo unique). */
  async function reviewJobs(repositoryId: string) {
    return testDb.db
      .select()
      .from(prReviewJobs)
      .where(eq(prReviewJobs.repositoryId, repositoryId));
  }

  function postGithubPr(repo: CreatedProject, body: string) {
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

  it("pull_request opened con toggle attivo → riga in pr_review_jobs", async () => {
    const project = await createProject({
      name: "PR Review Opened",
      provider: "github",
      repoUrl: "https://github.com/acme/pr-review-opened",
      credentials: { token: "tok" },
    });
    await setPrReviewEnabled(true);
    const before = Date.now();

    const res = await postGithubPr(project, githubPrOpenedPayload());
    expect(res.statusCode).toBe(204);

    const jobs = await reviewJobs(project.id);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.prNumber).toBe(42);
    expect(job.headSha).toBe("a".repeat(40));
    expect(job.prTitle).toBe("Add login");
    expect(job.prBody).toBe("desc");
    expect(job.sourceBranch).toBe("feature/login");
    expect(job.targetBranch).toBe("main");
    expect(job.prUrl).toBe("https://github.com/acme/repo/pull/42");
    // not_before almeno 90s nel futuro: pinna la finestra di debounce
    // (before è catturato prima della request, quindi mai flaky).
    expect(job.notBefore.getTime()).toBeGreaterThanOrEqual(before + 90_000);
  });

  it("synchronize sulla stessa PR → upsert (una sola riga, head e debounce aggiornati)", async () => {
    const project = await createProject({
      name: "PR Review Sync",
      provider: "github",
      repoUrl: "https://github.com/acme/pr-review-sync",
      credentials: { token: "tok" },
    });
    await setPrReviewEnabled(true);

    expect((await postGithubPr(project, githubPrOpenedPayload())).statusCode).toBe(204);
    const [first] = await reviewJobs(project.id);
    const firstNotBefore = first!.notBefore.getTime();

    // Push sulla source branch: synchronize con nuova head.
    const newSha = "b".repeat(40);
    const res = await postGithubPr(
      project,
      githubPrOpenedPayload({ action: "synchronize", sha: newSha }),
    );
    expect(res.statusCode).toBe(204);

    // SEMPRE una sola riga (upsert sul vincolo repo+PR), head e debounce avanzati.
    const jobs = await reviewJobs(project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.headSha).toBe(newSha);
    expect(jobs[0]!.notBefore.getTime()).toBeGreaterThanOrEqual(firstNotBefore);
  });

  it("toggle spento → nessuna riga (204)", async () => {
    const project = await createProject({
      name: "PR Review Off",
      provider: "github",
      repoUrl: "https://github.com/acme/pr-review-off",
      credentials: { token: "tok" },
    });
    await setPrReviewEnabled(false);

    const res = await postGithubPr(project, githubPrOpenedPayload());
    expect(res.statusCode).toBe(204);
    expect(await reviewJobs(project.id)).toHaveLength(0);
  });

  it("firma errata → 401 e nessuna riga", async () => {
    const project = await createProject({
      name: "PR Review Firma KO",
      provider: "github",
      repoUrl: "https://github.com/acme/pr-review-firma-ko",
      credentials: { token: "tok" },
    });
    await setPrReviewEnabled(true);
    const body = githubPrOpenedPayload();

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
    expect(await reviewJobs(project.id)).toHaveLength(0);
  });

  it("Bitbucket pullrequest:created con toggle attivo → riga accodata", async () => {
    const project = await createProject({
      name: "PR Review BB",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/pr-review-bb",
      credentials: { username: "acme-bot", token: "tok" },
    });
    await setPrReviewEnabled(true);
    const body = bitbucketPrCreatedPayload();

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-event-key": "pullrequest:created",
        "x-hub-signature": sign(project.webhookSecret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(204);

    const jobs = await reviewJobs(project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.prNumber).toBe(42);
    expect(jobs[0]!.headSha).toBe("abc123def456");
    expect(jobs[0]!.prUrl).toBe("https://bitbucket.org/acme/repo/pull-requests/42");
  });
});

describe("webhook PR Review (chiusura)", () => {
  /**
   * Inserisce un ticket di tipo `review` (quelli creati dal worker per le PR
   * esterne) con numero e stato espliciti, restituendone l'id. Come
   * insertTicket, ma il type è `review`: è l'unico type che il webhook di
   * chiusura auto-chiude.
   */
  async function insertReviewTicket(
    repositoryId: string,
    number: number,
    status: "open" | "done" | "closed" = "open",
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
        title: `Review PR #${number}`,
        type: "review",
        priority: "medium",
        status,
        source: "webhook",
      })
      .returning({ id: tickets.id });
    if (!row) throw new Error("insert ticket review non ha restituito la riga");
    return row.id;
  }

  /** Riga di storico pr_reviews che lega la PR al suo ticket review. */
  async function seedPrReview(
    repositoryId: string,
    prNumber: number,
    ticketId: string,
  ): Promise<void> {
    await testDb.db.insert(prReviews).values({
      repositoryId,
      prNumber,
      prUrl: `https://github.com/acme/repo/pull/${prNumber}`,
      prTitle: "Add login",
      headSha: "a".repeat(40),
      ticketId,
      status: "completed",
    });
  }

  /** Pending in coda pr_review_jobs per (repo, PR): quello che la chiusura deve eliminare. */
  async function seedPendingReviewJob(repositoryId: string, prNumber: number): Promise<void> {
    await testDb.db.insert(prReviewJobs).values({
      repositoryId,
      prNumber,
      prUrl: `https://github.com/acme/repo/pull/${prNumber}`,
      prTitle: "Add login",
      prBody: "desc",
      sourceBranch: "feature/login",
      targetBranch: "main",
      headSha: "a".repeat(40),
      notBefore: new Date(Date.now() + 60_000),
    });
  }

  /** Le righe pr_review_jobs del repository. */
  async function pendingJobs(repositoryId: string) {
    return testDb.db
      .select()
      .from(prReviewJobs)
      .where(eq(prReviewJobs.repositoryId, repositoryId));
  }

  function postGithubClosure(repo: CreatedProject, body: string) {
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

  it("PR esterna mergiata → pending eliminato e ticket review chiuso a done con commento", async () => {
    const project = await createProject({
      name: "Review Chiusura Merge",
      provider: "github",
      repoUrl: "https://github.com/acme/review-chiusura-merge",
      credentials: { token: "tok" },
    });
    const ticketId = await insertReviewTicket(project.id, 1, "open");
    await seedPrReview(project.id, 7, ticketId);
    await seedPendingReviewJob(project.id, 7);
    // Decoy: pending di un'ALTRA PR (9) dello stesso repo. La delete deve
    // essere scoped a (repo, prNumber): il decoy deve sopravvivere.
    await seedPendingReviewJob(project.id, 9);
    // Branch NON stubwise: il flusso di chiusura dei ticket del fix non scatta.
    const body = githubPayload("feature/login");

    const res = await postGithubClosure(project, body);
    expect(res.statusCode).toBe(204);

    // Il pending della PR chiusa è stato eliminato (la review non serve più);
    // quello dell'altra PR (9) è intatto.
    const remaining = await pendingJobs(project.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.prNumber).toBe(9);
    // Il ticket review si è auto-chiuso a done (PR mergiata), con commento system.
    expect(await ticketStatus(ticketId)).toBe("done");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
    expect(cmts[0]!.body).toContain("https://github.com/acme/repo/pull/7");
  });

  it("re-review fallita (ticketId null) più recente della review col ticket → il merge chiude comunque il ticket", async () => {
    const project = await createProject({
      name: "Review Chiusura Failed Recente",
      provider: "github",
      repoUrl: "https://github.com/acme/review-chiusura-failed",
      credentials: { token: "tok" },
    });
    const ticketId = await insertReviewTicket(project.id, 1, "open");
    await seedPrReview(project.id, 7, ticketId);
    // Re-review della STESSA PR fallita DOPO quella completata: ticketId null
    // (le righe failed/running non hanno mai il ticket) e createdAt più
    // recente. La lookup del webhook deve saltarla e trovare la riga col ticket.
    await testDb.db.insert(prReviews).values({
      repositoryId: project.id,
      prNumber: 7,
      prUrl: "https://github.com/acme/repo/pull/7",
      prTitle: "Add login",
      headSha: "b".repeat(40),
      ticketId: null,
      status: "failed",
      createdAt: new Date(Date.now() + 60_000),
    });
    const body = githubPayload("feature/login");

    const res = await postGithubClosure(project, body);
    expect(res.statusCode).toBe(204);

    // Nonostante la riga più recente sia senza ticket, il ticket review della
    // riga completata si chiude a done con il commento system.
    expect(await ticketStatus(ticketId)).toBe("done");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
  });

  it("PR esterna chiusa senza merge → ticket review a closed", async () => {
    const project = await createProject({
      name: "Review Chiusura Rifiuto",
      provider: "github",
      repoUrl: "https://github.com/acme/review-chiusura-rifiuto",
      credentials: { token: "tok" },
    });
    const ticketId = await insertReviewTicket(project.id, 1, "open");
    await seedPrReview(project.id, 7, ticketId);
    await seedPendingReviewJob(project.id, 7);
    const body = githubClosedUnmergedPayload("feature/login");

    const res = await postGithubClosure(project, body);
    expect(res.statusCode).toBe(204);

    expect(await pendingJobs(project.id)).toHaveLength(0);
    // PR rifiutata (non mergiata): il ticket review va a closed, non done.
    expect(await ticketStatus(ticketId)).toBe("closed");
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
    expect(cmts[0]!.body).toContain("https://github.com/acme/repo/pull/7");
  });

  it("chiusura senza prNumber → nessun cleanup ma nessun errore", async () => {
    const project = await createProject({
      name: "Review Chiusura NoNumber",
      provider: "github",
      repoUrl: "https://github.com/acme/review-chiusura-nonumber",
      credentials: { token: "tok" },
    });
    // Pending di un'ALTRA PR (9): non deve essere toccato dal cleanup saltato.
    await seedPendingReviewJob(project.id, 9);
    // Payload closed SENZA number: provider anomalo → prNumber null.
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        merged: true,
        head: { ref: "feature/login" },
        html_url: "https://github.com/acme/repo/pull/7",
      },
    });

    const res = await postGithubClosure(project, body);
    expect(res.statusCode).toBe(204);
    // Il cleanup è stato saltato: il pending dell'altra PR resta.
    expect(await pendingJobs(project.id)).toHaveLength(1);
  });

  it("ticket review già chiuso → idempotente, un solo commento system", async () => {
    const project = await createProject({
      name: "Review Chiusura Idem",
      provider: "github",
      repoUrl: "https://github.com/acme/review-chiusura-idem",
      credentials: { token: "tok" },
    });
    const ticketId = await insertReviewTicket(project.id, 1, "open");
    await seedPrReview(project.id, 7, ticketId);
    await seedPendingReviewJob(project.id, 7);
    const body = githubPayload("feature/login");

    // Prima consegna: chiude il ticket con un commento.
    expect((await postGithubClosure(project, body)).statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    expect(await ticketComments(ticketId)).toHaveLength(1);

    // Seconda consegna dello STESSO evento: 204, nessun secondo commento.
    expect((await postGithubClosure(project, body)).statusCode).toBe(204);
    expect(await ticketStatus(ticketId)).toBe("done");
    expect(await ticketComments(ticketId)).toHaveLength(1);
  });

  it("ticket di FIX stubwise con riga pr_reviews → auto-chiusura review NON scatta, chiude il flusso stubwise (un solo commento)", async () => {
    const project = await createProject({
      name: "Review Chiusura FixTicket",
      provider: "github",
      repoUrl: "https://github.com/acme/review-chiusura-fixticket",
      credentials: { token: "tok" },
    });
    // Ticket di FIX (type bug, in_review) con la sua PR stubwise aperta...
    const ticketId = await insertTicket(project.id, 1, "in_review");
    await seedTicketRepository(ticketId, project.id, "open");
    const jobId = await insertJob(ticketId, "pr_opened");
    // ...e una riga pr_reviews che punta a QUEL ticket (es. la PR stubwise è
    // stata a sua volta reviewata). Il guard sul type deve impedire al ramo di
    // auto-chiusura review di toccare il ticket: se lo facesse, il flusso
    // stubwise sotto verrebbe cortocircuitato (riga ticket_repositories mai
    // marcata merged, job AI mai allineato) o il commento duplicato.
    await seedPrReview(project.id, 7, ticketId);

    // Merge della PR stubwise: head.ref stubwise/ticket-1, number 7.
    const body = githubPayload("stubwise/ticket-1");
    const res = await postGithubClosure(project, body);
    expect(res.statusCode).toBe(204);

    // Il ticket va a done tramite il FLUSSO STUBWISE: riga per-repo marcata
    // merged e job AI passato a pr_merged (side effect esclusivi di quel ramo).
    expect(await ticketStatus(ticketId)).toBe("done");
    expect(await repoState(ticketId, project.id)).toBe("merged");
    expect((await jobById(jobId)).status).toBe("pr_merged");
    // ESATTAMENTE UN commento system: quello del flusso stubwise, non due.
    const cmts = await ticketComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
  });
});
