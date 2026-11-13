import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import type { ReleaseDetail, ReleaseRow } from "@stubwise/shared";
import { createRealExplain, createRealReleases, type ReleasesApi } from "./releases";

// Area 8, F1: i rilasci sulle rotte vere, con le firme del prototipo
// (`data/releases/reads.ts`, `writes.ts`). Lo stato e i permessi li calcola il
// server; i campi che un server di prima non manda hanno il default PRUDENTE
// (nessun bottone, nessun punto, una task esistente conta come aperta).

const row = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  id: "r1",
  code: "AUD-V3",
  projectId: "p1",
  repositoryId: "repo1",
  repositoryName: "audin/audin-app",
  prNumber: 246,
  prUrl: "https://github.com/audin/audin-app/pull/246",
  title: "Checkout",
  mergeSha: "4be1f0c27a9d",
  mergedAt: "2026-11-13T09:00:00.000Z",
  mergedById: "ada",
  mergedGitName: null,
  viaStubwise: true,
  status: { kind: "failed", since: "2026-11-13T09:05:00.000Z" },
  fixTask: null,
  ...over,
});
const detail = (over: Partial<ReleaseDetail> = {}): ReleaseDetail => ({
  ...row(),
  runs: [
    {
      id: "run1",
      name: "Deploy to production",
      status: "failed",
      url: null,
      failedStep: "Run migrations",
      startedAt: null,
      endedAt: "2026-11-13T09:05:00.000Z",
    },
  ],
  releaseNotes: "- AUD-12: Checkout",
  seenInProductionAt: null,
  permissions: { fix: true },
  ...over,
});

function fakeApi(over: Partial<ReleasesApi> = {}) {
  const calls: string[] = [];
  const api: ReleasesApi = {
    list: async (projectId) => (calls.push(`GET ${projectId}/releases`), { items: [row()] }),
    get: async (code) => (calls.push(`GET releases/${code}`), detail()),
    fix: async (code, body) => (
      calls.push(`POST releases/${code}/fix ${JSON.stringify(body)}`),
      { taskId: "t9", taskCode: "AUD-77", existing: false, noteAdded: false }
    ),
    ...over,
  };
  return { api, calls };
}
const codeOf = async () => "AUD";

describe("i rilasci della build app (area 8, F1)", () => {
  it("l'elenco: le righe nella forma del prototipo, col codice del progetto e lo stato del server", async () => {
    const { api } = fakeApi();
    const [r] = await createRealReleases(api, codeOf).listReleases("p1");
    expect(r).toMatchObject({
      code: "AUD-V3",
      projectCode: "AUD",
      pr: { repo: "audin/audin-app", number: 246 },
      status: { kind: "failed" },
      mergedGitName: "",
      runs: [],
    });
  });

  it("i campi che il server non manda ancora: niente bottone, niente punto, task esistente aperta", async () => {
    const { api } = fakeApi({
      list: async () => ({ items: [row({ fixTask: { id: "t1", code: "AUD-70" } })] }),
    });
    const [r] = await createRealReleases(api, codeOf).listReleases("p1");
    expect(r).toMatchObject({
      canFix: false,
      waitsOnViewer: false,
      fixTask: { id: "t1", code: "AUD-70", open: true },
      productionServer: null,
    });
  });

  it("il nome intero del repository, il server di produzione col suo nome, «startFix» dal server", async () => {
    const { api } = fakeApi({
      get: async () =>
        ({
          ...detail(),
          repositoryName: "audin-app",
          repositoryFullName: "audin/audin-app",
          permissions: { fix: true, startFix: true },
          productionServer: { serverId: "s1", serverName: "web-01", reportedSha: "abc1234" },
        }) as never,
    });
    const r = await createRealReleases(api, codeOf).getRelease("AUD-V3");
    expect(r).toMatchObject({
      pr: { repo: "audin/audin-app", number: 246 },
      canStartFix: true,
      productionServer: { serverCode: "web-01", reportedSha: "abc1234" },
    });
  });

  it("il dettaglio: run senza log (P-1), il passo fallito nell'anteprima, i permessi del server", async () => {
    const { api } = fakeApi();
    const r = await createRealReleases(api, codeOf).getRelease("AUD-V3");
    expect(r).toMatchObject({
      canFix: true,
      canStartFix: false,
      fixBlock: null,
      releaseNotes: "- AUD-12: Checkout",
      fixPreview: { step: "Run migrations", relatedTaskCode: null, logLines: false },
      runs: [{ name: "Deploy to production", log: null, logHidden: false, url: "" }],
    });
  });

  it("un rilascio che non c'è o non si vede (404) è null; un progetto invisibile non ha rilasci", async () => {
    const notFound = async () => {
      throw new ApiError(404, "not_found", "not_found");
    };
    const { api } = fakeApi({ get: notFound, list: notFound });
    const releases = createRealReleases(api, codeOf);
    expect(await releases.getRelease("AUD-V99")).toBeNull();
    expect(await releases.listReleases("p1")).toEqual([]);
  });

  it("«Fai sistemare a Claude»: la nota va al server, l'esito nelle parole della pagina", async () => {
    const { api, calls } = fakeApi();
    const res = await createRealReleases(api, codeOf).fixRelease("AUD-V3", "Guarda la 0042");
    // `start`: Claude parte se il server lo permette (`runs.start`, budget); lo dice `started`.
    expect(calls).toContain('POST releases/AUD-V3/fix {"note":"Guarda la 0042","start":true}');
    expect(res).toMatchObject({ id: "t9", code: "AUD-77", existing: false, noteAdded: false });
  });

  it("gli errori del fix nelle parole del prototipo (403 forbidden, 409 col codice)", async () => {
    const releases = (status: number, code: string) =>
      createRealReleases(
        fakeApi({
          fix: async () => {
            throw new ApiError(status, code, code);
          },
        }).api,
        codeOf,
      );
    await expect(releases(403, "forbidden").fixRelease("AUD-V3")).rejects.toThrow("forbidden");
    await expect(releases(409, "not_failed").fixRelease("AUD-V3")).rejects.toThrow(
      "invalid: not_failed",
    );
  });
});

describe("«Spiega» un rilascio (area 8, F1, releases-explain)", () => {
  it("una conversazione nuova col contesto del rilascio; la mia aperta sullo stesso rilascio si riusa", async () => {
    const created: unknown[] = [];
    const explain = createRealExplain({
      mine: async () => [
        { id: "c-old", context: { kind: "release", id: "AUD-V2" } },
        { id: "c-other", context: { kind: "task", id: "AUD-12" } },
      ],
      create: async (context) => (created.push(context), { id: "c-new" }),
    });
    expect(await explain.explainRelease("AUD-V3")).toMatchObject({ id: "c-new", reused: false });
    expect(created).toEqual([{ kind: "release", id: "AUD-V3" }]);
    expect(await explain.explainRelease("AUD-V2")).toMatchObject({ id: "c-old", reused: true });
    expect(created).toHaveLength(1);
  });
});
