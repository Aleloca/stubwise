import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatChannels, chatMessageAttachments, chatMessages } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { pruneChatUploads } from "../chat/attachments.js";
import type { ObjectStorage } from "../storage/index.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Chat, area 4 fetta 4: gli allegati dei messaggi. Si caricano nel canale
// (in sospeso), un messaggio di chi li ha caricati li lega, si scaricano con
// un URL firmato solo da chi LEGGE il canale, se ne vanno col messaggio.

function fakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putObject: vi.fn(async (key: string, body: Buffer) => void objects.set(key, body)),
    getSignedDownloadUrl: vi.fn(async (key: string, filename: string) => `https://fake-storage.test/${key}?filename=${encodeURIComponent(filename)}`),
    deleteObject: vi.fn(async (key: string) => void objects.delete(key)),
    putObjectStream: vi.fn(async () => undefined),
    copyObject: vi.fn(async (from: string, to: string) => void objects.set(to, objects.get(from) ?? Buffer.alloc(0))),
  };
}

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let storage: ReturnType<typeof fakeStorage>;
let active: ObjectStorage | null;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let dev2: U;
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
  lead = await createUserWithSession(app, "lead-at@example.com");
  dev = await createUserWithSession(app, "dev-at@example.com");
  dev2 = await createUserWithSession(app, "dev2-at@example.com");
  outsider = await createUserWithSession(app, "outsider-at@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, dev2.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

beforeEach(() => {
  storage = fakeStorage();
  active = storage;
});

const as = (u: U, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const idOf = (res: { json: () => unknown }) => (res.json() as { id: string }).id;

const BOUNDARY = "----stubwisechatboundary";
function upload(u: U, channelId: string, file: { filename: string; contentType: string; content?: Buffer }) {
  const payload = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.content ?? Buffer.from("contenuto"),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/api/chat/channels/${channelId}/attachments`,
    headers: { cookie: u.headers.cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
}
let n = 0;
const openChannel = async (by: U, extra: Record<string, unknown> = {}) =>
  idOf(await as(by, "POST", "/api/chat/channels", { projectId, name: `allegati-${++n}`, ...extra }));
async function general(): Promise<string> {
  const [row] = await t.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
  return row!.id;
}
type Att = { id: string; filename: string; mimeType: string; sizeBytes: number; createdAt: string };
type Msg = { id: string; text: string; attachments: Att[] };

describe("caricare", () => {
  it("chi scrive nel canale carica un file in sospeso; la risposta ha l'id", async () => {
    const g = await general();
    const res = await upload(dev, g, { filename: "preventivo.pdf", contentType: "application/pdf" });
    expect(res.statusCode, res.body).toBe(201);
    const att = res.json() as Att;
    expect(att).toMatchObject({ filename: "preventivo.pdf", mimeType: "application/pdf", sizeBytes: 9 });
    const [row] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, att.id));
    expect(row).toMatchObject({ messageId: null, uploaderId: dev.id, channelId: g });
    expect(row!.storageKey.startsWith(`chat/${g}/`)).toBe(true);
    expect(storage.putObject).toHaveBeenCalledWith(row!.storageKey, expect.any(Buffer), "application/pdf");
  });

  it("tipi ed estensioni dall'elenco; oltre 25 MB no; chi non scrive no; senza storage no", async () => {
    const g = await general();
    expect((await upload(dev, g, { filename: "setup.exe", contentType: "application/x-msdownload" })).json()).toMatchObject({ code: "unsupported_type" });
    expect((await upload(dev, g, { filename: "foto.exe", contentType: "image/png" })).json()).toMatchObject({ code: "unsupported_type" });
    expect((await upload(dev, g, { filename: "demo.mov", contentType: "video/quicktime" })).statusCode).toBe(201);
    const big = await upload(dev, g, { filename: "grande.zip", contentType: "application/zip", content: Buffer.alloc(25 * 1024 * 1024 + 1) });
    expect(big.statusCode).toBe(413);
    // 12 MB passano (sopra il tetto dei ticket, sotto quello della Chat).
    expect((await upload(dev, g, { filename: "medio.zip", contentType: "application/zip", content: Buffer.alloc(12 * 1024 * 1024) })).statusCode).toBe(201);
    const ch = await openChannel(dev);
    expect((await upload(dev2, ch, { filename: "a.pdf", contentType: "application/pdf" })).statusCode).toBe(403);
    expect((await upload(outsider, ch, { filename: "a.pdf", contentType: "application/pdf" })).statusCode).toBe(404);
    active = null;
    expect((await upload(dev, g, { filename: "a.pdf", contentType: "application/pdf" })).json()).toMatchObject({ code: "storage_not_configured" });
  });

  it("un allegato in sospeso lo scarica e lo toglie solo chi l'ha caricato", async () => {
    const g = await general();
    const att = (await upload(dev, g, { filename: "bozza.txt", contentType: "text/plain" })).json() as Att;
    expect((await as(dev, "GET", `/api/chat/attachments/${att.id}/download`)).statusCode).toBe(302);
    expect((await as(lead, "GET", `/api/chat/attachments/${att.id}/download`)).statusCode).toBe(404);
    expect((await as(lead, "DELETE", `/api/chat/attachments/${att.id}`)).statusCode).toBe(404);
    expect((await as(dev, "DELETE", `/api/chat/attachments/${att.id}`)).statusCode).toBe(204);
    expect(storage.deleteObject).toHaveBeenCalled();
    expect(await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, att.id))).toHaveLength(0);
  });
});

describe("il messaggio con gli allegati", () => {
  it("anche senza testo; li vede e li scarica chi legge il canale, con un URL firmato", async () => {
    const g = await general();
    const a = (await upload(dev, g, { filename: "uno.pdf", contentType: "application/pdf" })).json() as Att;
    const b = (await upload(dev, g, { filename: "due.png", contentType: "image/png" })).json() as Att;
    const res = await as(dev, "POST", `/api/chat/channels/${g}/messages`, { attachmentIds: [b.id, a.id] });
    expect(res.statusCode, res.body).toBe(201);
    const msg = res.json() as Msg;
    expect(msg.text).toBe("");
    expect(msg.attachments.map((x) => x.filename)).toEqual(["due.png", "uno.pdf"]);
    const forLead = (await as(lead, "GET", `/api/chat/messages/${msg.id}`)).json() as Msg;
    expect(forLead.attachments.map((x) => x.id)).toEqual([b.id, a.id]);
    const down = await as(lead, "GET", `/api/chat/attachments/${a.id}/download`);
    expect(down.statusCode).toBe(302);
    expect(down.headers.location).toMatch(/^https:\/\/fake-storage\.test\/chat\//);
    expect((await as(outsider, "GET", `/api/chat/attachments/${a.id}/download`)).statusCode).toBe(404);
    // Senza testo e senza allegati no.
    expect((await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "" })).statusCode).toBe(400);
  });

  it("un privato e un DM: scarica solo chi legge (mai chi gestisce senza esserne membro)", async () => {
    const priv = await openChannel(dev, { visibility: "private" });
    const a = (await upload(dev, priv, { filename: "segreto.pdf", contentType: "application/pdf" })).json() as Att;
    await as(dev, "POST", `/api/chat/channels/${priv}/messages`, { text: "riservato", attachmentIds: [a.id] });
    expect((await as(dev, "GET", `/api/chat/attachments/${a.id}/download`)).statusCode).toBe(302);
    // Il Lead gestisce i canali del progetto ma non è membro del privato (D2).
    expect((await as(lead, "GET", `/api/chat/attachments/${a.id}/download`)).statusCode).toBe(404);
    const dm = idOf(await as(dev, "POST", "/api/chat/dm", { personIds: [dev2.id] }));
    const d = (await upload(dev, dm, { filename: "fra-noi.txt", contentType: "text/plain" })).json() as Att;
    await as(dev, "POST", `/api/chat/channels/${dm}/messages`, { text: "solo per te", attachmentIds: [d.id] });
    expect((await as(dev2, "GET", `/api/chat/attachments/${d.id}/download`)).statusCode).toBe(302);
    expect((await as(lead, "GET", `/api/chat/attachments/${d.id}/download`)).statusCode).toBe(404);
  });

  it("si legano solo i propri allegati in sospeso dello stesso canale", async () => {
    const g = await general();
    const ch = await openChannel(dev);
    const other = (await upload(dev2, g, { filename: "suo.pdf", contentType: "application/pdf" })).json() as Att;
    expect((await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "x", attachmentIds: [other.id] })).json()).toMatchObject({ code: "invalid_attachments" });
    const elsewhere = (await upload(dev, ch, { filename: "altrove.pdf", contentType: "application/pdf" })).json() as Att;
    expect((await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "x", attachmentIds: [elsewhere.id] })).json()).toMatchObject({ code: "invalid_attachments" });
    const mine = (await upload(dev, g, { filename: "mio.pdf", contentType: "application/pdf" })).json() as Att;
    expect((await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "x", attachmentIds: [mine.id] })).statusCode).toBe(201);
    // Già legato: non si lega una seconda volta.
    expect((await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "y", attachmentIds: [mine.id] })).json()).toMatchObject({ code: "invalid_attachments" });
    // Uno vecchio di più di 24 ore non si lega più.
    const old = (await upload(dev, g, { filename: "vecchio.pdf", contentType: "application/pdf" })).json() as Att;
    await t.db.update(chatMessageAttachments).set({ createdAt: sql`now() - interval '25 hours'` }).where(eq(chatMessageAttachments.id, old.id));
    expect((await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "z", attachmentIds: [old.id] })).json()).toMatchObject({ code: "invalid_attachments" });
  });

  it("modificare toglie, non aggiunge; assente = invariati; il testo vuoto solo se resta un allegato", async () => {
    const g = await general();
    const a = (await upload(dev, g, { filename: "a.pdf", contentType: "application/pdf" })).json() as Att;
    const b = (await upload(dev, g, { filename: "b.pdf", contentType: "application/pdf" })).json() as Att;
    const msg = idOf(await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "due file", attachmentIds: [a.id, b.id] }));
    const keyOf = async (id: string) => (await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, id)))[0]!.storageKey;
    const [aKey, bKey] = [await keyOf(a.id), await keyOf(b.id)];
    const same = (await as(dev, "PATCH", `/api/chat/messages/${msg}`, { text: "ancora due" })).json() as Msg;
    expect(same.attachments.map((x) => x.id)).toEqual([a.id, b.id]);
    const one = await as(dev, "PATCH", `/api/chat/messages/${msg}`, { text: "", attachmentIds: [b.id] });
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as Msg).attachments.map((x) => x.id)).toEqual([b.id]);
    await new Promise((r) => setTimeout(r, 20));
    expect(storage.deleteObject).toHaveBeenCalledWith(aKey);
    expect(storage.deleteObject).not.toHaveBeenCalledWith(bKey);
    expect((await as(lead, "GET", `/api/chat/attachments/${a.id}/download`)).statusCode).toBe(404);
    // Un id che il messaggio non ha non si aggiunge.
    const c = (await upload(dev, g, { filename: "c.pdf", contentType: "application/pdf" })).json() as Att;
    const notAdded = (await as(dev, "PATCH", `/api/chat/messages/${msg}`, { text: "", attachmentIds: [b.id, c.id] })).json() as Msg;
    expect(notAdded.attachments.map((x) => x.id)).toEqual([b.id]);
    expect((await as(dev, "PATCH", `/api/chat/messages/${msg}`, { text: "", attachmentIds: [] })).json()).toMatchObject({ code: "empty_message" });
  });

  it("eliminare il messaggio porta via gli allegati: righe, oggetti e download", async () => {
    const g = await general();
    const a = (await upload(dev, g, { filename: "via.pdf", contentType: "application/pdf" })).json() as Att;
    const msg = idOf(await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "da togliere", attachmentIds: [a.id] }));
    const [row] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, a.id));
    expect((await as(dev, "DELETE", `/api/chat/messages/${msg}`)).statusCode).toBe(204);
    expect(((await as(lead, "GET", `/api/chat/messages/${msg}`)).json() as Msg).attachments).toEqual([]);
    expect(await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, a.id))).toHaveLength(0);
    expect(storage.deleteObject).toHaveBeenCalledWith(row!.storageKey);
    expect((await as(lead, "GET", `/api/chat/attachments/${a.id}/download`)).statusCode).toBe(404);
  });
});

describe("la ricerca e la potatura", () => {
  it("«con allegati» e i nomi dei file nella ricerca", async () => {
    const g = await general();
    const a = (await upload(dev, g, { filename: "Fattura-Ottobre.pdf", contentType: "application/pdf" })).json() as Att;
    const withFile = idOf(await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "ecco la quindicina", attachmentIds: [a.id] }));
    const without = idOf(await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "e la quindicina senza file" }));
    const ids = async (q: string) =>
      ((await as(lead, "GET", `/api/chat/search?${q}`)).json() as { items: { message: { id: string } }[] }).items.map((h) => h.message.id);
    expect(await ids("q=fattura-ottobre")).toEqual([withFile]);
    const both = await ids("q=quindicina");
    expect(both).toEqual(expect.arrayContaining([withFile, without]));
    expect(await ids("q=quindicina&withAttachments=true")).toEqual([withFile]);
  });

  it("gli allegati in sospeso da più di 24 ore se ne vanno, righe e oggetti; i legati e i recenti restano", async () => {
    const g = await general();
    const old = (await upload(dev, g, { filename: "dimenticato.pdf", contentType: "application/pdf" })).json() as Att;
    const fresh = (await upload(dev, g, { filename: "nuovo.pdf", contentType: "application/pdf" })).json() as Att;
    const sent = (await upload(dev, g, { filename: "mandato.pdf", contentType: "application/pdf" })).json() as Att;
    await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "mandato", attachmentIds: [sent.id] });
    await t.db
      .update(chatMessageAttachments)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(inArray(chatMessageAttachments.id, [old.id, sent.id]));
    const [oldRow] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, old.id));
    await pruneChatUploads(t.db, storage, () => undefined);
    const left = (await t.db.select({ id: chatMessageAttachments.id }).from(chatMessageAttachments)).map((r) => r.id);
    expect(left).not.toContain(old.id);
    expect(left).toEqual(expect.arrayContaining([fresh.id, sent.id]));
    expect(storage.deleteObject).toHaveBeenCalledWith(oldRow!.storageKey);
  });
});

describe("review della fetta 4 (11 nov 2026)", () => {
  it("2. eliminare un canale porta via dallo storage gli oggetti dei suoi allegati", async () => {
    const ch = await openChannel(lead);
    const a = (await upload(lead, ch, { filename: "canale.pdf", contentType: "application/pdf" })).json() as Att;
    await as(lead, "POST", `/api/chat/channels/${ch}/messages`, { text: "x", attachmentIds: [a.id] });
    const pending = (await upload(lead, ch, { filename: "sospeso.pdf", contentType: "application/pdf" })).json() as Att;
    const keys = (await t.db.select().from(chatMessageAttachments).where(inArray(chatMessageAttachments.id, [a.id, pending.id]))).map((r) => r.storageKey);
    expect((await as(lead, "DELETE", `/api/chat/channels/${ch}`)).statusCode).toBe(204);
    for (const key of keys) expect(storage.deleteObject).toHaveBeenCalledWith(key);
  });

  it("2. eliminare un progetto porta via dallo storage gli allegati della sua Chat e dei suoi ticket", async () => {
    const { projectId: other } = await seedRepository(t.db);
    await addMember(app, other, lead.id, "project_lead");
    const [g] = await t.db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.projectId, other), eq(chatChannels.isGeneral, true)));
    const a = (await upload(lead, g!.id, { filename: "progetto.pdf", contentType: "application/pdf" })).json() as Att;
    const [row] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, a.id));
    const res = await as(lead, "DELETE", `/api/projects/${other}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(storage.deleteObject).toHaveBeenCalledWith(row!.storageKey);
  });

  it("3. l'accesso si controlla PRIMA di leggere il file: chi non scrive riceve 403 anche con un file troppo grande", async () => {
    const ch = await openChannel(dev);
    const big = await upload(dev2, ch, { filename: "grande.zip", contentType: "application/zip", content: Buffer.alloc(25 * 1024 * 1024 + 1) });
    expect(big.statusCode).toBe(403);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("3. un tetto per persona sui file in sospeso", async () => {
    const g = await general();
    const heavy = await createUserWithSession(app, "heavy-at@example.com");
    await addMember(app, projectId, heavy.id, "developer");
    await t.db.insert(chatMessageAttachments).values(
      Array.from({ length: 8 }, (_, i) => ({
        channelId: g,
        uploaderId: heavy.id,
        filename: `pieno-${i}.zip`,
        mimeType: "application/zip",
        sizeBytes: 25 * 1024 * 1024,
        storageKey: `chat/${g}/pieno-${heavy.id}-${i}`,
      })),
    );
    const res = await upload(heavy, g, { filename: "ancora.pdf", contentType: "application/pdf" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "pending_quota" });
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("3. la rotta di caricamento ha un tetto di richieste per persona", async () => {
    const g = await general();
    const busy = await createUserWithSession(app, "busy-at@example.com");
    await addMember(app, projectId, busy.id, "developer");
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await upload(busy, g, { filename: `f${i}.txt`, contentType: "text/plain" })).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 201)).toBe(true);
    expect(codes[60]).toBe(429);
  });

  it("4. la potatura: senza storage non tocca niente; un oggetto che lo storage rifiuta tiene la riga per il giro dopo", async () => {
    const g = await general();
    // Righe scritte a mano: un caricamento vero lancerebbe una potatura sua, in corsa col test.
    const [a, b] = await t.db
      .insert(chatMessageAttachments)
      .values(
        ["a", "b"].map((x) => ({
          channelId: g,
          uploaderId: dev.id,
          filename: `vecchio-${x}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 3,
          storageKey: `chat/${g}/vecchio-${x}-${crypto.randomUUID()}`,
          createdAt: sql`now() - interval '25 hours'`,
        })),
      )
      .returning({ id: chatMessageAttachments.id });
    const ids = async () => (await t.db.select({ id: chatMessageAttachments.id }).from(chatMessageAttachments).where(inArray(chatMessageAttachments.id, [a!.id, b!.id]))).map((r) => r.id);
    await pruneChatUploads(t.db, null, () => undefined);
    expect((await ids()).sort()).toEqual([a!.id, b!.id].sort());
    const [aRow] = await t.db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, a!.id));
    const failing = fakeStorage();
    failing.deleteObject.mockImplementation(async (key: string) => {
      if (key === aRow!.storageKey) throw new Error("storage giù");
    });
    await pruneChatUploads(t.db, failing, () => undefined);
    expect(await ids()).toEqual([a!.id]);
    // Al giro dopo, con lo storage tornato, se ne va anche lei.
    await pruneChatUploads(t.db, fakeStorage(), () => undefined);
    expect(await ids()).toEqual([]);
  });

  it("5. il download vuole il messaggio vivo (anche se la riga è rimasta, come sotto un server di prima)", async () => {
    const g = await general();
    const a = (await upload(dev, g, { filename: "resta.pdf", contentType: "application/pdf" })).json() as Att;
    const msg = idOf(await as(dev, "POST", `/api/chat/channels/${g}/messages`, { text: "con file", attachmentIds: [a.id] }));
    // Un server della fetta 3 elimina il messaggio senza toccare gli allegati.
    await t.db.update(chatMessages).set({ body: "", deletedAt: new Date() }).where(eq(chatMessages.id, msg));
    expect((await as(lead, "GET", `/api/chat/attachments/${a.id}/download`)).statusCode).toBe(404);
  });

  it("5. un nome di file oltre 255 caratteri: 400", async () => {
    const g = await general();
    const res = await upload(dev, g, { filename: `${"n".repeat(252)}.pdf`, contentType: "application/pdf" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_filename" });
    expect((await upload(dev, g, { filename: `${"n".repeat(251)}.pdf`, contentType: "application/pdf" })).statusCode).toBe(201);
  });
});

