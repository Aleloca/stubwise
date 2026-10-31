import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docs, instance, projectSettings, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { grantProjectPermission, revokeProjectPermission, viewerFor } from "../viewer";

// I repository del progetto, livello dati (area 9c, Task 4): l'elenco, la
// creazione guidata con la verifica degli accessi, la modifica e il
// webhook git. Persone: Laura (Project Lead in ACQ, `repos.manage`), Sara
// (Contributor in ACQ: `repos.view`, non `repos.manage`), Roberta (full
// admin). ACQ ha `portale-utenti` su «Bitbucket Audin», col webhook da
// configurare.

const LAURA = "p-laura";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const RNC = "prj-rnc";
const BITBUCKET = "git-bitbucket-audin";
const GITHUB = "git-github-stubwise";

const as = (personId: string) => setSessionPersonId(personId);
let seeded = 0;
const entries = (kind?: string) =>
  state.changelog.slice(seeded).filter((e) => !kind || e.kind === kind);
const repo = (id: string) => state.repositories.find((r) => r.id === id)!;
const snapshot = () =>
  JSON.stringify({
    repositories: state.repositories,
    docSpaces: state.docSpaces,
    checks: state.repositoryChecks,
  });

const NEW = {
  gitAccountId: BITBUCKET,
  fullName: "audin/fatture-api",
  name: "fatture-api",
  branch: "main",
  installCommand: null,
  testCommand: "npm test",
};
const verify = (over: Partial<typeof NEW> = {}) =>
  projectSettings.checkRepositoryAccess({
    projectId: ACQ,
    gitAccountId: over.gitAccountId ?? NEW.gitAccountId,
    fullName: over.fullName ?? NEW.fullName,
    branch: over.branch ?? NEW.branch,
  });

beforeEach(() => {
  setLatency(0);
  resetApi();
  seeded = state.changelog.length;
});
afterEach(() => resetApi());

describe("l'elenco dei repository del progetto", () => {
  it("Laura legge ACQ: portale-utenti con account, piattaforma, ramo e webhook da configurare", async () => {
    as(LAURA);
    const list = (await projectSettings.listProjectRepositories(ACQ))!;
    expect(list.canManage).toBe(true);
    expect(list.repositories).toEqual([
      {
        id: "repo-acq",
        name: "portale-utenti",
        fullName: "audin/portale-utenti",
        url: "https://bitbucket.org/audin/portale-utenti",
        provider: "bitbucket",
        defaultBranch: "main",
        gitAccount: { id: BITBUCKET, name: "Bitbucket Audin" },
        reviewAccount: null,
        installCommand: null,
        testCommand: null,
        graphEnabled: false,
        protectedBranches: ["main"],
        webhook: { state: "not_configured", configuredAt: null },
      },
    ]);
    // Nessun id del caveau e nessuna cifra del secret nella vista.
    expect(JSON.stringify(list)).not.toMatch(/secretId|last4/);
  });

  it("Sara (Contributor, senza repos.view) non li legge; con repos.view li legge senza gestire", async () => {
    as(SARA);
    expect(await projectSettings.listProjectRepositories(ACQ)).toBeNull();
    grantProjectPermission(SARA, ACQ, "repos.view" as never);
    expect((await projectSettings.listProjectRepositories(ACQ))!.canManage).toBe(false);
    expect(await projectSettings.listProjectRepositories(AUD)).toBeNull();
    revokeProjectPermission(SARA, ACQ, "repos.view" as never);
    expect(await projectSettings.listProjectRepositories(ACQ)).toBeNull();
    as(ROBERTA);
    expect(await projectSettings.listProjectRepositories(RNC)).toBeNull();
  });

  it("i repository della piattaforma, per account, coi rami e il predefinito", async () => {
    as(LAURA);
    const remote = await projectSettings.listRemoteRepositories(BITBUCKET);
    expect(remote.map((r) => r.fullName)).toEqual(
      expect.arrayContaining(["audin/portale-utenti", "audin/fatture-api"]),
    );
    const fatture = remote.find((r) => r.fullName === "audin/fatture-api")!;
    expect(fatture.defaultBranch).toBe("main");
    expect(fatture.branches).toContain("main");
    expect(fatture.branches).toContain("develop");
    expect(await projectSettings.listRemoteRepositories("git-nope")).toEqual([]);
    as(SARA);
    await expect(projectSettings.listRemoteRepositories(BITBUCKET)).rejects.toThrow("forbidden");
  });
});

describe("la creazione guidata", () => {
  it("senza verifica → access_not_verified, e niente cambia", async () => {
    as(LAURA);
    const before = snapshot();
    expect(await projectSettings.createRepository(ACQ, NEW)).toEqual({
      ok: false,
      error: "invalid",
      reason: "access_not_verified",
    });
    expect(snapshot()).toBe(before);
    expect(entries()).toHaveLength(0);
  });

  it("con la verifica invalid_credentials simulata la creazione resta rifiutata", async () => {
    as(LAURA);
    await projectSettings.simulateNextRepositoryCheck("invalid_credentials");
    expect(await verify()).toEqual({ ok: true, outcome: "invalid_credentials" });
    expect(await projectSettings.createRepository(ACQ, NEW)).toMatchObject({
      error: "invalid",
      reason: "access_not_verified",
    });
    // La simulazione vale una volta: la verifica dopo è vera.
    expect(await verify()).toEqual({ ok: true, outcome: "ok" });
  });

  it("una verifica di un'altra terna, o di un'altra persona, non vale", async () => {
    as(LAURA);
    expect(await verify({ branch: "develop" })).toMatchObject({ outcome: "ok" });
    expect(await projectSettings.createRepository(ACQ, NEW)).toMatchObject({
      reason: "access_not_verified",
    });
    as(ROBERTA);
    expect(await verify()).toMatchObject({ outcome: "ok" });
    as(LAURA);
    expect(await projectSettings.createRepository(ACQ, NEW)).toMatchObject({
      reason: "access_not_verified",
    });
  });

  it("con ok il repository compare nel progetto, in Amministrazione → Repositories e fra gli spazi dei Docs", async () => {
    as(LAURA);
    await verify();
    const created = await projectSettings.createRepository(ACQ, NEW);
    expect(created).toMatchObject({ ok: true });
    const id = (created as { repositoryId: string }).repositoryId;

    const list = (await projectSettings.listProjectRepositories(ACQ))!;
    expect(list.repositories.find((r) => r.id === id)).toEqual({
      id,
      name: "fatture-api",
      fullName: "audin/fatture-api",
      url: "https://bitbucket.org/audin/fatture-api",
      provider: "bitbucket",
      defaultBranch: "main",
      gitAccount: { id: BITBUCKET, name: "Bitbucket Audin" },
      reviewAccount: null,
      installCommand: null,
      testCommand: "npm test",
      graphEnabled: false,
      protectedBranches: [],
      webhook: { state: "not_configured", configuredAt: null },
    });
    const groups = await instance.listAllRepositories();
    expect(groups.find((g) => g.projectId === ACQ)!.repositories.map((r) => r.name)).toContain(
      "fatture-api",
    );
    expect((await docs.listDocSpaces(ACQ)).map((s) => s.name)).toContain("fatture-api");
    expect((await docs.getDocSpace(id))!.generation.status).toBe("never");

    const voices = entries("repository.created");
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({
      projectId: ACQ,
      object: { type: "repository", id, label: "fatture-api" },
    });
    // La verifica è stata usata: una seconda creazione non la riusa.
    expect(
      await projectSettings.createRepository(ACQ, { ...NEW, name: "fatture-api-2" }),
    ).toMatchObject({ reason: "access_not_verified" });
  });

  it("il ramo scelto è quello delle PR; il predefinito viene dalla piattaforma", async () => {
    as(LAURA);
    await verify({ branch: "develop" });
    const created = await projectSettings.createRepository(ACQ, { ...NEW, branch: "develop" });
    const id = (created as { repositoryId: string }).repositoryId;
    expect(repo(id).defaultBranch).toBe("main");
    expect(repo(id).releaseBranch).toBe("develop");
  });

  it("nome già usato nel progetto → name_taken; senza repos.manage → forbidden; archiviato → not_found", async () => {
    as(LAURA);
    await verify();
    expect(await projectSettings.createRepository(ACQ, { ...NEW, name: "portale-utenti" })).toEqual(
      { ok: false, error: "invalid", reason: "name_taken" },
    );
    expect(await projectSettings.createRepository(ACQ, { ...NEW, name: "  " })).toMatchObject({
      reason: "name",
    });
    expect(
      await projectSettings.createRepository(ACQ, { ...NEW, fullName: "audin/nope" }),
    ).toMatchObject({ reason: "repository" });
    expect(await projectSettings.createRepository(ACQ, { ...NEW, branch: "nope" })).toMatchObject({
      reason: "branch",
    });
    as(SARA);
    expect(await projectSettings.createRepository(ACQ, NEW)).toEqual({
      ok: false,
      error: "forbidden",
    });
    as(ROBERTA);
    expect(
      await projectSettings.checkRepositoryAccess({
        projectId: RNC,
        gitAccountId: BITBUCKET,
        fullName: NEW.fullName,
        branch: "main",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(entries()).toHaveLength(0);
  });
});

describe("la modifica di un repository", () => {
  it("una voce per campo cambiato, con la chiave del campo", async () => {
    as(LAURA);
    expect(
      await projectSettings.updateRepository("repo-acq", {
        testCommand: "pnpm test",
        graphEnabled: true,
        protectedBranches: ["main", "release/*"],
      }),
    ).toEqual({ ok: true });
    expect(repo("repo-acq")).toMatchObject({
      testCommand: "pnpm test",
      graphEnabled: true,
      protectedBranches: ["main", "release/*"],
    });
    const voices = entries("repository.updated");
    expect(voices.map((v) => v.params.field)).toEqual([
      "testCommand",
      "graphEnabled",
      "protectedBranches",
    ]);
    expect(JSON.parse(voices[0]!.after!)).toEqual({ testCommand: "pnpm test" });
  });

  it("rinominare sposta anche lo spazio dei Docs; nome già usato → name_taken", async () => {
    as(ROBERTA);
    expect(await projectSettings.updateRepository("repo-aud-admin", { name: "audin-app" })).toEqual(
      { ok: false, error: "invalid", reason: "name_taken" },
    );
    expect(await projectSettings.updateRepository("repo-stw", { name: "stubwise-core" })).toEqual({
      ok: true,
    });
    expect(state.docSpaces.find((s) => s.repositoryId === "repo-stw")!.name).toBe("stubwise-core");
  });

  it("account di review uguale al principale o d'un'altra piattaforma → review_account", async () => {
    as(LAURA);
    const before = snapshot();
    expect(
      await projectSettings.updateRepository("repo-acq", { reviewGitAccountId: BITBUCKET }),
    ).toEqual({ ok: false, error: "invalid", reason: "review_account" });
    expect(
      await projectSettings.updateRepository("repo-acq", { reviewGitAccountId: GITHUB }),
    ).toEqual({ ok: false, error: "invalid", reason: "review_account" });
    expect(snapshot()).toBe(before);
    // Un account bitbucket diverso dal principale va bene; la voce dice il nome.
    as(ROBERTA);
    state.instance.gitAccounts.push({
      ...state.instance.gitAccounts.find((g) => g.id === BITBUCKET)!,
      id: "git-bitbucket-review",
      name: "Bitbucket Review",
    });
    as(LAURA);
    expect(
      await projectSettings.updateRepository("repo-acq", {
        reviewGitAccountId: "git-bitbucket-review",
      }),
    ).toEqual({ ok: true });
    const voice = entries("repository.updated").at(-1)!;
    expect(voice.params.field).toBe("reviewGitAccount");
    expect(JSON.parse(voice.before!)).toEqual({ reviewGitAccount: null });
    expect(JSON.parse(voice.after!)).toEqual({ reviewGitAccount: "Bitbucket Review" });
    expect(
      (await projectSettings.listProjectRepositories(ACQ))!.repositories[0]!.reviewAccount,
    ).toEqual({ id: "git-bitbucket-review", name: "Bitbucket Review" });
  });

  it("url non https, ramo protetto vuoto o con spazi, account sconosciuto → invalid", async () => {
    as(LAURA);
    const before = snapshot();
    expect(
      await projectSettings.updateRepository("repo-acq", { url: "http://bitbucket.org/x" }),
    ).toMatchObject({ error: "invalid", reason: "url" });
    expect(
      await projectSettings.updateRepository("repo-acq", { protectedBranches: ["main", ""] }),
    ).toEqual({ ok: false, error: "invalid", reason: "protected_branch", line: 2 });
    // La riga (a base 1) la dice il livello dati: la pagina non rifà la regola (I3).
    expect(
      await projectSettings.updateRepository("repo-acq", {
        protectedBranches: ["rel ease", "main"],
      }),
    ).toEqual({ ok: false, error: "invalid", reason: "protected_branch", line: 1 });
    expect(
      await projectSettings.updateRepository("repo-acq", { gitAccountId: "git-nope" }),
    ).toMatchObject({ error: "invalid", reason: "git_account" });
    expect(snapshot()).toBe(before);
    expect(entries()).toHaveLength(0);
  });

  it("il ramo predefinito non sta nella patch: si legge e basta (P27)", async () => {
    as(LAURA);
    await projectSettings.updateRepository("repo-acq", {
      defaultBranch: "develop",
    } as unknown as Parameters<typeof projectSettings.updateRepository>[1]);
    expect(repo("repo-acq").defaultBranch).toBe("main");
  });

  it("senza repos.manage → forbidden; in un progetto invisibile → not_found", async () => {
    as(SARA);
    expect(await projectSettings.updateRepository("repo-acq", { testCommand: "x" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await projectSettings.updateRepository("repo-aud", { testCommand: "x" })).toEqual({
      ok: false,
      error: "not_found",
    });
    grantProjectPermission(SARA, ACQ, "repos.manage" as never);
    expect(await projectSettings.updateRepository("repo-acq", { testCommand: "x" })).toEqual({
      ok: true,
    });
  });
});

describe("il webhook git", () => {
  it("il primo configura → updated false; il secondo → true; la voce dice lo stato", async () => {
    as(LAURA);
    expect(await projectSettings.configureRepositoryWebhook("repo-acq")).toEqual({
      ok: true,
      state: "configured",
      updated: false,
    });
    expect(repo("repo-acq").webhook!.state).toBe("configured");
    expect(repo("repo-acq").webhook!.configuredAt).not.toBeNull();
    // Configurare imposta anche un secret: ora ne ha le ultime 4.
    expect(repo("repo-acq").webhook!.last4).toMatch(/^[0-9a-f]{4}$/);
    expect(await projectSettings.configureRepositoryWebhook("repo-acq")).toEqual({
      ok: true,
      state: "configured",
      updated: true,
    });
    const voices = entries("repository.webhook_configured");
    expect(voices.map((v) => [v.before, v.after])).toEqual([
      ["not_configured", "configured"],
      ["configured", "configured"],
    ]);
  });

  it("con failed simulato lo stato è failed, una volta sola", async () => {
    as(LAURA);
    await projectSettings.simulateNextWebhookSetup("failed");
    expect(await projectSettings.configureRepositoryWebhook("repo-acq")).toEqual({
      ok: true,
      state: "failed",
      updated: false,
    });
    expect(
      (await projectSettings.listProjectRepositories(ACQ))!.repositories[0]!.webhook.state,
    ).toBe("failed");
    expect(entries("repository.webhook_configured").at(-1)!.after).toBe("failed");
    expect(await projectSettings.configureRepositoryWebhook("repo-acq")).toMatchObject({
      state: "configured",
    });
  });

  it("senza repos.manage → forbidden, niente cambia", async () => {
    as(SARA);
    const before = snapshot();
    expect(await projectSettings.configureRepositoryWebhook("repo-acq")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(snapshot()).toBe(before);
  });
});

describe("un permesso preso in un progetto archiviato non apre niente", () => {
  it("Giulia, con repos.manage solo in RNC (archiviato): né repository remoti né simulazioni", async () => {
    // Giulia è Project Lead in RNC; negli altri suoi progetti le si toglie
    // `repos.manage`, così l'unico posto dove l'ha è l'archiviato.
    for (const p of visibleProjectIds(GIULIA))
      revokeProjectPermission(GIULIA, p, "repos.manage" as never);
    expect(viewerFor(GIULIA).projectPermissions[RNC]).toContain("repos.manage");
    as(GIULIA);
    await expect(projectSettings.listRemoteRepositories(BITBUCKET)).rejects.toThrow("forbidden");
    await expect(projectSettings.simulateNextRepositoryCheck("unreachable")).rejects.toThrow(
      "forbidden",
    );
    await expect(projectSettings.simulateNextWebhookSetup("failed")).rejects.toThrow("forbidden");
    expect(state.repositoryChecks.nextRepositoryCheck).toBeNull();
    expect(state.repositoryChecks.nextWebhookSetup).toBeNull();
  });
});

describe("le simulazioni stanno nello stato (P29)", () => {
  it("le sceglie solo chi gestisce i repository", async () => {
    as(SARA);
    await expect(projectSettings.simulateNextRepositoryCheck("unreachable")).rejects.toThrow(
      "forbidden",
    );
    await expect(projectSettings.simulateNextWebhookSetup("failed")).rejects.toThrow("forbidden");
    expect(state.repositoryChecks.nextRepositoryCheck).toBeNull();
    expect(state.repositoryChecks.nextWebhookSetup).toBeNull();
  });

  it("resetApi le azzera", async () => {
    as(LAURA);
    await projectSettings.simulateNextRepositoryCheck("unreachable");
    await projectSettings.simulateNextWebhookSetup("failed");
    await verify();
    resetApi();
    expect(state.repositoryChecks).toEqual({
      checks: [],
      nextRepositoryCheck: null,
      nextWebhookSetup: null,
    });
  });
});
