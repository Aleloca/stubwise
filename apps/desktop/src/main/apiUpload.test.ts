// @vitest-environment node
import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent" }, safeStorage: {} }));
// I descrittori aperti dal codice sotto prova, per controllare che si chiudano
// (solo i suoi: non quelli del processo, che altro lavoro dello stesso worker sposta).
const opened = vi.hoisted(() => [] as { fd: number }[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      opened.push(handle);
      return handle;
    },
  };
});

const { createActiveUploads, createUploadTokens, formDataHeader, isAllowedUploadPath, uploadFile, DRIVE_UPLOAD_MAX_BYTES } = await import(
  "./apiUpload"
);

// Il caricamento di un file del Drive dal desktop (area 5, fetta 2): il
// renderer consegna un File scelto dall'utente; il preload ne prende il
// percorso (`webUtils.getPathForFile`) e il main lo APRE una volta sola
// (`O_NOFOLLOW`, `fstat` sul descrittore) dietro un token monouso. Poi il main
// lo manda in streaming dal descrittore, col bearer, solo alla rotta del Drive.

const PROJECT = "7f1c2a1e-0000-4000-8000-0000000000a1";
const ROUTE = `/api/projects/${PROJECT}/drive/files`;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stubwise-upload-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, content: string | number) => {
  const path = join(dir, name);
  if (typeof content === "number") {
    writeFileSync(path, "");
    truncateSync(path, content);
  } else writeFileSync(path, content);
  return path;
};

describe("la rotta", () => {
  it("solo il caricamento del Drive di un progetto, esatto", () => {
    expect(isAllowedUploadPath(ROUTE)).toBe(true);
    for (const path of [
      `/api/projects/${PROJECT}/drive/files?x=1`,
      `/api/projects/not-a-uuid/drive/files`,
      `/api/projects/${PROJECT}/drive/files/x`,
      `/api/chat/channels/${PROJECT}/attachments`,
      `https://evil.example${ROUTE}`,
      42,
    ]) {
      expect(isAllowedUploadPath(path), String(path)).toBe(false);
    }
  });
});

describe("i token dei file scelti", () => {
  it("un file vero: il token, nome e peso dal descrittore; si usa una volta sola, e solo da chi l'ha chiesto", async () => {
    const tokens = createUploadTokens();
    const r = await tokens.register(1, file("spec.pdf", "%PDF-1"), "application/pdf");
    expect(r).toMatchObject({ ok: true, name: "spec.pdf", sizeBytes: 6 });
    if (!r.ok) throw new Error("no token");
    expect(tokens.take(2, r.grant)).toBeNull();
    const entry = tokens.take(1, r.grant)!;
    expect(entry).toMatchObject({ name: "spec.pdf", size: 6, mime: "application/pdf" });
    expect(tokens.take(1, r.grant)).toBeNull();
    await entry.handle.close();
  });

  it("un collegamento simbolico, una cartella, un percorso vuoto o mancante: rifiutati prima di leggere", async () => {
    const tokens = createUploadTokens();
    const target = file("real.pdf", "x");
    const link = join(dir, "link.pdf");
    symlinkSync(target, link);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(await tokens.register(1, link, "application/pdf")).toEqual({ ok: false, reason: "invalid" });
    expect(await tokens.register(1, folder, "application/pdf")).toEqual({ ok: false, reason: "invalid" });
    expect(await tokens.register(1, "", "application/pdf")).toEqual({ ok: false, reason: "invalid" });
    expect(await tokens.register(1, join(dir, "missing.pdf"), "application/pdf")).toEqual({ ok: false, reason: "invalid" });
  });

  it.skipIf(process.platform === "win32")("una FIFO non blocca il main: rifiutata senza aspettare chi scrive", async () => {
    const fifo = join(dir, "pipe.pdf");
    execFileSync("mkfifo", [fifo]);
    const tokens = createUploadTokens();
    try {
      const out = await Promise.race([
        tokens.register(1, fifo, "application/pdf"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
      ]);
      expect(out).toEqual({ ok: false, reason: "invalid" });
    } finally {
      // Se l'apertura era rimasta appesa, uno scrittore la sblocca.
      try {
        closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
      } catch {
        /* nessuno in attesa */
      }
      await tokens.dropOwner(1);
    }
  });

  it("oltre 100 MB: «too_large», senza token", async () => {
    const tokens = createUploadTokens();
    expect(await tokens.register(1, file("big.zip", DRIVE_UPLOAD_MAX_BYTES + 1), "application/zip")).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("un tetto ai token aperti per finestra; la chiusura della finestra li chiude tutti; uno scaduto non vale", async () => {
    let now = 1_000;
    const tokens = createUploadTokens({ max: 2, ttlMs: 60_000, now: () => now });
    const a = await tokens.register(1, file("a.txt", "a"), "text/plain");
    const b = await tokens.register(1, file("b.txt", "b"), "text/plain");
    expect(await tokens.register(1, file("c.txt", "c"), "text/plain")).toEqual({ ok: false, reason: "too_many" });
    // Un'altra finestra ha il suo tetto.
    expect((await tokens.register(2, file("d.txt", "d"), "text/plain")).ok).toBe(true);
    expect(tokens.open(1)).toBe(2);
    await tokens.dropOwner(1);
    expect(tokens.open(1)).toBe(0);
    if (!a.ok || !b.ok) throw new Error("no token");
    expect(tokens.take(1, a.grant)).toBeNull();
    // Scaduto.
    const e = await tokens.register(3, file("e.txt", "e"), "text/plain");
    if (!e.ok) throw new Error("no token");
    now += 60_001;
    expect(tokens.take(3, e.grant)).toBeNull();
    await tokens.dropOwner(2);
  });

  it(
    "una pulizia periodica chiude i descrittori dei token scaduti, senza tenere vivo il processo",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        let now = 1_000;
        const tokens = createUploadTokens({ ttlMs: 60_000, now: () => now });
        const before = opened.length;
        expect((await tokens.register(1, file("a.txt", "a"), "text/plain")).ok).toBe(true);
        expect(opened).toHaveLength(before + 1);
        // Il descrittore del token: aperto finché il token vale (un FileHandle chiuso ha `fd` -1).
        const handle = opened.at(-1)!;
        expect(handle.fd).toBeGreaterThan(-1);
        const timer = tokens.startSweeper(30_000);
        expect(timer.hasRef()).toBe(false);
        vi.advanceTimersByTime(30_000);
        await new Promise((resolve) => setImmediate(resolve));
        expect(handle.fd).toBeGreaterThan(-1);
        now += 60_001;
        vi.advanceTimersByTime(30_000);
        await vi.waitFor(() => expect(handle.fd).toBe(-1));
        clearInterval(timer);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("il tipo del File si accetta solo se è un tipo MIME; altrimenti octet-stream", async () => {
    const tokens = createUploadTokens();
    const r = await tokens.register(1, file("x.bin", "x"), 'text/plain"\r\nX-Evil: 1');
    if (!r.ok) throw new Error("no token");
    expect(tokens.take(1, r.grant)!.mime).toBe("application/octet-stream");
  });
});

describe("i caricamenti in corso", () => {
  const ID = "0b6f2c1e-1111-4000-8000-000000000001";

  it("un `uploadId` mancante, non valido o già in corso: rifiutato", () => {
    const active = createActiveUploads();
    for (const id of [undefined, "", 42, "a b", "x".repeat(65), "../x"]) {
      expect(active.begin(1, id), String(id)).toEqual({ ok: false, reason: "invalid" });
    }
    const first = active.begin(1, ID);
    expect(first.ok).toBe(true);
    expect(active.begin(1, ID)).toEqual({ ok: false, reason: "invalid" });
    // Un'altra finestra ha i suoi id.
    expect(active.begin(2, ID).ok).toBe(true);
  });

  it("al più 3 attivi per finestra, gli altri «busy»; finito uno, ne parte un altro", () => {
    const active = createActiveUploads();
    const started = [1, 2, 3].map((n) => active.begin(1, `id-${n}`));
    expect(started.every((s) => s.ok)).toBe(true);
    expect(active.begin(1, "id-4")).toEqual({ ok: false, reason: "busy" });
    expect(active.begin(2, "id-4").ok).toBe(true);
    const done = started[0]!;
    if (done.ok) done.end();
    expect(active.begin(1, "id-4").ok).toBe(true);
  });

  it("«Cancel» annulla quello di chi chiede; la finestra che se ne va li annulla tutti", () => {
    const active = createActiveUploads();
    const a = active.begin(1, "a");
    const b = active.begin(1, "b");
    const other = active.begin(2, "a");
    if (!a.ok || !b.ok || !other.ok) throw new Error("not started");
    expect(active.cancel(2, "b")).toBe(false);
    expect(active.cancel(1, "a")).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    active.dropOwner(1);
    expect(b.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(active.begin(1, "c").ok).toBe(true);
  });
});

describe("l'intestazione del campo", () => {
  it("niente CR, LF né virgolette nei nomi; un nome non ASCII anche in filename*", () => {
    expect(formDataHeader("file", "spec.pdf", "application/pdf")).toBe(
      'Content-Disposition: form-data; name="file"; filename="spec.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
    );
    const evil = formDataHeader('fi"le\r\n', 'a"b\r\nX-Evil: 1.pdf', "application/pdf");
    expect(evil).not.toMatch(/\r\nX-Evil/);
    expect(evil.split("\r\n")[0]).toBe('Content-Disposition: form-data; name="file"; filename="a_b__X-Evil: 1.pdf"');
    expect(formDataHeader("file", "città.pdf", "application/pdf").split("\r\n")[0]).toBe(
      "Content-Disposition: form-data; name=\"file\"; filename=\"citt_.pdf\"; filename*=UTF-8''citt%C3%A0.pdf",
    );
  });
});

describe("il caricamento", () => {
  async function registered(name: string, content: string | number, mime = "application/pdf") {
    const tokens = createUploadTokens();
    const r = await tokens.register(1, file(name, content), mime);
    if (!r.ok) throw new Error("no token");
    return tokens.take(1, r.grant)!;
  }
  const deps = (over: Record<string, unknown> = {}) => ({
    instanceUrl: () => "https://stubwise.example.com",
    token: () => "stw_pat_x",
    onUnauthorized: vi.fn(),
    ...over,
  });
  /** Un fetch finto che legge il corpo a pezzi, come la rete. */
  const reading = (status: number, body: unknown) =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const chunks: Uint8Array[] = [];
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      (reading as unknown as { last: Buffer }).last = Buffer.concat(chunks);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });

  it("multipart esatto dal descrittore, con Content-Length giusta e il bearer, solo all'istanza", async () => {
    const entry = await registered("spec.pdf", "%PDF-1.7 hello");
    const fetchImpl = reading(201, { file: { id: "x" }, keptBoth: false, requestedName: "spec.pdf" });
    const progress: number[] = [];
    const out = await uploadFile(entry, ROUTE, { ...deps(), fetch: fetchImpl as never }, { onProgress: (sent) => progress.push(sent) });
    expect(out).toEqual({ ok: true, status: 201, body: { file: { id: "x" }, keptBoth: false, requestedName: "spec.pdf" } });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit & { duplex?: string }];
    expect(url).toBe(`https://stubwise.example.com${ROUTE}`);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer stw_pat_x");
    expect(init.redirect).toBe("manual");
    expect(init.duplex).toBe("half");
    const boundary = /boundary=(.+)$/.exec(headers.get("content-type")!)![1]!;
    const sent = (reading as unknown as { last: Buffer }).last.toString("utf8");
    expect(sent).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="spec.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7 hello\r\n--${boundary}--\r\n`,
    );
    expect(Number(headers.get("content-length"))).toBe(Buffer.byteLength(sent));
    expect(progress.at(-1)).toBe(14);
  });

  it("i rifiuti del server come esito; un 401 di sessione chiude la sessione; un reindirizzamento non si segue", async () => {
    for (const [status, code, reason] of [
      [413, "file_too_large", "too_large"],
      [400, "unsupported_type", "unsupported_type"],
      [400, "invalid_filename", "invalid"],
      [404, "not_found", "invalid"],
      [500, "boom", "failed"],
    ] as const) {
      const entry = await registered("spec.pdf", "x");
      const out = await uploadFile(entry, ROUTE, { ...deps(), fetch: reading(status, { code }) as never });
      expect(out, code).toMatchObject({ ok: false, reason, status });
    }
    // Il codice del server passa (`storage_not_configured`: il renderer dice «archiviazione spenta»).
    const off = await uploadFile(await registered("spec.pdf", "x"), ROUTE, {
      ...deps(),
      fetch: reading(400, { code: "storage_not_configured" }) as never,
    });
    expect(off).toMatchObject({ ok: false, reason: "invalid", status: 400, code: "storage_not_configured" });
    const d = deps({ fetch: reading(401, { code: "unauthorized" }) });
    expect(await uploadFile(await registered("spec.pdf", "x"), ROUTE, d as never)).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect(d.onUnauthorized).toHaveBeenCalledWith("stw_pat_x");
    const moved = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
    expect(await uploadFile(await registered("spec.pdf", "x"), ROUTE, { ...deps(), fetch: moved as never })).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("l'annullamento ferma lo stream: «canceled»", async () => {
    const entry = await registered("big.bin", 4 * 1024 * 1024, "application/zip");
    const abort = new AbortController();
    const slow = vi.fn(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      abort.abort();
      await reader.read().catch(() => undefined);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(await uploadFile(entry, ROUTE, { ...deps(), fetch: slow as never }, { signal: abort.signal })).toEqual({
      ok: false,
      reason: "canceled",
    });
  });

  it("la backpressure: con un consumatore lento il disco non corre avanti, e il progresso segue ciò che è stato consegnato", async () => {
    const entry = await registered("big.bin", 20 * 1024 * 1024, "application/zip");
    // Quanto è stato letto dal disco: lo stream del descrittore passa da `read`.
    let fromDisk = 0;
    const read = entry.handle.read.bind(entry.handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    (entry.handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
      const r = await read(...a);
      fromDisk += r.bytesRead;
      return r;
    };
    let delivered = 0;
    let paused = { fromDisk: 0, delivered: 0, progress: 0 };
    const progress: number[] = [];
    const slow = vi.fn(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      while (delivered < 1024 * 1024) delivered += (await reader.read()).value!.byteLength;
      // Il consumatore si ferma (la rete è lenta): il disco non deve continuare.
      await new Promise((resolve) => setTimeout(resolve, 200));
      paused = { fromDisk, delivered, progress: progress.at(-1) ?? 0 };
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      return new Response(JSON.stringify({ file: {}, keptBoth: false, requestedName: "big.bin" }), { status: 201 });
    });
    const out = await uploadFile(entry, ROUTE, { ...deps(), fetch: slow as never }, { onProgress: (sent) => progress.push(sent) });
    expect(out.ok).toBe(true);
    // In pausa: dal disco al più qualche pezzo oltre il consegnato; il progresso non va oltre.
    expect(paused.fromDisk).toBeLessThan(4 * 1024 * 1024);
    expect(paused.progress).toBeLessThanOrEqual(paused.delivered);
    expect(paused.progress).toBeGreaterThan(512 * 1024);
    expect(progress.at(-1)).toBe(20 * 1024 * 1024);
  });

  it("100 MB non stanno mai tutti in memoria: lo stream passa a pezzi", async () => {
    const entry = await registered("big.bin", DRIVE_UPLOAD_MAX_BYTES, "application/zip");
    let largest = 0;
    let total = 0;
    const counting = vi.fn(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        largest = Math.max(largest, value.byteLength);
        total += value.byteLength;
      }
      return new Response(JSON.stringify({ file: {}, keptBoth: false, requestedName: "big.bin" }), { status: 201 });
    });
    const before = process.memoryUsage().arrayBuffers;
    const out = await uploadFile(entry, ROUTE, { ...deps(), fetch: counting as never });
    expect(out.ok).toBe(true);
    expect(total).toBeGreaterThanOrEqual(DRIVE_UPLOAD_MAX_BYTES);
    // Pezzi piccoli (lo stream del file, 64 KiB), mai il file intero.
    expect(largest).toBeLessThanOrEqual(1024 * 1024);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(50 * 1024 * 1024);
  }, 30_000);
});
