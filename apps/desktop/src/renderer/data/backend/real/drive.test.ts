import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appClient, setAppClientForTests } from "./client";
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

  it("senza progetto l'elenco globale", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/files": { body: { items: [serverRow({ projectCode: null })] } },
    });
    const rows = await drive.listDriveFiles({ sort: "most_used" });
    expect(rows.map((r) => r.projectCode)).toEqual(["AUD"]);
  });

  // Review F5b (2): «Nascosti» e «Origine» li filtra il server (F5b, 72).
  it("i nascosti e l'origine vanno al server come filtri", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/files": { body: { items: [serverRow({ projectCode: null })] } },
    });
    await drive.listDriveFiles({ sort: "most_used", hidden: true });
    await drive.listDriveFiles({ sort: "most_used", source: "google" });
    await drive.listDriveFiles({ sort: "most_used", source: "upload" });
    const lists = seen.filter((r) => r.path.startsWith("/api/drive/files"));
    expect(lists.map((r) => [query(r.path).get("hidden"), query(r.path).get("source")])).toEqual([
      ["true", null],
      [null, "google"],
      [null, "upload"],
    ]);
  });

  // Review F5b (2, 3): la ricerca coi Google, e i file del mio Drive fuori dai progetti.
  it("la ricerca: i Google al server; i file del mio Drive fuori dai progetti quando l'origine non è «caricato»", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/files": { body: { items: [] } },
      "GET /api/drive/google/outside": {
        body: {
          items: [
            {
              googleFileId: "g-9",
              name: "Piano 2027",
              type: "document",
              mime: "application/vnd.google-apps.document",
              owner: null,
              modifiedAt: null,
              alreadyInProject: false,
            },
          ],
        },
      },
    });
    const google = await drive.searchDrive("piano", { source: "google" });
    expect(google.outside.map((o) => o.googleFileId)).toEqual(["g-9"]);
    expect(query(seen.find((r) => r.path.startsWith("/api/drive/files"))!.path).get("source")).toBe("google");
    // Solo caricati, o i file di una persona: niente Drive fuori dai progetti.
    const before = seen.filter((r) => r.path.startsWith("/api/drive/google/outside")).length;
    expect((await drive.searchDrive("piano", { source: "upload" })).outside).toEqual([]);
    expect((await drive.searchDrive("piano", { addedById: ME_ID })).outside).toEqual([]);
    expect(seen.filter((r) => r.path.startsWith("/api/drive/google/outside")).length).toBe(before);
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

  it("il codice si risolve una volta sola: le riletture del dettaglio non chiedono di nuovo dove sta", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/codes/AUD-F3": { body: { code: "AUD-F3", projectId: PROJECT_ID, fileId: FILE_ID } },
      [`GET /api/drive/files/${FILE_ID}`]: { body: { ...serverRow(), opensTotal: 9, history: null } },
    });
    for (let i = 0; i < 3; i++) expect(await drive.getDriveFile("AUD-F3")).toMatchObject({ id: FILE_ID });
    expect(seen.filter((r) => r.path === "/api/drive/codes/AUD-F3")).toHaveLength(1);
    expect(seen.filter((r) => r.path === `/api/drive/files/${FILE_ID}`)).toHaveLength(3);
  });

  it("un codice in cache il cui file non si vede più: null, e la volta dopo si risolve di nuovo", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/drive/codes/AUD-F9": { body: { code: "AUD-F9", projectId: PROJECT_ID, fileId: FILE_ID } },
    });
    expect(await drive.getDriveFile("AUD-F9")).toBeNull();
    expect(await drive.getDriveFile("AUD-F9")).toBeNull();
    expect(seen.filter((r) => r.path === "/api/drive/codes/AUD-F9")).toHaveLength(2);
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

describe("il Drive nella build app: il contenuto (F3)", () => {
  it("lo stato del contenuto: in coda o in lettura è «processing»; uno ignoto è «no_text»; un server senza la F3 è «ready»", async () => {
    const cases = [
      ["pending", "processing"],
      ["processing", "processing"],
      ["ready", "ready"],
      ["no_text", "no_text"],
      ["unsupported", "unsupported"],
      ["error", "error"],
      ["indexing_v2", "no_text"],
      [undefined, "ready"],
    ] as const;
    const id = (i: number) => `0000000${i}-0000-4000-8000-000000000000`;
    installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: {
        body: {
          items: cases.map(([status], i) =>
            serverRow({ id: id(i), code: `AUD-F${i + 1}`, ...(status ? { contentStatus: status } : {}) }),
          ),
        },
      },
    });
    const rows = await drive.listDriveFiles({ projectId: PROJECT_ID, sort: "recent" });
    expect(rows.map((r) => r.content)).toEqual(cases.map(([, content]) => content));
  });

  it("«Retry» lo permette il server (`permissions.retry`); la pagina lo mostra solo su un errore", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: {
        body: { items: [serverRow({ contentStatus: "error", permissions: { delete: true, remove: false, hide: false, retry: true } })] },
      },
    });
    const [row] = await drive.listDriveFiles({ projectId: PROJECT_ID, sort: "recent" });
    expect(row).toMatchObject({ content: "error", permissions: { delete: true, retry: true } });
  });

  it("«Retry»: POST alla rotta di retry, la riga torna in lettura; 403, 404 e 409 coi nomi del prototipo", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`POST /api/drive/files/${FILE_ID}/retry`]: { body: serverRow({ contentStatus: "pending" }) },
    });
    const row = await drive.retryExtraction(FILE_ID);
    expect(seen.some((r) => r.method === "POST" && r.path === `/api/drive/files/${FILE_ID}/retry`)).toBe(true);
    expect(row).toMatchObject({ id: FILE_ID, content: "processing" });
    for (const [status, code, error] of [
      [403, "forbidden", "forbidden"],
      [404, "not_found", "not_found"],
      [409, "not_retryable", "invalid: content not in error"],
    ] as const) {
      installFakeServer({ [`POST /api/drive/files/${FILE_ID}/retry`]: { status, body: { code, message: "x" } } });
      await expect(drive.retryExtraction(FILE_ID), code).rejects.toThrow(error);
    }
  });

  it("il riassunto: nell'elenco la prima frase, nel dettaglio intero; l'OCR, e se è solo sulle prime pagine", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: {
        body: {
          items: [
            serverRow({ contentStatus: "ready", contentOcr: "partial", summaryLine: "Il contratto di Audin." }),
            serverRow({ id: "22222222-2222-4222-8222-222222222222", code: "AUD-F4", contentStatus: "ready", contentOcr: "full" }),
            serverRow({ id: "33333333-3333-4333-8333-333333333333", code: "AUD-F5", contentStatus: "ready", contentOcr: "none" }),
          ],
        },
      },
      [`GET /api/drive/files/${FILE_ID}`]: {
        body: {
          ...serverRow({ contentStatus: "ready", contentOcr: "partial", summaryLine: "Il contratto di Audin." }),
          summary: "Il contratto di Audin. Rinnovo annuale, disdetta a 60 giorni.",
          opensTotal: 9,
          history: null,
        },
      },
    });
    const rows = await drive.listDriveFiles({ projectId: PROJECT_ID, sort: "recent" });
    expect(rows.map((r) => [r.code, r.content, r.ocr, r.ocrPartial ?? false, r.summaryLine])).toEqual([
      ["AUD-F3", "ready", true, true, "Il contratto di Audin."],
      ["AUD-F4", "ready", true, false, null],
      ["AUD-F5", "ready", false, false, null],
    ]);
    const detail = await drive.getDriveFile(FILE_ID);
    expect(detail).toMatchObject({
      summary: "Il contratto di Audin. Rinnovo annuale, disdetta a 60 giorni.",
      summaryLine: "Il contratto di Audin.",
      ocr: true,
      ocrPartial: true,
    });
  });

  it("la ricerca per contenuto porta il passaggio (testo puro, dal server); per nome o codice nessuno", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: {
        body: {
          items: [
            serverRow({ contentStatus: "ready", snippet: "…la disdetta va inviata 60 giorni prima…" }),
            serverRow({ id: "22222222-2222-4222-8222-222222222222", code: "AUD-F4", contentStatus: "ready", snippet: null }),
          ],
        },
      },
    });
    const result = await drive.searchDrive("disdetta", { projectId: PROJECT_ID });
    expect(result.files.map((h) => [h.file.code, h.passage])).toEqual([
      ["AUD-F3", "…la disdetta va inviata 60 giorni prima…"],
      ["AUD-F4", null],
    ]);
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

  // F5b (72): `GET /api/drive/files/:id/open` conta l'apertura e rimanda a Google.
  it("«Apri in Google Drive» sul web: la rotta `open` in una scheda nuova (conta l'apertura)", async () => {
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    expect(await drive.recordOpen(FILE_ID, "google")).toEqual({ counted: true });
    expect(open).toHaveBeenCalledWith(`/api/drive/files/${FILE_ID}/open`, "_blank", "noopener");
  });

  // Sul desktop la sessione sta nel main: la rotta non si apre da fuori. Si apre
  // il file su Google (i permessi li applica Google), e l'apertura non si conta.
  it("«Apri in Google Drive» sul desktop: il file su Google, senza contare", async () => {
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    installFakeServer({
      [`GET /api/drive/files/${FILE_ID}`]: {
        body: serverRow({
          source: "google",
          mime: "application/vnd.google-apps.document",
          sizeBytes: null,
          googleFileId: "g-1",
        }),
      },
    });
    // Il client nasce prima del ponte del main: le richieste vanno al server finto.
    appClient();
    (window as { stubwise?: unknown }).stubwise = { api: { download: vi.fn() } };
    expect(await drive.recordOpen(FILE_ID, "google")).toEqual({ counted: false });
    expect(open).toHaveBeenCalledWith("https://docs.google.com/document/d/g-1/edit", "_blank", "noopener");
  });
});

describe("il Drive nella build app: caricare", () => {
  const uploaded = (over: Record<string, unknown> = {}) => ({
    file: serverRow({ name: "Contratto (2).pdf" }),
    keptBoth: true,
    requestedName: "Contratto.pdf",
    ...over,
  });
  const pdf = () => new File(["%PDF"], "Contratto.pdf", { type: "application/pdf" });

  it("sul desktop: il main apre il file (token), lo manda in streaming e dice l'avanzamento", async () => {
    let progress: ((p: { uploadId: string; sent: number; total: number }) => void) | null = null;
    const register = vi.fn(async () => ({ ok: true, grant: "g1", name: "Contratto.pdf", sizeBytes: 4 }));
    const upload = vi.fn(async (req: { grant: string; path: string; uploadId: string }) => {
      progress?.({ uploadId: "other", sent: 9, total: 9 });
      progress?.({ uploadId: req.uploadId, sent: 2, total: 4 });
      return { ok: true, status: 201, body: uploaded() };
    });
    (window as { stubwise?: unknown }).stubwise = {
      api: { upload },
      files: {
        register,
        cancel: vi.fn(),
        onProgress: (fn: typeof progress) => {
          progress = fn;
          return () => (progress = null);
        },
      },
    };
    const seenProgress: number[] = [];
    const file = pdf();
    const [result] = await drive.uploadFiles(PROJECT_ID, [{ name: file.name, mime: file.type, sizeBytes: file.size, file }], {
      onProgress: (loaded) => seenProgress.push(loaded),
    });
    expect(register).toHaveBeenCalledWith(file);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ grant: "g1", path: `/api/projects/${PROJECT_ID}/drive/files` }));
    expect(seenProgress).toEqual([2]);
    expect(progress).toBeNull();
    expect(result).toEqual({ name: "Contratto.pdf", file: expect.objectContaining({ id: FILE_ID, name: "Contratto (2).pdf" }), error: null });
  });

  it("sul desktop: troppo grande, archiviazione spenta, annullato, rifiutato", async () => {
    const upload = vi.fn();
    const register = vi.fn();
    (window as { stubwise?: unknown }).stubwise = { api: { upload }, files: { register, cancel: vi.fn(), onProgress: () => () => undefined } };
    const file = pdf();
    const input = [{ name: file.name, mime: file.type, sizeBytes: file.size, file }];
    register.mockResolvedValue({ ok: false, reason: "too_large" });
    expect(await drive.uploadFiles(PROJECT_ID, input)).toEqual([{ name: "Contratto.pdf", file: null, error: "too_large" }]);
    register.mockResolvedValue({ ok: true, grant: "g", name: "Contratto.pdf", sizeBytes: 4 });
    upload.mockResolvedValueOnce({ ok: false, reason: "too_large", status: 413 });
    expect(await drive.uploadFiles(PROJECT_ID, input)).toEqual([{ name: "Contratto.pdf", file: null, error: "too_large" }]);
    upload.mockResolvedValueOnce({ ok: false, reason: "invalid", status: 400, code: "storage_not_configured" });
    await expect(drive.uploadFiles(PROJECT_ID, input)).rejects.toThrow("invalid: storage_off");
    upload.mockResolvedValueOnce({ ok: false, reason: "canceled" });
    await expect(drive.uploadFiles(PROJECT_ID, input)).rejects.toThrow("canceled");
    upload.mockResolvedValueOnce({ ok: false, reason: "unsupported_type", status: 400 });
    await expect(drive.uploadFiles(PROJECT_ID, input)).rejects.toThrow("failed");
    // Un upload interrotto, un multipart con campi in più (review della fetta 2, server): «Upload failed».
    for (const code of ["upload_incomplete", "invalid_multipart"]) {
      upload.mockResolvedValueOnce({ ok: false, reason: "invalid", status: 400, code });
      await expect(drive.uploadFiles(PROJECT_ID, input), code).rejects.toThrow(/^failed$/);
    }
  });

  it("sul web: un upload interrotto o un multipart con campi in più è «failed»", async () => {
    let code = "";
    class FakeXhr {
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      responseText = "";
      withCredentials = false;
      open() {}
      send() {
        this.status = 400;
        this.responseText = JSON.stringify({ code, message: "x" });
        this.onload?.();
      }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const file = pdf();
    for (code of ["upload_incomplete", "invalid_multipart"]) {
      await expect(
        drive.uploadFiles(PROJECT_ID, [{ name: file.name, mime: file.type, sizeBytes: file.size, file }]),
        code,
      ).rejects.toThrow(/^failed$/);
    }
  });

  it("sul desktop l'annullamento ferma il caricamento nel main", async () => {
    const cancel = vi.fn(async () => true);
    let release: (v: unknown) => void = () => undefined;
    const upload = vi.fn(() => new Promise((resolve) => (release = resolve)));
    (window as { stubwise?: unknown }).stubwise = {
      api: { upload },
      files: { register: async () => ({ ok: true, grant: "g", name: "a.pdf", sizeBytes: 4 }), cancel, onProgress: () => () => undefined },
    };
    const controller = new AbortController();
    const file = pdf();
    const pending = drive.uploadFiles(PROJECT_ID, [{ name: file.name, mime: file.type, sizeBytes: file.size, file }], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    controller.abort();
    const uploadId = (upload.mock.calls[0] as unknown as [{ uploadId: string }])[0].uploadId;
    expect(cancel).toHaveBeenCalledWith(uploadId);
    release({ ok: false, reason: "canceled" });
    await expect(pending).rejects.toThrow("canceled");
  });

  it("sul desktop un annullamento mentre il main apre il file: niente caricamento, «canceled»", async () => {
    const upload = vi.fn(async () => ({ ok: true, status: 201, body: {} }));
    let opened: (v: unknown) => void = () => undefined;
    const register = vi.fn(() => new Promise((resolve) => (opened = resolve)));
    (window as { stubwise?: unknown }).stubwise = {
      api: { upload },
      files: { register, cancel: vi.fn(async () => false), onProgress: () => () => undefined },
    };
    const controller = new AbortController();
    const file = pdf();
    const pending = drive.uploadFiles(PROJECT_ID, [{ name: file.name, mime: file.type, sizeBytes: file.size, file }], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    controller.abort();
    opened({ ok: true, grant: "g", name: "a.pdf", sizeBytes: 4 });
    await expect(pending).rejects.toThrow("canceled");
    expect(upload).not.toHaveBeenCalled();
  });

  it("sul web: il FormData col campo `file`, col cookie, e l'avanzamento vero", async () => {
    const sent: { method: string; url: string; body: unknown; withCredentials: boolean }[] = [];
    class FakeXhr {
      upload: { onprogress: ((e: { loaded: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      responseText = "";
      withCredentials = false;
      private method = "";
      private url = "";
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      send(body: unknown) {
        sent.push({ method: this.method, url: this.url, body, withCredentials: this.withCredentials });
        this.upload.onprogress?.({ loaded: 3, lengthComputable: true });
        this.status = 201;
        this.responseText = JSON.stringify(uploaded({ keptBoth: false, file: serverRow() }));
        this.onload?.();
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const loaded: number[] = [];
    const file = pdf();
    const [result] = await drive.uploadFiles(PROJECT_ID, [{ name: file.name, mime: file.type, sizeBytes: file.size, file }], {
      onProgress: (n) => loaded.push(n),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", url: `/api/projects/${PROJECT_ID}/drive/files`, withCredentials: true });
    const part = (sent[0]!.body as FormData).get("file") as File;
    expect([part.name, part.size, part.type]).toEqual(["Contratto.pdf", 4, "application/pdf"]);
    expect(loaded).toEqual([3]);
    expect(result).toMatchObject({ name: "Contratto.pdf", file: { name: "Contratto.pdf" }, error: null });
  });

  it("oltre 100 MB non parte nulla; senza il File (un client che non lo passa) neppure", async () => {
    const { seen } = installFakeServer({});
    expect(await drive.uploadFiles(PROJECT_ID, [{ name: "big.bin", mime: "", sizeBytes: 101 * 1024 * 1024 }])).toEqual([
      { name: "big.bin", file: null, error: "too_large" },
    ]);
    await expect(drive.uploadFiles(PROJECT_ID, [{ name: "a.pdf", mime: "", sizeBytes: 1 }])).rejects.toThrow("failed");
    expect(seen).toEqual([]);
  });
});

describe("il Drive nella build app: «Save to Drive» da un allegato della Chat", () => {
  const ATT = "55555555-5555-4555-8555-555555555555";
  const input = { name: "spec.pdf", mime: "application/pdf", sizeBytes: 4 };
  const saved = { file: serverRow({ name: "spec.pdf" }), keptBoth: false, requestedName: "spec.pdf" };

  it("in un canale di progetto non manda il progetto (è il suo); in un DM sì", async () => {
    const { seen } = installFakeServer({ [`POST /api/chat/attachments/${ATT}/save-to-drive`]: { status: 201, body: saved } });
    const here = await drive.saveAttachmentToDrive(ATT, input, { projectId: PROJECT_ID, channelProject: true });
    expect(here).toEqual({ name: "spec.pdf", file: expect.objectContaining({ id: FILE_ID }), error: null });
    await drive.saveAttachmentToDrive(ATT, input, { projectId: PROJECT_ID, channelProject: false });
    expect(seen.map((r) => r.body)).toEqual([{}, { projectId: PROJECT_ID }]);
  });

  it("troppo grande è un esito; senza permesso o allegato non leggibile un errore", async () => {
    installFakeServer({
      [`POST /api/chat/attachments/${ATT}/save-to-drive`]: { status: 413, body: { code: "file_too_large", message: "x" } },
    });
    expect(await drive.saveAttachmentToDrive(ATT, input, { projectId: PROJECT_ID, channelProject: true })).toEqual({
      name: "spec.pdf",
      file: null,
      error: "too_large",
    });
    installFakeServer({
      [`POST /api/chat/attachments/${ATT}/save-to-drive`]: { status: 403, body: { code: "forbidden", message: "x" } },
    });
    await expect(drive.saveAttachmentToDrive(ATT, input, { projectId: PROJECT_ID, channelProject: true })).rejects.toThrow("forbidden");
  });
});

describe("il Drive nella build app: al più 3 caricamenti alla volta per finestra", () => {
  it("il quarto aspetta che uno finisca; uno annullato in coda non parte nemmeno", async () => {
    const releases: ((v: unknown) => void)[] = [];
    const upload = vi.fn(() => new Promise((resolve) => releases.push(resolve)));
    const register = vi.fn(async () => ({ ok: true, grant: "g", name: "a.pdf", sizeBytes: 4 }));
    (window as { stubwise?: unknown }).stubwise = { api: { upload }, files: { register, cancel: vi.fn(), onProgress: () => () => undefined } };
    const one = () => {
      const file = new File(["abcd"], "a.pdf", { type: "application/pdf" });
      return [{ name: file.name, mime: file.type, sizeBytes: file.size, file }];
    };
    const ok = { ok: true, status: 201, body: { file: serverRow(), keptBoth: false, requestedName: "a.pdf" } };
    const running = [1, 2, 3, 4].map(() => drive.uploadFiles(PROJECT_ID, one()));
    const queued = new AbortController();
    const fifth = drive.uploadFiles(PROJECT_ID, one(), { signal: queued.signal });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(register).toHaveBeenCalledTimes(3);
    queued.abort();
    await expect(fifth).rejects.toThrow("canceled");
    releases[0]!(ok);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    releases.slice(1).forEach((r) => r(ok));
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases[3]!(ok);
    await Promise.all(running);
    expect(register).toHaveBeenCalledTimes(4);
    // Nessun posto è rimasto preso (nemmeno da quello annullato in coda): ne ripartono 3.
    const again = [1, 2, 3].map(() => drive.uploadFiles(PROJECT_ID, one()));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(7));
    releases.slice(4).forEach((r) => r(ok));
    await Promise.all(again);
  });
});
