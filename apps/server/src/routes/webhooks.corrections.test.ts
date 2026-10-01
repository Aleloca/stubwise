import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  aiJobs,
  comments,
  gitAccounts,
  prCorrections,
  prReviews,
  projects,
  repositories,
  ticketRepositories,
  tickets,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { BitbucketProvider, GitHubProvider, GitProviderError, type RepositoryPermission } from "@stubwise/git";
import type { PrComment } from "@stubwise/shared";
import { seedUsers } from "../test/fixtures.js";

/**
 * Il webhook "Request changes" (ciclo di correzione post-PR, design §5 e §9).
 *
 * I test che contano più degli altri sono i NEGATIVI sul ciclo che si
 * auto-innesca: un evento dall'account revisore o dall'account principale non
 * deve lasciare NESSUNA riga — si asserisce sulle righe di `pr_corrections` e
 * di `ai_jobs`, non sulla risposta (che è 204 in ogni caso, apposta: il
 * provider non deve ritentare un evento scartato).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

/** Id sulla piattaforma: i due account di Stubwise e la persona che chiede. */
const MAIN_ID = "1001";
const REVIEWER_ID = "1002";
const HUMAN_ID = "5150";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

interface Fixture {
  repositoryId: string;
  slug: string;
  secret: string;
  ticketId: string;
  mainAccountId: string;
  reviewAccountId: string | null;
}

async function createAccount(provider: "github" | "bitbucket", name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload: {
      name: `${name} ${randomBytes(3).toString("hex")}`,
      provider,
      credentials: { username: `${name}-bot`, token: `tok-${name}` },
      ...(provider === "bitbucket" ? { workspace: "acme" } : {}),
    },
  });
  if (res.statusCode !== 201) throw new Error(`account: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/**
 * Repository con account principale (e, di default, revisore) le cui
 * identità sono GIÀ salvate; un ticket #3 con la PR #42 aperta sul branch
 * `stubwise/ticket-3`. Revisore e identità si scrivono in DB: la validazione
 * della rotta repository ha i suoi test (Task D7).
 */
async function seedFixture(
  opts: {
    provider?: "github" | "bitbucket";
    withReviewer?: boolean;
    mainUserId?: string | null;
    reviewerUserId?: string | null;
    branch?: string;
    prState?: "open" | "merged" | "closed_unmerged";
  } = {},
): Promise<Fixture> {
  const provider = opts.provider ?? "github";
  const mainAccountId = await createAccount(provider, "principale");
  const reviewAccountId = opts.withReviewer === false ? null : await createAccount(provider, "revisore");
  const [project] = await testDb.db
    .insert(projects)
    .values({
      name: "Gruppo correzioni",
      slug: `gruppo-${randomBytes(4).toString("hex")}`,
      ingestionKey: randomBytes(16).toString("hex"),
    })
    .returning({ id: projects.id });
  const repoUrl =
    provider === "github" ? "https://github.com/acme/repo" : "https://bitbucket.org/acme/repo";
  const created = await app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie: adminCookie },
    payload: {
      projectId: project!.id,
      name: `Repo ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainAccountId,
      repoUrl,
    },
  });
  if (created.statusCode !== 201) throw new Error(`repository: ${created.statusCode} ${created.body}`);
  const repo = created.json() as { id: string; slug: string };
  const hook = await app.inject({
    method: "GET",
    url: `/api/repositories/${repo.slug}/webhook`,
    headers: { cookie: adminCookie },
  });
  const { webhookSecret } = hook.json() as { webhookSecret: string };

  await testDb.db
    .update(repositories)
    .set({ reviewGitAccountId: reviewAccountId })
    .where(eq(repositories.id, repo.id));
  await testDb.db
    .update(gitAccounts)
    .set({ providerUserId: opts.mainUserId === undefined ? MAIN_ID : opts.mainUserId })
    .where(eq(gitAccounts.id, mainAccountId));
  if (reviewAccountId) {
    await testDb.db
      .update(gitAccounts)
      .set({ providerUserId: opts.reviewerUserId === undefined ? REVIEWER_ID : opts.reviewerUserId })
      .where(eq(gitAccounts.id, reviewAccountId));
  }

  const [ticket] = await testDb.db
    .insert(tickets)
    .values({
      projectId: project!.id,
      number: 3,
      title: "Ticket con PR",
      type: "bug",
      priority: "medium",
      status: "in_review",
      source: "manual",
    })
    .returning({ id: tickets.id });
  await testDb.db.insert(ticketRepositories).values({
    ticketId: ticket!.id,
    repositoryId: repo.id,
    branch: opts.branch ?? "stubwise/ticket-3",
    prUrl:
      provider === "github"
        ? "https://github.com/acme/repo/pull/42"
        : "https://bitbucket.org/acme/repo/pull-requests/42",
    prState: opts.prState ?? "open",
    prNumber: 42,
  });

  return {
    repositoryId: repo.id,
    slug: repo.slug,
    secret: webhookSecret,
    ticketId: ticket!.id,
    mainAccountId,
    reviewAccountId,
  };
}

/**
 * `association` è `author_association` della review (E3): di default
 * `COLLABORATOR`, cioè una persona col permesso di chiedere modifiche; `null`
 * toglie il campo dal payload.
 */
function githubReview(
  o: {
    actorId?: string;
    login?: string;
    body?: string | null;
    branch?: string;
    prNumber?: number;
    association?: string | null;
  } = {},
) {
  return JSON.stringify({
    action: "submitted",
    review: {
      id: 900,
      state: "changes_requested",
      body: o.body === undefined ? "Manca il test sul carrello vuoto" : o.body,
      user: { id: Number(o.actorId ?? HUMAN_ID), login: o.login ?? "mario-rossi" },
      ...(o.association === null ? {} : { author_association: o.association ?? "COLLABORATOR" }),
    },
    pull_request: {
      number: o.prNumber ?? 42,
      html_url: `https://github.com/acme/repo/pull/${o.prNumber ?? 42}`,
      head: { ref: o.branch ?? "stubwise/ticket-3", sha: "a".repeat(40) },
      base: { ref: "main" },
    },
  });
}

function bitbucketChangesRequest(o: { actorId?: string; login?: string } = {}) {
  const user = {
    uuid: o.actorId ?? HUMAN_ID,
    nickname: o.login ?? "mario.rossi",
    display_name: "Mario Rossi",
  };
  return JSON.stringify({
    actor: user,
    changes_request: { date: "2026-09-30T10:00:00+00:00", user },
    pullrequest: {
      id: 42,
      source: { branch: { name: "stubwise/ticket-3" }, commit: { hash: "abc123def456" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "https://bitbucket.org/acme/repo/pull-requests/42" } },
    },
  });
}

/** Id di consegna: uno nuovo per chiamata, salvo quando il test simula una ritrasmissione. */
const newDelivery = () => randomBytes(8).toString("hex");

function postGithub(fx: Fixture, body: string, secret = fx.secret, delivery = newDelivery()) {
  return app.inject({
    method: "POST",
    url: `/webhooks/git/${fx.slug}`,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request_review",
      "x-github-delivery": delivery,
      "x-hub-signature-256": sign(secret, body),
    },
    payload: body,
  });
}

function postBitbucket(fx: Fixture, body: string, delivery = newDelivery()) {
  return app.inject({
    method: "POST",
    url: `/webhooks/git/${fx.slug}`,
    headers: {
      "content-type": "application/json",
      "x-event-key": "pullrequest:changes_request_created",
      "x-request-uuid": delivery,
      "x-hub-signature": sign(fx.secret, body),
    },
    payload: body,
  });
}

async function correctionsOf(repositoryId: string) {
  return testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, repositoryId));
}

async function correctionJobsOf(ticketId: string) {
  return testDb.db
    .select()
    .from(aiJobs)
    .where(and(eq(aiJobs.ticketId, ticketId), isNotNull(aiJobs.correctionId)));
}

/**
 * Commenti della PR: il webhook NON deve leggerli (lo fa il worker, C8). Il
 * primo test li offre al mock per provare che `listPrComments` non viene
 * chiamato nemmeno quando avrebbe qualcosa da dire.
 */
const COMMENTS: PrComment[] = [
  {
    id: "c1",
    authorId: HUMAN_ID,
    authorLogin: "mario-rossi",
    body: "Il nome della funzione è fuorviante",
    createdAt: "2026-09-30T09:00:00.000Z",
    path: "src/cart.ts",
    line: 12,
  },
  {
    id: "c2",
    authorId: MAIN_ID,
    authorLogin: "stubwise-bot",
    body: "## Review AI\nTutto ok",
    createdAt: "2026-09-30T09:01:00.000Z",
    path: null,
    line: null,
  },
  {
    id: "c3",
    authorId: REVIEWER_ID,
    authorLogin: "stubwise-review",
    body: "Modifiche richieste dalla review",
    createdAt: "2026-09-30T09:02:00.000Z",
    path: null,
    line: null,
  },
];

/** Un `getAuthenticatedUserId` che non deve essere chiamato: le identità sono salvate. */
function identityMustNotBeCalled(provider: typeof GitHubProvider | typeof BitbucketProvider) {
  return vi
    .spyOn(provider.prototype, "getAuthenticatedUserId")
    .mockRejectedValue(new Error("identità già salvata: il provider non va interrogato"));
}

/**
 * Il permesso reale dell'autore (E3, step 16): `getCollaboratorPermission`
 * del GitHubProvider spiato sul prototype. Un `Error` fa lanciare la chiamata
 * (→ `unverifiable`).
 */
function permissionIs(value: RepositoryPermission | Error) {
  const spy = vi.spyOn(GitHubProvider.prototype, "getCollaboratorPermission");
  return value instanceof Error ? spy.mockRejectedValue(value) : spy.mockResolvedValue(value);
}

/** La scorciatoia (OWNER/MEMBER/COLLABORATOR) o Bitbucket: il permesso non va chiesto. */
function permissionMustNotBeCalled() {
  return vi
    .spyOn(GitHubProvider.prototype, "getCollaboratorPermission")
    .mockRejectedValue(new Error("associazione fidata: il permesso non va chiesto"));
}

describe("webhook \"Request changes\" — chi lo chiede", () => {
  it("da una persona terza: una correzione `provider` in coda, col suo job, e il solo testo della review", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    const list = vi.spyOn(GitHubProvider.prototype, "listPrComments").mockResolvedValue(COMMENTS);

    const res = await postGithub(fx, githubReview());
    expect(res.statusCode).toBe(204);

    const rows = await correctionsOf(fx.repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticketId: fx.ticketId,
      prNumber: 42,
      trigger: "provider",
      status: "queued",
      requestedByUserId: null,
      requestedByProviderLogin: "mario-rossi",
      // E1: il webhook non scrive MAI il flag; la fotografia completa la fa il worker.
      feedbackComplete: false,
    });
    // Il webhook NON legge i commenti (la fotografia la rifà il worker
    // all'avvio, C8): salva solo il testo della review, attribuito a chi l'ha
    // scritta — il ripiego se la lettura del worker fallisce.
    const feedback = rows[0]!.providerFeedback as PrComment[];
    expect(feedback.map((c) => c.id)).toEqual(["review-body"]);
    expect(feedback[0]).toMatchObject({ authorId: HUMAN_ID, body: "Manca il test sul carrello vuoto", path: null });
    expect(list).not.toHaveBeenCalled();

    const jobs = await correctionJobsOf(fx.ticketId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "queued", correctionId: rows[0]!.id });
  });

  it("dall'ACCOUNT REVISORE: nessuna riga, nemmeno la lettura dei commenti", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    const list = vi.spyOn(GitHubProvider.prototype, "listPrComments").mockResolvedValue(COMMENTS);

    const res = await postGithub(fx, githubReview({ actorId: REVIEWER_ID, login: "stubwise-review" }));
    expect(res.statusCode).toBe(204);

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
  });

  it("dall'ACCOUNT PRINCIPALE: nessuna riga", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ actorId: MAIN_ID, login: "stubwise-bot" }));

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
  });

  it("identità del revisore NON risolvibile: fail-closed, nessuna riga", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    const identity = vi
      .spyOn(GitHubProvider.prototype, "getAuthenticatedUserId")
      .mockRejectedValue(new Error("401"));

    const res = await postGithub(fx, githubReview());
    expect(res.statusCode).toBe(204);

    expect(identity).toHaveBeenCalled();
    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
  });

  it("identità del principale mai salvata ma risolvibile: si salva, e la richiesta passa", async () => {
    const fx = await seedFixture({ mainUserId: null });
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockResolvedValue(MAIN_ID);

    await postGithub(fx, githubReview());

    const [main] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, fx.mainAccountId));
    expect(main!.providerUserId).toBe(MAIN_ID);
    expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
  });

  it("senza account revisore basta l'identità del principale", async () => {
    const fx = await seedFixture({ withReviewer: false });
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview());

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
  });

  // --- E3: chi ha il permesso di chiedere modifiche -----------------------

  // Un `it.each`, non un ciclo con tre `seedFixture()` nello stesso `it`: un
  // caso rosso dice QUALE associazione, e le spie si ripuliscono fra un caso e
  // l'altro senza `vi.restoreAllMocks()` a mano (afterEach del file).
  it.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"])(
    "GitHub, da un ESTRANEO (%s, permesso reale `read`): nessuna riga, nessun job",
    async (association) => {
      const fx = await seedFixture();
      identityMustNotBeCalled(GitHubProvider);
      const permission = permissionIs("read");

      const res = await postGithub(fx, githubReview({ association, actorId: "7777", login: "sconosciuto" }));
      expect(res.statusCode).toBe(204);

      expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
      expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
      // il permesso è stato chiesto per QUEL login
      expect(permission).toHaveBeenCalledTimes(1);
      expect(permission.mock.calls[0]![1]).toBe("sconosciuto");
    },
  );

  it("GitHub, author_association assente: decide il permesso reale (`none` → nessuna riga)", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    const permission = permissionIs("none");

    await postGithub(fx, githubReview({ association: null }));

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(permission).toHaveBeenCalledTimes(1);
  });

  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "GitHub, da %s: la correzione parte senza chiedere il permesso (scorciatoia)",
    async (association) => {
      const fx = await seedFixture();
      identityMustNotBeCalled(GitHubProvider);
      const permission = permissionMustNotBeCalled();

      await postGithub(fx, githubReview({ association }));

      const rows = await correctionsOf(fx.repositoryId);
      expect(rows).toHaveLength(1);
      // la fotografia minima porta l'associazione di chi ha scritto la review
      expect((rows[0]!.providerFeedback as PrComment[])[0]).toMatchObject({ authorAssociation: association });
      expect(permission).not.toHaveBeenCalled();
    },
  );

  // Vale anche come test di E3 lato Bitbucket: l'evento non porta nessuna
  // associazione (`authorAssociation: null`) e la correzione parte lo stesso.
  it("Bitbucket: chi è collegato (users.bitbucketUsername) viene registrato come utente", async () => {
    const fx = await seedFixture({ provider: "bitbucket" });
    identityMustNotBeCalled(BitbucketProvider);
    const [mario] = await testDb.db
      .insert(users)
      .values({
        email: `mario-${randomBytes(3).toString("hex")}@acme.test`,
        passwordHash: "x",
        role: "member",
        bitbucketUsername: `mario.rossi.${randomBytes(2).toString("hex")}`,
      })
      .returning();

    await postBitbucket(fx, bitbucketChangesRequest({ login: mario!.bitbucketUsername! }));

    const rows = await correctionsOf(fx.repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestedByUserId: mario!.id,
      requestedByProviderLogin: mario!.bitbucketUsername,
      // Bitbucket non porta testo: fotografia vuota ma NON null (la rifà il worker).
      providerFeedback: [],
    });
  });
});

describe("webhook \"Request changes\" — quale PR", () => {
  it("branch non di Stubwise: nessuna riga", async () => {
    const fx = await seedFixture({ branch: "feature/login" });
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ branch: "feature/login" }));

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
  });

  it("PR già mergiata: nessuna riga", async () => {
    const fx = await seedFixture({ prState: "merged" });
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview());

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
  });

  it("una PR diversa sullo stesso branch (numero diverso dalla riga): nessuna riga", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ prNumber: 41 }));

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
  });

  it("firma sbagliata: 401, nessuna riga (HMAC invariato)", async () => {
    const fx = await seedFixture();

    const res = await postGithub(fx, githubReview(), "segreto-sbagliato");

    expect(res.statusCode).toBe(401);
    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
  });
});

describe("webhook \"Request changes\" — riconsegne e concorrenza", () => {
  it("la STESSA consegna ricevuta due volte (ritrasmissione del provider) crea UNA riga", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    const body = githubReview();

    const first = await postGithub(fx, body, fx.secret, "delivery-1");
    const again = await postGithub(fx, body, fx.secret, "delivery-1");
    expect(first.statusCode).toBe(204);
    expect(again.statusCode).toBe(204);

    const rows = await correctionsOf(fx.repositoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(1);
  });

  it("due consegne DIVERSE (due Request changes veri) restano due richieste", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview(), fx.secret, "delivery-a");
    await postGithub(fx, githubReview({ login: "giulia-bianchi", actorId: "6160" }), fx.secret, "delivery-b");

    const statuses = (await correctionsOf(fx.repositoryId)).map((r) => r.status).sort();
    expect(statuses).toEqual(["pending", "queued"]);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(1);
  });

  it("Bitbucket: dedupe sull'header X-Request-UUID", async () => {
    const fx = await seedFixture({ provider: "bitbucket" });
    identityMustNotBeCalled(BitbucketProvider);
    const body = bitbucketChangesRequest();

    await postBitbucket(fx, body, "uuid-1");
    await postBitbucket(fx, body, "uuid-1");

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
  });

  it("un errore libera l'id di consegna: il ritentativo del provider (stesso id) passa", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    // Un'app il cui DB rifiuta SOLO la prima transazione (quella di
    // enqueueCorrection): la prima consegna finisce in 500, la seconda — stesso
    // id, come la ritrasmissione del provider — deve essere elaborata.
    let failures = 1;
    const flakyDb = new Proxy(testDb.db, {
      get(target, prop, receiver) {
        if (prop === "transaction" && failures > 0) {
          failures--;
          return () => Promise.reject(new Error("DB giù per il test"));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const flaky = buildApp({
      db: flakyDb,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      publicUrl: "https://stubwise.example.com",
    });
    try {
      const body = githubReview();
      const post = () =>
        flaky.inject({
          method: "POST",
          url: `/webhooks/git/${fx.slug}`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "pull_request_review",
            "x-github-delivery": "delivery-retry",
            "x-hub-signature-256": sign(fx.secret, body),
          },
          payload: body,
        });
      const first = await post();
      expect(first.statusCode).toBe(500);
      expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);

      const retry = await post();
      expect(retry.statusCode).toBe(204);
      expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
    } finally {
      await flaky.close();
    }
  });

  it("l'ultima review completata della PR entra come review_id (default di enqueueCorrection)", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    const [review] = await testDb.db
      .insert(prReviews)
      .values({
        repositoryId: fx.repositoryId,
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        prTitle: "Fix",
        headSha: "a".repeat(40),
        status: "completed",
        verdict: "request_changes",
      })
      .returning();

    await postGithub(fx, githubReview());

    expect((await correctionsOf(fx.repositoryId))[0]!.reviewId).toBe(review!.id);
  });

  it("una review senza testo: fotografia vuota ma non null", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ body: null }));

    expect((await correctionsOf(fx.repositoryId))[0]!.providerFeedback).toEqual([]);
  });
});

async function systemCommentsOf(ticketId: string) {
  return testDb.db
    .select()
    .from(comments)
    .where(and(eq(comments.ticketId, ticketId), eq(comments.authorType, "system")))
    .orderBy(comments.createdAt);
}

/** L'identità di QUALUNQUE account non si legge: il caso del token senza scope. */
function identityFails(provider: typeof GitHubProvider | typeof BitbucketProvider) {
  return vi.spyOn(provider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("403"));
}

describe("webhook \"Request changes\" scartato — l'avviso sul ticket", () => {
  it("identità non risolvibile: UN commento di sistema con PR, chi l'ha chiesto e il bottone", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);

    const res = await postGithub(fx, githubReview());
    expect(res.statusCode).toBe(204);

    const rows = await systemCommentsOf(fx.ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorType: "system", authorId: null });
    const lines = rows[0]!.body.split("\n");
    expect(lines[0]).toBe("Changes requested on PR #42: no correction was started");
    expect(rows[0]!.body).toContain("mario-rossi");
    expect(rows[0]!.body).toContain('"Apply corrections"');
    // GitHub: nessuno scope da nominare.
    expect(rows[0]!.body).not.toContain("read:user:bitbucket");
    // Un avviso, non una richiesta: nessuna correzione, nessun job.
    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
  });

  it("Bitbucket: l'avviso nomina lo scope read:user:bitbucket", async () => {
    const fx = await seedFixture({ provider: "bitbucket", mainUserId: null });
    identityFails(BitbucketProvider);

    await postBitbucket(fx, bitbucketChangesRequest());

    const [row] = await systemCommentsOf(fx.ticketId);
    expect(row!.body).toContain("read:user:bitbucket");
    expect(row!.body).toContain("mario.rossi");
    expect(row!.body).toContain("Bitbucket");
  });

  it("un secondo Request changes con la condizione che persiste: nessun commento nuovo", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);

    await postGithub(fx, githubReview());
    await postGithub(fx, githubReview({ login: "giulia-bianchi", actorId: "6160" }));

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(1);
  });

  it("dopo una richiesta dalla piattaforma riuscita DOPO l'avviso, un nuovo scarto riavvisa", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);
    await postGithub(fx, githubReview());
    const [notice] = await systemCommentsOf(fx.ticketId);

    // L'identità era tornata risolvibile: una correzione `provider` è nata
    // dopo l'avviso (qui scritta a mano; `done` per non toccare gli indici
    // unici parziali su pending/queued).
    await testDb.db.insert(prCorrections).values({
      ticketId: fx.ticketId,
      repositoryId: fx.repositoryId,
      prNumber: 42,
      trigger: "provider",
      status: "done",
      requestedByProviderLogin: "mario-rossi",
      providerFeedback: [],
      createdAt: new Date(notice!.createdAt.getTime() + 1_000),
    });

    await postGithub(fx, githubReview());

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(2);
  });

  it("una correzione NON `provider` nata dopo l'avviso non lo riarma (non prova che l'identità sia tornata)", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);
    await postGithub(fx, githubReview());
    const [notice] = await systemCommentsOf(fx.ticketId);

    // Un click su "Applica le correzioni" non passa dal webhook: niente dice
    // che l'identità degli account sia di nuovo leggibile.
    await testDb.db.insert(prCorrections).values({
      ticketId: fx.ticketId,
      repositoryId: fx.repositoryId,
      prNumber: 42,
      trigger: "stubwise",
      status: "done",
      createdAt: new Date(notice!.createdAt.getTime() + 1_000),
    });

    await postGithub(fx, githubReview());

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(1);
  });

  it("una correzione `provider` più VECCHIA dell'avviso non lo riarma", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);
    await testDb.db.insert(prCorrections).values({
      ticketId: fx.ticketId,
      repositoryId: fx.repositoryId,
      prNumber: 42,
      trigger: "provider",
      status: "done",
      requestedByProviderLogin: "mario-rossi",
      providerFeedback: [],
      createdAt: new Date(Date.now() - 60 * 60_000),
    });

    await postGithub(fx, githubReview());
    await postGithub(fx, githubReview());

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(1);
  });

  it("una PR diversa sullo stesso ticket: commento nuovo", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);
    await postGithub(fx, githubReview());

    // La PR #42 è stata chiusa e il fix ne ha aperta un'altra, la #43.
    await testDb.db
      .update(ticketRepositories)
      .set({ prNumber: 43, prUrl: "https://github.com/acme/repo/pull/43" })
      .where(eq(ticketRepositories.ticketId, fx.ticketId));
    await postGithub(fx, githubReview({ prNumber: 43 }));

    const rows = await systemCommentsOf(fx.ticketId);
    expect(rows.map((r) => r.body.split("\n")[0])).toEqual([
      "Changes requested on PR #42: no correction was started",
      "Changes requested on PR #43: no correction was started",
    ]);
  });

  it("scartato per un ALTRO motivo (evento dell'account principale, branch non di Stubwise): nessun commento", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ actorId: MAIN_ID, login: "stubwise-bot" }));
    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);

    const other = await seedFixture({ branch: "feature/login" });
    await postGithub(other, githubReview({ branch: "feature/login" }));
    expect(await systemCommentsOf(other.ticketId)).toHaveLength(0);
  });

  it("la scrittura del commento fallisce: 204 comunque, nessuna riga", async () => {
    const fx = await seedFixture({ reviewerUserId: null });
    identityFails(GitHubProvider);
    // Un'app col DB che rifiuta le transazioni: l'avviso si scrive in una
    // transazione (lock del dedup), il resto del ramo no. Verifica prima che
    // la rotta non apra una transazione PRIMA del ramo "Request changes":
    // se lo fa, restringi il Proxy (es. fallisci solo al secondo `transaction`).
    const failingDb = new Proxy(testDb.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") return () => Promise.reject(new Error("DB giù per il test"));
        return Reflect.get(target, prop, receiver);
      },
    });
    const faulty = buildApp({
      db: failingDb,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      publicUrl: "https://stubwise.example.com",
    });
    try {
      const body = githubReview();
      const res = await faulty.inject({
        method: "POST",
        url: `/webhooks/git/${fx.slug}`,
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request_review",
          "x-github-delivery": newDelivery(),
          "x-hub-signature-256": sign(fx.secret, body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await faulty.close();
    }
    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);
  });
});

describe("webhook \"Request changes\" da chi non ha il permesso — l'avviso sul ticket (E3)", () => {
  it("estraneo: nessuna riga pr_corrections, UN commento di sistema col titolo del motivo", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    permissionIs("read");

    const res = await postGithub(fx, githubReview({ association: "NONE", actorId: "7777", login: "sconosciuto" }));
    expect(res.statusCode).toBe(204);

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
    const rows = await systemCommentsOf(fx.ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body.split("\n")[0]).toBe(
      "Changes requested on PR #42 by an account without permission: no correction was started",
    );
    expect(rows[0]!.body).toContain("sconosciuto");
  });

  it("dieci richieste di estranei sulla stessa PR: UN commento (anti-flood)", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    permissionIs("read");

    for (let i = 0; i < 10; i++) {
      await postGithub(fx, githubReview({ association: "NONE", actorId: String(7000 + i), login: `estraneo-${i}` }));
    }

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(1);
  });

  it("collaboratore: la correzione parte e nessun commento di sistema", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ association: "COLLABORATOR" }));

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);
  });

  it("Bitbucket (nessuna associazione): la correzione parte e nessun commento di sistema", async () => {
    const fx = await seedFixture({ provider: "bitbucket" });
    identityMustNotBeCalled(BitbucketProvider);

    await postBitbucket(fx, bitbucketChangesRequest());

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);
  });

  it("il nostro revisore senza associazione ammessa: scartato come PROPRIO, in silenzio", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);

    await postGithub(fx, githubReview({ actorId: REVIEWER_ID, login: "stubwise-review", association: "NONE" }));

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);
  });

  it("i due motivi non si zittiscono a vicenda sulla stessa PR", async () => {
    // Prima un estraneo (identità risolte), poi l'identità del revisore si rompe.
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    permissionIs("read");
    await postGithub(fx, githubReview({ association: "NONE", actorId: "7777", login: "sconosciuto" }));
    vi.restoreAllMocks();

    await testDb.db
      .update(gitAccounts)
      .set({ providerUserId: null })
      .where(eq(gitAccounts.id, fx.reviewAccountId!));
    identityFails(GitHubProvider);
    await postGithub(fx, githubReview());

    const firstLines = (await systemCommentsOf(fx.ticketId)).map((r) => r.body.split("\n")[0]);
    expect(firstLines).toEqual([
      "Changes requested on PR #42 by an account without permission: no correction was started",
      "Changes requested on PR #42: no correction was started",
    ]);
  });
});

describe("webhook \"Request changes\" — il permesso reale (E3)", () => {
  it.each(["write", "maintain", "admin"] as const)(
    "CONTRIBUTOR (membro con appartenenza privata) con permesso %s: la correzione parte, nessun avviso",
    async (permission) => {
      const fx = await seedFixture();
      identityMustNotBeCalled(GitHubProvider);
      const spy = permissionIs(permission);

      await postGithub(fx, githubReview({ association: "CONTRIBUTOR", login: "membro-privato" }));

      expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
      expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);
      // col token dell'account PRINCIPALE e sulla repository della PR
      const [p, login] = spy.mock.calls[0]!;
      expect(login).toBe("membro-privato");
      expect(p.repoUrl).toBe("https://github.com/acme/repo");
      expect(p.credentials.token).toBe("tok-principale");
    },
  );

  it.each(["triage", "read", "none"] as const)(
    "permesso %s → denied: nessuna correzione, avviso «senza permesso»",
    async (permission) => {
      const fx = await seedFixture();
      identityMustNotBeCalled(GitHubProvider);
      permissionIs(permission);

      await postGithub(fx, githubReview({ association: "NONE", actorId: "7777", login: "sconosciuto" }));

      expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
      const rows = await systemCommentsOf(fx.ticketId);
      expect(rows.map((r) => r.body.split("\n")[0])).toEqual([
        "Changes requested on PR #42 by an account without permission: no correction was started",
      ]);
    },
  );

  it("la verifica fallisce → unverifiable: nessuna correzione, avviso col TERZO motivo", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    permissionIs(new GitProviderError("GitHub: accesso negato leggendo il permesso sulla repository (403)", 403, ""));

    const res = await postGithub(fx, githubReview({ association: "CONTRIBUTOR", login: "membro-privato" }));
    expect(res.statusCode).toBe(204);

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(0);
    expect(await correctionJobsOf(fx.ticketId)).toHaveLength(0);
    const rows = await systemCommentsOf(fx.ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body.split("\n")[0]).toBe(
      "Changes requested on PR #42, but the author's permission could not be verified: no correction was started",
    );
    expect(rows[0]!.body).toContain("membro-privato");
  });

  it("unverifiable ripetuto sulla stessa PR: UN commento (dedup per motivo)", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    permissionIs(new Error("rete"));

    for (let i = 0; i < 5; i++) {
      await postGithub(fx, githubReview({ association: "NONE", actorId: String(7000 + i), login: `estraneo-${i}` }));
    }

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(1);
  });

  it("denied e unverifiable sulla stessa PR non si zittiscono a vicenda", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    permissionIs("read");
    await postGithub(fx, githubReview({ association: "NONE", actorId: "7777", login: "sconosciuto" }));
    vi.restoreAllMocks();

    identityMustNotBeCalled(GitHubProvider);
    permissionIs(new Error("rete"));
    await postGithub(fx, githubReview({ association: "NONE", actorId: "7778", login: "altro" }));

    const firstLines = (await systemCommentsOf(fx.ticketId)).map((r) => r.body.split("\n")[0]);
    expect(firstLines).toEqual([
      "Changes requested on PR #42 by an account without permission: no correction was started",
      "Changes requested on PR #42, but the author's permission could not be verified: no correction was started",
    ]);
  });

  it("il nostro revisore (NONE): scartato come PROPRIO, il permesso non si chiede", async () => {
    const fx = await seedFixture();
    identityMustNotBeCalled(GitHubProvider);
    const spy = permissionMustNotBeCalled();

    await postGithub(fx, githubReview({ actorId: REVIEWER_ID, login: "stubwise-review", association: "NONE" }));

    expect(await systemCommentsOf(fx.ticketId)).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Bitbucket: il permesso non si chiede mai", async () => {
    const fx = await seedFixture({ provider: "bitbucket" });
    identityMustNotBeCalled(BitbucketProvider);
    const spy = permissionMustNotBeCalled();

    await postBitbucket(fx, bitbucketChangesRequest());

    expect(await correctionsOf(fx.repositoryId)).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
