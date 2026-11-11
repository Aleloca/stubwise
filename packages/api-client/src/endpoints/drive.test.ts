import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// Il Drive dei file caricati (area 5, fetta 2): elenco del progetto e globale,
// dettaglio, caricamento, eliminazione, download e anteprima (percorsi dei 302),
// codici F e «Save to Drive» da un allegato della Chat.

const PROJECT = "7f1c2a1e-0000-4000-8000-0000000000b1";
const FILE = "7f1c2a1e-0000-4000-8000-0000000000b2";
const row = {
  id: FILE,
  code: "AUD-F3",
  projectId: PROJECT,
  projectCode: "AUD",
  source: "upload",
  name: "Contratto.pdf",
  mime: "application/pdf",
  type: "pdf",
  sizeBytes: 10,
  addedById: null,
  addedAt: "2026-11-11T10:00:00.000Z",
  opens90d: 2,
  lastOpenedAt: null,
  summaryLine: null,
  permissions: { delete: true, remove: false, hide: false, retry: false },
};

function client(body: unknown, { status = 200 } = {}) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const last = (f: ReturnType<typeof client>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body };
};

describe("endpoints drive", () => {
  it("l'elenco del progetto coi filtri, e quello globale", async () => {
    const g = client({ items: [row] });
    expect((await g.c.drive.list(PROJECT, { type: "pdf", q: "contr", sort: "recent" })).items[0]).toMatchObject({ code: "AUD-F3" });
    expect(last(g.fetchImpl)).toMatchObject({ url: `/api/projects/${PROJECT}/drive/files?type=pdf&q=contr&sort=recent`, method: "GET" });
    await g.c.drive.listAll({ projectId: PROJECT });
    expect(last(g.fetchImpl).url).toBe(`/api/drive/files?projectId=${PROJECT}`);
    await g.c.drive.listAll();
    expect(last(g.fetchImpl).url).toBe("/api/drive/files");
  });

  it("una riga senza i campi con default (un server più vecchio) si legge lo stesso", async () => {
    const { opens90d: _o, lastOpenedAt: _l, summaryLine: _s, permissions: _p, projectCode: _c, ...bare } = row;
    const g = client({ items: [bare] });
    expect((await g.c.drive.list(PROJECT)).items[0]).toMatchObject({ opens90d: 0, summaryLine: null, permissions: { delete: false } });
  });

  it("dettaglio, eliminazione, codici e i percorsi di download e anteprima", async () => {
    const d = client({ ...row, opensTotal: 4, history: null });
    expect(await d.c.drive.get(FILE)).toMatchObject({ opensTotal: 4, history: null });
    expect(last(d.fetchImpl)).toMatchObject({ url: `/api/drive/files/${FILE}`, method: "GET" });
    const r = client({ code: "AUD-F3", projectId: PROJECT, fileId: FILE });
    expect(await r.c.drive.resolveCode("AUD-F3")).toMatchObject({ fileId: FILE });
    expect(last(r.fetchImpl).url).toBe("/api/drive/codes/AUD-F3");
    const x = client(null, { status: 204 });
    await x.c.drive.remove(FILE);
    expect(last(x.fetchImpl)).toMatchObject({ url: `/api/drive/files/${FILE}`, method: "DELETE" });
    expect(x.c.drive.downloadPath(FILE)).toBe(`/api/drive/files/${FILE}/download`);
    expect(x.c.drive.previewPath(FILE)).toBe(`/api/drive/files/${FILE}/preview`);
  });

  it("il caricamento: multipart col campo `file`; «Save to Drive» col progetto quando serve", async () => {
    const u = client({ file: row, keptBoth: true, requestedName: "contratto.pdf" });
    expect(await u.c.drive.upload(PROJECT, new Blob(["x"]), "contratto.pdf")).toMatchObject({ keptBoth: true });
    const sent = last(u.fetchImpl);
    expect(sent).toMatchObject({ url: `/api/projects/${PROJECT}/drive/files`, method: "POST" });
    expect((sent.body as FormData).get("file")).toBeInstanceOf(Blob);
    const s = client({ file: row, requestedName: "a.pdf" });
    expect((await s.c.drive.saveFromChat(FILE, { projectId: PROJECT })).keptBoth).toBe(false);
    expect(last(s.fetchImpl)).toMatchObject({ url: `/api/chat/attachments/${FILE}/save-to-drive`, method: "POST", body: JSON.stringify({ projectId: PROJECT }) });
    await s.c.drive.saveFromChat(FILE);
    expect(last(s.fetchImpl).body).toBe("{}");
  });
});
