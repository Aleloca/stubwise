import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { BitbucketProvider, GitHubProvider } from "@stubwise/git";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { gitAccounts, projects, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

/** Chiave AES-256 di test: la stessa passata a buildApp. */
const ENCRYPTION_KEY = randomBytes(32);

const PLAINTEXT_TOKEN = "token-git-in-chiaro-da-non-salvare";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let githubAccountId: string;
let bitbucketAccountId: string;
/** Progetto (gruppo) sotto cui nascono i repository dei test. */
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });

  ({ adminCookie, memberCookie } = await seedUsers(app));
  const [project] = await testDb.db
    .insert(projects)
    .values({ name: "Gruppo di test", slug: "gruppo-di-test", ingestionKey: randomBytes(16).toString("hex") })
    .returning({ id: projects.id });
  projectId = project!.id;
  githubAccountId = await createAccount({
    name: "Account GitHub",
    provider: "github",
    credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN },
  });
  bitbucketAccountId = await createAccount({
    name: "Account Bitbucket",
    provider: "bitbucket",
    credentials: { username: "git-user", email: "atlassian@acme.io", token: PLAINTEXT_TOKEN },
  });
}, 120_000);

/**
 * Ogni salvataggio verifica l'identità dell'account principale (avviso
 * `main_account_identity_unresolved`): senza un doppio, i test che non se ne
 * occupano chiamerebbero GitHub/Bitbucket per davvero. Il default RIGETTA —
 * così non scrive nessuna identità nella cache degli account condivisi — e i
 * test che ne hanno bisogno lo sovrascrivono.
 */
beforeEach(() => {
  vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("rete spenta nei test"));
  vi.spyOn(BitbucketProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("rete spenta nei test"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function createAccount(payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: adminCookie },
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`creazione account fallita: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

function createProject(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { cookie },
    payload,
  });
}

const basePayload = () => ({
  projectId,
  name: "Sito Vetrina",
  gitAccountId: githubAccountId,
  repoUrl: "https://github.com/acme/sito-vetrina",
});

describe("POST /api/projects", () => {
  it("l'admin crea un progetto: 201 con slug, provider ereditato dall'account, gitAccountId/Name", async () => {
    const res = await createProject(basePayload());
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      projectId,
      name: "Sito Vetrina",
      slug: "sito-vetrina",
      provider: "github",
      repoUrl: "https://github.com/acme/sito-vetrina",
      defaultBranch: "main",
      gitAccountId: githubAccountId,
      gitAccountName: "Account GitHub",
      // Nessun account revisore alla creazione, se non indicato.
      reviewGitAccountId: null,
      // Nessun revisore effettivo: né esplicito né un predefinito nell'ambito.
      effectiveReviewAccount: null,
      skippedDefaultReviewAccount: null,
      testCommand: null,
      installCommand: null,
      webhookConfiguredAt: null,
      // Knowledge graph spento alla creazione: si accende dalla PATCH.
      graphEnabled: false,
      createdAt: expect.any(String),
      // L'identità del principale non si legge (il doppio di default rigetta):
      // avviso non bloccante, il repository è creato comunque.
      warnings: ["main_account_identity_unresolved"],
    });
    expect(res.body).not.toContain("webhookSecret");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
  });

  it("il provider del progetto è quello dell'account (bitbucket)", async () => {
    const res = await createProject({
      projectId,
      name: "API Bitbucket",
      gitAccountId: bitbucketAccountId,
      repoUrl: "https://bitbucket.org/acme/api-bb",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { provider: string }).provider).toBe("bitbucket");
  });

  it("account inesistente: 404", async () => {
    const res = await createProject({
      projectId,
      name: "Senza Account",
      gitAccountId: "00000000-0000-0000-0000-000000000000",
      repoUrl: "https://github.com/acme/senza-account",
    });
    expect(res.statusCode).toBe(404);
  });

  it("collisione di slug: stesso nome → suffisso numerico", async () => {
    const res = await createProject(basePayload());
    expect(res.statusCode).toBe(201);
    expect((res.json() as { slug: string }).slug).toBe("sito-vetrina-2");
  });

  it("defaultBranch esplicito viene rispettato", async () => {
    const res = await createProject({
      projectId,
      name: "API Backend",
      gitAccountId: bitbucketAccountId,
      repoUrl: "https://bitbucket.org/acme/api-backend",
      defaultBranch: "develop",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { slug: string; defaultBranch: string };
    expect(body.defaultBranch).toBe("develop");
    expect(body.slug).toBe("api-backend");
  });

  it("il repository NON genera più una ingestionKey e non la espone (salita al progetto, Fase 3)", async () => {
    const res = await createProject({
      ...basePayload(),
      name: "Repo Product Level",
    });
    expect(res.statusCode).toBe(201);
    // La proiezione pubblica del repository non contiene più ingestionKey.
    expect(res.json()).not.toHaveProperty("ingestionKey");
    expect(res.body).not.toContain("ingestionKey");
    expect(res.body).not.toContain("ingestion_key");
  });

  it("ogni progetto riceve un webhookSecret diverso (32 hex)", async () => {
    const secrets = await testDb.db.select({ secret: repositories.webhookSecret }).from(repositories);
    const unique = new Set(secrets.map((s) => s.secret));
    expect(unique.size).toBe(secrets.length);
    for (const { secret } of secrets) expect(secret).toMatch(/^[0-9a-f]{32}$/);
  });

  it("un member non può creare progetti: 403", async () => {
    const res = await createProject({ ...basePayload(), name: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/repositories", payload: basePayload() });
    expect(res.statusCode).toBe(401);
  });

  it("body non valido (gitAccountId mancante): 400", async () => {
    const res = await createProject({ name: "Rotto", repoUrl: "https://github.com/acme/rotto" });
    expect(res.statusCode).toBe(400);
  });

  it("campi oltre la lunghezza massima: 400", async () => {
    const tooLongName = await createProject({ ...basePayload(), name: "x".repeat(201) });
    expect(tooLongName.statusCode).toBe(400);
    const tooLongRepoUrl = await createProject({
      ...basePayload(),
      name: "Url Lungo",
      repoUrl: `https://github.com/acme/${"r".repeat(500)}`,
    });
    expect(tooLongRepoUrl.statusCode).toBe(400);
    const tooLongTestCommand = await createProject({
      ...basePayload(),
      name: "Test Command Lungo",
      testCommand: "x".repeat(501),
    });
    expect(tooLongTestCommand.statusCode).toBe(400);
    const tooLongInstallCommand = await createProject({
      ...basePayload(),
      name: "Install Command Lungo",
      installCommand: "x".repeat(501),
    });
    expect(tooLongInstallCommand.statusCode).toBe(400);
  });

  it("testCommand valorizzato alla creazione: persistito e restituito", async () => {
    const res = await createProject({
      ...basePayload(),
      name: "Con Test Command",
      testCommand: "pnpm test",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { testCommand: string | null }).testCommand).toBe("pnpm test");
  });

  it("testCommand omesso: null di default", async () => {
    const res = await createProject({ ...basePayload(), name: "Senza Test Command" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { testCommand: string | null }).testCommand).toBeNull();
  });

  it("installCommand valorizzato alla creazione: persistito e restituito", async () => {
    const res = await createProject({
      ...basePayload(),
      name: "Con Install Command",
      installCommand: "pnpm install --frozen-lockfile",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { installCommand: string | null }).installCommand).toBe(
      "pnpm install --frozen-lockfile",
    );
  });

  it("installCommand omesso: null di default", async () => {
    const res = await createProject({ ...basePayload(), name: "Senza Install Command" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { installCommand: string | null }).installCommand).toBeNull();
  });
});

describe("GET /api/projects", () => {
  it("un member legge la lista, senza credenziali né webhookSecret", async () => {
    const res = await app.inject({ method: "GET", url: "/api/repositories", headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body.map((p) => p.slug)).toContain("sito-vetrina");
    expect(body[0]).toHaveProperty("gitAccountName");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:slug", () => {
  it("un member legge il singolo progetto con gitAccountId/Name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/sito-vetrina",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { slug: string; gitAccountId: string; gitAccountName: string };
    expect(body.slug).toBe("sito-vetrina");
    expect(body.gitAccountId).toBe(githubAccountId);
    expect(body.gitAccountName).toBe("Account GitHub");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/non-esiste",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:slug/webhook", () => {
  it("l'admin legge il webhookSecret e il path del webhook", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/sito-vetrina/webhook",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { webhookSecret: string; webhookPath: string };
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{32}$/);
    expect(body.webhookPath).toBe("/webhooks/git/sito-vetrina");
  });

  it("un member non può leggere il webhookSecret: 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/sito-vetrina/webhook",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/non-esiste/webhook",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/projects/:slug", () => {
  it("l'admin aggiorna nome, repoUrl e defaultBranch; lo slug resta stabile", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: {
        name: "API Backend v2",
        repoUrl: "https://bitbucket.org/acme/api-backend-v2",
        defaultBranch: "main",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe("API Backend v2");
    expect(body.repoUrl).toBe("https://bitbucket.org/acme/api-backend-v2");
    expect(body.defaultBranch).toBe("main");
    expect(body.slug).toBe("api-backend");
  });

  it("cambio di account git: aggiorna gitAccountId e ri-denormalizza il provider", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { gitAccountId: githubAccountId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { gitAccountId: string; gitAccountName: string; provider: string };
    expect(body.gitAccountId).toBe(githubAccountId);
    expect(body.gitAccountName).toBe("Account GitHub");
    expect(body.provider).toBe("github");
  });

  it("cambio verso account inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { gitAccountId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH senza campi restituisce il progetto invariato", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("API Backend v2");
  });

  it("aggiorna testCommand e poi lo azzera con null; omesso lo lascia invariato", async () => {
    // Imposta il comando.
    const set = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { testCommand: "pnpm vitest run" },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { testCommand: string | null }).testCommand).toBe("pnpm vitest run");

    // PATCH senza testCommand: invariato.
    const untouched = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { name: "API Backend v3" },
    });
    expect((untouched.json() as { testCommand: string | null }).testCommand).toBe("pnpm vitest run");

    // null azzera.
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { testCommand: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { testCommand: string | null }).testCommand).toBeNull();
  });

  it("aggiorna installCommand e poi lo azzera con null; omesso lo lascia invariato", async () => {
    // Imposta il comando.
    const set = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { installCommand: "pnpm install --frozen-lockfile" },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { installCommand: string | null }).installCommand).toBe(
      "pnpm install --frozen-lockfile",
    );

    // PATCH senza installCommand: invariato.
    const untouched = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { name: "API Backend v4" },
    });
    expect((untouched.json() as { installCommand: string | null }).installCommand).toBe(
      "pnpm install --frozen-lockfile",
    );

    // null azzera.
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { installCommand: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { installCommand: string | null }).installCommand).toBeNull();
  });

  // I toggle di prodotto (docAutoUpdate, aiProviderId) sono saliti al PROGETTO:
  // le relative PATCH sono testate in projects.test.ts, non più qui. Il toggle
  // del knowledge graph invece è PER REPOSITORY e vive su questa PATCH.
  it("accende graphEnabled, lo espone e lo lascia invariato se omesso", async () => {
    const on = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { graphEnabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { graphEnabled: boolean }).graphEnabled).toBe(true);

    const untouched = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { name: "API Backend v5" },
    });
    expect((untouched.json() as { graphEnabled: boolean }).graphEnabled).toBe(true);

    const off = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: adminCookie },
      payload: { graphEnabled: false },
    });
    expect((off.json() as { graphEnabled: boolean }).graphEnabled).toBe(false);
  });

  it("un member non può aggiornare: 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repositories/api-backend",
      headers: { cookie: memberCookie },
      payload: { name: "Hackerato" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repositories/non-esiste",
      headers: { cookie: adminCookie },
      payload: { name: "Fantasma" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:slug/configure-webhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const HOOKS_URL = "https://api.github.com/repos/acme/sito-vetrina/hooks";

  function configure(slug: string, cookie = adminCookie) {
    return app.inject({
      method: "POST",
      url: `/api/repositories/${slug}/configure-webhook`,
      headers: { cookie },
    });
  }

  it("l'admin configura il webhook: usa le credenziali decifrate dell'account collegato", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === `${HOOKS_URL}?per_page=100` && (init?.method ?? "GET") === "GET") {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        if (url === HOOKS_URL && init?.method === "POST") {
          return Promise.resolve(new Response(JSON.stringify({ id: 99, config: { url } }), { status: 201 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const webhookRes = await app.inject({
      method: "GET",
      url: "/api/repositories/sito-vetrina/webhook",
      headers: { cookie: adminCookie },
    });
    const expectedSecret = (webhookRes.json() as { webhookSecret: string }).webhookSecret;

    const res = await configure("sito-vetrina");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; created: boolean; updated: boolean; url: string };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.updated).toBe(false);
    expect(body.url).toBe("https://stubwise.example.com/webhooks/git/sito-vetrina");

    const [row] = await testDb.db
      .select({ at: repositories.webhookConfiguredAt })
      .from(repositories)
      .where(eq(repositories.slug, "sito-vetrina"));
    expect(row!.at).toBeInstanceOf(Date);

    expect(res.body).not.toContain(expectedSecret);
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);

    // La chiamata uscente ha usato le credenziali decifrate DELL'ACCOUNT.
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect((post.init!.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${PLAINTEXT_TOKEN}`);
    const sent = JSON.parse(post.init!.body as string) as { config: { url: string; secret: string } };
    expect(sent.config.url).toBe("https://stubwise.example.com/webhooks/git/sito-vetrina");
    expect(sent.config.secret).toBe(expectedSecret);
  });

  it("webhook già presente: 200 con updated true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const hookUrl = "https://stubwise.example.com/webhooks/git/sito-vetrina";
        if (url === `${HOOKS_URL}?per_page=100` && (init?.method ?? "GET") === "GET") {
          return Promise.resolve(new Response(JSON.stringify([{ id: 5, config: { url: hookUrl } }]), { status: 200 }));
        }
        if (url === `${HOOKS_URL}/5` && init?.method === "PATCH") {
          return Promise.resolve(new Response(JSON.stringify({ id: 5 }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const res = await configure("sito-vetrina");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { created: boolean; updated: boolean };
    expect(body.created).toBe(false);
    expect(body.updated).toBe(true);
  });

  it("provider 403: 4xx con il messaggio di guida sui permessi webhook", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 }))));
    const res = await configure("sito-vetrina");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect((res.json() as { message: string }).message).toMatch(/webhook/i);
  });

  it("credenziali account non decifrabili: 400", async () => {
    // Sovrascrive il blob dell'account collegato con uno illeggibile.
    const [proj] = await testDb.db.select().from(repositories).where(eq(repositories.slug, "sito-vetrina"));
    await testDb.db
      .update(gitAccounts)
      .set({ encryptedCredentials: "non-decifrabile" })
      .where(eq(gitAccounts.id, proj!.gitAccountId));
    const res = await configure("sito-vetrina");
    expect(res.statusCode).toBe(400);
    // Ripristina un blob valido per non rompere altri test sull'account.
    const accountRes = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${proj!.gitAccountId}`,
      headers: { cookie: adminCookie },
      payload: { credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN } },
    });
    expect(accountRes.statusCode).toBe(200);
  });

  it("un member non può configurare: 403", async () => {
    const res = await configure("sito-vetrina", memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("slug inesistente: 404", async () => {
    const res = await configure("non-esiste");
    expect(res.statusCode).toBe(404);
  });
});

describe("account revisore (ciclo di correzione, 30 set 2026)", () => {
  /**
   * Identità sulla piattaforma per username: il principale è `acme-bot`.
   * `validateCredentials` restituisce TUTTI i controlli che GitHub fa davvero,
   * compreso quello dei webhook (che vuole Admin): un doppio con il solo push
   * nasconderebbe proprio il caso del revisore con la sola scrittura.
   */
  function mockGithub(
    opts: { pushOk?: boolean; restOk?: boolean; webhookOk?: boolean; identity?: (username: string) => string } = {},
  ) {
    const pushOk = opts.pushOk ?? true;
    const restOk = opts.restOk ?? true;
    const webhookOk = opts.webhookOk ?? true;
    const validate = vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockResolvedValue([
      { name: "Accesso git (push)", ok: pushOk, detail: pushOk ? "ok" : "403", purpose: "push" },
      { name: "Permessi repository (PR e merge)", ok: restOk, detail: restOk ? "ok" : "404", purpose: "rest" },
      {
        name: "Accesso webhook (config automatica)",
        ok: webhookOk,
        detail: webhookOk ? "ok" : "403/404: serve Admin",
        purpose: "webhook",
      },
    ]);
    const identity = vi
      .spyOn(GitHubProvider.prototype, "getAuthenticatedUserId")
      .mockImplementation(async (p) =>
        (opts.identity ?? ((u) => (u === "acme-bot" ? "1001" : "2002")))(p.credentials.username ?? ""),
      );
    return { validate, identity };
  }

  async function newRepository(): Promise<string> {
    const res = await createProject({ ...basePayload(), name: `Con revisore ${randomBytes(3).toString("hex")}` });
    return (res.json() as { slug: string }).slug;
  }

  function patch(slug: string, payload: Record<string, unknown>, cookie = adminCookie) {
    return app.inject({ method: "PATCH", url: `/api/repositories/${slug}`, headers: { cookie }, payload });
  }

  async function reviewColumn(slug: string): Promise<string | null> {
    const [row] = await testDb.db
      .select({ id: repositories.reviewGitAccountId })
      .from(repositories)
      .where(eq(repositories.slug, slug));
    return row!.id;
  }

  async function newReviewer(username = "review-bot"): Promise<string> {
    return createAccount({
      name: `Revisore ${randomBytes(3).toString("hex")}`,
      provider: "github",
      credentials: { username, token: PLAINTEXT_TOKEN },
    });
  }

  it("l'admin sceglie il revisore: 200, le due identità risolte e salvate", async () => {
    const { validate } = mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { reviewGitAccountId: string }).reviewGitAccountId).toBe(reviewerId);
    // I permessi si verificano SUL REPOSITORY, con le credenziali del revisore.
    expect(validate.mock.calls[0]![0]).toMatchObject({
      repoUrl: "https://github.com/acme/sito-vetrina",
      credentials: { username: "review-bot" },
    });
    const ids = await testDb.db
      .select({ id: gitAccounts.id, providerUserId: gitAccounts.providerUserId })
      .from(gitAccounts);
    expect(ids.find((a) => a.id === reviewerId)!.providerUserId).toBe("2002");
    expect(ids.find((a) => a.id === githubAccountId)!.providerUserId).toBe("1001");
  });

  it("l'identità del revisore si RI-risolve al salvataggio, anche se è già in cache", async () => {
    const { identity } = mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    await testDb.db.update(gitAccounts).set({ providerUserId: "vecchio" }).where(eq(gitAccounts.id, reviewerId));

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(200);
    expect(identity.mock.calls.some(([p]) => p.credentials.username === "review-bot")).toBe(true);
    const [row] = await testDb.db
      .select({ providerUserId: gitAccounts.providerUserId })
      .from(gitAccounts)
      .where(eq(gitAccounts.id, reviewerId));
    expect(row!.providerUserId).toBe("2002");
  });

  it("null toglie il revisore", async () => {
    mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    await patch(slug, { reviewGitAccountId: reviewerId });

    const res = await patch(slug, { reviewGitAccountId: null });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { reviewGitAccountId: string | null }).reviewGitAccountId).toBeNull();
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("un PATCH SENZA il campo non tocca il revisore (patch, non replace)", async () => {
    mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    expect((await patch(slug, { reviewGitAccountId: reviewerId })).statusCode).toBe(200);

    const res = await patch(slug, { name: `Rinominata ${randomBytes(3).toString("hex")}` });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { reviewGitAccountId: string }).reviewGitAccountId).toBe(reviewerId);
    expect(await reviewColumn(slug)).toBe(reviewerId);
  });

  it("cambiare il SOLO principale rifà i controlli locali, non quelli di rete, e tiene il revisore", async () => {
    const { validate } = mockGithub();
    const reviewerId = await newReviewer();
    const otherMain = await createAccount({
      name: `Altro principale ${randomBytes(3).toString("hex")}`,
      provider: "github",
      credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN },
    });
    const slug = await newRepository();
    expect((await patch(slug, { reviewGitAccountId: reviewerId })).statusCode).toBe(200);
    validate.mockClear();

    const res = await patch(slug, { gitAccountId: otherMain });

    expect(res.statusCode).toBe(200);
    expect(validate).not.toHaveBeenCalled();
    expect(await reviewColumn(slug)).toBe(reviewerId);
  });

  it("passare a un principale di un altro provider con un revisore GitHub: 400, niente scritto", async () => {
    mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    expect((await patch(slug, { reviewGitAccountId: reviewerId })).statusCode).toBe(200);

    const res = await patch(slug, { gitAccountId: bitbucketAccountId });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_provider_mismatch");
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.slug, slug));
    expect(row!.gitAccountId).toBe(githubAccountId);
  });

  it("lo stesso account del principale: 400 review_account_same_as_main, niente scritto", async () => {
    mockGithub();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: githubAccountId });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_same_as_main");
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("revisore inesistente: 404 review_git_account_not_found", async () => {
    mockGithub();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: "00000000-0000-4000-8000-000000000000" });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("review_git_account_not_found");
  });

  it("provider diverso: 400 review_account_provider_mismatch", async () => {
    mockGithub();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: bitbucketAccountId });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_provider_mismatch");
  });

  it("Bitbucket, workspace diverso: 400 review_account_workspace_mismatch", async () => {
    const mainBb = await createAccount({
      name: `BB principale ${randomBytes(3).toString("hex")}`,
      provider: "bitbucket",
      credentials: { username: "bb-bot", token: PLAINTEXT_TOKEN },
      workspace: "acme",
    });
    const otherBb = await createAccount({
      name: `BB altro ${randomBytes(3).toString("hex")}`,
      provider: "bitbucket",
      credentials: { username: "bb-review", token: PLAINTEXT_TOKEN },
      workspace: "altro-workspace",
    });
    const created = await createProject({
      ...basePayload(),
      name: `BB ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainBb,
      repoUrl: "https://bitbucket.org/acme/sito",
    });
    const slug = (created.json() as { slug: string }).slug;

    const res = await patch(slug, { reviewGitAccountId: otherBb });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_workspace_mismatch");
  });

  it("revisore con la sola SCRITTURA (webhook ko, push e REST ok): 200 — il webhook non gli serve", async () => {
    mockGithub({ webhookOk: false });
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewerId);
  });

  it("token senza accesso alla repository: 422 review_account_invalid col dettaglio dei controlli", async () => {
    mockGithub({ pushOk: false, restOk: false, webhookOk: false });
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("review_account_invalid");
    expect(body.message).toContain("Permessi repository (PR e merge)");
    // Push e webhook falliti non entrano nel messaggio: il revisore non pusha
    // e non gestisce webhook (allow-list del solo `rest`).
    expect(body.message).not.toContain("Accesso git (push)");
    expect(body.message).not.toContain("Accesso webhook");
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("revisore col solo PUSH ko (REST ok): 200 — il revisore non pusha", async () => {
    mockGithub({ pushOk: false, webhookOk: false });
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewerId);
  });

  // ── Bitbucket con le risposte REALI dopo CHANGE-2770 (1 ott 2026) ─────────
  // Il difetto di produzione: l'endpoint globale dei permessi risponde 404
  // per chiunque, e un revisore con un API token spesso non ha uno username
  // Bitbucket (push KO «username mancante», o 401 con uno indovinato). Il
  // provider VERO dietro `validateCredentials`: solo `fetch` è doppiato, con
  // le risposte che Bitbucket ha dato davvero al revisore di prova.
  function stubBitbucketFetch(r: {
    push?: number;
    rest: number;
    restHeaders?: Record<string, string>;
    hooks?: number;
    merge?: number;
  }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(".git/info/refs")) return new Response("", { status: r.push ?? 200 });
      if (url.includes("/pullrequests?pagelen=1")) {
        return new Response("{}", { status: r.rest, ...(r.restHeaders ? { headers: r.restHeaders } : {}) });
      }
      if (url.includes("/hooks?pagelen=1")) return new Response("", { status: r.hooks ?? 403 });
      if (url.includes("/2.0/user/permissions/repositories")) {
        return new Response('{"type":"error","error":{"message":"Resource not found"}}', { status: r.merge ?? 404 });
      }
      throw new Error(`fetch inatteso nel test: ${url}`);
    });
  }

  async function bitbucketPair(reviewerCredentials: Record<string, string>): Promise<{ slug: string; reviewBb: string }> {
    vi.spyOn(BitbucketProvider.prototype, "getAuthenticatedUserId").mockImplementation(async (p) =>
      p.credentials.email === "main@acme.test" ? "{main}" : "{review}",
    );
    const mainBb = await createAccount({
      name: `BB principale ${randomBytes(3).toString("hex")}`,
      provider: "bitbucket",
      credentials: { username: "bb-bot", email: "main@acme.test", token: PLAINTEXT_TOKEN },
      workspace: "acme",
    });
    const reviewBb = await createAccount({
      name: `BB revisore ${randomBytes(3).toString("hex")}`,
      provider: "bitbucket",
      credentials: { ...reviewerCredentials, token: PLAINTEXT_TOKEN },
      workspace: "acme",
    });
    const created = await createProject({
      ...basePayload(),
      name: `BB revisore reale ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainBb,
      repoUrl: "https://bitbucket.org/acme/sito",
    });
    return { slug: (created.json() as { slug: string }).slug, reviewBb };
  }

  it("Bitbucket, revisore SENZA username (merge 404, webhook 403, REST ok): 200 — nessun 422", async () => {
    const { slug, reviewBb } = await bitbucketPair({ email: "review@acme.test" });
    const fetchSpy = stubBitbucketFetch({ rest: 200, merge: 404 });

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewBb);
    // La REST è stata davvero interrogata: «200» non è «nessun controllo».
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/pullrequests?pagelen=1"))).toBe(true);
  });

  it("Bitbucket, revisore con uno username indovinato (push 401, merge 410): 200", async () => {
    const { slug, reviewBb } = await bitbucketPair({ username: "indovinato", email: "review@acme.test" });
    stubBitbucketFetch({ push: 401, rest: 200, merge: 410 });

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewBb);
  });

  // Gli SCOPE DEL REVISORE sul TOKEN, dalla stessa risposta della REST.
  const REVIEWER_SCOPES_HEADER =
    "read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:user:bitbucket";

  it("Bitbucket, REST ok e scope del revisore completi sul token: 200", async () => {
    const { slug, reviewBb } = await bitbucketPair({ email: "review@acme.test" });
    stubBitbucketFetch({
      rest: 200,
      restHeaders: { "x-credential-type": "api_token", "x-oauth-scopes": REVIEWER_SCOPES_HEADER },
    });

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewBb);
  });

  it("Bitbucket, REST ok ma il token non ha write:pullrequest: 422 che nomina lo scope (del TOKEN)", async () => {
    const { slug, reviewBb } = await bitbucketPair({ email: "review@acme.test" });
    stubBitbucketFetch({
      rest: 200,
      restHeaders: {
        "x-credential-type": "api_token",
        "x-oauth-scopes": REVIEWER_SCOPES_HEADER.replace(", write:pullrequest:bitbucket", ""),
      },
    });

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("review_account_invalid");
    expect(body.message).toContain("write:pullrequest:bitbucket");
    expect(body.message).toContain("token's scopes, not the user's permission");
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("Bitbucket, header degli scope assente (app password): 200 — «non verificabile», non blocca", async () => {
    const { slug, reviewBb } = await bitbucketPair({ username: "legacy", email: "review@acme.test" });
    stubBitbucketFetch({ rest: 200, push: 200 });

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewBb);
  });

  it("GitHub invariato: l'opzione degli scope arriva al provider ma non aggiunge check", async () => {
    mockGithub();
    vi.mocked(GitHubProvider.prototype.validateCredentials).mockRestore();
    const fetchSpy = stubGithubRepoFetch(true);
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(200);
    // Le stesse tre chiamate di sempre: nessuna per gli scope.
    expect(fetchSpy.mock.calls.map(([u]) => String(u)).sort()).toEqual(
      [
        "https://api.github.com/repos/acme/sito-vetrina",
        "https://api.github.com/repos/acme/sito-vetrina/hooks?per_page=1",
        "https://github.com/acme/sito-vetrina.git/info/refs?service=git-receive-pack",
      ].sort(),
    );
  });

  it.each([403, 401])("Bitbucket, revisore SENZA accesso alle PR (REST %i): 422 review_account_invalid", async (status) => {
    const { slug, reviewBb } = await bitbucketPair({ email: "review@acme.test" });
    stubBitbucketFetch({ rest: status, merge: 404 });

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("review_account_invalid");
    expect(body.message).toContain("Accesso REST API (PR)");
    expect(body.message).not.toContain("Accesso git (push)");
    expect(body.message).not.toContain("Permesso di merge");
    expect(await reviewColumn(slug)).toBeNull();
  });

  /**
   * GitHub VERO dietro `validateCredentials` (nessun doppio del metodo): solo
   * `fetch` è sostituito, così il test copre anche il cablaggio fra il motivo
   * dichiarato dal provider (`failure`) e la risposta della rotta.
   */
  function stubGithubRepoFetch(push: boolean) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(".git/info/refs")) return new Response("", { status: 200 });
      if (url === "https://api.github.com/repos/acme/sito-vetrina") {
        return new Response(JSON.stringify({ permissions: { push } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // I webhook vogliono Admin: al revisore non servono.
      if (url.includes("/hooks")) return new Response("", { status: 403 });
      throw new Error(`fetch inatteso nel test: ${url}`);
    });
  }

  it("GitHub, il revisore vede la repository ma permissions.push è false: 422 che lo dice in chiaro", async () => {
    mockGithub();
    vi.mocked(GitHubProvider.prototype.validateCredentials).mockRestore();
    stubGithubRepoFetch(false);
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("review_account_no_write_permission");
    expect(body.message).toBe("The review account has no write permission on the repository");
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("GitHub, permissions.push true (webhook 403): 200", async () => {
    mockGithub();
    vi.mocked(GitHubProvider.prototype.validateCredentials).mockRestore();
    stubGithubRepoFetch(true);
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(200);
    expect(await reviewColumn(slug)).toBe(reviewerId);
  });

  // La prima condizione M4 (cambio del SOLO principale in corsa con un altro
  // admin) non si riproduce da qui: la copre il CHECK della 0081, vedi il
  // commento accanto al suo test in packages/db/src/migration-0081.test.ts.

  it("PATCH con lo STESSO revisore già salvato: nessun controllo di rete", async () => {
    const { validate } = mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    expect((await patch(slug, { reviewGitAccountId: reviewerId })).statusCode).toBe(200);
    validate.mockClear();

    const res = await patch(slug, { reviewGitAccountId: reviewerId, testCommand: "pnpm test" });

    expect(res.statusCode).toBe(200);
    expect(validate).not.toHaveBeenCalled();
    expect(await reviewColumn(slug)).toBe(reviewerId);
  });

  it("cambia repoUrl con un revisore impostato: i suoi permessi si riverificano sulla repository NUOVA", async () => {
    const { validate } = mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    expect((await patch(slug, { reviewGitAccountId: reviewerId })).statusCode).toBe(200);
    validate.mockClear();
    validate.mockResolvedValue([
      { name: "Accesso git (push)", ok: false, detail: "403", purpose: "push" },
      { name: "Permessi repository (PR e merge)", ok: false, detail: "404", purpose: "rest" },
      { name: "Accesso webhook (config automatica)", ok: false, detail: "404", purpose: "webhook" },
    ]);

    const res = await patch(slug, { repoUrl: "https://github.com/acme/altra-repo" });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("review_account_invalid");
    expect(validate.mock.calls[0]![0]).toMatchObject({
      repoUrl: "https://github.com/acme/altra-repo",
      credentials: { username: "review-bot" },
    });
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.slug, slug));
    expect(row!.repoUrl).toBe("https://github.com/acme/sito-vetrina");
  });

  it("cambia defaultBranch senza revisore: nessun controllo di rete", async () => {
    const { validate } = mockGithub();
    const slug = await newRepository();

    const res = await patch(slug, { defaultBranch: "develop" });

    expect(res.statusCode).toBe(200);
    expect(validate).not.toHaveBeenCalled();
  });

  it("credenziali del REVISORE non decifrabili: 400 review_credentials_undecryptable", async () => {
    mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    await testDb.db
      .update(gitAccounts)
      .set({ encryptedCredentials: "non-decifrabile" })
      .where(eq(gitAccounts.id, reviewerId));

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("review_credentials_undecryptable");
    expect(body.message).toMatch(/review account/);
  });

  it("corsa fra due admin: il revisore diventa principale mentre si salva → 409, la regola regge", async () => {
    const { validate } = mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    // L'«altro admin»: mentre questo PATCH verifica il revisore (dopo aver
    // letto la riga), promuove quello stesso account a principale.
    validate.mockImplementationOnce(async () => {
      await testDb.db.update(repositories).set({ gitAccountId: reviewerId }).where(eq(repositories.slug, slug));
      return [
        { name: "Accesso git (push)", ok: true, detail: "ok", purpose: "push" },
        { name: "Permessi repository (PR e merge)", ok: true, detail: "ok", purpose: "rest" },
        { name: "Accesso webhook (config automatica)", ok: true, detail: "ok", purpose: "webhook" },
      ];
    });

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("repository_changed_concurrently");
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.slug, slug));
    expect(row!.gitAccountId).toBe(reviewerId);
    expect(row!.reviewGitAccountId).toBeNull();
  });

  it("due account dello STESSO utente della piattaforma: 400 review_account_same_identity", async () => {
    mockGithub({ identity: () => "1001" });
    const reviewerId = await newReviewer("acme-bot-bis");
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_same_identity");
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("identità del revisore non risolvibile: 422 review_account_identity_unresolved", async () => {
    vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockResolvedValue([
      { name: "Accesso git (push)", ok: true, detail: "ok" },
    ]);
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("401"));
    const reviewerId = await newReviewer();
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("review_account_identity_unresolved");
  });

  it("identità del PRINCIPALE non risolvibile scegliendo un revisore: 422 main_account_identity_unresolved", async () => {
    mockGithub({
      identity: (u) => {
        if (u === "acme-bot") throw new Error("403");
        return "2002";
      },
    });
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    await testDb.db.update(gitAccounts).set({ providerUserId: null }).where(eq(gitAccounts.id, githubAccountId));

    const res = await patch(slug, { reviewGitAccountId: reviewerId });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("main_account_identity_unresolved");
    expect(await reviewColumn(slug)).toBeNull();
  });

  it("Bitbucket senza lo scope read:user:bitbucket: 422 che lo dice", async () => {
    vi.spyOn(BitbucketProvider.prototype, "validateCredentials").mockResolvedValue([
      { name: "Accesso git (push)", ok: true, detail: "ok" },
    ]);
    vi.spyOn(BitbucketProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("403"));
    const mainBb = await createAccount({
      name: `BB principale ${randomBytes(3).toString("hex")}`,
      provider: "bitbucket",
      credentials: { username: "bb-bot", token: PLAINTEXT_TOKEN },
      workspace: "acme",
    });
    const reviewBb = await createAccount({
      name: `BB revisore ${randomBytes(3).toString("hex")}`,
      provider: "bitbucket",
      credentials: { username: "bb-review", token: PLAINTEXT_TOKEN },
      workspace: "acme",
    });
    const created = await createProject({
      ...basePayload(),
      name: `BB scope ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainBb,
      repoUrl: "https://bitbucket.org/acme/sito",
    });
    const slug = (created.json() as { slug: string }).slug;

    const res = await patch(slug, { reviewGitAccountId: reviewBb });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("review_account_identity_unresolved");
    expect(body.message).toContain("read:user:bitbucket");
    // Il messaggio del provider va nel log, non nella risposta; il token mai.
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
  });

  it("promuovere il revisore ad account principale: 400 review_account_same_as_main", async () => {
    mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    await patch(slug, { reviewGitAccountId: reviewerId });

    const res = await patch(slug, { gitAccountId: reviewerId });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_same_as_main");
  });

  it("alla creazione il revisore si può già indicare", async () => {
    mockGithub();
    const reviewerId = await newReviewer();

    const res = await createProject({
      ...basePayload(),
      name: `Nato con revisore ${randomBytes(3).toString("hex")}`,
      reviewGitAccountId: reviewerId,
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { reviewGitAccountId: string }).reviewGitAccountId).toBe(reviewerId);
  });

  it("alla creazione un revisore non valido: 400 e nessun repository creato", async () => {
    mockGithub();
    const name = `Mai nato ${randomBytes(3).toString("hex")}`;

    const res = await createProject({ ...basePayload(), name, reviewGitAccountId: githubAccountId });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_same_as_main");
    const rows = await testDb.db.select().from(repositories).where(eq(repositories.name, name));
    expect(rows).toHaveLength(0);
  });

  it("eliminato l'account revisore, il repository resta senza revisore (ON DELETE SET NULL)", async () => {
    mockGithub();
    const reviewerId = await newReviewer();
    const slug = await newRepository();
    expect((await patch(slug, { reviewGitAccountId: reviewerId })).statusCode).toBe(200);

    await testDb.db.delete(gitAccounts).where(eq(gitAccounts.id, reviewerId));

    expect(await reviewColumn(slug)).toBeNull();
    const res = await app.inject({ method: "GET", url: `/api/repositories/${slug}`, headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reviewGitAccountId: string | null }).reviewGitAccountId).toBeNull();
  });

  it("un member non può sceglierlo: 403, né in modifica né alla creazione", async () => {
    const slug = await newRepository();

    const res = await patch(slug, { reviewGitAccountId: null }, memberCookie);
    expect(res.statusCode).toBe(403);

    const created = await createProject(
      { ...basePayload(), name: `Del member ${randomBytes(3).toString("hex")}`, reviewGitAccountId: null },
      memberCookie,
    );
    expect(created.statusCode).toBe(403);
  });

  it("PATCH qualunque con l'identità del principale non leggibile: 200, salvato, e l'avviso", async () => {
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("403"));
    const slug = await newRepository();
    await testDb.db.update(gitAccounts).set({ providerUserId: null }).where(eq(gitAccounts.id, githubAccountId));

    const res = await patch(slug, { name: `Rinominata ${randomBytes(3).toString("hex")}` });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toEqual(["main_account_identity_unresolved"]);
    // Non bloccante: il nome è salvato.
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.slug, slug));
    expect(row!.name).toMatch(/^Rinominata /);
  });

  it("identità del principale già salvata: nessun avviso, e il provider NON viene interrogato", async () => {
    const identity = vi
      .spyOn(GitHubProvider.prototype, "getAuthenticatedUserId")
      .mockRejectedValue(new Error("non va chiamato: c'è la cache"));
    const slug = await newRepository();
    await testDb.db.update(gitAccounts).set({ providerUserId: "1001" }).where(eq(gitAccounts.id, githubAccountId));
    identity.mockClear();

    const res = await patch(slug, { testCommand: "pnpm test" });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toEqual([]);
    expect(identity).not.toHaveBeenCalled();
  });

  it("POST con l'identità del principale non leggibile: 201 e l'avviso", async () => {
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockRejectedValue(new Error("401"));
    await testDb.db.update(gitAccounts).set({ providerUserId: null }).where(eq(gitAccounts.id, githubAccountId));

    const res = await createProject({ ...basePayload(), name: `Senza identità ${randomBytes(3).toString("hex")}` });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings: string[] }).warnings).toEqual(["main_account_identity_unresolved"]);
  });

  it("POST con l'identità del principale in cache: 201 senza avviso", async () => {
    await testDb.db.update(gitAccounts).set({ providerUserId: "1001" }).where(eq(gitAccounts.id, githubAccountId));

    const res = await createProject({ ...basePayload(), name: `Con identità ${randomBytes(3).toString("hex")}` });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings: string[] }).warnings).toEqual([]);
  });

  it("il provider che LANCIA (invece di rigettare): 200, salvato, avviso — mai un 5xx", async () => {
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockImplementation(() => {
      throw new Error("boom");
    });
    const slug = await newRepository();
    await testDb.db.update(gitAccounts).set({ providerUserId: null }).where(eq(gitAccounts.id, githubAccountId));

    const res = await patch(slug, { installCommand: "pnpm install" });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toEqual(["main_account_identity_unresolved"]);
  });

  it("la GET non porta `warnings`: l'avviso è solo dei salvataggi", async () => {
    const slug = await newRepository();

    const res = await app.inject({ method: "GET", url: `/api/repositories/${slug}`, headers: { cookie: adminCookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("warnings");
  });
});

describe("revisore EFFETTIVO nella proiezione (1 ott 2026)", () => {
  /** Un progetto suo: la lista si filtra lì, così le repository degli altri test non entrano. */
  let derivedProjectId: string;
  /** Principale GitHub delle repository di questo blocco. */
  let mainId: string;
  /** Revisore esplicito. */
  let explicitId: string;
  /** Predefinito dell'ambito GitHub. */
  let defaultId: string;

  beforeAll(async () => {
    const [project] = await testDb.db
      .insert(projects)
      .values({ name: "Derivati", slug: "derivati-revisore", ingestionKey: randomBytes(16).toString("hex") })
      .returning({ id: projects.id });
    derivedProjectId = project!.id;
    mainId = await createAccount({
      name: "Principale derivati",
      provider: "github",
      credentials: { username: "main-bot", token: PLAINTEXT_TOKEN },
    });
    explicitId = await createAccount({
      name: "Revisore esplicito",
      provider: "github",
      credentials: { username: "explicit-bot", token: PLAINTEXT_TOKEN },
    });
    defaultId = await createAccount({
      name: "Revisore predefinito",
      provider: "github",
      credentials: { username: "default-bot", token: PLAINTEXT_TOKEN },
    });
  });

  beforeEach(async () => {
    // L'identità in cache tiene la rete fuori da ogni controllo del principale.
    await testDb.db.update(gitAccounts).set({ providerUserId: "9001" }).where(eq(gitAccounts.id, mainId));
    await testDb.db.update(gitAccounts).set({ isDefaultReviewer: true }).where(eq(gitAccounts.id, defaultId));
  });

  afterEach(async () => {
    // Un predefinito lasciato acceso cambierebbe il revisore EFFETTIVO di ogni
    // repository GitHub degli altri blocchi.
    await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false });
  });

  /** Inserita direttamente: questa è la PROIEZIONE, non la validazione del form. */
  async function insertRepository(gitAccountId: string, reviewGitAccountId: string | null = null) {
    const name = `Derivata ${randomBytes(3).toString("hex")}`;
    const [row] = await testDb.db
      .insert(repositories)
      .values({
        projectId: derivedProjectId,
        name,
        slug: name.toLowerCase().replace(/\s+/g, "-"),
        provider: "github",
        gitAccountId,
        reviewGitAccountId,
        repoUrl: "https://github.com/acme/derivata",
        defaultBranch: "main",
        webhookSecret: randomBytes(16).toString("hex"),
      })
      .returning();
    return row!;
  }

  /** Validazione del revisore e identità: tutto ok, senza rete. */
  function mockGithubOk() {
    const validate = vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockResolvedValue([
      { name: "Accesso git (push)", ok: true, detail: "ok", purpose: "push" },
      { name: "Permessi repository (PR e merge)", ok: true, detail: "ok", purpose: "rest" },
    ]);
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockImplementation(async (p) =>
      p.credentials.username === "main-bot" ? "9001" : `id-${p.credentials.username ?? ""}`,
    );
    return validate;
  }

  type Derived = {
    slug: string;
    effectiveReviewAccount: { id: string; name: string; source: string } | null;
    skippedDefaultReviewAccount: { id: string; name: string } | null;
  };

  it("lista: esplicito, predefinito, nessuno e predefinito = principale, ognuno col suo", async () => {
    const withExplicit = await insertRepository(mainId, explicitId);
    const withDefault = await insertRepository(mainId);
    // Il predefinito è principale qui: non si applica, e lo si dice.
    const defaultIsMain = await insertRepository(defaultId);
    // Nessun predefinito nell'ambito Bitbucket: nessun revisore.
    const name = `Derivata bb ${randomBytes(3).toString("hex")}`;
    const [none] = await testDb.db
      .insert(repositories)
      .values({
        projectId: derivedProjectId,
        name,
        slug: name.toLowerCase().replace(/\s+/g, "-"),
        provider: "bitbucket",
        gitAccountId: bitbucketAccountId,
        repoUrl: "https://bitbucket.org/acme/derivata",
        defaultBranch: "main",
        webhookSecret: randomBytes(16).toString("hex"),
      })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories?projectId=${derivedProjectId}`,
      headers: { cookie: memberCookie },
    });

    expect(res.statusCode).toBe(200);
    const bySlug = new Map((res.json() as Derived[]).map((r) => [r.slug, r]));
    expect(bySlug.get(withExplicit.slug)).toMatchObject({
      effectiveReviewAccount: { id: explicitId, name: "Revisore esplicito", source: "explicit" },
      skippedDefaultReviewAccount: null,
    });
    expect(bySlug.get(withDefault.slug)).toMatchObject({
      effectiveReviewAccount: { id: defaultId, name: "Revisore predefinito", source: "default" },
      skippedDefaultReviewAccount: null,
    });
    expect(bySlug.get(defaultIsMain.slug)).toMatchObject({
      effectiveReviewAccount: null,
      skippedDefaultReviewAccount: { id: defaultId, name: "Revisore predefinito" },
    });
    expect(bySlug.get(none!.slug)).toMatchObject({
      effectiveReviewAccount: null,
      skippedDefaultReviewAccount: null,
    });
  });

  it("i sotto-oggetti hanno SOLO id, nome (e fonte): niente credenziali né identità", async () => {
    await testDb.db.update(gitAccounts).set({ providerUserId: "segreto-7777" }).where(eq(gitAccounts.id, defaultId));
    const withDefault = await insertRepository(mainId);
    const defaultIsMain = await insertRepository(defaultId);

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories?projectId=${derivedProjectId}`,
      headers: { cookie: memberCookie },
    });

    const bySlug = new Map((res.json() as Derived[]).map((r) => [r.slug, r]));
    expect(Object.keys(bySlug.get(withDefault.slug)!.effectiveReviewAccount!).sort()).toEqual(["id", "name", "source"]);
    expect(Object.keys(bySlug.get(defaultIsMain.slug)!.skippedDefaultReviewAccount!).sort()).toEqual(["id", "name"]);
    expect(res.body).not.toContain("encryptedCredentials");
    expect(res.body).not.toContain("providerUserId");
    expect(res.body).not.toContain("segreto-7777");
    expect(res.body).not.toContain("isDefaultReviewer");
  });

  it("GET /:slug porta gli stessi campi", async () => {
    const withDefault = await insertRepository(mainId);

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${withDefault.slug}`,
      headers: { cookie: memberCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      effectiveReviewAccount: { id: defaultId, name: "Revisore predefinito", source: "default" },
      skippedDefaultReviewAccount: null,
    });
  });

  it("POST porta gli stessi campi", async () => {
    mockGithubOk();

    const res = await createProject({
      projectId: derivedProjectId,
      name: `Creata ${randomBytes(3).toString("hex")}`,
      gitAccountId: defaultId,
      repoUrl: "https://github.com/acme/creata",
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      effectiveReviewAccount: null,
      skippedDefaultReviewAccount: { id: defaultId, name: "Revisore predefinito" },
    });
  });

  it("PATCH porta gli stessi campi, ricalcolati DOPO il salvataggio", async () => {
    mockGithubOk();
    const withExplicit = await insertRepository(mainId, explicitId);

    // Toglie l'esplicito: da quel momento vale il predefinito.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${withExplicit.slug}`,
      headers: { cookie: adminCookie },
      payload: { reviewGitAccountId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reviewGitAccountId: null,
      effectiveReviewAccount: { id: defaultId, name: "Revisore predefinito", source: "default" },
      skippedDefaultReviewAccount: null,
    });
  });

  // ── P1-6: l'avviso sul predefinito che diventa effettivo ──────────────────

  /** Il predefinito vede la repository ma non ci scrive. */
  function mockDefaultWithoutWrite() {
    const validate = vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockResolvedValue([
      { name: "Accesso git (push)", ok: true, detail: "ok", purpose: "push" },
      {
        name: "Permessi repository (PR e merge)",
        ok: false,
        detail: "permissions.push false",
        purpose: "rest",
        failure: "no_write_permission",
      },
    ]);
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockImplementation(async (p) =>
      p.credentials.username === "main-bot" ? "9001" : `id-${p.credentials.username ?? ""}`,
    );
    return validate;
  }

  it("POST senza revisore, predefinito senza scrittura: 201, riga creata, avviso NON bloccante", async () => {
    const validate = mockDefaultWithoutWrite();
    const name = `Avviso ${randomBytes(3).toString("hex")}`;

    const res = await createProject({
      projectId: derivedProjectId,
      name,
      gitAccountId: mainId,
      repoUrl: "https://github.com/acme/avviso",
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Derived & { warnings: string[] };
    expect(body.warnings).toEqual(["default_review_account_invalid"]);
    expect(body.effectiveReviewAccount).toMatchObject({ id: defaultId, source: "default" });
    // La verifica è del PREDEFINITO, sulla repository appena creata.
    expect(validate.mock.calls[0]![0]).toMatchObject({
      repoUrl: "https://github.com/acme/avviso",
      credentials: { username: "default-bot" },
    });
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.name, name));
    expect(row).toBeDefined();
  });

  it("POST, predefinito con SOLO push e merge ko (REST ok): nessun avviso falso", async () => {
    // Il caso di produzione dopo CHANGE-2770, in forma di doppio: push KO
    // (revisore senza username Bitbucket) e merge KO — nessuno dei due è un
    // requisito del revisore, quindi niente avviso.
    const validate = vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockResolvedValue([
      { name: "Accesso git (push)", ok: false, detail: "username mancante", purpose: "push" },
      { name: "Permessi repository (PR e merge)", ok: true, detail: "ok", purpose: "rest" },
      { name: "Accesso webhook (config automatica)", ok: false, detail: "403", purpose: "webhook" },
      { name: "Permesso di merge", ok: false, detail: "status 404", purpose: "merge" },
    ]);
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockImplementation(async (p) =>
      p.credentials.username === "main-bot" ? "9001" : `id-${p.credentials.username ?? ""}`,
    );

    const res = await createProject({
      projectId: derivedProjectId,
      name: `Solo push e merge ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainId,
      repoUrl: "https://github.com/acme/solo-push-merge",
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings: string[] }).warnings).toEqual([]);
    // Verificato davvero il predefinito: «nessun avviso» non è «nessun controllo».
    expect(validate.mock.calls.some(([p]) => p.credentials.username === "default-bot")).toBe(true);
  });

  it("POST con un predefinito valido: nessun avviso", async () => {
    mockGithubOk();

    const res = await createProject({
      projectId: derivedProjectId,
      name: `Valido ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainId,
      repoUrl: "https://github.com/acme/valido",
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { warnings: string[] }).warnings).toEqual([]);
  });

  it("PATCH che cambia solo il nome: nessuna chiamata di rete, nessun avviso", async () => {
    const validate = mockDefaultWithoutWrite();
    const repo = await insertRepository(mainId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: { name: `Rinominata ${randomBytes(3).toString("hex")}` },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  it("PATCH che RIMANDA i valori di sempre (il form lo fa): nessuna chiamata di rete", async () => {
    const validate = mockDefaultWithoutWrite();
    const repo = await insertRepository(mainId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: {
        gitAccountId: mainId,
        repoUrl: repo.repoUrl,
        defaultBranch: repo.defaultBranch,
        reviewGitAccountId: null,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(validate).not.toHaveBeenCalled();
  });

  it("PATCH che sposta la repository: il predefinito si riverifica DOVE andrà a scrivere", async () => {
    const validate = mockDefaultWithoutWrite();
    const repo = await insertRepository(mainId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: { repoUrl: "https://github.com/acme/spostata" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toEqual(["default_review_account_invalid"]);
    expect(validate.mock.calls[0]![0]).toMatchObject({ repoUrl: "https://github.com/acme/spostata" });
  });

  it("PATCH che cambia SOLO il branch di default: il predefinito si riverifica", async () => {
    const validate = mockDefaultWithoutWrite();
    const repo = await insertRepository(mainId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: { defaultBranch: "release" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toEqual(["default_review_account_invalid"]);
    // Verificato il PREDEFINITO, sul branch NUOVO: è lì che scriverà.
    expect(validate.mock.calls[0]![0]).toMatchObject({
      defaultBranch: "release",
      credentials: { username: "default-bot" },
    });
  });

  it("PATCH che cambia il principale: il predefinito si riverifica", async () => {
    const validate = mockDefaultWithoutWrite();
    const otherMain = await createAccount({
      name: `Altro principale ${randomBytes(3).toString("hex")}`,
      provider: "github",
      credentials: { username: "main-bot", token: PLAINTEXT_TOKEN },
    });
    const repo = await insertRepository(mainId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: { gitAccountId: otherMain },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { warnings: string[] }).warnings).toContain("default_review_account_invalid");
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("PATCH che toglie l'esplicito con un predefinito valido: nessun avviso, vale il predefinito", async () => {
    const validate = mockGithubOk();
    const repo = await insertRepository(mainId, explicitId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: { reviewGitAccountId: null },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Derived & { warnings: string[] };
    expect(body.warnings).toEqual([]);
    expect(body.effectiveReviewAccount).toMatchObject({ id: defaultId, source: "default" });
    // Il predefinito è stato verificato davvero: «nessun avviso» non è «nessun controllo».
    expect(validate.mock.calls.some(([p]) => p.credentials.username === "default-bot")).toBe(true);
  });

  it("l'identità del PRINCIPALE non leggibile: un avviso solo, quello del principale", async () => {
    mockGithubOk();
    vi.spyOn(GitHubProvider.prototype, "getAuthenticatedUserId").mockImplementation(async (p) => {
      if (p.credentials.username === "main-bot") throw new Error("403");
      return `id-${p.credentials.username ?? ""}`;
    });
    await testDb.db.update(gitAccounts).set({ providerUserId: null }).where(eq(gitAccounts.id, mainId));

    const res = await createProject({
      projectId: derivedProjectId,
      name: `Senza identità ${randomBytes(3).toString("hex")}`,
      gitAccountId: mainId,
      repoUrl: "https://github.com/acme/senza-identita",
    });

    expect(res.statusCode).toBe(201);
    // Il predefinito non ha colpe: la causa è il principale, e la dice già l'altro avviso.
    expect((res.json() as { warnings: string[] }).warnings).toEqual(["main_account_identity_unresolved"]);
  });

  it("la verifica del predefinito che LANCIA: 201, salvato — mai un 5xx", async () => {
    vi.spyOn(GitHubProvider.prototype, "validateCredentials").mockRejectedValue(new Error("boom"));
    const name = `Lancia ${randomBytes(3).toString("hex")}`;

    const res = await createProject({
      projectId: derivedProjectId,
      name,
      gitAccountId: mainId,
      repoUrl: "https://github.com/acme/lancia",
    });

    expect(res.statusCode).toBe(201);
    // Best-effort: la verifica che lancia si logga e NON diventa un avviso
    // (né quello del predefinito, né un altro al suo posto).
    expect((res.json() as { warnings: string[] }).warnings).toEqual([]);
    const [row] = await testDb.db.select().from(repositories).where(eq(repositories.name, name));
    expect(row).toBeDefined();
  });

  it("non regressione: con un predefinito attivo, l'esplicito = principale resta un 400", async () => {
    const repo = await insertRepository(mainId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repo.slug}`,
      headers: { cookie: adminCookie },
      payload: { reviewGitAccountId: mainId },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("review_account_same_as_main");
  });

  it("non regressione: il CHECK sulla colonna esplicita regge un inserimento diretto", async () => {
    await expect(insertRepository(mainId, mainId)).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
