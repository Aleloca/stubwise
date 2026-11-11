import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { drive } from "./drive";
import { installFakeServer, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";

// Il Drive nella build app (area 5, fetta 2): i caricati «come oggi», senza
// Google né contenuto (F3). Le aperture le conta il server quando si apre
// davvero (`/download`, `/preview`): `recordOpen` è il gesto stesso.

const FILE_ID = "44444444-4444-4444-8444-444444444444";

const serverRow = (over: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  code: "AUD-F3",
  projectId: PROJECT_ID,
  projectCode: "AUD",
  source: "upload",
  name: "Contratto.pdf",
  mime: "application/pdf",
  type: "pdf",
  sizeBytes: 2048,
  addedById: ME_ID,
  addedAt: "2026-11-10T09:00:00.000Z",
  opens90d: 4,
  lastOpenedAt: "2026-11-11T08:00:00.000Z",
  summaryLine: null,
  permissions: { delete: true, remove: false, hide: false, retry: false },
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
  delete (window as { stubwise?: unknown }).stubwise;
});

const query = (path: string) => new URL(`http://x${path}`).searchParams;

describe("il Drive nella build app: le letture", () => {
  it("l'elenco di un progetto, coi filtri e l'ordine, nella forma del prototipo", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: { body: { items: [serverRow()] } },
    });
    const rows = await drive.listDriveFiles({ projectId: PROJECT_ID, type: "pdf", addedById: ME_ID, sort: "recent" });
    const call = seen.find((r) => r.path.includes("/drive/files"))!;
    expect(query(call.path).get("sort")).toBe("recent");
    expect(query(call.path).get("type")).toBe("pdf");
    expect(query(call.path).get("addedById")).toBe(ME_ID);
    expect(rows).toEqual([
      expect.objectContaining({
        id: FILE_ID,
        code: "AUD-F3",
        projectCode: "AUD",
        source: "upload",
        name: "Contratto.pdf",
        sizeBytes: 2048,
        addedById: ME_ID,
        addedAt: "2026-11-10T09:00:00.000Z",
        modifiedAt: "2026-11-10T09:00:00.000Z",
        opens90d: 4,
        // Nessun contenuto prima della F3: pronto, senza riassunto.
        content: "ready",
        summary: null,
        summaryLine: null,
        hidden: false,
        unavailable: null,
        folder: null,
        googleFileId: null,
        permissions: { delete: true, remove: false, hide: false, retry: false },
      }),
    ]);
  });

  it("senza progetto l'elenco globale; i nascosti e i Google (area 6) non ci sono, senza chiamate", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/files": { body: { items: [serverRow({ projectCode: null })] } },
    });
    const rows = await drive.listDriveFiles({ sort: "most_used" });
    expect(rows.map((r) => r.projectCode)).toEqual(["AUD"]);
    expect(await drive.listDriveFiles({ sort: "most_used", hidden: true })).toEqual([]);
    expect(await drive.listDriveFiles({ sort: "most_used", source: "google" })).toEqual([]);
    expect(seen.filter((r) => r.path.includes("/drive/")).length).toBe(1);
  });

  it("un progetto di cui non si è membri: elenco vuoto (404)", async () => {
    installFakeServer({ "GET /api/projects": { body: [] } });
    expect(await drive.listDriveFiles({ projectId: PROJECT_ID, sort: "most_used" })).toEqual([]);
  });

  it("il dettaglio per codice: dove sta, poi il file con totale e storia", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/codes/AUD-F3": { body: { code: "AUD-F3", projectId: PROJECT_ID, fileId: FILE_ID } },
      [`GET /api/drive/files/${FILE_ID}`]: {
        body: { ...serverRow(), opensTotal: 9, history: [{ personId: ME_ID, at: "2026-11-11T08:00:00.000Z", via: "download" }] },
      },
    });
    const file = await drive.getDriveFile("AUD-F3");
    expect(file).toEqual(
      expect.objectContaining({
        id: FILE_ID,
        opensTotal: 9,
        history: [{ fileId: FILE_ID, personId: ME_ID, at: "2026-11-11T08:00:00.000Z", via: "download" }],
      }),
    );
  });

  it("un file che non si vede è null; un riferimento che non è né id né codice non chiama", async () => {
    const { seen } = installFakeServer({ "GET /api/projects": { body: [serverProject({ memberIds: [] })] } });
    expect(await drive.getDriveFile(FILE_ID)).toBeNull();
    expect(await drive.getDriveFile("AUD-F99")).toBeNull();
    const before = seen.length;
    expect(await drive.getDriveFile("drv-1")).toBeNull();
    expect(seen.length).toBe(before);
  });

  it("la ricerca cerca nel nome e nel codice (`q`), senza passaggi né file fuori dai progetti", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: { body: { items: [serverRow()] } },
    });
    const result = await drive.searchDrive("contr", { projectId: PROJECT_ID });
    expect(query(seen.find((r) => r.path.includes("/drive/files"))!.path).get("q")).toBe("contr");
    expect(result.files.map((h) => [h.file.code, h.passage])).toEqual([["AUD-F3", null]]);
    expect(result.outside).toEqual([]);
    const before = seen.length;
    expect(await drive.searchDrive("c")).toEqual({ files: [], outside: [] });
    expect(seen.length).toBe(before);
  });
});

describe("il Drive nella build app: eliminare e aprire", () => {
  it("eliminare: DELETE; un file non proprio è forbidden, uno sparito not_found", async () => {
    const { seen } = installFakeServer({ [`DELETE /api/drive/files/${FILE_ID}`]: { status: 204 } });
    await drive.deleteDriveFile(FILE_ID);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([`DELETE /api/drive/files/${FILE_ID}`]);
    installFakeServer({ [`DELETE /api/drive/files/${FILE_ID}`]: { status: 403, body: { code: "forbidden", message: "no" } } });
    await expect(drive.deleteDriveFile(FILE_ID)).rejects.toThrow("forbidden");
    installFakeServer({});
    await expect(drive.deleteDriveFile(FILE_ID)).rejects.toThrow("not_found");
  });

  it("sul desktop scaricare e l'anteprima passano dal main, sul solo percorso del download", async () => {
    const download = vi.fn(async () => ({ ok: true }));
    (window as { stubwise?: unknown }).stubwise = { api: { download } };
    expect(await drive.recordOpen(FILE_ID, "download")).toEqual({ counted: true });
    expect(await drive.recordOpen(FILE_ID, "preview")).toEqual({ counted: true });
    expect(download.mock.calls).toEqual([[`/api/drive/files/${FILE_ID}/download`], [`/api/drive/files/${FILE_ID}/download`]]);
  });

  it("sul desktop un download annullato non è un errore; un file sparito sì", async () => {
    const download = vi.fn(async () => ({ ok: false, reason: "canceled" }));
    (window as { stubwise?: unknown }).stubwise = { api: { download } };
    expect(await drive.recordOpen(FILE_ID, "download")).toEqual({ counted: false });
    download.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    await expect(drive.recordOpen(FILE_ID, "download")).rejects.toThrow("not_found");
  });

  it("sul web l'anteprima apre la rotta `preview` in una scheda nuova", async () => {
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    expect(await drive.recordOpen(FILE_ID, "preview")).toEqual({ counted: true });
    expect(open).toHaveBeenCalledWith(`/api/drive/files/${FILE_ID}/preview`, "_blank", "noopener");
  });

  it("«Apri in Google Drive» non c'è (area 6)", async () => {
    await expect(drive.recordOpen(FILE_ID, "google")).rejects.toThrow();
  });
});
