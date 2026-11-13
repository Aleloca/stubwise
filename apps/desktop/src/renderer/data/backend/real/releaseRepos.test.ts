import { describe, expect, it } from "vitest";
import { createRealRepoSettings, type RepoSettingsApi } from "./releaseRepos";

// Area 8, F1 (`releases-repo-settings`): il ramo di rilascio, la pipeline e
// le PR dei colleghi di un repository, sulle rotte vere (S6 di 72), con le
// firme del prototipo. Chi li cambia (`repos.manage`) lo dicono i permessi
// che il server calcola per chi guarda.

const repo = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  projectId: "p1",
  name: "audin-app",
  slug: "audin-app",
  provider: "github",
  repoUrl: "https://github.com/audin/audin-app",
  defaultBranch: "main",
  releaseBranch: null,
  releasePipeline: { mode: "named" },
  ciProvider: "github_actions",
  colleaguePrs: "analyze_only",
  ...over,
});

function fakeApi(over: Partial<RepoSettingsApi> = {}, manage = true) {
  const calls: string[] = [];
  const api: RepoSettingsApi = {
    list: async (projectId) => (calls.push(`GET repositories?projectId=${projectId}`), [repo()]),
    update: async (slug, patch) => (calls.push(`PATCH ${slug} ${JSON.stringify(patch)}`), repo()),
    canManage: async () => manage,
    ...over,
  };
  return { api, calls };
}

describe("le impostazioni di rilascio dei repository (area 8, F1)", () => {
  it("nella forma del prototipo: owner/repo dall'indirizzo, il ramo di default se non scelto, i nomi della pipeline mancanti = []", async () => {
    const s = await createRealRepoSettings(fakeApi().api).getRepositorySettings("p1");
    expect(s).toEqual({
      canManage: true,
      repositories: [
        {
          id: "r1",
          name: "audin-app",
          fullName: "audin/audin-app",
          colleaguePrs: "analyze_only",
          releaseBranch: "main",
          releasePipeline: { mode: "named", names: [] },
          ciProvider: "github_actions",
        },
      ],
    });
  });

  it("canManage è quello che il server dice per chi guarda (repos.manage)", async () => {
    const s = await createRealRepoSettings(fakeApi({}, false).api).getRepositorySettings("p1");
    expect(s?.canManage).toBe(false);
  });

  it("le PR dei colleghi e la pipeline col ramo: la PATCH per slug", async () => {
    const { api, calls } = fakeApi();
    const settings = createRealRepoSettings(api);
    await settings.getRepositorySettings("p1");
    await settings.setRepoPrMode("r1", "off");
    await settings.setReleasePipeline("r1", { mode: "named", names: ["deploy"] }, "release");
    expect(calls).toContain('PATCH audin-app {"colleaguePrs":"off"}');
    expect(calls).toContain(
      'PATCH audin-app {"releasePipeline":{"mode":"named","names":["deploy"]},"releaseBranch":"release"}',
    );
  });

  it("un ramo vuoto non si manda (invalid: branch, come il prototipo)", async () => {
    const { api, calls } = fakeApi();
    const settings = createRealRepoSettings(api);
    await settings.getRepositorySettings("p1");
    await expect(settings.setReleasePipeline("r1", { mode: "auto" }, "  ")).rejects.toThrow(
      "invalid: branch",
    );
    expect(calls.some((c) => c.startsWith("PATCH"))).toBe(false);
  });

  it("il ramo si manda solo se cambia; tornare al default è null (review F1, m3)", async () => {
    const { api, calls } = fakeApi();
    const settings = createRealRepoSettings(api);
    await settings.getRepositorySettings("p1");
    // Il ramo mostrato è il default (`main`, null sul server): salvare solo la pipeline non lo fissa.
    await settings.setReleasePipeline("r1", { mode: "auto" }, "main");
    expect(calls.at(-1)).toBe('PATCH audin-app {"releasePipeline":{"mode":"auto"}}');
    await settings.setReleasePipeline("r1", { mode: "auto" }, "release");
    expect(calls.at(-1)).toBe(
      'PATCH audin-app {"releasePipeline":{"mode":"auto"},"releaseBranch":"release"}',
    );
  });

  it("da un ramo scelto, tornare al default manda null", async () => {
    const { api, calls } = fakeApi({ list: async () => [repo({ releaseBranch: "release" })] });
    const settings = createRealRepoSettings(api);
    await settings.getRepositorySettings("p1");
    await settings.setReleasePipeline("r1", { mode: "auto" }, "main");
    expect(calls.at(-1)).toBe(
      'PATCH audin-app {"releasePipeline":{"mode":"auto"},"releaseBranch":null}',
    );
  });
});
