import { ApiError } from "@stubwise/api-client";
import { describe, expect, it, vi } from "vitest";
import { createRealProjectRepositories, type ProjectRepositoriesApi } from "./projectRepositories";

// Progetto → Settings → Repositories nella build app (ritiro del web vecchio,
// inventario §1.3): l'adattatore sulle rotte, con un'API finta.

const P = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: P,
  name: "web",
  slug: "web-2",
  provider: "github",
  repoUrl: "https://github.com/acme/web",
  defaultBranch: "main",
  releaseBranch: null,
  gitAccountId: ACCOUNT,
  gitAccountName: "acme-bot",
  reviewGitAccountId: null,
  effectiveReviewAccount: null,
  testCommand: "pnpm test",
  installCommand: null,
  webhookConfiguredAt: null,
  graphEnabled: false,
  protectedBranches: ["main"],
};
const ENV = { test: "e1111111-1111-4111-8111-111111111111", prod: "e2222222-2222-4222-8222-222222222222" };

function apiWith(over: Partial<ProjectRepositoriesApi> = {}): ProjectRepositoriesApi {
  return {
    list: vi.fn(async () => [ROW]),
    me: vi.fn(async () => ({ instancePermissions: [], projectPermissions: { [P]: ["repos.view", "repos.manage"] } })),
    create: vi.fn(async () => ({ ...ROW, id: "new-id", slug: "nuovo" })),
    update: vi.fn(async () => ROW),
    configureWebhook: vi.fn(async () => ({ ok: true, created: true, updated: false, detail: "", url: "" })),
    remoteRepositories: vi.fn(async () => [{ fullName: "acme/web", defaultBranch: "main" }, { fullName: "acme/api", defaultBranch: null }]),
    branches: vi.fn(async () => ({ branches: ["develop", "main"], defaultBranch: "main" })),
    validateRepo: vi.fn(async () => ({ ok: true })),
    gitAccountName: vi.fn(async () => ({ provider: "bitbucket" as const, name: "acme-bot" })),
    environments: vi.fn(async () => [
      { id: ENV.prod, name: "Production", kind: "production" },
      { id: ENV.test, name: "Test", kind: "test" },
    ]),
    envFiles: vi.fn(async () => [{ id: "f1", environmentId: ENV.test, path: ".env", vars: [{ key: "API_KEY", setAt: "2026-11-27T10:00:00.000Z" }] }]),
    createEnvFile: vi.fn(async () => ({ id: "f2" })),
    importEnvFile: vi.fn(async () => ({ imported: ["A", "B"], replaced: ["A"], skipped: [{ line: 3, reason: "key" }] })),
    setEnvVar: vi.fn(async () => undefined),
    removeEnvVar: vi.fn(async () => undefined),
    deleteEnvFile: vi.fn(async () => undefined),
    ...over,
  };
}

describe("Repositories nella build app: elenco e pagina", () => {
  it("chi non ha repos.view: null; canManage e la vista dai permessi del server e dalle righe", async () => {
    const hidden = createRealProjectRepositories(apiWith({ me: vi.fn(async () => ({ instancePermissions: [], projectPermissions: {} })) }));
    expect(await hidden.listProjectRepositories(P)).toBeNull();
    const repos = createRealProjectRepositories(apiWith());
    const list = await repos.listProjectRepositories(P);
    expect(list).toEqual({
      canManage: true,
      // Scegliere un account git è d'istanza (`git_accounts.manage`): Laura qui non può.
      canChooseGitAccount: false,
      repositories: [
        {
          id: ROW.id, name: "web", fullName: "acme/web", url: ROW.repoUrl, provider: "github", defaultBranch: "main", releaseBranch: "main",
          gitAccount: { id: ACCOUNT, name: "acme-bot" }, reviewAccount: null, installCommand: null, testCommand: "pnpm test", graphEnabled: false,
          protectedBranches: ["main"], webhook: { state: "not_configured", configuredAt: null },
        },
      ],
    });
  });

  it("canChooseGitAccount: con git_accounts.manage d'istanza, o da full admin", async () => {
    const with_ = createRealProjectRepositories(apiWith({ me: vi.fn(async () => ({ instancePermissions: ["git_accounts.manage"], projectPermissions: { [P]: ["repos.view"] } })) }));
    expect((await with_.listProjectRepositories(P))!.canChooseGitAccount).toBe(true);
    const admin = createRealProjectRepositories(apiWith({ me: vi.fn(async () => ({ instancePermissions: ["instance.full_admin"], projectPermissions: {} })) }));
    expect(await admin.listProjectRepositories(P)).toMatchObject({ canManage: true, canChooseGitAccount: true });
  });

  it("la modifica va per slug; i controlli della pagina (nome, indirizzo, rami) prima della rete; i rifiuti nella forma della pagina", async () => {
    const api = apiWith();
    const repos = createRealProjectRepositories(api);
    await repos.listProjectRepositories(P);
    expect(await repos.updateRepository(ROW.id, { url: "http://x" })).toEqual({ ok: false, error: "invalid", reason: "url" });
    expect(await repos.updateRepository(ROW.id, { protectedBranches: ["main", "con spazio"] })).toEqual({ ok: false, error: "invalid", reason: "protected_branch", line: 2 });
    expect(api.update).not.toHaveBeenCalled();
    expect(await repos.updateRepository(ROW.id, { name: "web-app", testCommand: "  ", gitAccountId: ACCOUNT })).toEqual({ ok: true });
    expect(api.update).toHaveBeenCalledWith("web-2", { name: "web-app", testCommand: null, gitAccountId: ACCOUNT });
    const forbid = createRealProjectRepositories(apiWith({ update: vi.fn(async () => { throw new ApiError(403, "Missing permission", "forbidden"); }) }));
    await forbid.listProjectRepositories(P);
    expect(await forbid.updateRepository(ROW.id, { gitAccountId: "altro" })).toEqual({ ok: false, error: "forbidden" });
  });

  it("il webhook: configurato; la piattaforma che rifiuta è «failed» e l'elenco lo ricorda fino al tentativo dopo", async () => {
    let fail = true;
    const api = apiWith({
      configureWebhook: vi.fn(async () => {
        if (fail) throw new ApiError(422, "scope", "git_provider_error");
        return { ok: true, created: false, updated: true, detail: "", url: "" };
      }),
    });
    const repos = createRealProjectRepositories(api);
    await repos.listProjectRepositories(P);
    expect(await repos.configureRepositoryWebhook(ROW.id)).toEqual({ ok: true, state: "failed", updated: false });
    expect((await repos.listProjectRepositories(P))!.repositories[0]!.webhook.state).toBe("failed");
    fail = false;
    expect(await repos.configureRepositoryWebhook(ROW.id)).toEqual({ ok: true, state: "configured", updated: true });
    expect((await repos.listProjectRepositories(P))!.repositories[0]!.webhook.state).toBe("not_configured");
  });
});

describe("la creazione guidata", () => {
  it("i repository della piattaforma (già nel progetto: per nome completo) e i rami di quello scelto, il predefinito per primo", async () => {
    const repos = createRealProjectRepositories(apiWith());
    expect(await repos.listRemoteRepositories(ACCOUNT, P)).toEqual([
      { fullName: "acme/web", defaultBranch: "main", branches: ["main"], inProject: true },
      { fullName: "acme/api", defaultBranch: "main", branches: ["main"], inProject: false },
    ]);
    expect(await repos.listRemoteBranches(ACCOUNT, "acme/web")).toEqual({ defaultBranch: "main", branches: ["main", "develop"] });
    const noPerm = createRealProjectRepositories(apiWith({ remoteRepositories: vi.fn(async () => { throw new ApiError(403, "no", "forbidden"); }) }));
    await expect(noPerm.listRemoteRepositories(ACCOUNT, P)).rejects.toThrow("forbidden");
  });

  it("la verifica: un ramo che non c'è, credenziali che non bastano, piattaforma che non risponde", async () => {
    const input = { projectId: P, gitAccountId: ACCOUNT, fullName: "acme/web", branch: "main" };
    expect(await createRealProjectRepositories(apiWith()).checkRepositoryAccess(input)).toEqual({ ok: true, outcome: "ok" });
    expect(await createRealProjectRepositories(apiWith()).checkRepositoryAccess({ ...input, branch: "nope" })).toEqual({ ok: false, error: "invalid", reason: "branch" });
    expect(await createRealProjectRepositories(apiWith({ validateRepo: vi.fn(async () => ({ ok: false })) })).checkRepositoryAccess(input)).toEqual({ ok: true, outcome: "invalid_credentials" });
    expect(await createRealProjectRepositories(apiWith({ validateRepo: vi.fn(async () => { throw new ApiError(422, "giù", "git_provider_error"); }) })).checkRepositoryAccess(input)).toEqual({ ok: true, outcome: "unreachable" });
  });

  it("crea con l'indirizzo della piattaforma dell'account e il ramo predefinito; un ramo scelto diverso è il ramo di rilascio", async () => {
    const api = apiWith();
    const repos = createRealProjectRepositories(api);
    const out = await repos.createRepository(P, { gitAccountId: ACCOUNT, fullName: "acme/web", name: " web ", branch: "develop", installCommand: "", testCommand: "pnpm test" });
    expect(out).toEqual({ ok: true, repositoryId: "new-id" });
    expect(api.create).toHaveBeenCalledWith({ projectId: P, name: "web", gitAccountId: ACCOUNT, repoUrl: "https://bitbucket.org/acme/web", defaultBranch: "main", testCommand: "pnpm test", installCommand: null });
    expect(api.update).toHaveBeenCalledWith("nuovo", { releaseBranch: "develop" });
    expect(await repos.createRepository(P, { gitAccountId: ACCOUNT, fullName: "acme/web", name: "con spazio", branch: "main", installCommand: null, testCommand: null })).toEqual({ ok: false, error: "invalid", reason: "name" });
    const denied = createRealProjectRepositories(apiWith({ create: vi.fn(async () => { throw new ApiError(403, "Missing permission", "forbidden"); }) }));
    expect(await denied.createRepository(P, { gitAccountId: ACCOUNT, fullName: "acme/web", name: "web", branch: "main", installCommand: null, testCommand: null })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("i file d'ambiente", () => {
  it("per ambiente (test, staging, production), coi nomi e la data; mai un valore", async () => {
    const repos = createRealProjectRepositories(apiWith());
    await repos.listProjectRepositories(P);
    const env = await repos.listEnvFiles(ROW.id);
    expect(env.environments.map((e) => [e.kind, e.reachesClaude, e.files.length])).toEqual([["test", true, 1], ["production", false, 0]]);
    expect(env.environments[0]!.files[0]).toEqual({ id: "f1", path: ".env", keys: [{ key: "API_KEY", setAt: "2026-11-27T10:00:00.000Z" }] });
    expect(JSON.stringify(env)).not.toMatch(/value/i);
  });

  it("le scritture vanno sotto il repository del file; l'import dice importate, sostituite e saltate; la riconferma passa com'è", async () => {
    const api = apiWith();
    const repos = createRealProjectRepositories(api);
    await repos.listProjectRepositories(P);
    await repos.listEnvFiles(ROW.id);
    expect(await repos.importEnvFile("f1", "A=1\nB=2\n1X=3")).toEqual({ ok: true, imported: ["B"], replaced: ["A"], skipped: [{ line: 3, reason: "key" }] });
    expect(await repos.setEnvVar("f1", "API_KEY", "segreto")).toEqual({ ok: true });
    expect(api.setEnvVar).toHaveBeenCalledWith(ROW.id, "f1", "API_KEY", "segreto");
    expect(await repos.setEnvVar("f1", "1BAD", "x")).toEqual({ ok: false, error: "invalid", reason: "key" });
    const reauth = createRealProjectRepositories(apiWith({ deleteEnvFile: vi.fn(async () => { throw new ApiError(403, "Recent second factor confirmation required", "reauth_required"); }) }));
    await reauth.listProjectRepositories(P);
    await reauth.listEnvFiles(ROW.id);
    expect(await reauth.deleteEnvFile("f1")).toEqual({ ok: false, error: "reauth_required" });
    // Un file che questa sessione non ha letto: non lo si raggiunge.
    expect(await repos.removeEnvVar("sconosciuto", "A")).toEqual({ ok: false, error: "not_found" });
  });
});
