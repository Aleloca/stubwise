import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { decrypt, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

/** Chiave AES-256 di test: la stessa passata a buildApp, riusata per decifrare nelle assert. */
const ENCRYPTION_KEY = randomBytes(32);

const PLAINTEXT_TOKEN = "token-git-in-chiaro-da-non-salvare";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });

  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createProject(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie },
    payload,
  });
}

const basePayload = {
  name: "Sito Vetrina",
  provider: "github",
  repoUrl: "https://github.com/acme/sito-vetrina",
  credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN },
};

describe("POST /api/projects", () => {
  it("l'admin crea un progetto: 201 con slug generato, ingestionKey 32 hex e senza credenziali", async () => {
    const res = await createProject(basePayload);
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
      createdAt: expect.any(String),
    });
    // Il webhookSecret è un segreto HMAC: mai nella proiezione pubblica,
    // nemmeno per l'admin. Si legge solo via GET /:slug/webhook.
    expect(res.body).not.toContain("webhookSecret");
    // Mai credenziali nella risposta, nemmeno cifrate.
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
  });

  it("le credenziali sono salvate cifrate: il plaintext non compare nel DB", async () => {
    const [row] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "sito-vetrina"));
    expect(row).toBeDefined();
    expect(row!.encryptedCredentials).not.toContain(PLAINTEXT_TOKEN);
    expect(row!.encryptedCredentials).not.toContain("acme-bot");
    // E la decifratura con la chiave dell'app restituisce le credenziali originali.
    expect(JSON.parse(decrypt(row!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      username: "acme-bot",
      token: PLAINTEXT_TOKEN,
    });
  });

  it("salva cifrate anche username + email + token (API token Bitbucket) e non li espone", async () => {
    const res = await createProject({
      name: "API Token Bitbucket",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/api-token",
      credentials: { username: "git-user", email: "atlassian@acme.io", token: PLAINTEXT_TOKEN },
    });
    expect(res.statusCode).toBe(201);
    // Nessun campo sensibile nella risposta.
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    expect(res.body).not.toContain("atlassian@acme.io");

    const [row] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "api-token-bitbucket"));
    expect(row).toBeDefined();
    // Il blob cifrato non contiene i plaintext.
    expect(row!.encryptedCredentials).not.toContain(PLAINTEXT_TOKEN);
    expect(row!.encryptedCredentials).not.toContain("atlassian@acme.io");
    expect(row!.encryptedCredentials).not.toContain("git-user");
    // Round-trip: la decifratura restituisce tutti e tre i campi.
    expect(JSON.parse(decrypt(row!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      username: "git-user",
      email: "atlassian@acme.io",
      token: PLAINTEXT_TOKEN,
    });
  });

  it("collisione di slug: stesso nome → suffisso numerico", async () => {
    const res = await createProject(basePayload);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { slug: string }).slug).toBe("sito-vetrina-2");
  });

  it("defaultBranch esplicito viene rispettato e username è opzionale", async () => {
    const res = await createProject({
      name: "API Backend",
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/api-backend",
      defaultBranch: "develop",
      credentials: { token: "solo-token" },
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

  it("ogni progetto riceve un webhookSecret diverso", async () => {
    const secrets = await testDb.db.select({ secret: projects.webhookSecret }).from(projects);
    const unique = new Set(secrets.map((s) => s.secret));
    expect(unique.size).toBe(secrets.length);
    for (const { secret } of secrets) {
      expect(secret).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("un member non può creare progetti: 403", async () => {
    const res = await createProject({ ...basePayload, name: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: basePayload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("body non valido (provider sconosciuto): 400", async () => {
    const res = await createProject({ ...basePayload, name: "Rotto", provider: "gitlab" });
    expect(res.statusCode).toBe(400);
  });

  it("campi oltre la lunghezza massima: 400", async () => {
    const tooLongName = await createProject({ ...basePayload, name: "x".repeat(201) });
    expect(tooLongName.statusCode).toBe(400);
    const tooLongRepoUrl = await createProject({
      ...basePayload,
      name: "Url Lungo",
      repoUrl: `https://github.com/acme/${"r".repeat(500)}`,
    });
    expect(tooLongRepoUrl.statusCode).toBe(400);
    const tooLongBranch = await createProject({
      ...basePayload,
      name: "Branch Lungo",
      defaultBranch: "b".repeat(201),
    });
    expect(tooLongBranch.statusCode).toBe(400);
  });
});

describe("POST /api/projects/validate-credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function validate(payload: Record<string, unknown>, cookie = adminCookie) {
    return app.inject({
      method: "POST",
      url: "/api/projects/validate-credentials",
      headers: { cookie },
      payload,
    });
  }

  it("l'admin ottiene i check per Bitbucket: la rete è mockata via fetch globale", async () => {
    // git info/refs → 200, REST pullrequests → 200: entrambi ok.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.includes("api.bitbucket.org")) return Promise.resolve(new Response("{}", { status: 200 }));
        if (input.includes("info/refs")) return Promise.resolve(new Response("", { status: 200 }));
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const res = await validate({
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/shop",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveLength(3);
    expect(body.checks.map((c) => c.name)).toEqual([
      "Accesso git (push)",
      "Accesso REST API (PR)",
      "Accesso webhook (config automatica)",
    ]);
    expect(body.checks.every((c) => c.ok)).toBe(true);
  });

  it("riflette i fallimenti: REST 401 → ok:false con guida sull'email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.includes("api.bitbucket.org")) return Promise.resolve(new Response("", { status: 401 }));
        if (input.includes("info/refs")) return Promise.resolve(new Response("", { status: 200 }));
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const res = await validate({
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/acme/shop",
      credentials: { username: "alice", token: "api-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    expect(body.ok).toBe(false);
    const rest = body.checks.find((c) => c.name === "Accesso REST API (PR)")!;
    expect(rest.ok).toBe(false);
    expect(rest.detail).toMatch(/email/i);
  });

  it("un member non può validare: 403", async () => {
    const res = await validate(
      {
        provider: "github",
        repoUrl: "https://github.com/acme/demo",
        credentials: { token: "ghp_x" },
      },
      memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/validate-credentials",
      payload: {
        provider: "github",
        repoUrl: "https://github.com/acme/demo",
        credentials: { token: "ghp_x" },
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects", () => {
  it("un member legge la lista, senza credenziali nel payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body.length).toBeGreaterThanOrEqual(3);
    expect(body.map((p) => p.slug)).toContain("sito-vetrina");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    // Il webhookSecret non deve trapelare nella lista (member né admin).
    expect(res.body).not.toContain("webhookSecret");
  });

  it("nemmeno l'admin vede il webhookSecret nella lista", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("webhookSecret");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:slug", () => {
  it("un member legge il singolo progetto, senza credenziali", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.slug).toBe("sito-vetrina");
    expect(body.name).toBe("Sito Vetrina");
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    // Il singolo progetto non espone il webhookSecret a nessun ruolo.
    expect(res.body).not.toContain("webhookSecret");
  });

  it("nemmeno l'admin vede il webhookSecret sul singolo progetto", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
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
    expect(res.body).not.toContain("webhookSecret");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina/webhook",
    });
    expect(res.statusCode).toBe(401);
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
    // Lo slug è il path della DSN di ingestion: non cambia mai.
    expect(body.slug).toBe("api-backend");
  });

  it("l'admin aggiorna le credenziali: vengono ricifrate, mai in chiaro nel DB", async () => {
    const [before] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "api-backend"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/api-backend",
      headers: { cookie: adminCookie },
      payload: { credentials: { token: "nuovo-token-ruotato" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain("nuovo-token-ruotato");

    const [after] = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.slug, "api-backend"));
    expect(after!.encryptedCredentials).not.toBe(before!.encryptedCredentials);
    expect(after!.encryptedCredentials).not.toContain("nuovo-token-ruotato");
    expect(JSON.parse(decrypt(after!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      token: "nuovo-token-ruotato",
    });
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

  it("l'admin configura il webhook: 200 con created, url e dettaglio; usa creds decifrate e URL/secret corretti", async () => {
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
          return Promise.resolve(
            new Response(JSON.stringify({ id: 99, config: { url } }), { status: 201 }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    // Recupera il segreto webhook atteso per l'assert.
    const webhookRes = await app.inject({
      method: "GET",
      url: "/api/projects/sito-vetrina/webhook",
      headers: { cookie: adminCookie },
    });
    const expectedSecret = (webhookRes.json() as { webhookSecret: string }).webhookSecret;

    const res = await configure("sito-vetrina");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; created: boolean; updated: boolean; detail: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.updated).toBe(false);
    expect(body.url).toBe("https://stubwise.example.com/webhooks/git/sito-vetrina");

    // La risposta non deve MAI contenere il segreto né il token.
    expect(res.body).not.toContain(expectedSecret);
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);

    // La chiamata uscente ha usato le credenziali decifrate (Bearer token) e
    // l'URL/secret corretti nel body.
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect((post.init!.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${PLAINTEXT_TOKEN}`,
    );
    const sent = JSON.parse(post.init!.body as string) as {
      config: { url: string; secret: string };
    };
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
          return Promise.resolve(
            new Response(JSON.stringify([{ id: 5, config: { url: hookUrl } }]), { status: 200 }),
          );
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 }))),
    );

    const res = await configure("sito-vetrina");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = res.json() as { message: string };
    expect(body.message).toMatch(/webhook/i);
  });

  it("un member non può configurare: 403", async () => {
    const res = await configure("sito-vetrina", memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/sito-vetrina/configure-webhook",
    });
    expect(res.statusCode).toBe(401);
  });

  it("slug inesistente: 404", async () => {
    const res = await configure("non-esiste");
    expect(res.statusCode).toBe(404);
  });
});
