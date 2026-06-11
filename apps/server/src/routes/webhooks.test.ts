import { createHmac, randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiJobs, comments, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
  });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface CreatedProject {
  id: string;
  slug: string;
  provider: string;
  webhookSecret: string;
}

/**
 * Crea un progetto via API e ne legge il webhookSecret reale dall'endpoint
 * admin dedicato (la proiezione pubblica del progetto non lo espone più).
 */
async function createProject(payload: Record<string, unknown>): Promise<CreatedProject> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: adminCookie },
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`creazione progetto fallita: ${res.statusCode} ${res.body}`);
  }
  const project = res.json() as { id: string; slug: string; provider: string };

  const webhookRes = await app.inject({
    method: "GET",
    url: `/api/projects/${project.slug}/webhook`,
    headers: { cookie: adminCookie },
  });
  if (webhookRes.statusCode !== 200) {
    throw new Error(`lettura webhookSecret fallita: ${webhookRes.statusCode} ${webhookRes.body}`);
  }
  const { webhookSecret } = webhookRes.json() as { webhookSecret: string };
  return { ...project, webhookSecret };
}

/** Inserisce un ticket con numero e stato espliciti, restituendone l'id. */
async function insertTicket(
  projectId: string,
  number: number,
  status: "in_review" | "done",
): Promise<string> {
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
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

/** Header firma HMAC-SHA256 (sha256=<hex>) sul raw body, schema condiviso da entrambi i provider. */
function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function bitbucketPayload(branch: string, prUrl = "https://bitbucket.org/acme/repo/pull-requests/7") {
  return JSON.stringify({
    pullrequest: { source: { branch: { name: branch } }, links: { html: { href: prUrl } } },
  });
}

function githubPayload(branch: string, prUrl = "https://github.com/acme/repo/pull/7") {
  return JSON.stringify({
    action: "closed",
    pull_request: { merged: true, head: { ref: branch }, html_url: prUrl },
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

  it("evento non rilevante (PR non mergiata) firmato → 204 ignorato", async () => {
    const project = await createProject({
      name: "Webhook NonMerge",
      provider: "github",
      repoUrl: "https://github.com/acme/webhook-nonmerge",
      credentials: { token: "tok" },
    });
    const body = JSON.stringify({
      action: "closed",
      pull_request: { merged: false, head: { ref: "stubwise/ticket-1" }, html_url: "x" },
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
    const [row] = await testDb.db
      .insert(projects)
      .values({
        name: "Legacy",
        slug: "legacy-no-secret",
        provider: "github",
        repoUrl: "https://github.com/acme/legacy",
        defaultBranch: "main",
        encryptedCredentials: "x",
        ingestionKey: randomBytes(16).toString("hex"),
        webhookSecret: "",
      })
      .returning({ id: projects.id, slug: projects.slug });
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
});
