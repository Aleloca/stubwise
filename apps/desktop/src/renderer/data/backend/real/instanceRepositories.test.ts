import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import {
  createRealInstanceRepositories,
  type InstanceRepositoriesApi,
} from "./instanceRepositories";

// Area 9, F6, Task 6 di 72 (1d3d3a5c5): Amministrazione → Repositories. I
// collegati si compongono da `repositories.list()` (le righe con `config`,
// cioè i progetti dove chi guarda ha `repos.view`) e da `projects.list()`;
// gli staccati, il collegamento e l'eliminazione hanno le loro rotte.

const P_ACQ = "11111111-1111-4111-8111-111111111111";
const P_WEB = "22222222-2222-4222-8222-222222222222";
const P_DOCS = "33333333-3333-4333-8333-333333333333";

const repo = (over: Record<string, unknown>) => ({
  id: "r1",
  projectId: P_ACQ,
  name: "api",
  slug: "api",
  repoUrl: "https://github.com/acme/api.git",
  config: true,
  gitAccountName: "acme-bot",
  ...over,
});

const DETACHED = {
  id: "d1",
  name: "vetrina",
  fullName: "ronchi/vetrina",
  repoUrl: "https://github.com/ronchi/vetrina",
  provider: "github",
  gitAccountName: "acme-bot",
  gitAccountProvider: "github",
  detachedAt: "2026-11-18T10:00:00.000Z",
  formerProject: { code: "RNC", name: "Vetrina online" },
  canDelete: true,
  linkTargets: [{ projectId: P_ACQ, code: "ACQ", name: "Acquedotto" }],
};

const apiError = (status: number, code: string) =>
  new ApiError(status, code, code, { details: { code, message: code } });

function fake(over: Partial<InstanceRepositoriesApi> = {}) {
  const calls: string[] = [];
  const api: InstanceRepositoriesApi = {
    repositories: async () => [
      repo({ id: "r2", name: "web", repoUrl: "git@github.com:acme/web.git", projectId: P_WEB }),
      repo({}),
      repo({
        id: "r0",
        name: "admin",
        repoUrl: "https://gitlab.com/acme/tools/admin",
        gitAccountName: undefined,
      }),
      // Solo docs.view: senza configurazione, fuori dall'elenco.
      repo({
        id: "r9",
        name: "manuale",
        projectId: P_DOCS,
        config: false,
        gitAccountName: undefined,
      }),
    ],
    projects: async () => [
      { id: P_WEB, code: "WEB", name: "Sito" },
      { id: P_ACQ, code: "ACQ", name: "Acquedotto" },
      { id: P_DOCS, code: "DOC", name: "Docs" },
    ],
    detached: async () => [DETACHED],
    link: async (id, projectId) => {
      calls.push(`link ${id} ${projectId}`);
    },
    deleteDetached: async (id) => {
      calls.push(`delete ${id}`);
    },
    ...over,
  };
  return { api, calls };
}

describe("Amministrazione → Repositories dal server", () => {
  it("i collegati: un gruppo per progetto con repos.view, per nome; owner/nome dall'URL", async () => {
    const groups = await createRealInstanceRepositories(fake().api).listAllRepositories();
    expect(groups).toEqual([
      {
        projectId: P_ACQ,
        projectCode: "ACQ",
        projectName: "Acquedotto",
        repositories: [
          {
            id: "r0",
            name: "admin",
            fullName: "acme/tools/admin",
            gitAccountName: null,
            href: "#/p/ACQ/settings/repositories",
          },
          {
            id: "r1",
            name: "api",
            fullName: "acme/api",
            gitAccountName: "acme-bot",
            href: "#/p/ACQ/settings/repositories",
          },
        ],
      },
      {
        projectId: P_WEB,
        projectCode: "WEB",
        projectName: "Sito",
        repositories: [
          {
            id: "r2",
            name: "web",
            fullName: "acme/web",
            gitAccountName: "acme-bot",
            href: "#/p/WEB/settings/repositories",
          },
        ],
      },
    ]);
  });

  it("gli staccati come li calcola il server", async () => {
    const rows = await createRealInstanceRepositories(fake().api).listDetachedRepositories();
    expect(rows).toEqual([
      {
        id: "d1",
        name: "vetrina",
        fullName: "ronchi/vetrina",
        gitAccountName: "acme-bot",
        gitAccountProvider: "github",
        detachedAt: "2026-11-18T10:00:00.000Z",
        formerProject: { code: "RNC", name: "Vetrina online" },
        linkTargets: [{ projectId: P_ACQ, code: "ACQ", name: "Acquedotto" }],
        canDelete: true,
      },
    ]);
  });

  it("collegare: 204 è ok; name_taken e not_detached diventano invalid, 403 e 404 come sempre", async () => {
    const { api, calls } = fake();
    expect(await createRealInstanceRepositories(api).linkRepository("d1", P_ACQ)).toEqual({
      ok: true,
    });
    expect(calls).toEqual([`link d1 ${P_ACQ}`]);
    const cases: [ApiError, object][] = [
      [apiError(409, "name_taken"), { ok: false, error: "invalid", reason: "name_taken" }],
      // Un altro l'ha appena collegato o eliminato: come nel prototipo, non c'è più.
      [apiError(409, "not_detached"), { ok: false, error: "not_found" }],
      [apiError(403, "forbidden"), { ok: false, error: "forbidden" }],
      [apiError(404, "not_found"), { ok: false, error: "not_found" }],
      // La destinazione sparita (review F6, M2; 72, Task 7): non è il repository che manca.
      [
        apiError(404, "target_not_found"),
        { ok: false, error: "invalid", reason: "target_not_found" },
      ],
    ];
    for (const [err, want] of cases) {
      const f = fake({ link: async () => Promise.reject(err) });
      expect(await createRealInstanceRepositories(f.api).linkRepository("d1", P_ACQ)).toEqual(want);
    }
  });

  it("eliminare: 204 è ok; reauth_required, forbidden, not_detached", async () => {
    const { api, calls } = fake();
    expect(await createRealInstanceRepositories(api).deleteDetachedRepository("d1")).toEqual({
      ok: true,
    });
    expect(calls).toEqual(["delete d1"]);
    const cases: [ApiError, object][] = [
      [apiError(403, "reauth_required"), { ok: false, error: "reauth_required" }],
      [apiError(403, "forbidden"), { ok: false, error: "forbidden" }],
      [apiError(409, "not_detached"), { ok: false, error: "not_found" }],
    ];
    for (const [err, want] of cases) {
      const f = fake({ deleteDetached: async () => Promise.reject(err) });
      expect(await createRealInstanceRepositories(f.api).deleteDetachedRepository("d1")).toEqual(
        want,
      );
    }
  });

  it("un 403 sugli staccati si propaga: la pagina lo legge come non accessibile", async () => {
    const err = apiError(403, "forbidden");
    const { api } = fake({ detached: async () => Promise.reject(err) });
    await expect(createRealInstanceRepositories(api).listDetachedRepositories()).rejects.toBe(err);
  });
});
