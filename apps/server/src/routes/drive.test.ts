import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { driveFiles, projects } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { DriveError, purgeDeletedDriveObjects, uploadDriveFile } from "../drive/service.js";
import type { ObjectStorage } from "../storage/index.js";
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
    deleteObject: vi.fn(async (key: string) => void objects.delete(key)),
  };
}

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
    expect(row!.storageKey.startsWith(`drive/${projectId}/`)).toBe(true);
    expect(row!.sizeBytes).toBe(content.length);
    // Lo storage ha ricevuto uno stream a pezzi, non un buffer intero.
    expect(storage.putObjectStream).toHaveBeenCalledTimes(1);
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(storage.chunks.length).toBeGreaterThan(1);
    expect(storage.objects.get(row!.storageKey)!.length).toBe(content.length);
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
    expect(storage.objects.has(row!.storageKey)).toBe(false);
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
    expect(storage.objects.has(row!.storageKey)).toBe(false);
  });
});
