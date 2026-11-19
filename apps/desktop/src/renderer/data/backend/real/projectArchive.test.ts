import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealProjectArchive, type ProjectArchiveApi } from "./projectArchive";

// Area 9, F6, Task 3 di 72 (2d4cff4c9): archiviare e riaprire un progetto.
// `GET …/archive-preview` → `{openAutomationRuns, busy}`; `POST …/archive` e
// `POST …/reopen` → 204. Gli errori sono piatti (`{code, message}`), il 409
// `busy` porta `reasons` nel body (`ApiError.details`).

const SERVER_REASONS = [
  {
    kind: "claude_session",
    code: "WEB-12",
    title: "Fix login",
    waiting: false,
    repository: null,
    paused: false,
  },
  {
    kind: "claude_session",
    code: null,
    title: null,
    waiting: true,
    repository: null,
    paused: false,
  },
  { kind: "release", code: "WEB-V3", title: null, waiting: false, repository: null, paused: false },
  {
    kind: "doc_generation",
    code: null,
    title: null,
    waiting: false,
    repository: "web",
    paused: true,
  },
];

const RENDERER_REASONS = [
  { kind: "claude_session", code: "WEB-12", title: "Fix login", waiting: false },
  { kind: "claude_session", code: null, title: null, waiting: true },
  { kind: "release", code: "WEB-V3" },
  { kind: "doc_generation", repository: "web", paused: true },
];

const apiError = (status: number, code: string, extra: object = {}) =>
  new ApiError(status, code, code, { details: { code, message: code, ...extra } });

function fake(over: Partial<ProjectArchiveApi> = {}) {
  const calls: string[] = [];
  const api: ProjectArchiveApi = {
    preview: async (id) => {
      calls.push(`preview ${id}`);
      return { openAutomationRuns: 2, busy: SERVER_REASONS };
    },
    archive: async (id) => {
      calls.push(`archive ${id}`);
    },
    reopen: async (id) => {
      calls.push(`reopen ${id}`);
    },
    ...over,
  };
  return { api, calls };
}

describe("archiviare e riaprire un progetto dal server", () => {
  it("l'anteprima: le esecuzioni che si annullano e le ragioni nella forma del renderer", async () => {
    const r = await createRealProjectArchive(fake().api).getArchivePreview("p1");
    expect(r).toEqual({ ok: true, openAutomationRuns: 2, busy: RENDERER_REASONS });
  });

  it("l'anteprima parsa la risposta: i campi assenti prendono il default", async () => {
    const { api } = fake({
      preview: async () => ({ busy: [{ kind: "release", code: "WEB-V1" }] }),
    });
    const r = await createRealProjectArchive(api).getArchivePreview("p1");
    expect(r).toEqual({
      ok: true,
      openAutomationRuns: 0,
      busy: [{ kind: "release", code: "WEB-V1" }],
    });
  });

  it("una ragione di un tipo che il client non conosce resta, come lavoro che non vedi", async () => {
    const { api } = fake({ preview: async () => ({ busy: [{ kind: "export_job", code: "X" }] }) });
    const r = await createRealProjectArchive(api).getArchivePreview("p1");
    expect(r).toEqual({
      ok: true,
      openAutomationRuns: 0,
      busy: [{ kind: "claude_session", code: null, title: null, waiting: false }],
    });
  });

  it("l'anteprima: 404 è not_found, 403 è forbidden", async () => {
    const nf = fake({ preview: async () => Promise.reject(apiError(404, "not_found")) });
    expect(await createRealProjectArchive(nf.api).getArchivePreview("p1")).toEqual({
      ok: false,
      error: "not_found",
    });
    const fb = fake({ preview: async () => Promise.reject(apiError(403, "forbidden")) });
    expect(await createRealProjectArchive(fb.api).getArchivePreview("p1")).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("archivia: 204 è ok", async () => {
    const { api, calls } = fake();
    expect(await createRealProjectArchive(api).archiveProject("p1")).toEqual({ ok: true });
    expect(calls).toEqual(["archive p1"]);
  });

  it("archivia: il 409 busy dà le ragioni del body", async () => {
    const { api } = fake({
      archive: async () => Promise.reject(apiError(409, "busy", { reasons: SERVER_REASONS })),
    });
    expect(await createRealProjectArchive(api).archiveProject("p1")).toEqual({
      ok: false,
      error: "busy",
      reasons: RENDERER_REASONS,
    });
  });

  it("archivia: il 409 already_archived è invalid con quel motivo", async () => {
    const { api } = fake({
      archive: async () => Promise.reject(apiError(409, "already_archived")),
    });
    expect(await createRealProjectArchive(api).archiveProject("p1")).toEqual({
      ok: false,
      error: "invalid",
      reason: "already_archived",
    });
  });

  it("archivia: 404 e 403", async () => {
    const nf = fake({ archive: async () => Promise.reject(apiError(404, "not_found")) });
    expect(await createRealProjectArchive(nf.api).archiveProject("p1")).toEqual({
      ok: false,
      error: "not_found",
    });
    const fb = fake({ archive: async () => Promise.reject(apiError(403, "forbidden")) });
    expect(await createRealProjectArchive(fb.api).archiveProject("p1")).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("un errore che non conosce si propaga", async () => {
    const boom = new ApiError(500, "boom", "internal");
    const { api } = fake({ archive: async () => Promise.reject(boom) });
    await expect(createRealProjectArchive(api).archiveProject("p1")).rejects.toBe(boom);
  });

  it("riapre: 204 è ok, il 409 not_archived è invalid con quel motivo", async () => {
    const { api, calls } = fake();
    expect(await createRealProjectArchive(api).reopenProject("p1")).toEqual({ ok: true });
    expect(calls).toEqual(["reopen p1"]);
    const na = fake({ reopen: async () => Promise.reject(apiError(409, "not_archived")) });
    expect(await createRealProjectArchive(na.api).reopenProject("p1")).toEqual({
      ok: false,
      error: "invalid",
      reason: "not_archived",
    });
  });
});
