import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { decrypt, gitAccounts, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PLAINTEXT_TOKEN = "token-account-da-non-salvare";

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

function createAccount(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie },
    payload,
  });
}

const basePayload = {
  name: "Account GitHub",
  provider: "github",
  credentials: { username: "acme-bot", token: PLAINTEXT_TOKEN },
};

describe("POST /api/git-accounts", () => {
  it("l'admin crea un account: 201 con l'account pubblico, senza credenziali", async () => {
    const res = await createAccount(basePayload);
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      name: "Account GitHub",
      provider: "github",
      workspace: null,
      createdAt: expect.any(String),
    });
    expect(res.body).not.toContain("credentials");
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    expect(res.body).not.toContain("acme-bot");
  });

  it("salva il workspace Bitbucket e lo espone nella proiezione pubblica", async () => {
    const res = await createAccount({
      name: "Account Bitbucket WS",
      provider: "bitbucket",
      credentials: { username: "git-user", email: "atlassian@acme.io", token: PLAINTEXT_TOKEN },
      workspace: "mio-workspace",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.workspace).toBe("mio-workspace");
    const id = (body as { id: string }).id;
    const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(row!.workspace).toBe("mio-workspace");
  });

  it("le credenziali sono salvate cifrate (round-trip con la chiave dell'app)", async () => {
    const res = await createAccount({
      name: "Account Bitbucket",
      provider: "bitbucket",
      credentials: { username: "git-user", email: "atlassian@acme.io", token: PLAINTEXT_TOKEN },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(row!.encryptedCredentials).not.toContain(PLAINTEXT_TOKEN);
    expect(row!.encryptedCredentials).not.toContain("atlassian@acme.io");
    expect(JSON.parse(decrypt(row!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      username: "git-user",
      email: "atlassian@acme.io",
      token: PLAINTEXT_TOKEN,
    });
  });

  it("un member non può creare account: 403", async () => {
    const res = await createAccount({ ...basePayload, name: "Negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/git-accounts", payload: basePayload });
    expect(res.statusCode).toBe(401);
  });

  it("provider sconosciuto: 400", async () => {
    const res = await createAccount({ ...basePayload, provider: "gitlab" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/git-accounts", () => {
  it("un member legge la lista, senza credenziali", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/git-accounts",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(res.body).not.toContain(PLAINTEXT_TOKEN);
    expect(res.body).not.toContain("credentials");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/git-accounts" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/git-accounts/:id", () => {
  it("un member legge il singolo account; 404 se inesistente", async () => {
    const created = await createAccount({ ...basePayload, name: "Account Singolo" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("Account Singolo");

    const missing = await app.inject({
      method: "GET",
      url: "/api/git-accounts/00000000-0000-0000-0000-000000000000",
      headers: { cookie: memberCookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("PATCH /api/git-accounts/:id", () => {
  it("l'admin aggiorna il nome e ricifra le credenziali", async () => {
    const created = await createAccount({ ...basePayload, name: "Da Modificare" });
    const id = (created.json() as { id: string }).id;
    const [before] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));

    const res = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: "Modificato", credentials: { token: "nuovo-token-ruotato" } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("Modificato");
    expect(res.body).not.toContain("nuovo-token-ruotato");

    const [after] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(after!.encryptedCredentials).not.toBe(before!.encryptedCredentials);
    expect(JSON.parse(decrypt(after!.encryptedCredentials, ENCRYPTION_KEY))).toEqual({
      token: "nuovo-token-ruotato",
    });
  });

  it("l'admin aggiorna il workspace", async () => {
    const created = await createAccount({
      name: "WS da modificare",
      provider: "bitbucket",
      credentials: { email: "a@b.io", token: PLAINTEXT_TOKEN },
      workspace: "vecchio-ws",
    });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
      payload: { workspace: "nuovo-ws" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { workspace: string }).workspace).toBe("nuovo-ws");
  });

  it("PATCH vuoto restituisce l'account invariato", async () => {
    const created = await createAccount({ ...basePayload, name: "Invariato" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("Invariato");
  });

  it("un member non può modificare: 403", async () => {
    const created = await createAccount({ ...basePayload, name: "Protetto" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: memberCookie },
      payload: { name: "Hackerato" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/git-accounts/:id", () => {
  it("elimina un account non usato (204) e 404 al secondo tentativo", async () => {
    const created = await createAccount({ ...basePayload, name: "Da Eliminare" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("409 se un progetto usa l'account", async () => {
    const created = await createAccount({ ...basePayload, name: "In Uso" });
    const id = (created.json() as { id: string }).id;
    await testDb.db.insert(projects).values({
      name: "Progetto Collegato",
      slug: `collegato-${randomBytes(4).toString("hex")}`,
      provider: "github",
      gitAccountId: id,
      repoUrl: "https://github.com/acme/collegato",
      defaultBranch: "main",
      ingestionKey: randomBytes(16).toString("hex"),
      webhookSecret: randomBytes(16).toString("hex"),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { message: string }).message).toMatch(/in use/i);
  });

  it("un member non può eliminare: 403", async () => {
    const created = await createAccount({ ...basePayload, name: "Protetto Delete" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/git-accounts/:id/validate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validazione a livello account: usa /2.0/repositories/{workspace} e dà un singolo check", async () => {
    const created = await createAccount({
      name: "Validabile",
      provider: "bitbucket",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
      workspace: "mio-ws",
    });
    const id = (created.json() as { id: string }).id;
    const fetchMock = vi.fn((input: string) => {
      // Solo l'endpoint scoped al workspace GET /2.0/repositories/{workspace}
      // deve essere contattato (gli endpoint account/globali sono dismessi: 410).
      if (input.includes("api.bitbucket.org/2.0/repositories/mio-ws")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: `/api/git-accounts/${id}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: { name: string }[] };
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]!.name).toBe("Autenticazione e accesso workspace");
    expect(body.ok).toBe(true);
    // Nessuna chiamata agli endpoint account/globali dismessi.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("repositories?role=member"))).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/2.0/workspaces"))).toBe(false);
    // Nessuna sonda repo-specifica (info/refs).
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("info/refs"))).toBe(false);
  });

  it("account Bitbucket senza workspace: check fallito che richiede il workspace", async () => {
    const created = await createAccount({
      name: "SenzaWS",
      provider: "bitbucket",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });
    const id = (created.json() as { id: string }).id;
    const fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: `/api/git-accounts/${id}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: { ok: boolean; detail: string }[] };
    expect(body.ok).toBe(false);
    expect(body.checks[0]!.detail).toMatch(/workspace/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un member non può validare: 403", async () => {
    const created = await createAccount({ ...basePayload, name: "Validabile2" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/git-accounts/${id}/validate`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/git-accounts/:id/validate-repo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restituisce i 3 check repo-specifici per il repo dato (rete mockata)", async () => {
    const created = await createAccount({
      name: "RepoValidabile",
      provider: "bitbucket",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });
    const id = (created.json() as { id: string }).id;
    const fetchMock = vi.fn((input: string) => {
      if (input.includes("api.bitbucket.org")) return Promise.resolve(new Response("{}", { status: 200 }));
      if (input.includes("info/refs")) return Promise.resolve(new Response("", { status: 200 }));
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/validate-repo?repo=myws/myrepo`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: { name: string }[] };
    expect(body.checks).toHaveLength(3);
    expect(body.checks.map((c) => c.name)).toEqual([
      "Accesso git (push)",
      "Accesso REST API (PR)",
      "Accesso webhook (config automatica)",
    ]);
    // Il repoUrl ricostruito deve contenere il fullName richiesto.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("bitbucket.org/myws/myrepo")),
    ).toBe(true);
  });

  it("repo mancante nella query: 400", async () => {
    const created = await createAccount({ ...basePayload, name: "RepoNoQuery" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/validate-repo`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("account inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/git-accounts/00000000-0000-0000-0000-000000000000/validate-repo?repo=a/b",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può validare il repo: 403", async () => {
    const created = await createAccount({ ...basePayload, name: "RepoNegato" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/validate-repo?repo=a/b`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/git-accounts/:id/repositories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decifra le creds e mappa i repository (rete mockata)", async () => {
    const created = await createAccount({ ...basePayload, name: "Con Repo" });
    const id = (created.json() as { id: string }).id;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              { full_name: "acme/a", name: "a", clone_url: "https://github.com/acme/a.git", default_branch: "main" },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/repositories`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fullName: string }[];
    expect(body).toEqual([
      { fullName: "acme/a", name: "a", cloneUrl: "https://github.com/acme/a.git", defaultBranch: "main" },
    ]);
  });

  it("Bitbucket: elenca i repo del workspace dell'account via /2.0/repositories/{workspace}", async () => {
    const created = await createAccount({
      name: "Bitbucket Repos",
      provider: "bitbucket",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
      workspace: "mio-ws",
    });
    const id = (created.json() as { id: string }).id;
    const fetchMock = vi.fn((input: string) => {
      if (input.includes("api.bitbucket.org/2.0/repositories/mio-ws")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              values: [
                {
                  full_name: "mio-ws/repo-a",
                  name: "repo-a",
                  mainbranch: { name: "main" },
                  links: { clone: [{ name: "https", href: "https://bitbucket.org/mio-ws/repo-a.git" }] },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/repositories`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fullName: string }[];
    expect(body).toEqual([
      { fullName: "mio-ws/repo-a", name: "repo-a", cloneUrl: "https://bitbucket.org/mio-ws/repo-a.git", defaultBranch: "main" },
    ]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/2.0/workspaces"))).toBe(false);
  });

  it("Bitbucket senza workspace → 422", async () => {
    const created = await createAccount({
      name: "Bitbucket NoWS",
      provider: "bitbucket",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });
    const id = (created.json() as { id: string }).id;
    const fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/repositories`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { message: string }).message).toMatch(/workspace/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errore del provider (401) → 422 con messaggio", async () => {
    const created = await createAccount({ ...basePayload, name: "Repo 401" });
    const id = (created.json() as { id: string }).id;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("nope", { status: 401 }))));
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/repositories`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { message: string }).message).toMatch(/autenticazione|401/i);
  });

  it("un member non può elencare i repo: 403", async () => {
    const created = await createAccount({ ...basePayload, name: "Repo 403" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/repositories`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/git-accounts/:id/branches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decifra le creds e restituisce branch + default (rete mockata)", async () => {
    const created = await createAccount({ ...basePayload, name: "Con Branch" });
    const id = (created.json() as { id: string }).id;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input === "https://api.github.com/repos/acme/a") {
          return Promise.resolve(
            new Response(JSON.stringify({ default_branch: "main" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify([{ name: "main" }, { name: "dev" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/branches?repo=acme/a`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branches: ["main", "dev"], defaultBranch: "main" });
  });

  it("repo mancante nella query: 400", async () => {
    const created = await createAccount({ ...basePayload, name: "Branch No Repo" });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/git-accounts/${id}/branches`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
