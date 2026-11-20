import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { driveFiles, productPageImages, productPageRevisions, productPages, projects } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductBlock, ProductPageView, ProductRevisionView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { storageKeysOfProject } from "../chat/attachments.js";
import type { ObjectStorage } from "../storage/index.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F1, Task 4: la scrittura del corpo SOLO a operazioni, la cronologia,
// Segui, le immagini. Un id non si riusa mai; i riferimenti con la visibilità
// di chi salva; `stale` con le revisioni mancanti.

function fakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putObject: vi.fn(async (key: string, body: Buffer) => void objects.set(key, body)),
    putObjectStream: vi.fn(async () => undefined),
    copyObject: vi.fn(async () => undefined),
    getSignedDownloadUrl: vi.fn(async (key: string) => `https://bucket.example/${key}`),
    getObjectBytes: async () => Buffer.alloc(0),
    deleteObject: vi.fn(async (key: string) => void objects.delete(key)),
  };
}

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let storage: ReturnType<typeof fakeStorage>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let editor: U;
let other: U;
let reader: U;
let projectId: string;
let hiddenProject: string;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({
    db: t.db,
    sessionSecret: "x".repeat(40),
    encryptionKey: randomBytes(32).toString("base64"),
    storageFactory: async () => storage as unknown as ObjectStorage,
  });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ({ projectId: hiddenProject } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-ops@example.com");
  other = await createUserWithSession(app, "other-ops@example.com");
  reader = await createUserWithSession(app, "reader-ops@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, other.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});
beforeEach(() => {
  storage = fakeStorage();
});

const as = (u: U, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
async function page(): Promise<{ id: string; code: string }> {
  const res = await as(editor, "POST", `/api/projects/${projectId}/product/pages`, { title: `Pagina ${++n}` });
  return res.json() as { id: string; code: string };
}
const view = async (code: string, who: U = editor) => (await as(who, "GET", `/api/product-pages/by-code/${code}`)).json() as ProductPageView;
const para = (id: string, text: string): ProductBlock => ({ id, type: "paragraph", content: { text, marks: [] } });
const ops = (who: U, pageId: string, body: object) => as(who, "POST", `/api/product-pages/${pageId}/ops`, body);

describe("scrivere a operazioni", () => {
  it("due salvataggi della stessa sessione si uniscono in una revisione; un'altra sessione ne apre una nuova", async () => {
    const p = await page();
    const v = await view(p.code);
    const first = (v.blocks[0]!.id as string);
    const a = await ops(editor, p.id, { sessionId: "s1", baseSeq: v.seq, ops: [{ op: "set", block: para(first, "Ciao") }] });
    expect(a.statusCode, a.body).toBe(200);
    const b = await ops(editor, p.id, { sessionId: "s1", baseSeq: (a.json() as { seq: number }).seq, ops: [{ op: "insert", afterId: first, block: para("blk-due", "Due") }] });
    expect(b.json()).toMatchObject({ revisionId: (a.json() as { revisionId: string }).revisionId });
    const c = await ops(editor, p.id, { sessionId: "s2", baseSeq: (b.json() as { seq: number }).seq, ops: [{ op: "delete", blockId: "blk-due" }] });
    expect((c.json() as { revisionId: string }).revisionId).not.toBe((a.json() as { revisionId: string }).revisionId);
    expect((await view(p.code)).blocks.map((x) => (x as { content?: { text: string } }).content?.text)).toEqual(["Ciao"]);
  });

  it("`stale`: un salvataggio su una versione vecchia, dopo uno di un ALTRO, è 409 con le revisioni mancanti; la propria sessione no", async () => {
    const p = await page();
    const v = await view(p.code);
    const first = (v.blocks[0]!.id as string);
    expect((await ops(other, p.id, { sessionId: "o1", baseSeq: v.seq, ops: [{ op: "set", block: para(first, "Dell'altro") }] })).statusCode).toBe(200);
    const stale = await ops(editor, p.id, { sessionId: "e1", baseSeq: v.seq, ops: [{ op: "insert", afterId: first, block: para("blk-mio", "Mio") }] });
    expect(stale.statusCode).toBe(409);
    const body = stale.json() as { code: string; revisions: ProductRevisionView[] };
    expect(body.code).toBe("stale");
    expect(body.revisions).toHaveLength(1);
    expect((await view(p.code)).blocks).toHaveLength(1);
  });

  it("un id già dato in questa pagina non torna (422), salvo ⌘Z della stessa sessione", async () => {
    const p = await page();
    let v = await view(p.code);
    await ops(editor, p.id, { sessionId: "s", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: para("blk-x", "X") }] });
    v = await view(p.code);
    const del = await ops(editor, p.id, { sessionId: "s", baseSeq: v.seq, ops: [{ op: "delete", blockId: "blk-x" }] });
    v = await view(p.code);
    const reuse = await ops(other, p.id, { sessionId: "o", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: para("blk-x", "Di nuovo") }] });
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json()).toMatchObject({ code: "block_id_taken" });
    const undo = await ops(editor, p.id, { sessionId: "s", baseSeq: v.seq, undoOf: (del.json() as { revisionId: string }).revisionId, ops: [{ op: "insert", afterId: null, block: para("blk-x", "X") }] });
    expect(undo.statusCode, undo.body).toBe(200);
  });

  it("un link javascript: e un'operazione su un blocco che non c'è: 422, niente cambiato", async () => {
    const p = await page();
    const v = await view(p.code);
    const bad = { id: "blk-l", type: "paragraph", content: { text: "Clicca", marks: [{ type: "link", start: 0, end: 6, href: "javascript:alert(1)" }] } };
    expect((await ops(editor, p.id, { sessionId: "s", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: bad }] })).statusCode).toBe(422);
    expect((await ops(editor, p.id, { sessionId: "s", baseSeq: v.seq, ops: [{ op: "delete", blockId: "blk-mai" }] })).statusCode).toBe(422);
    expect((await view(p.code)).blocks).toHaveLength(1);
  });

  it("un file del Drive di un progetto che chi salva non vede: 422", async () => {
    const p = await page();
    const v = await view(p.code);
    const [file] = await t.db.insert(driveFiles).values({ projectId: hiddenProject, number: 1, name: "s.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `drive/${randomUUID()}`, addedBy: editor.id } as typeof driveFiles.$inferInsert).returning();
    const [code] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, hiddenProject));
    const res = await ops(editor, p.id, { sessionId: "s", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: { id: "blk-f", type: "drive", fileId: file!.id, code: `${code!.code}-F1` } }] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "invalid_drive" });
  });

  it("chi ha solo `docs.view` non scrive (403)", async () => {
    const p = await page();
    const v = await view(p.code);
    expect((await ops(reader, p.id, { sessionId: "r", baseSeq: v.seq, ops: [{ op: "delete", blockId: (v.blocks[0]!.id as string) }] })).statusCode).toBe(403);
  });

  it("due salvataggi in parallelo sulla stessa pagina non perdono operazioni (il FOR UPDATE)", async () => {
    const p = await page();
    const v = await view(p.code);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ops(editor, p.id, { sessionId: "par", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: para(`blk-p${i}`, `P${i}`) }] })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await view(p.code)).blocks).toHaveLength(7);
  });
});

describe("la cronologia, Segui, le immagini", () => {
  it("la cronologia dalla più recente, coi cambi; il nome dell'autore", async () => {
    const p = await page();
    const v = await view(p.code);
    await ops(editor, p.id, { sessionId: "h", baseSeq: v.seq, ops: [{ op: "set", block: para((v.blocks[0]!.id as string), "Storia") }] });
    const revs = (await as(reader, "GET", `/api/product-pages/${p.id}/revisions`)).json() as ProductRevisionView[];
    expect(revs.map((r) => r.kind)).toEqual(["edit", "create"]);
    expect(revs[0]!.actorName).not.toBeNull();
  });

  it("seguire e smettere (chi legge può)", async () => {
    const p = await page();
    expect((await as(reader, "PUT", `/api/product-pages/${p.id}/follow`)).statusCode).toBe(204);
    expect((await view(p.code, reader)).following).toBe(true);
    expect((await as(reader, "DELETE", `/api/product-pages/${p.id}/follow`)).statusCode).toBe(204);
    expect((await view(p.code, reader)).following).toBe(false);
  });

  const BOUNDARY = "----stubwiseproductboundary";
  const upload = (u: U, pageId: string, content: Buffer, filename = "x.png") =>
    app.inject({
      method: "POST",
      url: `/api/product-pages/${pageId}/images`,
      headers: { cookie: u.headers.cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.concat([
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

  it("un'immagine PNG si carica e si usa nel blocco; uno SVG travestito no; un riferimento di un'altra pagina no", async () => {
    const p = await page();
    const up = await upload(editor, p.id, PNG);
    expect(up.statusCode, up.body).toBe(201);
    const { ref } = up.json() as { ref: string };
    const svg = await upload(editor, p.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.png");
    expect(svg.statusCode).toBe(422);
    const v = await view(p.code);
    const ok = await ops(editor, p.id, { sessionId: "i", baseSeq: v.seq, ops: [{ op: "insert", afterId: null, block: { id: "blk-img", type: "image", src: ref, caption: "", alt: "Schermata" } }] });
    expect(ok.statusCode, ok.body).toBe(200);
    const q = await page();
    const vq = await view(q.code);
    const foreign = await ops(editor, q.id, { sessionId: "i", baseSeq: vq.seq, ops: [{ op: "insert", afterId: null, block: { id: "blk-img2", type: "image", src: ref, caption: "", alt: "" } }] });
    expect(foreign.statusCode).toBe(422);
    const open = await as(reader, "GET", `/api/product-pages/${p.id}/images/${ref.split(":")[1]}`);
    expect(open.statusCode).toBe(302);
  });

  it("l'eliminazione di un progetto toglie anche le chiavi delle immagini", async () => {
    const p = await page();
    await upload(editor, p.id, PNG);
    const [img] = await t.db.select({ key: productPageImages.storageKey }).from(productPageImages).where(eq(productPageImages.pageId, p.id));
    expect(await storageKeysOfProject(t.db, projectId)).toContain(img!.key);
  });

  it("una pagina che se ne va porta via le sue revisioni", async () => {
    const p = await page();
    await as(editor, "DELETE", `/api/product-pages/${p.id}`);
    expect(await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, p.id))).toEqual([]);
    expect(await t.db.select().from(productPages).where(eq(productPages.id, p.id))).toEqual([]);
  });
});
