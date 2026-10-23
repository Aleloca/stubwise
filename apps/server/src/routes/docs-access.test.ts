import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  docChatSessions,
  docChunks,
  docGenerationJobs,
  docGenerations,
  docPages,
  projectEnvFiles,
  repoGraphs,
  repositories,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedEnvironment, seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import {
  addMember,
  createFakeGraphMcpClient,
  createUserWithPat,
  seedUsers,
  withOfflinePlatformIdentity,
} from "../test/fixtures.js";
import type { ChatLlm, ChatLlmInput } from "./chat-llm.js";

/**
 * Docs, repository, file d'ambiente, grafo e chat RAG sui PERMESSI (Task 7,
 * design `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Due progetti: A (gli utenti di test ne sono membri con ruoli diversi) e B
 * (nessuno di loro lo è). I test negativi asseriscono anche lo STATO (nessuna
 * riga nuova, colonna invariata), non solo lo status.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

const embeddingClient = createFakeEmbeddingClient();
let lastChatInput: ChatLlmInput | null = null;
const fakeChatLlm: ChatLlm = {
  async *stream(input: ChatLlmInput): AsyncIterable<string> {
    lastChatInput = input;
    yield "ok";
  },
  async isAvailable() {
    return { available: true };
  },
};
const fakeGraphClient = createFakeGraphMcpClient();

type Headers = { authorization: string };
interface TestUser {
  id: string;
  headers: Headers;
}

let testDb: TestDb;
let app: FastifyInstance;
let projectA: string;
let repoA: string;
let repoASlug: string;
let projectB: string;
let repoB: string;
let repoBSlug: string;
let lead: TestUser;
let dev: TestUser;
let legacy: TestUser;
let viewer: TestUser;
let contrib: TestUser;
let outsider: TestUser;
let adminCookie: string;

/** Testo distintivo delle pagine dei due progetti: la chat non deve mescolarli. */
const TEXT_A = "Il modulo Zqwfatture del progetto Alfa emette le fatture.";
const TEXT_B = "Il modulo Zqwfatture del progetto Beta archivia le fatture segrete.";

async function seedDocs(repositoryId: string, slug: string, text: string): Promise<void> {
  const [gen] = await testDb.db
    .insert(docGenerations)
    .values({
      repositoryId,
      status: "succeeded",
      commitSha: "abc1234",
      trigger: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  await testDb.db
    .update(repositories)
    .set({ currentDocGenerationId: gen!.id })
    .where(eq(repositories.id, repositoryId));
  const [page] = await testDb.db
    .insert(docPages)
    .values({
      repositoryId,
      generationId: gen!.id,
      kind: "technical",
      slug,
      title: "Fatture",
      body: text,
      isManual: false,
    })
    .returning();
  const [vector] = await embeddingClient.embed([text]);
  await testDb.db.insert(docChunks).values({
    pageId: page!.id,
    repositoryId,
    generationId: gen!.id,
    content: text,
    embedding: vector,
  });
}

async function seedGraph(repositoryId: string): Promise<void> {
  await testDb.db
    .update(repositories)
    .set({ graphEnabled: true })
    .where(eq(repositories.id, repositoryId));
  await testDb.db
    .insert(repoGraphs)
    .values({ repositoryId, status: "done", commitSha: "abcdef1234567890" });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
    chatLlm: fakeChatLlm,
    graphMcpClient: fakeGraphClient,
  });
  ({ adminCookie } = await seedUsers(app));
  ({ projectId: projectA, repositoryId: repoA } = await seedRepository(testDb.db));
  ({ projectId: projectB, repositoryId: repoB } = await seedRepository(testDb.db));
  const slugs = await testDb.db.select({ id: repositories.id, slug: repositories.slug }).from(repositories);
  repoASlug = slugs.find((r) => r.id === repoA)!.slug;
  repoBSlug = slugs.find((r) => r.id === repoB)!.slug;
  await seedDocs(repoA, "fatture-a", TEXT_A);
  await seedDocs(repoB, "fatture-b", TEXT_B);
  await seedGraph(repoA);

  lead = await createUserWithPat(app, "lead@example.com");
  dev = await createUserWithPat(app, "dev@example.com");
  legacy = await createUserWithPat(app, "legacy@example.com");
  viewer = await createUserWithPat(app, "viewer@example.com");
  contrib = await createUserWithPat(app, "contrib@example.com");
  outsider = await createUserWithPat(app, "outsider@example.com");
  await addMember(app, projectA, lead.id, "project_lead");
  await addMember(app, projectA, dev.id, "developer");
  await addMember(app, projectA, legacy.id, "legacy_member");
  await addMember(app, projectA, viewer.id, "viewer");
  await addMember(app, projectA, contrib.id, "contributor");
  // L'estraneo è membro di B ma non di A: vede B, non A.
  await addMember(app, projectB, outsider.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(() => {
  lastChatInput = null;
  fakeGraphClient.reset();
});

function call(
  user: TestUser,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: user.headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

describe("Docs di un repository: docs.view, docs.edit, docs.generate", () => {
  const reads = () => [
    `/api/repositories/${repoA}/docs/status`,
    `/api/repositories/${repoA}/docs/tree`,
    `/api/repositories/${repoA}/docs/highlights`,
    `/api/repositories/${repoA}/docs/pages/fatture-a`,
    `/api/repositories/${repoA}/docs/export?kind=technical`,
    `/api/repositories/${repoA}/docs/chat/sessions`,
  ];

  it("un non membro riceve 404 not_found su ogni lettura; Viewer e Contributor 200", async () => {
    for (const url of reads()) {
      const res = await call(outsider, "GET", url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
      expect(res.json()).toMatchObject({ code: "not_found" });
      for (const user of [viewer, contrib]) {
        const ok = await call(user, "GET", url);
        expect({ url, status: ok.statusCode }).toEqual({ url, status: 200 });
      }
    }
    const view = await call(outsider, "POST", `/api/repositories/${repoA}/docs/pages/fatture-a/view`);
    expect(view.statusCode).toBe(404);
  });

  it("pagina manuale: Viewer 403 (nessuna riga, nessuna modifica), Developer 201/200/204", async () => {
    const before = await testDb.db.select().from(docPages).where(eq(docPages.isManual, true));
    const denied = await call(viewer, "POST", `/api/repositories/${repoA}/docs/manual`, {
      title: "Appunti del viewer",
      body: "x",
    });
    expect(denied.statusCode).toBe(403);
    const after = await testDb.db.select().from(docPages).where(eq(docPages.isManual, true));
    expect(after.length).toBe(before.length);

    const created = await call(dev, "POST", `/api/repositories/${repoA}/docs/manual`, {
      title: "Appunti del developer",
      body: "x",
    });
    expect(created.statusCode).toBe(201);
    const pageId = (created.json() as { id: string }).id;

    const patch = await call(viewer, "PATCH", `/api/repositories/${repoA}/docs/manual/${pageId}`, {
      title: "Riscritto",
    });
    expect(patch.statusCode).toBe(403);
    const del = await call(viewer, "DELETE", `/api/repositories/${repoA}/docs/manual/${pageId}`);
    expect(del.statusCode).toBe(403);
    const [still] = await testDb.db.select().from(docPages).where(eq(docPages.id, pageId));
    expect(still?.title).toBe("Appunti del developer");

    const outsiderPatch = await call(outsider, "PATCH", `/api/repositories/${repoA}/docs/manual/${pageId}`, {
      title: "Riscritto",
    });
    expect(outsiderPatch.statusCode).toBe(404);

    expect((await call(dev, "PATCH", `/api/repositories/${repoA}/docs/manual/${pageId}`, { title: "Ok" })).statusCode).toBe(200);
    expect((await call(dev, "DELETE", `/api/repositories/${repoA}/docs/manual/${pageId}`)).statusCode).toBe(204);
  });

  it("generazione e ripresa: Legacy Member 403 senza job, Developer accoda", async () => {
    const denied = await call(legacy, "POST", `/api/repositories/${repoA}/docs/generate`);
    expect(denied.statusCode).toBe(403);
    expect(await testDb.db.select().from(docGenerationJobs).where(eq(docGenerationJobs.repositoryId, repoA))).toEqual([]);
    expect((await call(legacy, "POST", `/api/repositories/${repoA}/docs/resume`)).statusCode).toBe(403);
    expect((await call(outsider, "POST", `/api/repositories/${repoA}/docs/generate`)).statusCode).toBe(404);

    const queued = await call(dev, "POST", `/api/repositories/${repoA}/docs/generate`);
    expect(queued.statusCode).toBe(202);
    // Developer passa l'accesso: nessuna generazione in pausa → 409, non 403.
    expect((await call(dev, "POST", `/api/repositories/${repoA}/docs/resume`)).statusCode).toBe(409);
  });

  it("hub degli spazi: solo i repository dei progetti con docs.view", async () => {
    const ids = async (user: TestUser) =>
      ((await call(user, "GET", "/api/docs/spaces")).json() as { repositoryId: string }[]).map(
        (s) => s.repositoryId,
      );
    const viewerSpaces = await ids(viewer);
    expect(viewerSpaces).toContain(repoA);
    expect(viewerSpaces).not.toContain(repoB);
    const outsiderSpaces = await ids(outsider);
    expect(outsiderSpaces).toContain(repoB);
    expect(outsiderSpaces).not.toContain(repoA);
  });
});

describe("Docs di progetto e chat RAG", () => {
  it("le rotte dei Docs di un progetto invisibile rispondono 404", async () => {
    for (const url of [
      `/api/projects/${projectA}/docs/spaces`,
      `/api/projects/${projectA}/docs/highlights`,
      `/api/projects/${projectA}/docs/search?q=fatture`,
      `/api/projects/${projectA}/docs/chat/sessions`,
    ]) {
      const res = await call(outsider, "GET", url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
      const ok = await call(contrib, "GET", url);
      expect({ url, status: ok.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it("chat di un repository di un progetto invisibile: 404, nessuna sessione, nessun retrieval", async () => {
    const res = await call(viewer, "POST", `/api/repositories/${repoB}/docs/chat?stream=false`, {
      message: "Zqwfatture",
    });
    expect(res.statusCode).toBe(404);
    expect(lastChatInput).toBeNull();
    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, repoB));
    expect(sessions).toEqual([]);
  });

  it("chat di progetto: una domanda che tocca entrambi i progetti recupera SOLO quello visibile", async () => {
    const res = await call(viewer, "POST", `/api/projects/${projectA}/docs/chat?stream=false`, {
      message: "modulo Zqwfatture fatture",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sources: { repositoryId: string }[] };
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources.every((s) => s.repositoryId === repoA)).toBe(true);
    expect(lastChatInput!.system).toContain(TEXT_A);
    expect(lastChatInput!.system).not.toContain(TEXT_B);

    // E il progetto B, che il viewer non vede, non si interroga affatto.
    const other = await call(viewer, "POST", `/api/projects/${projectB}/docs/chat?stream=false`, {
      message: "modulo Zqwfatture fatture",
    });
    expect(other.statusCode).toBe(404);
  });

  it("ricerca di progetto: niente passaggi del progetto che non si vede", async () => {
    const res = await call(viewer, "GET", `/api/projects/${projectA}/docs/search?q=Zqwfatture`);
    expect(res.statusCode).toBe(200);
    const results = res.json() as { repositoryId: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.repositoryId === repoA)).toBe(true);
  });

  it("il grafo (codice) entra nella chat solo con repos.view: Contributor no, Viewer sì", async () => {
    fakeGraphClient.response = "TRAVERSAL da 'fatture'";
    const contribRes = await call(contrib, "POST", `/api/projects/${projectA}/docs/chat?stream=false`, {
      message: "fatture",
    });
    expect(contribRes.statusCode).toBe(200);
    expect(fakeGraphClient.calls).toEqual([]);
    const contribRepo = await call(contrib, "POST", `/api/repositories/${repoA}/docs/chat?stream=false`, {
      message: "fatture",
    });
    expect(contribRepo.statusCode).toBe(200);
    expect(fakeGraphClient.calls).toEqual([]);

    const viewerRes = await call(viewer, "POST", `/api/repositories/${repoA}/docs/chat?stream=false`, {
      message: "fatture",
    });
    expect(viewerRes.statusCode).toBe(200);
    expect(fakeGraphClient.calls.length).toBe(1);
  });
});

/** Campi di configurazione che arrivano solo con `repos.view` (R20). */
const CONFIG_FIELDS = [
  "gitAccountId",
  "gitAccountName",
  "testCommand",
  "installCommand",
  "webhookConfiguredAt",
  "graphEnabled",
] as const;

describe("Repository: repos.view / docs.view, repos.manage, git_accounts.manage", () => {
  it("elenco: con docs.view senza configurazione, con repos.view completa; nulla del progetto invisibile", async () => {
    const list = async (user: TestUser, query = "") =>
      (await call(user, "GET", `/api/repositories${query}`)).json() as Record<string, unknown>[];
    const viewerRepos = await list(viewer);
    expect(viewerRepos.map((r) => r.id)).toContain(repoA);
    expect(viewerRepos.map((r) => r.id)).not.toContain(repoB);
    expect(await list(viewer, `?projectId=${projectB}`)).toEqual([]);

    const devA = (await list(dev)).find((r) => r.id === repoA)!;
    expect(devA.config).toBe(true);
    for (const field of CONFIG_FIELDS) expect(devA).toHaveProperty(field);

    const contribRepos = await list(contrib);
    expect(contribRepos.map((r) => r.id)).toEqual([repoA]);
    const contribA = contribRepos[0]!;
    expect(contribA).toMatchObject({ id: repoA, slug: repoASlug, name: "Repository di test", config: false });
    for (const field of CONFIG_FIELDS) expect(contribA).not.toHaveProperty(field);
  });

  it("dettaglio: Contributor 200 senza configurazione, Developer completo, non membro 404", async () => {
    const contribRes = await call(contrib, "GET", `/api/repositories/${repoASlug}`);
    expect(contribRes.statusCode).toBe(200);
    const contribBody = contribRes.json() as Record<string, unknown>;
    expect(contribBody.config).toBe(false);
    for (const field of CONFIG_FIELDS) expect(contribBody).not.toHaveProperty(field);

    const devBody = (await call(dev, "GET", `/api/repositories/${repoASlug}`)).json() as Record<string, unknown>;
    expect(devBody.config).toBe(true);
    for (const field of CONFIG_FIELDS) expect(devBody).toHaveProperty(field);

    const hidden = await call(viewer, "GET", `/api/repositories/${repoBSlug}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: "not_found" });
  });

  it("webhook e modifica: Legacy Member 403 (nome invariato), Developer 200", async () => {
    expect((await call(legacy, "GET", `/api/repositories/${repoASlug}/webhook`)).statusCode).toBe(403);
    expect((await call(legacy, "POST", `/api/repositories/${repoASlug}/configure-webhook`)).statusCode).toBe(403);
    const denied = await call(legacy, "PATCH", `/api/repositories/${repoASlug}`, { name: "Rinominato" });
    expect(denied.statusCode).toBe(403);
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.id, repoA));
    expect(row?.name).toBe("Repository di test");

    expect((await call(dev, "GET", `/api/repositories/${repoASlug}/webhook`)).statusCode).toBe(200);
    expect((await call(outsider, "GET", `/api/repositories/${repoASlug}/webhook`)).statusCode).toBe(404);
    const ok = await withOfflinePlatformIdentity(() =>
      call(lead, "PATCH", `/api/repositories/${repoASlug}`, { name: "Repository di test" }),
    );
    expect(ok.statusCode).toBe(200);
  });

  it("cambiare l'account git vuole anche git_accounts.manage: Developer 403 (account invariato), full admin 200", async () => {
    const accountOf = async (id: string) =>
      (await testDb.db.select({ a: repositories.gitAccountId }).from(repositories).where(eq(repositories.id, id)))[0]!.a;
    const accountA = await accountOf(repoA);
    const accountB = await accountOf(repoB);

    const denied = await call(dev, "PATCH", `/api/repositories/${repoASlug}`, { gitAccountId: accountB });
    expect(denied.statusCode).toBe(403);
    expect(await accountOf(repoA)).toBe(accountA);
    const reviewDenied = await call(dev, "PATCH", `/api/repositories/${repoASlug}`, { reviewGitAccountId: accountB });
    expect(reviewDenied.statusCode).toBe(403);

    // Rimandare lo STESSO account (il form lo fa a ogni salvataggio) non è un cambio.
    const same = await withOfflinePlatformIdentity(() =>
      call(dev, "PATCH", `/api/repositories/${repoASlug}`, { gitAccountId: accountA, testCommand: "pnpm test" }),
    );
    expect(same.statusCode).toBe(200);

    const admin = await withOfflinePlatformIdentity(() =>
      app.inject({
        method: "PATCH",
        url: `/api/repositories/${repoASlug}`,
        headers: { cookie: adminCookie },
        payload: { gitAccountId: accountB },
      }),
    );
    expect(admin.statusCode).toBe(200);
    expect(await accountOf(repoA)).toBe(accountB);
    // Ripristino per gli altri test.
    await testDb.db.update(repositories).set({ gitAccountId: accountA }).where(eq(repositories.id, repoA));
  });

  it("creazione: repos.manage + git_accounts.manage (Developer e Legacy 403 senza riga, non membro 404, full admin 201)", async () => {
    const [account] = await testDb.db
      .select({ id: repositories.gitAccountId })
      .from(repositories)
      .where(eq(repositories.id, repoA));
    const payload = {
      projectId: projectA,
      name: "Nuovo",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/nuovo.git",
      defaultBranch: "main",
    };
    const count = async () => (await testDb.db.select().from(repositories).where(eq(repositories.projectId, projectA))).length;
    const before = await count();
    expect((await call(legacy, "POST", "/api/repositories", payload)).statusCode).toBe(403);
    expect((await call(outsider, "POST", "/api/repositories", payload)).statusCode).toBe(404);
    expect((await withOfflinePlatformIdentity(() => call(dev, "POST", "/api/repositories", payload))).statusCode).toBe(403);
    expect(await count()).toBe(before);
    const created = await withOfflinePlatformIdentity(() =>
      app.inject({ method: "POST", url: "/api/repositories", headers: { cookie: adminCookie }, payload }),
    );
    expect(created.statusCode).toBe(201);
    expect(await count()).toBe(before + 1);
  });
});

describe("File d'ambiente: repos.manage, lettura inclusa", () => {
  it("Legacy Member 403 (nessun file), Developer 200/201, non membro 404", async () => {
    const environmentId = await seedEnvironment(testDb.db, projectA);
    expect((await call(legacy, "GET", `/api/repositories/${repoA}/env-files`)).statusCode).toBe(403);
    expect((await call(outsider, "GET", `/api/repositories/${repoA}/env-files`)).statusCode).toBe(404);
    const denied = await call(legacy, "POST", `/api/repositories/${repoA}/env-files`, {
      path: ".env",
      environmentId,
    });
    expect(denied.statusCode).toBe(403);
    expect(await testDb.db.select().from(projectEnvFiles).where(eq(projectEnvFiles.repositoryId, repoA))).toEqual([]);

    expect((await call(dev, "GET", `/api/repositories/${repoA}/env-files`)).statusCode).toBe(200);
    const created = await call(dev, "POST", `/api/repositories/${repoA}/env-files`, {
      path: ".env",
      environmentId,
    });
    expect(created.statusCode).toBe(201);
    const fileId = (created.json() as { id: string }).id;
    expect(
      (await call(legacy, "PUT", `/api/repositories/${repoA}/env-files/${fileId}/vars/API_KEY`, { value: "x" }))
        .statusCode,
    ).toBe(403);
    expect((await call(legacy, "DELETE", `/api/repositories/${repoA}/env-files/${fileId}`)).statusCode).toBe(403);
    const [still] = await testDb.db.select().from(projectEnvFiles).where(eq(projectEnvFiles.id, fileId));
    expect(still).toBeDefined();
  });
});

describe("Grafo: repos.view, repos.manage", () => {
  it("stato: Viewer 200, Contributor 403, non membro 404", async () => {
    expect((await call(viewer, "GET", `/api/repositories/${repoA}/graph`)).statusCode).toBe(200);
    expect((await call(contrib, "GET", `/api/repositories/${repoA}/graph`)).statusCode).toBe(403);
    expect((await call(outsider, "GET", `/api/repositories/${repoA}/graph`)).statusCode).toBe(404);
    expect((await call(outsider, "GET", `/api/repositories/${repoA}/graph/report`)).statusCode).toBe(404);
  });

  it("rigenerazione e PR di setup: Legacy Member 403, Developer passa l'accesso", async () => {
    expect((await call(legacy, "POST", `/api/repositories/${repoA}/graph/generate`, {})).statusCode).toBe(403);
    expect((await call(legacy, "POST", `/api/repositories/${repoA}/graph/setup-pr`)).statusCode).toBe(403);
    expect((await call(outsider, "POST", `/api/repositories/${repoA}/graph/generate`, {})).statusCode).toBe(404);
    const ok = await call(dev, "POST", `/api/repositories/${repoA}/graph/generate`, {});
    expect([202, 409, 412]).toContain(ok.statusCode);
  });
});
