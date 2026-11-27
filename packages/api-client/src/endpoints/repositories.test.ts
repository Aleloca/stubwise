import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Endpoint `repositories` costruito dal CLIENT: url e metodo. Come i gemelli
 * accanto, non c'è un server dietro — `fetch` è finto: i test del server
 * iniettano il payload e non vedono MAI come il client compone il path.
 */
const REPOSITORY = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  name: "Portale B2B",
  slug: "portale-b2b",
  provider: "github",
  repoUrl: "https://github.com/acme/portale-b2b",
  defaultBranch: "main",
  gitAccountId: "33333333-3333-4333-8333-333333333333",
  gitAccountName: "acme-bot",
  testCommand: "pnpm test",
  installCommand: "pnpm install",
  webhookConfiguredAt: "2026-09-01T10:00:00.000Z",
  graphEnabled: true,
  createdAt: "2026-08-01T10:00:00.000Z",
};

function clientConRepository() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(REPOSITORY), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

describe("endpoints repositories", () => {
  it("get: indirizza per SLUG, non per id", async () => {
    const { client, fetchImpl } = clientConRepository();
    await client.repositories.get("portale-b2b");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories/portale-b2b");
    expect(fetchImpl.mock.calls.at(-1)![1]?.method).toBe("GET");
  });

  // Registro, A5 r.209: «Abilita» il grafo dal desktop, solo quel campo.
  it("setGraphEnabled: PATCH per slug col solo `graphEnabled`", async () => {
    const { client, fetchImpl } = clientConRepository();
    const r = await client.repositories.setGraphEnabled("portale-b2b", true);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(String(url)).toBe("/api/repositories/portale-b2b");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ graphEnabled: true });
    expect(r.graphEnabled).toBe(true);
  });

  it("uno slug con caratteri da codificare non esce dal path", async () => {
    const { client, fetchImpl } = clientConRepository();
    await client.repositories.get("a/b?c");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories/a%2Fb%3Fc");
  });

  it("legge i campi che il dettaglio mostra, compresi i comandi della pipeline", async () => {
    const { client } = clientConRepository();
    const repository = await client.repositories.get("portale-b2b");
    expect(repository.defaultBranch).toBe("main");
    expect(repository.installCommand).toBe("pnpm install");
    expect(repository.testCommand).toBe("pnpm test");
    expect(repository.graphEnabled).toBe(true);
  });

  /**
   * ⚠️ Il segreto HMAC del webhook non fa parte della proiezione pubblica
   * (permetterebbe di forgiare webhook di merge e forzare i ticket a `done`),
   * e `repositorySchema` è un `z.object`, che STRIPPA i campi in più: anche
   * se un server lo mandasse per errore, non arriverebbe a nessuna UI.
   */
  it("un campo che il server non deve mandare non arriva comunque al client", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ ...REPOSITORY, webhookSecret: "non-deve-passare" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const repository = await client.repositories.get("portale-b2b");
    expect(repository).not.toHaveProperty("webhookSecret");
  });
});

describe("area 8, F1: le impostazioni di rilascio", () => {
  it("PATCH per slug coi soli campi di rilascio; una risposta senza i campi nuovi (server di prima) si legge coi default", async () => {
    const { client, fetchImpl } = clientConRepository();
    const read = await client.repositories.updateReleaseSettings("portale-b2b", { releaseBranch: "production", colleaguePrs: "analyze_and_fix" });
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(String(url)).toBe("/api/repositories/portale-b2b");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ releaseBranch: "production", colleaguePrs: "analyze_and_fix" });
    expect(read).toMatchObject({ slug: "portale-b2b", releaseBranch: null, colleaguePrs: "analyze_only" });
  });
});

describe("area 8, F1: l'elenco dei repository di un progetto", () => {
  it("GET /api/repositories?projectId=…; una risposta di un server di prima si legge coi default dei rilasci", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify([REPOSITORY]), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const [read] = await client.repositories.list("p-1");
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories?projectId=p-1");
    expect(read).toMatchObject({ slug: "portale-b2b", releasePipeline: { mode: "auto" }, colleaguePrs: "analyze_only" });
    await client.repositories.list();
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories");
  });
});

describe("area 9, F6: i repository senza progetto", () => {
  function clientWith(body: unknown, status = 200) {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
    return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
  }

  it("detached parsa le righe coi default; link e deleteDetached: verbi, path e corpo", async () => {
    const row = { id: "50000000-0000-4000-8000-000000000001", name: "sito", provider: "github" };
    const list = clientWith([row]);
    expect(await list.client.repositories.detached()).toEqual([
      { ...row, fullName: null, repoUrl: null, gitAccountName: null, gitAccountProvider: null, detachedAt: null, formerProject: null, canDelete: false, linkTargets: [] },
    ]);
    expect(String(list.fetchImpl.mock.calls.at(-1)![0])).toBe("/api/repositories/detached");
    const { client, fetchImpl } = clientWith(null, 204);
    await client.repositories.link("r/1", "p1");
    let [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect([String(url), init?.method, JSON.parse(String(init?.body))]).toEqual(["/api/repositories/r%2F1/link", "POST", { projectId: "p1" }]);
    await client.repositories.deleteDetached("r");
    [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect([String(url), init?.method]).toEqual(["/api/repositories/r", "DELETE"]);
  });
});

describe("endpoints repositories: la pagina Repositories della nuova app", () => {
  const respond = (body: unknown, status = 200) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
    return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
  };
  const last = (f: ReturnType<typeof respond>["fetchImpl"]) => ({
    url: String(f.mock.calls.at(-1)![0]),
    method: f.mock.calls.at(-1)![1]?.method,
    body: f.mock.calls.at(-1)![1]?.body ? JSON.parse(String(f.mock.calls.at(-1)![1]!.body)) : undefined,
  });

  it("create: il segreto del webhook della risposta non arriva al chiamante", async () => {
    const { client, fetchImpl } = respond({ ...REPOSITORY, webhookSecret: "segreto-di-32", warnings: [] }, 201);
    const created = await client.repositories.create({ projectId: REPOSITORY.projectId, name: "x", gitAccountId: REPOSITORY.gitAccountId, repoUrl: REPOSITORY.repoUrl, defaultBranch: "main" });
    expect(last(fetchImpl)).toMatchObject({ url: "/api/repositories", method: "POST" });
    expect(JSON.stringify(created)).not.toContain("segreto-di-32");
  });

  it("update, configureWebhook, i file d'ambiente: metodo, indirizzo e corpo", async () => {
    let r = respond(REPOSITORY);
    await r.client.repositories.update("portale-b2b", { name: "n", protectedBranches: ["main"] });
    expect(last(r.fetchImpl)).toEqual({ url: "/api/repositories/portale-b2b", method: "PATCH", body: { name: "n", protectedBranches: ["main"] } });
    r = respond({ ok: true, created: true, updated: false, detail: "d", url: "u" });
    await r.client.repositories.configureWebhook("portale-b2b");
    expect(last(r.fetchImpl)).toMatchObject({ url: "/api/repositories/portale-b2b/configure-webhook", method: "POST" });
    const id = REPOSITORY.id;
    const file = "44444444-4444-4444-8444-444444444444";
    r = respond([]);
    await r.client.repositories.envFiles(id);
    expect(last(r.fetchImpl)).toMatchObject({ url: `/api/repositories/${id}/env-files`, method: "GET" });
    r = respond({ key: "API_KEY", valueSet: true });
    await r.client.repositories.setEnvVar(id, file, "API_KEY", "v");
    expect(last(r.fetchImpl)).toEqual({ url: `/api/repositories/${id}/env-files/${file}/vars/API_KEY`, method: "PUT", body: { value: "v" } });
    r = respond(null, 204);
    await r.client.repositories.removeEnvVar(id, file, "API_KEY");
    expect(last(r.fetchImpl)).toMatchObject({ url: `/api/repositories/${id}/env-files/${file}/vars/API_KEY`, method: "DELETE" });
  });

  it("l'import di un server di prima (senza replaced né skipped) si legge con elenchi vuoti", async () => {
    const { client } = respond({ count: 1, imported: ["A"] });
    expect(await client.repositories.importEnvFile(REPOSITORY.id, "44444444-4444-4444-8444-444444444444", "A=1")).toEqual({ count: 1, imported: ["A"], replaced: [], skipped: [] });
  });

  it("gli account git: i repository della piattaforma, i rami, la verifica", async () => {
    const acc = REPOSITORY.gitAccountId;
    let r = respond([]);
    await r.client.gitAccounts.repositories(acc);
    expect(last(r.fetchImpl)).toMatchObject({ url: `/api/git-accounts/${acc}/repositories`, method: "GET" });
    r = respond({ branches: ["main"], defaultBranch: "main" });
    await r.client.gitAccounts.branches(acc, "acme/web app");
    expect(last(r.fetchImpl).url).toBe(`/api/git-accounts/${acc}/branches?repo=acme%2Fweb%20app`);
    r = respond({ ok: true, checks: [] });
    await r.client.gitAccounts.validateRepo(acc, "acme/web");
    expect(last(r.fetchImpl).url).toBe(`/api/git-accounts/${acc}/validate-repo?repo=acme%2Fweb`);
  });
});
