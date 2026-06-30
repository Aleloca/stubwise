import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { aiProviders, gitAccounts, projects } from "@stubwise/db";
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

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });

  ({ adminCookie, memberCookie } = await seedUsers(app));
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
    url: "/api/projects",
    headers: { cookie },
    payload,
  });
}

const basePayload = () => ({
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
      name: "Sito Vetrina",
      slug: "sito-vetrina",
      provider: "github",
      repoUrl: "https://github.com/acme/sito-vetrina",
      defaultBranch: "main",
      ingestionKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      gitAccountId: githubAccountId,
      gitAccountName: "Account GitHub",
      testCommand: null,
      installCommand: null,
      webhookConfiguredAt: null,
      docAutoUpdate: false,
      aiProviderId: null,
      createdAt: expect.any(String),
    });
    expect(res.body).not.toContain("webhookSecret");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
  });

  it("il provider del progetto è quello dell'account (bitbucket)", async () => {
    const res = await createProject({
      name: "API Bitbucket",
      gitAccountId: bitbucketAccountId,
      repoUrl: "https://bitbucket.org/acme/api-bb",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { provider: string }).provider).toBe("bitbucket");
  });

  it("account inesistente: 404", async () => {
    const res = await createProject({
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

  it("ogni progetto riceve una ingestionKey diversa", async () => {
    const keys = await testDb.db.select({ key: projects.ingestionKey }).from(projects);
    const unique = new Set(keys.map((k) => k.key));
    expect(unique.size).toBe(keys.length);
  });

  it("ogni progetto riceve un webhookSecret diverso (32 hex)", async () => {
    const secrets = await testDb.db.select({ secret: projects.webhookSecret }).from(projects);
    const unique = new Set(secrets.map((s) => s.secret));
    expect(unique.size).toBe(secrets.length);
    for (const { secret } of secrets) expect(secret).toMatch(/^[0-9a-f]{32}$/);
  });

  it("un member non può creare progetti: 403", async () => {
    const res = await createProject({ ...basePayload(), name: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: basePayload() });
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
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body.map((p) => p.slug)).toContain("sito-vetrina");
    expect(body[0]).toHaveProperty("gitAccountName");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:slug", () => {
  it("un member legge il singolo progetto con gitAccountId/Name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina",
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
      url: "/api/projects/non-esiste",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:slug/webhook", () => {
  it("l'admin legge il webhookSecret e il path del webhook", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina/webhook",
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
      url: "/api/projects/sito-vetrina/webhook",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/non-esiste/webhook",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/projects/:slug", () => {
  it("l'admin aggiorna nome, repoUrl e defaultBranch; lo slug resta stabile", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
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
      url: "/api/projects/api-backend",
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
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { gitAccountId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH senza campi restituisce il progetto invariato", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
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
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { testCommand: "pnpm vitest run" },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { testCommand: string | null }).testCommand).toBe("pnpm vitest run");

    // PATCH senza testCommand: invariato.
    const untouched = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { name: "API Backend v3" },
    });
    expect((untouched.json() as { testCommand: string | null }).testCommand).toBe("pnpm vitest run");

    // null azzera.
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
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
      url: "/api/projects/api-backend",
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
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { name: "API Backend v4" },
    });
    expect((untouched.json() as { installCommand: string | null }).installCommand).toBe(
      "pnpm install --frozen-lockfile",
    );

    // null azzera.
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { installCommand: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { installCommand: string | null }).installCommand).toBeNull();
  });

  it("docAutoUpdate=true persiste e torna nella proiezione del progetto", async () => {
    const created = await createProject({ ...basePayload(), name: "Auto Update Toggle" });
    const slug = (created.json() as { slug: string }).slug;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
      payload: { docAutoUpdate: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { docAutoUpdate: boolean }).docAutoUpdate).toBe(true);

    // Rilettura: il valore è persistito.
    const reread = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
    });
    expect((reread.json() as { docAutoUpdate: boolean }).docAutoUpdate).toBe(true);
  });

  it("aiProviderId con provider esistente lo imposta, null lo azzera", async () => {
    const created = await createProject({ ...basePayload(), name: "AI Provider" });
    const slug = (created.json() as { slug: string }).slug;
    // Seed di un provider AI direttamente in DB (l'API di creazione non è qui).
    const [aiProvider] = await testDb.db
      .insert(aiProviders)
      .values({ position: 1, kind: "api_key", label: "Provider di test", secretEncrypted: "x" })
      .returning({ id: aiProviders.id });

    const set = await app.inject({
      method: "PATCH",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
      payload: { aiProviderId: aiProvider!.id },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { aiProviderId: string | null }).aiProviderId).toBe(aiProvider!.id);

    // null lo azzera (ricade sull'automatico).
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
      payload: { aiProviderId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { aiProviderId: string | null }).aiProviderId).toBeNull();
  });

  it("aiProviderId con provider inesistente: 400", async () => {
    const created = await createProject({ ...basePayload(), name: "AI Provider KO" });
    const slug = (created.json() as { slug: string }).slug;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${slug}`,
      headers: { cookie: adminCookie },
      payload: { aiProviderId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("un member non può aggiornare: 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: memberCookie },
      payload: { name: "Hackerato" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("slug inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/non-esiste",
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
      url: `/api/projects/${slug}/configure-webhook`,
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
        if (url === HOOKS_URL && (init?.method ?? "GET") === "GET") {
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
      url: "/api/projects/sito-vetrina/webhook",
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
      .select({ at: projects.webhookConfiguredAt })
      .from(projects)
      .where(eq(projects.slug, "sito-vetrina"));
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
        if (url === HOOKS_URL && (init?.method ?? "GET") === "GET") {
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
    const [proj] = await testDb.db.select().from(projects).where(eq(projects.slug, "sito-vetrina"));
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
