import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { driveContentJobs, driveFileChunks, driveFiles, driveOpens, projects, storageOrphans } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import { DriveError, openDriveFile, purgeDeletedDriveObjects, uploadDriveFile } from "../drive/service.js";
import type { ObjectStorage } from "../storage/index.js";
import { purgeStorageOrphans } from "../storage/orphans.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Il Drive dei file caricati (area 5, fetta 2): chi vede (i membri), chi
// carica (`drive.upload`), chi toglie (il proprio, o `drive.manage`), le
// aperture (30 minuti, la storia con `drive.history`), lo streaming verso lo
// storage, l'anteprima inline solo per i tipi sicuri e da un'altra origine.

function fakeStorage(origin = "https://bucket.example") {
  const objects = new Map<string, Buffer>();
  const chunks: number[] = [];
  return {
    objects,
    chunks,
    origin,
    putObject: vi.fn(async (key: string, body: Buffer) => void objects.set(key, body)),
    putObjectStream: vi.fn(async (key: string, body: Readable) => {
      const parts: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push((chunk as Buffer).length);
        parts.push(chunk as Buffer);
      }
      objects.set(key, Buffer.concat(parts));
    }),
    copyObject: vi.fn(async (from: string, to: string) => void objects.set(to, objects.get(from) ?? Buffer.alloc(0))),
    getSignedDownloadUrl: vi.fn(async (key: string, filename: string, _ttl?: number, opts?: { inlineContentType?: string }) =>
      `https://bucket.example/${key}?filename=${encodeURIComponent(filename)}${opts?.inlineContentType ? `&inline=${encodeURIComponent(opts.inlineContentType)}` : ""}`,
    ),
    // Area 6, F3: non serve a questi test; chiamarlo è un errore.
    getObjectBytes: async () => {
      throw new Error("getObjectBytes non previsto in questo test");
    },
    deleteObject: vi.fn(async (key: string) => void objects.delete(key)),
  };
}

const fakeEmbeddings = createFakeEmbeddingClient();
let embedder: { embed: (inputs: string[]) => Promise<number[][]> } = fakeEmbeddings;
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let projectCode: string;
let storage: ReturnType<typeof fakeStorage>;
let active: ObjectStorage | null;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let viewer: U;
let outsider: U;
let adminCookie: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({
    db: t.db,
    sessionSecret: "x".repeat(40),
    publicUrl: "https://stubwise.example",
    encryptionKey: randomBytes(32).toString("base64"),
    storageFactory: async () => active,
    embeddingClient: { embed: (inputs: string[]) => embedder.embed(inputs) },
  });
  ({ adminCookie } = await seedUsers(app));
  ({ projectId } = await seedRepository(t.db));
  projectCode = (await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)))[0]!.code;
  lead = await createUserWithSession(app, "lead-dr@example.com");
  dev = await createUserWithSession(app, "dev-dr@example.com");
  viewer = await createUserWithSession(app, "viewer-dr@example.com");
  outsider = await createUserWithSession(app, "outsider-dr@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, viewer.id, "viewer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

beforeEach(() => {
  storage = fakeStorage();
  active = storage;
});

const as = (u: U, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const BOUNDARY = "----stubwisedriveboundary";
function upload(u: U, project: string, file: { filename: string; contentType: string; content?: Buffer }, opts: { chunked?: boolean } = {}) {
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
    file.content ?? Buffer.from("contenuto del file"),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  // A pezzi da 64 KB, come arriva dalla rete: `inject` con un Buffer lo darebbe in un pezzo solo.
  const CHUNK = 64 * 1024;
  const payload = opts.chunked
    ? Readable.from(Array.from({ length: Math.ceil(body.length / CHUNK) }, (_, i) => body.subarray(i * CHUNK, (i + 1) * CHUNK)))
    : body;
  return app.inject({
    method: "POST",
    url: `/api/projects/${project}/drive/files`,
    headers: { cookie: u.headers.cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
}
type Row = { id: string; code: string; name: string; type: string; opens90d: number; permissions: { delete: boolean } };
type Upload = { file: Row; keptBoth: boolean; requestedName: string };
const list = async (u: U, query = "") => ((await as(u, "GET", `/api/projects/${projectId}/drive/files${query}`)).json() as { items: Row[] }).items;

describe("caricare", () => {
  it("chi ha drive.upload carica: 201, codice F, chiave del Drive, in STREAMING verso lo storage", async () => {
    const content = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await upload(dev, projectId, { filename: "Contratto.pdf", contentType: "application/pdf", content }, { chunked: true });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as Upload;
    expect(body).toMatchObject({ keptBoth: false, requestedName: "Contratto.pdf", file: { name: "Contratto.pdf", type: "pdf" } });
    expect(body.file.code).toMatch(new RegExp(`^${projectCode}-F\\d+$`));
    const [row] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, body.file.id));
    expect(row!.storageKey!.startsWith(`drive/${projectId}/`)).toBe(true);
    expect(row!.sizeBytes).toBe(content.length);
    // Lo storage ha ricevuto uno stream a pezzi, non un buffer intero.
    expect(storage.putObjectStream).toHaveBeenCalledTimes(1);
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(storage.chunks.length).toBeGreaterThan(1);
    expect(storage.objects.get(row!.storageKey!)!.length).toBe(content.length);
  });

  it("un file di 100 MB non sta mai tutto in memoria: la memoria dei buffer cresce di poco, non del file", async () => {
    // Lo storage conta i byte e li butta: quello che resta in memoria è solo del server.
    let received = 0;
    storage.putObjectStream.mockImplementation(async (_key: string, body: Readable) => {
      for await (const chunk of body) received += (chunk as Buffer).length;
    });
    // Il corpo multipart si prepara PRIMA della misura: è del client, non del server.
    const size = 100 * 1024 * 1024 - 1024;
    const body = Buffer.alloc(size + 512, 3);
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="grande.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
    head.copy(body, 0);
    tail.copy(body, head.length + size);
    const total = head.length + size + tail.length;
    const CHUNK = 64 * 1024;
    const pieces = Array.from({ length: Math.ceil(total / CHUNK) }, (_, i) => body.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, total)));
    const base = process.memoryUsage().arrayBuffers;
    let peak = base;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 5);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/drive/files`,
        headers: { cookie: dev.headers.cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        payload: Readable.from(pieces),
      });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    expect(received).toBe(size);
    console.log(`[drive] memoria dei buffer durante 100 MB: +${((peak - base) / 1024 / 1024).toFixed(1)} MB`);
    expect(peak - base).toBeLessThan(40 * 1024 * 1024);
  }, 120_000);

  it("un nome già usato fra i vivi: « (2)», « (3)», e la risposta lo dice", async () => {
    const a = (await upload(dev, projectId, { filename: "Piano.pdf", contentType: "application/pdf" })).json() as Upload;
    const b = (await upload(lead, projectId, { filename: "piano.pdf", contentType: "application/pdf" })).json() as Upload;
    const c = (await upload(dev, projectId, { filename: "Piano.pdf", contentType: "application/pdf" })).json() as Upload;
    expect(a.keptBoth).toBe(false);
    expect(b).toMatchObject({ keptBoth: true, requestedName: "piano.pdf", file: { name: "piano (2).pdf" } });
    expect(c).toMatchObject({ keptBoth: true, file: { name: "Piano (3).pdf" } });
  });

  it("oltre 100 MB: 413, nessuna riga e nessun oggetto rimasto", async () => {
    const before = await t.db.select({ id: driveFiles.id }).from(driveFiles);
    const res = await upload(dev, projectId, { filename: "enorme.zip", contentType: "application/zip", content: Buffer.alloc(100 * 1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "file_too_large" });
    expect(await t.db.select({ id: driveFiles.id }).from(driveFiles)).toHaveLength(before.length);
    expect([...storage.objects.keys()].filter((k) => k.includes("enorme"))).toEqual([]);
  }, 120_000);

  it("il servizio conta i byte da sé: uno stream oltre 100 MB senza il limite di busboy si ferma, 413, e l'oggetto si toglie", async () => {
    const MB = Buffer.alloc(1024 * 1024, 1);
    const stream = Readable.from((function* () {
      for (let i = 0; i < 101; i++) yield MB;
    })());
    const err = await uploadDriveFile(t.db, storage as unknown as ObjectStorage, { id: dev.id, instancePermissions: [] } as never, projectId, {
      filename: "senza-limite.zip",
      mime: "application/zip",
      stream,
      truncated: () => false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err).toMatchObject({ status: 413, code: "file_too_large" });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect([...storage.objects.keys()].filter((k) => k.includes("senza-limite"))).toEqual([]);
    // Fermato A METÀ: lo storage non ha ricevuto i 101 MB, solo fino al tetto.
    expect(storage.chunks.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100 * 1024 * 1024);
  }, 60_000);

  it("tipi della Chat: un eseguibile no; chi non ha drive.upload no; chi non è membro 404", async () => {
    expect((await upload(dev, projectId, { filename: "setup.exe", contentType: "application/x-msdownload" })).json()).toMatchObject({ code: "unsupported_type" });
    expect((await upload(viewer, projectId, { filename: "a.pdf", contentType: "application/pdf" })).statusCode).toBe(403);
    expect((await upload(outsider, projectId, { filename: "a.pdf", contentType: "application/pdf" })).statusCode).toBe(404);
    expect(storage.putObjectStream).not.toHaveBeenCalled();
    active = null;
    expect((await upload(dev, projectId, { filename: "a.pdf", contentType: "application/pdf" })).json()).toMatchObject({ code: "storage_not_configured" });
  });
});

describe("vedere e aprire", () => {
  it("i membri vedono (il Viewer compreso), gli altri ricevono 404 ovunque", async () => {
    const f = (await upload(dev, projectId, { filename: "visibile.pdf", contentType: "application/pdf" })).json() as Upload;
    expect((await list(viewer)).map((r) => r.id)).toContain(f.file.id);
    expect((await as(outsider, "GET", `/api/projects/${projectId}/drive/files`)).statusCode).toBe(404);
    for (const url of [`/api/drive/files/${f.file.id}`, `/api/drive/files/${f.file.id}/download`, `/api/drive/codes/${f.file.code}`]) {
      expect((await as(outsider, "GET", url)).statusCode, url).toBe(404);
    }
    const global = ((await as(outsider, "GET", "/api/drive/files")).json() as { items: Row[] }).items;
    expect(global.map((r) => r.id)).not.toContain(f.file.id);
    expect((await as(viewer, "GET", `/api/drive/codes/${f.file.code}`)).json()).toMatchObject({ fileId: f.file.id, projectId });
  });

  it("un full admin è membro implicito di ogni progetto (permissions.md): vede, apre, risolve il codice, carica e toglie, senza essere fra i membri", async () => {
    const f = (await upload(dev, projectId, { filename: "per-admin.pdf", contentType: "application/pdf" })).json() as Upload;
    const asAdmin = (method: "GET" | "DELETE", url: string) => app.inject({ method, url, headers: { cookie: adminCookie } });
    const items = ((await asAdmin("GET", `/api/projects/${projectId}/drive/files`)).json() as { items: Row[] }).items;
    expect(items.find((r) => r.id === f.file.id)!.permissions.delete).toBe(true);
    expect(((await asAdmin("GET", "/api/drive/files")).json() as { items: Row[] }).items.map((r) => r.id)).toContain(f.file.id);
    const detail = await asAdmin("GET", `/api/drive/files/${f.file.id}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { history: unknown }).history).not.toBeNull();
    expect((await asAdmin("GET", `/api/drive/files/${f.file.id}/download`)).statusCode).toBe(302);
    expect((await asAdmin("GET", `/api/drive/codes/${f.file.code}`)).statusCode).toBe(200);
    const up = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/drive/files`,
      headers: { cookie: adminCookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="admin.pdf"\r\nContent-Type: application/pdf\r\n\r\nx\r\n--${BOUNDARY}--\r\n`),
    });
    expect(up.statusCode, up.body).toBe(201);
    expect((await asAdmin("DELETE", `/api/drive/files/${f.file.id}`)).statusCode).toBe(204);
  });

  it("le aperture: una per persona ogni 30 minuti; «Più usati» le conta; la storia solo con drive.history", async () => {
    const a = (await upload(dev, projectId, { filename: "letto.pdf", contentType: "application/pdf" })).json() as Upload;
    const b = (await upload(dev, projectId, { filename: "ignorato.pdf", contentType: "application/pdf" })).json() as Upload;
    expect((await as(dev, "GET", `/api/drive/files/${a.file.id}/download`)).statusCode).toBe(302);
    await as(dev, "GET", `/api/drive/files/${a.file.id}/download`);
    await as(viewer, "GET", `/api/drive/files/${a.file.id}/preview`);
    const rows = await list(dev);
    expect(rows.find((r) => r.id === a.file.id)!.opens90d).toBe(2);
    expect(rows.find((r) => r.id === b.file.id)!.opens90d).toBe(0);
    expect(rows.findIndex((r) => r.id === a.file.id)).toBeLessThan(rows.findIndex((r) => r.id === b.file.id));
    const forLead = (await as(lead, "GET", `/api/drive/files/${a.file.id}`)).json() as { opensTotal: number; history: { personId: string }[] | null };
    expect(forLead.opensTotal).toBe(2);
    expect(forLead.history!.map((h) => h.personId).sort()).toEqual([dev.id, viewer.id].sort());
    expect(((await as(dev, "GET", `/api/drive/files/${a.file.id}`)).json() as { history: unknown }).history).toBeNull();
  });

  it("l'anteprima è inline solo per un tipo sicuro e da un'altra origine; il resto attachment", async () => {
    const pdf = (await upload(dev, projectId, { filename: "vedi.pdf", contentType: "application/pdf" })).json() as Upload;
    const zip = (await upload(dev, projectId, { filename: "pacco.zip", contentType: "application/zip" })).json() as Upload;
    const txt = (await upload(dev, projectId, { filename: "nota.md", contentType: "text/markdown" })).json() as Upload;
    expect((await as(dev, "GET", `/api/drive/files/${pdf.file.id}/preview`)).headers.location).toContain("inline=application%2Fpdf");
    expect((await as(dev, "GET", `/api/drive/files/${txt.file.id}/preview`)).headers.location).toContain(`inline=${encodeURIComponent("text/plain; charset=utf-8")}`);
    expect((await as(dev, "GET", `/api/drive/files/${zip.file.id}/preview`)).headers.location).not.toContain("inline=");
    // Lo storage servito dallo stesso host dell'istanza: mai inline.
    active = fakeStorage("https://stubwise.example");
    expect((await as(dev, "GET", `/api/drive/files/${pdf.file.id}/preview`)).headers.location).not.toContain("inline=");
  });
});

describe("eliminare", () => {
  it("il proprio sì, quello di un altro solo con drive.manage; la lapide sparisce da tutto e il numero non si riusa", async () => {
    const mine = (await upload(dev, projectId, { filename: "mio.pdf", contentType: "application/pdf" })).json() as Upload;
    const leads = (await upload(lead, projectId, { filename: "del-lead.pdf", contentType: "application/pdf" })).json() as Upload;
    expect((await list(dev)).find((r) => r.id === leads.file.id)!.permissions.delete).toBe(false);
    expect((await as(dev, "DELETE", `/api/drive/files/${leads.file.id}`)).statusCode).toBe(403);
    expect((await as(dev, "DELETE", `/api/drive/files/${mine.file.id}`)).statusCode).toBe(204);
    expect((await as(lead, "DELETE", `/api/drive/files/${leads.file.id}`)).statusCode).toBe(204);
    expect((await as(dev, "GET", `/api/drive/files/${mine.file.id}`)).statusCode).toBe(404);
    expect((await as(dev, "GET", `/api/drive/codes/${mine.file.code}`)).statusCode).toBe(404);
    expect((await list(dev)).map((r) => r.id)).not.toContain(mine.file.id);
    const [row] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, mine.file.id));
    expect(row).toMatchObject({ storagePurged: true });
    expect(storage.objects.has(row!.storageKey!)).toBe(false);
    const again = (await upload(dev, projectId, { filename: "mio.pdf", contentType: "application/pdf" })).json() as Upload;
    expect(Number(again.file.code.split("-F")[1])).toBeGreaterThan(Number(mine.file.code.split("-F")[1]));
  });

  it("con lo storage giù la lapide si scrive comunque; l'oggetto lo ritenta la pulizia, che salta senza storage", async () => {
    const f = (await upload(dev, projectId, { filename: "resta.pdf", contentType: "application/pdf" })).json() as Upload;
    const [row] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, f.file.id));
    storage.deleteObject.mockRejectedValueOnce(new Error("storage giù"));
    expect((await as(dev, "DELETE", `/api/drive/files/${f.file.id}`)).statusCode).toBe(204);
    expect((await as(dev, "GET", `/api/drive/files/${f.file.id}`)).statusCode).toBe(404);
    const purged = async () => (await t.db.select().from(driveFiles).where(eq(driveFiles.id, f.file.id)))[0]!.storagePurged;
    expect(await purged()).toBe(false);
    await purgeDeletedDriveObjects(t.db, null, () => undefined);
    expect(await purged()).toBe(false);
    await purgeDeletedDriveObjects(t.db, storage, () => undefined);
    expect(await purged()).toBe(true);
    expect(storage.objects.has(row!.storageKey!)).toBe(false);
  });
});

describe("review della fetta 2", () => {
  const asDev = () => ({ id: dev.id, instancePermissions: new Set() }) as never;
  const direct = (filename: string, stream: Readable, truncated = () => false) =>
    uploadDriveFile(t.db, storage as unknown as ObjectStorage, asDev(), projectId, { filename, mime: "application/pdf", stream, truncated });

  it("un client che si stacca a metà (destroy SENZA errore): il servizio risponde, niente handler appeso, e l'oggetto parziale si toglie", async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(64 * 1024, 1));
    setTimeout(() => source.destroy(), 20);
    const outcome = await Promise.race([
      direct("staccato.pdf", source).then(
        () => "caricato",
        (e: unknown) => e,
      ),
      new Promise((r) => setTimeout(() => r("appeso"), 3000)),
    ]);
    expect(outcome).toBeInstanceOf(DriveError);
    expect(outcome).toMatchObject({ status: 400, code: "upload_incomplete" });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(driveFiles).where(eq(driveFiles.name, "staccato.pdf"))).toEqual([]);
  }, 10_000);

  it("il multipart vuole UN file e nessun campo: un campo in più è 400 `invalid_multipart`, e lo storage non si tocca", async () => {
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nvalore\r\n`),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="campi.pdf"\r\nContent-Type: application/pdf\r\n\r\nx\r\n--${BOUNDARY}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/drive/files`,
      headers: { cookie: dev.headers.cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_multipart" });
    expect(storage.putObjectStream).not.toHaveBeenCalled();
  });

  it("un oggetto parziale che lo storage non toglie non si perde: resta da ritentare, e la pulizia lo toglie", async () => {
    storage.deleteObject.mockRejectedValueOnce(new Error("storage giù"));
    const err = await direct("orfano.pdf", Readable.from([Buffer.from("x")]), () => true).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413 });
    const orphans = await t.db.select().from(storageOrphans);
    const mine = orphans.filter((o) => o.storageKey.endsWith("/orfano.pdf"));
    expect(mine).toHaveLength(1);
    expect(storage.objects.has(mine[0]!.storageKey)).toBe(true);
    await purgeStorageOrphans(t.db, storage, () => undefined);
    expect(storage.objects.has(mine[0]!.storageKey)).toBe(false);
    expect((await t.db.select().from(storageOrphans)).filter((o) => o.storageKey === mine[0]!.storageKey)).toEqual([]);
  });

  it("i nomi: via i caratteri di controllo (NUL compreso) e i bidi; « (2)» resta entro 255", async () => {
    const one = (name: string) => direct(name, Readable.from([Buffer.from("x")]));
    expect((await one("a\u0000b\u0007c.pdf")).file.name).toBe("abc.pdf");
    expect((await one("fattura\u202Efdp\u2066\u2069.pdf")).file.name).toBe("fatturafdp.pdf");
    const long = `${"n".repeat(251)}.pdf`;
    expect(long).toHaveLength(255);
    await one(long);
    const second = await one(long);
    expect(second.keptBoth).toBe(true);
    expect(second.file.name.length).toBeLessThanOrEqual(255);
    expect(second.file.name.endsWith(" (2).pdf")).toBe(true);
  });

  it("le aperture in concorrenza: venti aperture INSIEME della stessa persona contano una", async () => {
    const f = (await upload(dev, projectId, { filename: "conteso.pdf", contentType: "application/pdf" })).json() as Upload;
    await Promise.all(Array.from({ length: 20 }, () => openDriveFile(t.db, asDev(), f.file.id, "download")));
    expect(await t.db.select().from(driveOpens).where(eq(driveOpens.fileId, f.file.id))).toHaveLength(1);
  });

  it("la pulizia prende le lapidi dalla più VECCHIA", async () => {
    const a = (await upload(dev, projectId, { filename: "vecchia-a.pdf", contentType: "application/pdf" })).json() as Upload;
    const b = (await upload(dev, projectId, { filename: "vecchia-b.pdf", contentType: "application/pdf" })).json() as Upload;
    storage.deleteObject.mockRejectedValueOnce(new Error("giù")).mockRejectedValueOnce(new Error("giù"));
    await as(dev, "DELETE", `/api/drive/files/${a.file.id}`);
    await as(dev, "DELETE", `/api/drive/files/${b.file.id}`);
    await t.db.update(driveFiles).set({ deletedAt: new Date("2000-01-01T00:00:00Z") }).where(eq(driveFiles.id, a.file.id));
    await t.db.update(driveFiles).set({ deletedAt: new Date("1999-01-01T00:00:00Z") }).where(eq(driveFiles.id, b.file.id));
    await purgeDeletedDriveObjects(t.db, storage, () => undefined, 1);
    const purged = async (id: string) => (await t.db.select().from(driveFiles).where(eq(driveFiles.id, id)))[0]!.storagePurged;
    expect(await purged(b.file.id)).toBe(true);
    expect(await purged(a.file.id)).toBe(false);
    await purgeDeletedDriveObjects(t.db, storage, () => undefined);
  });
});

describe("il contenuto (fetta 3, F3.1)", () => {
  const jobsOf = (fileId: string) => t.db.select().from(driveContentJobs).where(eq(driveContentJobs.fileId, fileId));

  it("un caricamento accoda il job del contenuto con la riga; un tipo senza estrazione nasce `unsupported`, senza job", async () => {
    const pdf = (await upload(dev, projectId, { filename: "da-leggere.pdf", contentType: "application/pdf" })).json() as Upload & { file: { contentStatus: string } };
    expect(pdf.file.contentStatus).toBe("pending");
    expect(await jobsOf(pdf.file.id)).toMatchObject([{ status: "queued", attempts: 0 }]);
    const zip = (await upload(dev, projectId, { filename: "pacco-f3.zip", contentType: "application/zip" })).json() as Upload & { file: { contentStatus: string } };
    expect(zip.file.contentStatus).toBe("unsupported");
    expect(await jobsOf(zip.file.id)).toEqual([]);
    const old = (await upload(dev, projectId, { filename: "vecchio.doc", contentType: "application/msword" })).json() as Upload & { file: { contentStatus: string } };
    expect(old.file.contentStatus).toBe("unsupported");
  });

  it("la riga porta stato, motivo, OCR e la prima frase del riassunto; il testo non esce dall'elenco", async () => {
    const f = (await upload(dev, projectId, { filename: "riassunto.pdf", contentType: "application/pdf" })).json() as Upload;
    await t.db
      .update(driveFiles)
      .set({ contentStatus: "ready", contentOcr: "partial", contentText: "TESTO SEGRETO DEL FILE", summary: "Un contratto di fornitura. Scade a marzo." })
      .where(eq(driveFiles.id, f.file.id));
    const res = await as(dev, "GET", `/api/projects/${projectId}/drive/files`);
    const row = (res.json() as { items: Record<string, unknown>[] }).items.find((r) => r.id === f.file.id)!;
    expect(row).toMatchObject({ contentStatus: "ready", contentReason: null, contentOcr: "partial", summaryLine: "Un contratto di fornitura." });
    expect(row).not.toHaveProperty("summary");
    expect(res.body).not.toContain("TESTO SEGRETO");
    expect(((await as(dev, "GET", `/api/drive/files/${f.file.id}`)).json() as { summary: string }).summary).toBe("Un contratto di fornitura. Scade a marzo.");
    await t.db.update(driveFiles).set({ contentStatus: "no_text", contentReason: "ocr_timeout", contentOcr: "none", contentText: null, summary: null }).where(eq(driveFiles.id, f.file.id));
    expect(((await as(dev, "GET", `/api/drive/files/${f.file.id}`)).json() as Record<string, unknown>)).toMatchObject({ contentStatus: "no_text", contentReason: "ocr_timeout", summaryLine: null });
  });

  it("la lapide porta via testo, riassunto e chunk, nella stessa transazione", async () => {
    const f = (await upload(dev, projectId, { filename: "via-tutto.pdf", contentType: "application/pdf" })).json() as Upload;
    await t.db.update(driveFiles).set({ contentStatus: "ready", contentOcr: "none", contentText: "riservato", summary: "Riservato." }).where(eq(driveFiles.id, f.file.id));
    await t.db.insert(driveFileChunks).values({ fileId: f.file.id, position: 0, content: "riservato", embedding: Array.from({ length: 1024 }, () => 0.1) });
    expect((await as(dev, "DELETE", `/api/drive/files/${f.file.id}`)).statusCode).toBe(204);
    const [row] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, f.file.id));
    expect(row).toMatchObject({ contentText: null, summary: null });
    expect(row!.deletedAt).not.toBeNull();
    expect(await t.db.select().from(driveFileChunks).where(eq(driveFileChunks.fileId, f.file.id))).toEqual([]);
  });
});

describe("ricerca per contenuto e «Riprova» (fetta 3, F3.4)", () => {
  type SearchRow = Row & { snippet: string | null; contentStatus: string; permissions: { delete: boolean; retry: boolean } };
  const search = async (u: U, q: string, scope: "project" | "global" = "global") => {
    const url = scope === "project" ? `/api/projects/${projectId}/drive/files?q=${encodeURIComponent(q)}` : `/api/drive/files?q=${encodeURIComponent(q)}`;
    const res = await as(u, "GET", url);
    return { status: res.statusCode, items: res.statusCode === 200 ? (res.json() as { items: SearchRow[] }).items : [] };
  };
  async function withText(filename: string, text: string, by: U = dev) {
    const res = await upload(by, projectId, { filename, contentType: "application/pdf" });
    expect(res.statusCode, res.body).toBe(201);
    const f = res.json() as Upload;
    await t.db.update(driveFiles).set({ contentStatus: "ready", contentOcr: "none", contentText: text }).where(eq(driveFiles.id, f.file.id));
    return f.file;
  }

  it("trova per contenuto, col passaggio in testo puro (niente marcatori, al più 300 caratteri); per nome lo snippet è null", async () => {
    const lungo = `${"premessa ".repeat(200)}La penale contrattuale scatta dopo trenta giorni di ritardo. ${"coda ".repeat(200)}`;
    const f = await withText("fornitura-2026.pdf", lungo);
    const byContent = (await search(dev, "penale contrattuale")).items.find((r) => r.id === f.id)!;
    expect(byContent).toBeDefined();
    expect(byContent.snippet).toContain("penale");
    expect(byContent.snippet!.length).toBeLessThanOrEqual(300);
    expect(byContent.snippet).not.toMatch(/<\/?b>|\*\*/);
    const byName = (await search(dev, "fornitura-2026")).items.find((r) => r.id === f.id)!;
    expect(byName.snippet).toBeNull();
    expect((await search(dev, "penale contrattuale", "project")).items.map((r) => r.id)).toContain(f.id);
  });

  it("il negativo: chi non è membro, col testo giusto, non trova niente; un file eliminato non si trova più per contenuto", async () => {
    const f = await withText("riservato-f34.pdf", "parolasegretissima del contratto");
    expect((await search(outsider, "parolasegretissima")).items).toEqual([]);
    expect((await search(outsider, "parolasegretissima", "project")).status).toBe(404);
    expect((await search(dev, "parolasegretissima")).items.map((r) => r.id)).toEqual([f.id]);
    await as(dev, "DELETE", `/api/drive/files/${f.id}`);
    expect((await search(dev, "parolasegretissima")).items).toEqual([]);
  });

  it("la corsia semantica: un passaggio vicino alla domanda trova il file anche senza la parola; con l'embedder giù resta il testo", async () => {
    const f = await withText("semantico.pdf", "nessuna parola in comune qui");
    const [vec] = await fakeEmbeddings.embed(["quanto costa il ritardo"]);
    await t.db.insert(driveFileChunks).values({ fileId: f.id, position: 0, content: "Il ritardo nella consegna costa il 2% al giorno.", embedding: vec! });
    const hit = (await search(dev, "quanto costa il ritardo")).items.find((r) => r.id === f.id)!;
    expect(hit.snippet).toBe("Il ritardo nella consegna costa il 2% al giorno.");
    embedder = { embed: async () => Promise.reject(new Error("embedder giù")) };
    try {
      const g = await withText("solo-testo.pdf", "parolaunicatesto qui");
      const r = await search(dev, "parolaunicatesto");
      expect(r.status).toBe(200);
      expect(r.items.map((x) => x.id)).toContain(g.id);
    } finally {
      embedder = fakeEmbeddings;
    }
  });

  it("«Riprova»: solo con drive.manage, solo su `no_text` o `error`; rimette il file in coda e risponde con la riga", async () => {
    // Caricato dal Lead: `dev` ha già superato i 30 caricamenti al minuto in questo file.
    const f = await withText("da-riprovare.pdf", "x", lead);
    const retry = (u: U, id: string) => as(u, "POST", `/api/drive/files/${id}/retry`);
    // `ready`: non si riprova (409), e il permesso è falso anche per il Project Lead.
    expect((await retry(lead, f.id)).json()).toMatchObject({ code: "not_retryable" });
    await t.db.update(driveFiles).set({ contentStatus: "no_text", contentReason: "ocr_timeout", contentText: null }).where(eq(driveFiles.id, f.id));
    await t.db.update(driveContentJobs).set({ status: "done" }).where(eq(driveContentJobs.fileId, f.id));
    expect(((await as(lead, "GET", `/api/drive/files/${f.id}`)).json() as SearchRow).permissions.retry).toBe(true);
    expect(((await as(dev, "GET", `/api/drive/files/${f.id}`)).json() as SearchRow).permissions.retry).toBe(false);
    expect((await retry(dev, f.id)).statusCode).toBe(403);
    expect((await retry(outsider, f.id)).statusCode).toBe(404);
    const ok = await retry(lead, f.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ id: f.id, contentStatus: "pending", contentReason: null });
    expect((await t.db.select().from(driveContentJobs).where(eq(driveContentJobs.fileId, f.id))).filter((j) => j.status === "queued")).toHaveLength(1);
    // Due «Riprova» di fila: un job vivo solo.
    await t.db.update(driveFiles).set({ contentStatus: "error", contentReason: null }).where(eq(driveFiles.id, f.id));
    expect((await retry(lead, f.id)).statusCode).toBe(200);
    expect((await t.db.select().from(driveContentJobs).where(eq(driveContentJobs.fileId, f.id))).filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("review della F3: la corsia semantica non perde il file giusto quando i chunk PIÙ vicini sono di un altro progetto (HNSW, ef_search)", async () => {
    const f = await withText("semantico-hnsw.pdf", "niente in comune", lead);
    const [q] = await fakeEmbeddings.embed(["la penale per il ritardo hnsw"]);
    const near = (scale: number, seed: number) => q!.map((v, i) => v + scale * Math.sin(i * 7.13 + seed));
    const other = { id: (await seedRepository(t.db)).projectId };
    const [foreign] = await t.db
      .insert(driveFiles)
      .values({ projectId: other!.id, number: 1, name: "altrui.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `drive/${other!.id}/x/altrui.pdf`, contentStatus: "ready", contentOcr: "none" })
      .returning({ id: driveFiles.id });
    // 300 chunk ALTRUI vicinissimi alla domanda, 3.000 lontani (perché il planner usi l'indice), e il nostro un po' più in là.
    const rows = [
      ...Array.from({ length: 300 }, (_, i) => ({ fileId: foreign!.id, position: i, content: `altrui ${i}`, embedding: near(0.01, i) })),
      ...Array.from({ length: 3000 }, (_, i) => ({ fileId: foreign!.id, position: 300 + i, content: `lontano ${i}`, embedding: Array.from({ length: 1024 }, (_, k) => Math.sin(k * (i + 3))) })),
    ];
    for (let i = 0; i < rows.length; i += 500) await t.db.insert(driveFileChunks).values(rows.slice(i, i + 500));
    await t.db.insert(driveFileChunks).values({ fileId: f.id, position: 0, content: "La penale del ritardo è del 2%.", embedding: near(0.05, 999) });
    await t.db.execute(sql`analyze drive_file_chunks`);
    // Un full admin vede TUTTI i progetti: il filtro non è selettivo e il planner scende sull'indice HNSW,
    // che restituisce al più `ef_search` chunk — tutti del file altrui, se non si alza il tetto.
    const res = await app.inject({ method: "GET", url: `/api/drive/files?q=${encodeURIComponent("la penale per il ritardo hnsw")}`, headers: { cookie: adminCookie } });
    const hit = (res.json() as { items: SearchRow[] }).items.find((r) => r.id === f.id);
    expect(hit?.snippet).toBe("La penale del ritardo è del 2%.");
  }, 120_000);

  it("review della F3: ts_headline gira solo sulle prime 30 righe restituite", async () => {
    const base = (await t.db.select({ n: sql<number>`coalesce(max(${driveFiles.number}), 0)::int` }).from(driveFiles).where(eq(driveFiles.projectId, projectId)))[0]!.n;
    await t.db.insert(driveFiles).values(
      Array.from({ length: 35 }, (_, i) => ({
        projectId,
        number: base + i + 1,
        name: `molti-${i}.pdf`,
        mime: "application/pdf",
        type: "pdf" as const,
        sizeBytes: 1,
        storageKey: `drive/${projectId}/molti/${i}.pdf`,
        addedBy: dev.id,
        contentStatus: "ready" as const,
        contentOcr: "none" as const,
        contentText: `intestazione e poi la parolamoltiplicata nel testo numero ${i}`,
      })),
    );
    const items = (await search(dev, "parolamoltiplicata", "project")).items;
    expect(items).toHaveLength(35);
    expect(items.slice(0, 30).every((r) => typeof r.snippet === "string")).toBe(true);
    expect(items.slice(30).every((r) => r.snippet === null)).toBe(true);
  });
});

