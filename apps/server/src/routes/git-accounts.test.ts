import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { BitbucketProvider } from "@stubwise/git";
import { decrypt, gitAccounts, projects, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { resolveProviderUserId, type FetchPlatformIdentity } from "@stubwise/notifications";
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
      // Nessun account nasce revisore predefinito: lo si marca con la sua rotta.
      isDefaultReviewer: false,
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

  it("porta `isDefaultReviewer` di ogni account (1 ott 2026)", async () => {
    const created = await createAccount({ ...basePayload, name: "Predefinito in lista" });
    const id = (created.json() as { id: string }).id;
    await testDb.db.update(gitAccounts).set({ isDefaultReviewer: true }).where(eq(gitAccounts.id, id));
    try {
      const res = await app.inject({ method: "GET", url: "/api/git-accounts", headers: { cookie: memberCookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; isDefaultReviewer: boolean }[];
      expect(body.find((a) => a.id === id)?.isDefaultReviewer).toBe(true);
      // Gli altri no: il flag è per account, non un valore costante.
      expect(body.filter((a) => a.id !== id).every((a) => a.isDefaultReviewer === false)).toBe(true);
    } finally {
      // L'indice ammette un solo predefinito per ambito: non lasciarlo ai test dopo.
      await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false }).where(eq(gitAccounts.id, id));
    }
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

  it("cambiando le credenziali l'identità sulla piattaforma si azzera (il token può essere di un altro utente)", async () => {
    const created = await createAccount({ ...basePayload, name: "Con Identità" });
    const id = (created.json() as { id: string }).id;
    await testDb.db.update(gitAccounts).set({ providerUserId: "1001" }).where(eq(gitAccounts.id, id));
    const [initial] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));

    // Solo nome e workspace: né il blob né l'identità cambiano.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: "Rinominato", workspace: "altro-ws" },
    });
    expect(renamed.statusCode).toBe(200);
    let [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(row!.providerUserId).toBe("1001");
    expect(row!.encryptedCredentials).toBe(initial!.encryptedCredentials);

    // Credenziali nuove: l'identità si risolverà di nuovo al primo uso, e il
    // blob cambia nella STESSA scrittura (è la versione su cui
    // `resolveProviderUserId` guarda la sua cache).
    const res = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${id}`,
      headers: { cookie: adminCookie },
      payload: { credentials: { username: "altro-bot", token: "token-nuovo" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("token-nuovo");
    [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(row!.providerUserId).toBeNull();
    expect(row!.encryptedCredentials).not.toBe(initial!.encryptedCredentials);
  });

  it("una risoluzione dell'identità partita col token vecchio non riscrive la cache dopo il cambio di credenziali", async () => {
    const created = await createAccount({ ...basePayload, name: "Corsa Identità" });
    const id = (created.json() as { id: string }).id;
    await testDb.db.update(gitAccounts).set({ providerUserId: "id-del-token-vecchio" }).where(eq(gitAccounts.id, id));
    const [stale] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));

    // Il provider risponde col token VECCHIO, ma solo dopo che il PATCH ha
    // cambiato le credenziali.
    const fetchIdentity: FetchPlatformIdentity = async () => {
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/git-accounts/${id}`,
        headers: { cookie: adminCookie },
        payload: { credentials: { token: "token-del-bot-nuovo" } },
      });
      expect(patch.statusCode).toBe(200);
      return "id-del-token-vecchio";
    };
    const resolved = await resolveProviderUserId(testDb.db, ENCRYPTION_KEY, stale!, fetchIdentity, {
      refresh: true,
    });

    expect(resolved).toBeNull();
    const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(row!.providerUserId).toBeNull();
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

  it("409 se un repository usa l'account", async () => {
    const created = await createAccount({ ...basePayload, name: "In Uso" });
    const id = (created.json() as { id: string }).id;
    const [project] = await testDb.db
      .insert(projects)
      .values({
        name: "Progetto Collegato",
        slug: `gruppo-${randomBytes(4).toString("hex")}`,
        ingestionKey: randomBytes(16).toString("hex"),
      })
      .returning({ id: projects.id });
    await testDb.db.insert(repositories).values({
      projectId: project!.id,
      name: "Repository Collegato",
      slug: `collegato-${randomBytes(4).toString("hex")}`,
      provider: "github",
      gitAccountId: id,
      repoUrl: "https://github.com/acme/collegato",
      defaultBranch: "main",
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

  it("validazione a livello account: usa /2.0/repositories/{workspace}; senza header degli scope, «non verificabili»", async () => {
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
    const body = res.json() as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    // Il 200 non porta `x-oauth-scopes`: il secondo check dice che gli scope
    // non sono verificabili, con `ok: true` (D10) — il verdetto resta ok.
    expect(body.checks.map((c) => c.name)).toEqual(["Autenticazione e accesso workspace", "Scope del token"]);
    expect(body.checks[1]!.ok).toBe(true);
    expect(body.checks[1]!.detail).toMatch(/non verificabili/);
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

  it("restituisce i 4 check repo-specifici per il repo dato, incluso il permesso di merge (rete mockata)", async () => {
    const created = await createAccount({
      name: "RepoValidabile",
      provider: "bitbucket",
      credentials: { username: "alice", email: "alice@corp.io", token: "api-token" },
    });
    const id = (created.json() as { id: string }).id;
    const fetchMock = vi.fn((input: string) => {
      // Il check "Permesso di merge" (fase 8, Task 8) legge
      // /user/permissions/repositories: un match più specifico deve
      // precedere il fallback generico su api.bitbucket.org sotto.
      if (input.includes("/user/permissions/repositories")) {
        return Promise.resolve(
          new Response(JSON.stringify({ values: [{ permission: "write" }] }), { status: 200 }),
        );
      }
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
    expect(body.checks).toHaveLength(4);
    expect(body.checks.map((c) => c.name)).toEqual([
      "Accesso git (push)",
      "Accesso REST API (PR)",
      "Accesso webhook (config automatica)",
      "Permesso di merge",
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

/* Helper del revisore predefinito e degli scope di Validate (P1-7, P2-2). */

/** Gli scope che bastano al RUOLO revisore, senza i webhook. */
const REVIEWER_SCOPES =
  "read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:user:bitbucket";

function newWorkspace(): string {
  return `ws-${randomBytes(4).toString("hex")}`;
}

async function bitbucketAccount(name: string, workspace: string | undefined, token = `tok-${name}`): Promise<string> {
  const res = await createAccount({
    name,
    provider: "bitbucket",
    credentials: { username: "bot", email: `${name}@corp.io`, token },
    ...(workspace === undefined ? {} : { workspace }),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

/**
 * La chiamata di `validateAccount` (GET /2.0/repositories/{ws}): 200 con gli
 * scope dati; `scopes: null` = header assenti, come un'app password.
 */
function stubAccountProbe(scopes: string | null) {
  const fetchMock = vi.fn((input: string) => {
    if (input.includes("api.bitbucket.org/2.0/repositories/")) {
      const headers: Record<string, string> =
        scopes === null ? {} : { "x-credential-type": "api_token", "x-oauth-scopes": scopes };
      return Promise.resolve(new Response("{}", { status: 200, headers }));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Identità sulla piattaforma = derivata dal token: account diversi, utenti diversi. */
function stubIdentities(resolve: (token: string) => string | null = (t) => `uid-${t}`) {
  return vi.spyOn(BitbucketProvider.prototype, "getAuthenticatedUserId").mockImplementation(async (p) => {
    const id = resolve(p.credentials.token);
    if (id === null) throw new Error("403 read:user mancante");
    return id;
  });
}

function put(id: string, cookie = adminCookie) {
  return app.inject({ method: "PUT", url: `/api/git-accounts/${id}/default-reviewer`, headers: { cookie } });
}

async function flagOf(id: string): Promise<boolean> {
  const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
  return row!.isDefaultReviewer;
}

async function repository(name: string, mainId: string, reviewId: string | null = null): Promise<string> {
  const [project] = await testDb.db
    .insert(projects)
    .values({
      name: `Progetto ${name}`,
      slug: `p-${randomBytes(4).toString("hex")}`,
      ingestionKey: randomBytes(16).toString("hex"),
    })
    .returning({ id: projects.id });
  const [repo] = await testDb.db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name,
      slug: `r-${randomBytes(4).toString("hex")}`,
      provider: "bitbucket",
      gitAccountId: mainId,
      reviewGitAccountId: reviewId,
      repoUrl: `https://bitbucket.org/acme/${name}`,
      defaultBranch: "main",
      webhookSecret: randomBytes(16).toString("hex"),
    })
    .returning({ id: repositories.id });
  return repo!.id;
}

/**
 * Revisore predefinito (1 ott 2026, piano P1-7). Ogni test lavora in un
 * workspace Bitbucket SUO: l'indice ammette un predefinito per ambito, e i
 * test condividono il database.
 */
describe("PUT/DELETE /api/git-accounts/:id/default-reviewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("imposta il predefinito: 200, flag in DB, nessun predefinito sostituito", async () => {
    const ws = newWorkspace();
    const id = await bitbucketAccount("pr-bot-1", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    const res = await put(id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { account: { id: string; isDefaultReviewer: boolean }; replaced: unknown; warnings: unknown[] };
    expect(body.account.id).toBe(id);
    expect(body.account.isDefaultReviewer).toBe(true);
    expect(body.replaced).toBeNull();
    expect(body.warnings).toEqual([]);
    expect(await flagOf(id)).toBe(true);
    expect(res.body).not.toContain("tok-pr-bot-1");
  });

  it("un secondo account dello stesso ambito SOSTITUISCE il primo: `replaced`, un solo flag", async () => {
    const ws = newWorkspace();
    const first = await bitbucketAccount("primo", ws);
    const second = await bitbucketAccount("secondo", ws);
    // Un altro ambito non si tocca: stesso provider, workspace diverso.
    const elsewhere = await bitbucketAccount("altrove", newWorkspace());
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    expect((await put(first)).statusCode).toBe(200);
    expect((await put(elsewhere)).statusCode).toBe(200);

    const res = await put(second);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { replaced: unknown }).replaced).toEqual({ id: first, name: "primo" });
    expect(await flagOf(first)).toBe(false);
    expect(await flagOf(second)).toBe(true);
    expect(await flagOf(elsewhere)).toBe(true);
  });

  it("identità non leggibile: 422 e NESSUNA scrittura, nemmeno sul predefinito precedente", async () => {
    const ws = newWorkspace();
    const previous = await bitbucketAccount("precedente", ws);
    const candidate = await bitbucketAccount("senza-identita", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities((token) => (token === "tok-senza-identita" ? null : `uid-${token}`));
    expect((await put(previous)).statusCode).toBe(200);

    const res = await put(candidate);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string; message: string }).code).toBe("review_account_identity_unresolved");
    expect((res.json() as { message: string }).message).toMatch(/read:user:bitbucket/);
    expect(await flagOf(candidate)).toBe(false);
    expect(await flagOf(previous)).toBe(true);
  });

  it("scope del revisore mancanti: 422 coi dettagli; header assente (app password): 200, non verificabile ≠ ko", async () => {
    const ws = newWorkspace();
    const id = await bitbucketAccount("senza-write-pr", ws);
    stubIdentities();
    stubAccountProbe(
      "read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, read:user:bitbucket",
    );
    const res = await put(id);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("default_reviewer_invalid");
    expect(body.message).toMatch(/write:pullrequest:bitbucket/);
    expect(await flagOf(id)).toBe(false);

    vi.unstubAllGlobals();
    stubAccountProbe(null);
    expect((await put(id)).statusCode).toBe(200);
    expect(await flagOf(id)).toBe(true);
  });

  it("al revisore non si chiedono i webhook: un token senza webhook è un predefinito valido", async () => {
    const ws = newWorkspace();
    const id = await bitbucketAccount("solo-revisore", ws);
    stubIdentities();
    const fetchMock = stubAccountProbe(REVIEWER_SCOPES);
    const res = await put(id);
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Il difetto di produzione dopo il deploy della #70 (1 ott 2026), con il
   * provider VERO e le risposte che Bitbucket ha dato davvero al revisore di
   * prova: l'endpoint dei permessi dismesso (CHANGE-2770) risponde 404, il
   * revisore non ha uno username Bitbucket (push «username mancante»), i
   * webhook 403. Solo la REST delle PR conta: dove risponde 200 nessun
   * avviso, dove risponde 403 l'avviso c'è.
   */
  it("avvisi con le risposte REALI: revisore senza username, merge 404 → avviso SOLO dove la REST delle PR è negata", async () => {
    const ws = newWorkspace();
    const createdReviewer = await createAccount({
      name: "predefinito-senza-username",
      provider: "bitbucket",
      credentials: { email: "revisore@corp.io", token: "tok-revisore" },
      workspace: ws,
    });
    expect(createdReviewer.statusCode).toBe(201);
    const reviewer = (createdReviewer.json() as { id: string }).id;
    const main = await bitbucketAccount("principale-reale", ws);
    const reachable = await repository("raggiungibile", main);
    const noPr = await repository("senza-pr", main);

    stubIdentities();
    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith(`/2.0/repositories/${ws}?pagelen=1`)) {
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "x-credential-type": "api_token", "x-oauth-scopes": REVIEWER_SCOPES },
          }),
        );
      }
      if (input.includes(".git/info/refs")) return Promise.resolve(new Response("", { status: 401 }));
      if (input.includes("/pullrequests?pagelen=1")) {
        return Promise.resolve(new Response("{}", { status: input.includes("/senza-pr/") ? 403 : 200 }));
      }
      if (input.includes("/hooks?pagelen=1")) return Promise.resolve(new Response("", { status: 403 }));
      if (input.includes("/2.0/user/permissions/repositories")) {
        return Promise.resolve(new Response('{"type":"error"}', { status: 404 }));
      }
      throw new Error(`fetch inatteso nel test: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await put(reviewer);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { warnings: { repositoryId: string; code: string }[] };
    expect(body.warnings).toEqual([
      { repositoryId: noPr, repositoryName: "senza-pr", code: "review_account_invalid" },
    ]);
    expect(body.warnings.some((w) => w.repositoryId === reachable)).toBe(false);
    // Le due REST sono state davvero interrogate.
    expect(fetchMock.mock.calls.filter(([u]) => u.includes("/pullrequests?pagelen=1"))).toHaveLength(2);
    expect(await flagOf(reviewer)).toBe(true);
  });

  it("avvisi per repository: senza scrittura → il suo codice; dove è il principale → default_is_main; con esplicito → niente", async () => {
    const ws = newWorkspace();
    const reviewer = await bitbucketAccount("predefinito", ws);
    const main = await bitbucketAccount("principale", ws);
    const explicit = await bitbucketAccount("esplicito", ws);
    const noWrite = await repository("senza-scrittura", main);
    const writable = await repository("scrivibile", main);
    const ownMain = await repository("e-il-principale", reviewer);
    await repository("con-esplicito", main, explicit);
    // Un'altra repository in un altro ambito: non entra nelle verifiche.
    const otherWsMain = await bitbucketAccount("altro-principale", newWorkspace());
    await repository("altro-ambito", otherWsMain);

    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    const validate = vi.spyOn(BitbucketProvider.prototype, "validateCredentials").mockImplementation(async (p) =>
      p.repoUrl.endsWith("/senza-scrittura")
        ? [
            {
              name: "Accesso REST API (PR)",
              ok: false,
              detail: "solo lettura",
              purpose: "rest",
              failure: "no_write_permission",
            },
          ]
        : [{ name: "Accesso REST API (PR)", ok: true, detail: "ok", purpose: "rest" }],
    );

    const res = await put(reviewer);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warnings: { repositoryId: string; repositoryName: string; code: string }[] };
    expect(body.warnings).toEqual(
      expect.arrayContaining([
        { repositoryId: noWrite, repositoryName: "senza-scrittura", code: "review_account_no_write_permission" },
        { repositoryId: ownMain, repositoryName: "e-il-principale", code: "default_is_main" },
      ]),
    );
    expect(body.warnings).toHaveLength(2);
    expect(body.warnings.some((w) => w.repositoryId === writable)).toBe(false);
    // Verificate solo le due dove il predefinito è EFFETTIVO.
    expect(validate.mock.calls.map(([p]) => p.repoUrl).sort()).toEqual([
      "https://bitbucket.org/acme/scrivibile",
      "https://bitbucket.org/acme/senza-scrittura",
    ]);
    expect(await flagOf(reviewer)).toBe(true);
  });

  it("Bitbucket senza workspace: 422 e nessuna chiamata; account inesistente: 404", async () => {
    const id = await bitbucketAccount("senza-ws", undefined);
    const fetchMock = stubAccountProbe(REVIEWER_SCOPES);
    const res = await put(id);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("default_reviewer_workspace_missing");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await flagOf(id)).toBe(false);

    expect((await put("00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
  });

  it("un member: 403 su PUT e DELETE, flag invariato", async () => {
    const ws = newWorkspace();
    const id = await bitbucketAccount("protetto", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    expect((await put(id, memberCookie)).statusCode).toBe(403);
    expect(await flagOf(id)).toBe(false);

    expect((await put(id)).statusCode).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/git-accounts/${id}/default-reviewer`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(403);
    expect(await flagOf(id)).toBe(true);
  });

  it("DELETE toglie il flag ed è idempotente (204 anche ripetuto); 404 se l'account non esiste", async () => {
    const ws = newWorkspace();
    const id = await bitbucketAccount("da-togliere", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    expect((await put(id)).statusCode).toBe(200);
    const del = () =>
      app.inject({ method: "DELETE", url: `/api/git-accounts/${id}/default-reviewer`, headers: { cookie: adminCookie } });
    expect((await del()).statusCode).toBe(204);
    expect(await flagOf(id)).toBe(false);
    expect((await del()).statusCode).toBe(204);
    const missing = await app.inject({
      method: "DELETE",
      url: "/api/git-accounts/00000000-0000-0000-0000-000000000000/default-reviewer",
      headers: { cookie: adminCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("PATCH del workspace di un predefinito: 409 e workspace invariato; nome e stesso workspace passano", async () => {
    const ws = newWorkspace();
    const id = await bitbucketAccount("bloccato", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    expect((await put(id)).statusCode).toBe(200);

    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/git-accounts/${id}`, headers: { cookie: adminCookie }, payload });
    const res = await patch({ workspace: newWorkspace(), name: "rinominato-insieme" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("default_reviewer_workspace_locked");
    const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(row!.workspace).toBe(ws);
    expect(row!.name).toBe("bloccato");

    expect((await patch({ workspace: ws, name: "rinominato" })).statusCode).toBe(200);
    // Tolto il predefinito, il workspace torna modificabile.
    await app.inject({ method: "DELETE", url: `/api/git-accounts/${id}/default-reviewer`, headers: { cookie: adminCookie } });
    const moved = newWorkspace();
    expect((await patch({ workspace: moved })).statusCode).toBe(200);
    const [after] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
    expect(after!.workspace).toBe(moved);
  });

  it("GitHub: il workspace di un predefinito si cambia (D7 vale solo dove il workspace entra nell'ambito)", async () => {
    const created = await createAccount({ ...basePayload, name: "Predefinito GitHub", workspace: "acme" });
    const id = (created.json() as { id: string }).id;
    await testDb.db.update(gitAccounts).set({ isDefaultReviewer: true }).where(eq(gitAccounts.id, id));
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/git-accounts/${id}`,
        headers: { cookie: adminCookie },
        payload: { workspace: "altra-org" },
      });
      expect(res.statusCode).toBe(200);
      const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
      expect(row!.workspace).toBe("altra-org");
      expect(row!.isDefaultReviewer).toBe(true);
    } finally {
      // L'indice ammette un solo predefinito per ambito: non lasciarlo ai test dopo.
      await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false }).where(eq(gitAccounts.id, id));
    }
  });

  it("corsa inversa: un PATCH sposta l'account durante le verifiche → 409, nessun flag, il predecessore resta", async () => {
    const ws = newWorkspace();
    const previous = await bitbucketAccount("resta-predefinito", ws);
    const candidate = await bitbucketAccount("spostato-durante", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();
    expect((await put(previous)).statusCode).toBe(200);

    // Il doppio della verifica d'identità — rete, secondi veri — è il momento
    // in cui un altro admin cambia il workspace: oggi permesso, perché
    // l'account non è ancora predefinito.
    const moved = newWorkspace();
    stubIdentities().mockImplementation(async (p) => {
      if (p.credentials.token === "tok-spostato-durante") {
        const patched = await app.inject({
          method: "PATCH",
          url: `/api/git-accounts/${candidate}`,
          headers: { cookie: adminCookie },
          payload: { workspace: moved },
        });
        expect(patched.statusCode).toBe(200);
      }
      return `uid-${p.credentials.token}`;
    });

    const res = await put(candidate);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("default_reviewer_account_changed");
    expect(await flagOf(candidate)).toBe(false);
    expect(await flagOf(previous)).toBe(true);
    const [row] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, candidate));
    expect(row!.workspace).toBe(moved);
  });

  it("una corsa fra due admin sullo stesso ambito: l'indice la ferma, 409 default_reviewer_conflict", async () => {
    const ws = newWorkspace();
    const winner = await bitbucketAccount("vince", ws);
    const loser = await bitbucketAccount("perde", ws);
    stubAccountProbe(REVIEWER_SCOPES);
    stubIdentities();

    // L'altro admin ha marcato `winner` in una transazione non ancora chiusa:
    // il PUT di `loser` non lo vede da togliere, e il suo insert nell'indice
    // aspetta quella transazione — poi viola l'unicità.
    let pending: ReturnType<typeof put> | undefined;
    await testDb.db.transaction(async (tx) => {
      await tx.update(gitAccounts).set({ isDefaultReviewer: true }).where(eq(gitAccounts.id, winner));
      pending = put(loser);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await testDb.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`,
        );
        if ((waiting[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("il PUT non è mai arrivato ad aspettare l'indice");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    const res = await pending!;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("default_reviewer_conflict");
    expect(await flagOf(winner)).toBe(true);
    expect(await flagOf(loser)).toBe(false);
  });
});

/**
 * Validate chiede gli scope del RUOLO dell'account, calcolato dal server (1 ott
 * 2026, piano P2-2, D9): il predefinito conta come revisore. Header
 * `x-oauth-scopes` simulato sulla chiamata che Validate fa già.
 */
describe("POST /api/git-accounts/:id/validate — scope secondo il ruolo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  type ValidateBody = { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };

  async function validate(id: string): Promise<ValidateBody> {
    const res = await app.inject({ method: "POST", url: `/api/git-accounts/${id}/validate`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as ValidateBody;
  }

  async function markDefault(id: string): Promise<void> {
    await testDb.db.update(gitAccounts).set({ isDefaultReviewer: true }).where(eq(gitAccounts.id, id));
  }

  /** Il verdetto dell'insieme del PRINCIPALE su un token da revisore: ko sui webhook. */
  function expectPrimarySet(body: ValidateBody) {
    expect(body.ok).toBe(false);
    const webhook = body.checks.find((c) => c.name === "Scope webhook");
    expect(webhook?.ok).toBe(false);
    expect(webhook?.detail).toMatch(/read:webhook:bitbucket/);
    expect(webhook?.detail).toMatch(/write:webhook:bitbucket/);
  }

  /** Il verdetto dell'insieme del REVISORE: nessun check sui webhook. */
  function expectReviewerSet(body: ValidateBody) {
    expect(body.ok).toBe(true);
    expect(body.checks.some((c) => c.name === "Scope webhook")).toBe(false);
    expect(body.checks.map((c) => c.name)).toContain("Scope repository e pull request");
  }

  it("revisore esplicito, token senza webhook: ok, nessun check sui webhook", async () => {
    const ws = newWorkspace();
    const reviewer = await bitbucketAccount("v-esplicito", ws);
    const main = await bitbucketAccount("v-principale-1", ws);
    await repository("v-repo-esplicito", main, reviewer);
    stubAccountProbe(REVIEWER_SCOPES);
    expectReviewerSet(await validate(reviewer));
  });

  it("lo stesso token su un account principale: ko, il check webhook nomina i due scope", async () => {
    const ws = newWorkspace();
    const main = await bitbucketAccount("v-principale-2", ws);
    await repository("v-repo-principale", main);
    stubAccountProbe(REVIEWER_SCOPES);
    expectPrimarySet(await validate(main));
  });

  it("predefinito EFFETTIVO su una repository senza esplicito: insieme del revisore", async () => {
    const ws = newWorkspace();
    const reviewer = await bitbucketAccount("v-predefinito", ws);
    const main = await bitbucketAccount("v-principale-3", ws);
    await repository("v-repo-predefinito", main);
    await markDefault(reviewer);
    try {
      stubAccountProbe(REVIEWER_SCOPES);
      expectReviewerSet(await validate(reviewer));
    } finally {
      await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false }).where(eq(gitAccounts.id, reviewer));
    }
  });

  it("predefinito senza repository nel suo ambito: conta il flag (D9), insieme del revisore", async () => {
    const reviewer = await bitbucketAccount("v-predefinito-solo", newWorkspace());
    await markDefault(reviewer);
    try {
      stubAccountProbe(REVIEWER_SCOPES);
      expectReviewerSet(await validate(reviewer));
    } finally {
      await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false }).where(eq(gitAccounts.id, reviewer));
    }
  });

  it("predefinito saltato ovunque perché è il principale: insieme del principale", async () => {
    const ws = newWorkspace();
    const account = await bitbucketAccount("v-saltato", ws);
    await repository("v-repo-saltato", account);
    await markDefault(account);
    try {
      stubAccountProbe(REVIEWER_SCOPES);
      expectPrimarySet(await validate(account));
    } finally {
      await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false }).where(eq(gitAccounts.id, account));
    }
  });

  it("account mai usato: insieme del principale", async () => {
    const account = await bitbucketAccount("v-mai-usato", newWorkspace());
    stubAccountProbe(REVIEWER_SCOPES);
    expectPrimarySet(await validate(account));
  });

  it("token senza read:user: check identità ko, coi Request changes scartati", async () => {
    const ws = newWorkspace();
    const reviewer = await bitbucketAccount("v-senza-user", ws);
    const main = await bitbucketAccount("v-principale-4", ws);
    await repository("v-repo-senza-user", main, reviewer);
    stubAccountProbe(
      "read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket",
    );
    const body = await validate(reviewer);
    expect(body.ok).toBe(false);
    const identity = body.checks.find((c) => c.name === "Scope identità (read:user)");
    expect(identity?.ok).toBe(false);
    expect(identity?.detail).toMatch(/i Request changes da Bitbucket vengono scartati/);
    expect(body.checks.some((c) => c.name === "Scope webhook")).toBe(false);
  });

  it("GitHub: output invariato, un solo check", async () => {
    const created = await createAccount({ ...basePayload, name: "v-github" });
    const id = (created.json() as { id: string }).id;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          input.includes("api.github.com/user/repos")
            ? new Response("[]", { status: 200, headers: { "x-oauth-scopes": "" } })
            : new Response("", { status: 404 }),
        ),
      ),
    );
    const body = await validate(id);
    expect(body).toEqual({
      ok: true,
      checks: [{ name: "Autenticazione e accesso repository", ok: true, detail: "token valido, accesso ai repository ok" }],
    });
  });
});
