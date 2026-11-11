import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatChannels, chatMessageAttachments, driveFiles } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { ObjectStorage } from "../storage/index.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Il Drive e la Chat (area 5, fetta 2, F2.4): «Save to Drive» è una COPIA
// dell'oggetto, mai un riferimento; le citazioni `drive` (il «#» e i codici F
// scritti a mano) le vede solo chi vede il file.

function fakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    origin: "https://bucket.example",
    putObject: vi.fn(async (key: string, body: Buffer) => void objects.set(key, body)),
    putObjectStream: vi.fn(async (key: string, body: AsyncIterable<Buffer>) => {
      const parts: Buffer[] = [];
      for await (const c of body) parts.push(c);
      objects.set(key, Buffer.concat(parts));
    }),
    copyObject: vi.fn(async (from: string, to: string) => {
      const src = objects.get(from);
      if (!src) throw new Error("NoSuchKey");
      objects.set(to, Buffer.from(src));
    }),
    getSignedDownloadUrl: vi.fn(async (key: string) => `https://bucket.example/${key}`),
    deleteObject: vi.fn(async (key: string) => void objects.delete(key)),
  };
}

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let otherProjectId: string;
let storage: ReturnType<typeof fakeStorage>;
let active: ObjectStorage | null;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let viewer: U;
let outsider: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({
    db: t.db,
    sessionSecret: "x".repeat(40),
    publicUrl: "https://stubwise.example",
    encryptionKey: randomBytes(32).toString("base64"),
    storageFactory: async () => active,
  });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ({ projectId: otherProjectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-dc@example.com");
  dev = await createUserWithSession(app, "dev-dc@example.com");
  viewer = await createUserWithSession(app, "viewer-dc@example.com");
  outsider = await createUserWithSession(app, "outsider-dc@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, viewer.id, "viewer");
  await addMember(app, otherProjectId, dev.id, "developer");
  await addMember(app, otherProjectId, outsider.id, "developer");
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
const idOf = (res: { json: () => unknown }) => (res.json() as { id: string }).id;

function multipart(filename: string, contentType: string, content = Buffer.from("contenuto")) {
  const BOUNDARY = "----stubwisedc";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  };
}
async function general(project: string): Promise<string> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, project), eq(chatChannels.isGeneral, true)));
  return row!.id;
}
/** Un messaggio con un allegato, nel canale: restituisce messaggio e allegato. */
async function sent(by: U, channelId: string, filename = "preventivo.pdf"): Promise<{ messageId: string; attachmentId: string }> {
  const m = multipart(filename, "application/pdf", Buffer.from(`il file ${filename}`));
  const up = await app.inject({ method: "POST", url: `/api/chat/channels/${channelId}/attachments`, headers: { cookie: by.headers.cookie, ...m.headers }, payload: m.payload });
  expect(up.statusCode, up.body).toBe(201);
  const attachmentId = idOf(up);
  const msg = await as(by, "POST", `/api/chat/channels/${channelId}/messages`, { text: "ecco", attachmentIds: [attachmentId] });
  expect(msg.statusCode, msg.body).toBe(201);
  return { messageId: idOf(msg), attachmentId };
}
async function driveUpload(by: U, project: string, filename: string): Promise<{ id: string; code: string }> {
  const m = multipart(filename, "application/pdf");
  const res = await app.inject({ method: "POST", url: `/api/projects/${project}/drive/files`, headers: { cookie: by.headers.cookie, ...m.headers }, payload: m.payload });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { file: { id: string; code: string } }).file;
}
type Upload = { file: { id: string; code: string; name: string; projectId: string }; keptBoth: boolean };
type Cite = { kind: string; id: string; label: string; code: string | null; drive: { type: string; projectCode: string; projectName: string; opens90d: number } | null };
const citationsOf = async (u: U, messageId: string) => ((await as(u, "GET", `/api/chat/messages/${messageId}`)).json() as { citations: Cite[] }).citations;

describe("«Save to Drive» dalla Chat", () => {
  it("da un canale di progetto: una COPIA con la sua chiave del Drive, nel progetto del canale", async () => {
    const g = await general(projectId);
    const { attachmentId } = await sent(dev, g);
    const res = await as(dev, "POST", `/api/chat/attachments/${attachmentId}/save-to-drive`, {});
    expect(res.statusCode, res.body).toBe(201);
    const saved = res.json() as Upload;
    expect(saved.file).toMatchObject({ name: "preventivo.pdf", projectId });
    const [att] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, attachmentId));
    const [row] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, saved.file.id));
    expect(row!.storageKey).not.toBe(att!.storageKey);
    expect(row!.storageKey.startsWith(`drive/${projectId}/`)).toBe(true);
    expect(storage.copyObject).toHaveBeenCalledWith(att!.storageKey, row!.storageKey);
    expect(row!.sizeBytes).toBe(att!.sizeBytes);
    expect(storage.objects.get(row!.storageKey)!.toString()).toBe("il file preventivo.pdf");
  });

  it("eliminare il messaggio lascia il file del Drive; eliminare il file del Drive lascia il messaggio", async () => {
    const g = await general(projectId);
    const one = await sent(dev, g, "uno.pdf");
    const saved = (await as(dev, "POST", `/api/chat/attachments/${one.attachmentId}/save-to-drive`, {})).json() as Upload;
    const [row] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, saved.file.id));
    expect((await as(dev, "DELETE", `/api/chat/messages/${one.messageId}`)).statusCode).toBe(204);
    expect(storage.objects.has(row!.storageKey)).toBe(true);
    expect((await as(dev, "GET", `/api/drive/files/${saved.file.id}/download`)).statusCode).toBe(302);

    const two = await sent(dev, g, "due.pdf");
    const [att] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, two.attachmentId));
    const saved2 = (await as(dev, "POST", `/api/chat/attachments/${two.attachmentId}/save-to-drive`, {})).json() as Upload;
    expect((await as(dev, "DELETE", `/api/drive/files/${saved2.file.id}`)).statusCode).toBe(204);
    expect(storage.objects.has(att!.storageKey)).toBe(true);
    expect((await as(dev, "GET", `/api/chat/attachments/${two.attachmentId}/download`)).statusCode).toBe(302);
  });

  it("senza drive.upload 403; un DM vuole il progetto; chi non legge il messaggio 404; un progetto diverso da quello del canale 400", async () => {
    const g = await general(projectId);
    const { attachmentId } = await sent(dev, g);
    expect((await as(viewer, "POST", `/api/chat/attachments/${attachmentId}/save-to-drive`, {})).statusCode).toBe(403);
    expect((await as(outsider, "POST", `/api/chat/attachments/${attachmentId}/save-to-drive`, {})).statusCode).toBe(404);
    expect((await as(dev, "POST", `/api/chat/attachments/${attachmentId}/save-to-drive`, { projectId: otherProjectId })).json()).toMatchObject({ code: "project_mismatch" });

    const dm = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [outsider.id] }));
    const inDm = await sent(dev, dm, "nel-dm.pdf");
    expect((await as(dev, "POST", `/api/chat/attachments/${inDm.attachmentId}/save-to-drive`, {})).json()).toMatchObject({ code: "project_required" });
    // L'altro del DM legge il messaggio, ma nel progetto non è membro: 404 come un progetto che non c'è.
    expect((await as(outsider, "POST", `/api/chat/attachments/${inDm.attachmentId}/save-to-drive`, { projectId })).statusCode).toBe(404);
    const ok = await as(dev, "POST", `/api/chat/attachments/${inDm.attachmentId}/save-to-drive`, { projectId: otherProjectId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((ok.json() as Upload).file.projectId).toBe(otherProjectId);
  });

  it("un allegato in sospeso (non ancora mandato) non si salva: si salva ciò che si legge in un messaggio", async () => {
    const g = await general(projectId);
    const m = multipart("sospeso.pdf", "application/pdf");
    const up = await app.inject({ method: "POST", url: `/api/chat/channels/${g}/attachments`, headers: { cookie: dev.headers.cookie, ...m.headers }, payload: m.payload });
    expect((await as(dev, "POST", `/api/chat/attachments/${idOf(up)}/save-to-drive`, {})).statusCode).toBe(404);
  });
});

describe("le citazioni `drive`", () => {
  it("col «#» e col codice F scritto a mano: la scheda per chi vede il file; chi non è membro non la vede", async () => {
    const picked = await driveUpload(dev, projectId, "Contratto quadro.pdf");
    const written = await driveUpload(dev, projectId, "listino.pdf");
    const dm = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [outsider.id] }));
    const res = await as(dev, "POST", `/api/chat/channels/${dm}/messages`, {
      text: `Guarda Contratto quadro.pdf e ${written.code}`,
      citations: [{ kind: "drive", id: picked.id }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const messageId = idOf(res);
    const mine = await citationsOf(dev, messageId);
    expect(mine.map((c) => c.id).sort()).toEqual([picked.id, written.id].sort());
    expect(mine.find((c) => c.id === picked.id)).toMatchObject({ kind: "drive", label: "Contratto quadro.pdf", code: picked.code, drive: { type: "pdf" } });
    // L'altro del DM legge il messaggio ma non è membro del progetto: niente scheda.
    expect(await citationsOf(outsider, messageId)).toEqual([]);
    // E il filtro «con citazioni» della ricerca: lo trova chi vede il file, non l'altro.
    const hits = async (u: U) =>
      ((await as(u, "GET", `/api/chat/search?q=${encodeURIComponent("Guarda Contratto")}&withCitations=true`)).json() as { items: { message: { id: string } }[] }).items.map(
        (h) => h.message.id,
      );
    expect(await hits(dev)).toContain(messageId);
    expect(await hits(outsider)).not.toContain(messageId);
  });

  it("un file scelto col «#» che il testo non nomina più non resta; uno eliminato sparisce dalla lettura", async () => {
    const g = await general(projectId);
    const f = await driveUpload(dev, projectId, "Bozza.pdf");
    const dropped = await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "niente nomi qui", citations: [{ kind: "drive", id: f.id }] });
    expect(await citationsOf(dev, idOf(dropped))).toEqual([]);
    const kept = await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: `vedi ${f.code}` });
    const messageId = idOf(kept);
    expect((await citationsOf(viewer, messageId)).map((c) => c.id)).toEqual([f.id]);
    expect((await as(dev, "DELETE", `/api/drive/files/${f.id}`)).statusCode).toBe(204);
    expect(await citationsOf(dev, messageId)).toEqual([]);
  });

  it("un codice F di un progetto che chi scrive non vede resta testo", async () => {
    const hidden = await driveUpload(outsider, otherProjectId, "riservato.pdf");
    const g = await general(projectId);
    const res = await as(lead, "POST", `/api/chat/channels/${g}/messages`, { text: `prova ${hidden.code}` });
    expect(await citationsOf(lead, idOf(res))).toEqual([]);
  });
});
