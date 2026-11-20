import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { productComments, productPageFollows, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductCommentView, ProductCommentsView, ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F2, Task 2: i commenti delle pagine di prodotto. `docs.view` legge
// i fili, `docs.edit` commenta e risolve; «Frase eliminata» si DERIVA dai
// blocchi di adesso; un `merge` sposta i fili; le menzioni fra chi legge i
// Docs, mai Claude né chi scrive.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let editor: U;
let reader: U;
let noDocs: U;
let outsider: U;
let claudeId: string;
let claudeName: string;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-c@example.com");
  reader = await createUserWithSession(app, "reader-c@example.com");
  noDocs = await createUserWithSession(app, "nodocs-c@example.com");
  outsider = await createUserWithSession(app, "out-c@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
  const [blind] = await t.db.insert(roles).values({ name: "Senza Docs C", scope: "project", permissions: ["tickets.view_all"] }).returning({ id: roles.id });
  await t.db.insert(projectMembers).values({ projectId, userId: noDocs.id, roleId: blind!.id });
  // Claude: l'utente agente dell'istanza (uno solo, `users_single_agent`).
  const [claude] = await t.db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(eq(users.isAgent, true));
  claudeId = claude!.id;
  claudeName = claude!.displayName?.trim() || claude!.email.split("@")[0]!;
  await addMember(app, projectId, claudeId, "viewer");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

const blk = () => `blk-${randomUUID()}`;
const para = (id: string, text: string) => ({ id, type: "paragraph" as const, content: { text, marks: [] } });

/** Una pagina con i paragrafi dati (in quest'ordine), e il suo stato per scriverci ancora. */
async function pageWith(...texts: string[]) {
  const created = await inject(editor, "POST", `/api/projects/${projectId}/product/pages`, { title: `P ${randomUUID().slice(0, 6)}` });
  expect(created.statusCode, created.body).toBe(201);
  const { id, code } = created.json() as { id: string; code: string };
  const view = (await inject(editor, "GET", `/api/product-pages/by-code/${code}`)).json() as ProductPageView;
  const ids = texts.map(() => blk());
  let afterId = view.blocks[0]!.id as string;
  const ops = texts.map((text, i) => {
    const op = { op: "insert", afterId, block: para(ids[i]!, text) };
    afterId = ids[i]!;
    return op;
  });
  const sessionId = randomUUID();
  const saved = await inject(editor, "POST", `/api/product-pages/${id}/ops`, { sessionId, baseSeq: view.seq, ops });
  expect(saved.statusCode, saved.body).toBe(200);
  return { id, code, ids, sessionId, seq: (saved.json() as { seq: number }).seq };
}

const comment = (who: U, pageId: string, payload: object) => inject(who, "POST", `/api/product-pages/${pageId}/comments`, payload);
const threads = async (who: U, pageId: string) => {
  const res = await inject(who, "GET", `/api/product-pages/${pageId}/comments`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ProductCommentsView;
};

describe("i commenti", () => {
  it("chi ha solo `docs.view` legge i fili ma non commenta (403); chi non vede il progetto 404", async () => {
    const page = await pageWith("Una frase");
    expect((await comment(reader, page.id, { anchorId: page.ids[0], quote: "", body: "No" })).statusCode).toBe(403);
    expect((await inject(reader, "GET", `/api/product-pages/${page.id}/comments`)).statusCode).toBe(200);
    expect((await inject(outsider, "GET", `/api/product-pages/${page.id}/comments`)).statusCode).toBe(404);
    expect((await comment(outsider, page.id, { anchorId: page.ids[0], quote: "", body: "No" })).statusCode).toBe(404);
  });

  it("la frase citata è ripulita: una riga, al più 200; senza frase, quella intera dell'ancora", async () => {
    const long = `  Riga uno\n\nriga due ${"x".repeat(300)}`;
    const page = await pageWith(long, "Altro");
    const a = await comment(editor, page.id, { anchorId: page.ids[0], quote: long, body: "Sì" });
    expect(a.statusCode, a.body).toBe(201);
    const quote = (a.json() as ProductCommentView).quote;
    expect(quote.startsWith("Riga uno riga due x")).toBe(true);
    expect(quote).not.toContain("\n");
    expect(quote).toHaveLength(200);
    const b = (await comment(editor, page.id, { anchorId: page.ids[1], quote: "", body: "Ok" })).json() as ProductCommentView;
    expect(b.quote).toBe("Altro");
    // Commentare non fa seguire la pagina a chi non la seguiva.
    expect(await t.db.select().from(productPageFollows).where(eq(productPageFollows.userId, reader.id))).toHaveLength(0);
  });

  it("un'ancora che non c'è è 422; una risposta prende ancora e frase della radice; una risposta a una risposta 422", async () => {
    const page = await pageWith("Radice");
    const gone = await comment(editor, page.id, { anchorId: "blk-nope", quote: "", body: "x" });
    expect(gone.statusCode).toBe(422);
    expect(gone.json()).toMatchObject({ code: "invalid_anchor" });
    const root = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "Radice", body: "Prima" })).json() as ProductCommentView;
    const reply = await comment(editor, page.id, { anchorId: "blk-ignorata", quote: "ignorata", body: "Risposta", replyToId: root.id });
    expect(reply.statusCode, reply.body).toBe(201);
    expect(reply.json()).toMatchObject({ anchorId: page.ids[0], quote: "Radice", replyToId: root.id });
    const nested = await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: "No", replyToId: (reply.json() as ProductCommentView).id });
    expect(nested.statusCode).toBe(422);
    expect(nested.json()).toMatchObject({ code: "invalid_reply" });
    const list = await threads(reader, page.id);
    expect(list.open).toHaveLength(1);
    expect(list.open[0]!.replies.map((r) => r.body)).toEqual(["Risposta"]);
    expect(list.open[0]!.root.authorName).toBe("editor-c");
  });

  it("«Frase eliminata» si deriva: tolta l'ancora dai blocchi, il filo va in fondo con `anchorGone`; una risposta ci va ancora", async () => {
    const page = await pageWith("Resta", "Sparisce");
    const keep = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: "Su Resta" })).json() as ProductCommentView;
    const lost = (await comment(editor, page.id, { anchorId: page.ids[1], quote: "", body: "Su Sparisce" })).json() as ProductCommentView;
    let list = await threads(editor, page.id);
    expect(list.open.map((th) => [th.root.id, th.anchorGone])).toEqual([[keep.id, false], [lost.id, false]]);
    const del = await inject(editor, "POST", `/api/product-pages/${page.id}/ops`, { sessionId: page.sessionId, baseSeq: page.seq, ops: [{ op: "delete", blockId: page.ids[1] }] });
    expect(del.statusCode, del.body).toBe(200);
    list = await threads(editor, page.id);
    expect(list.open.map((th) => [th.root.id, th.anchorGone])).toEqual([[keep.id, false], [lost.id, true]]);
    expect(list.open[1]!.root.quote).toBe("Sparisce");
    expect((await comment(editor, page.id, { anchorId: "x", quote: "", body: "Comunque", replyToId: lost.id })).statusCode).toBe(201);
  });

  it("un `merge` sposta sul blocco unito i fili del blocco assorbito (radici e risposte), la frase resta", async () => {
    const page = await pageWith("Primo", "Secondo");
    const root = (await comment(editor, page.id, { anchorId: page.ids[1], quote: "", body: "Sul secondo" })).json() as ProductCommentView;
    await comment(editor, page.id, { anchorId: "x", quote: "", body: "Risposta", replyToId: root.id });
    const merged = await inject(editor, "POST", `/api/product-pages/${page.id}/ops`, { sessionId: page.sessionId, baseSeq: page.seq, ops: [{ op: "merge", firstId: page.ids[0], secondId: page.ids[1] }] });
    expect(merged.statusCode, merged.body).toBe(200);
    const list = await threads(editor, page.id);
    expect(list.open).toHaveLength(1);
    expect(list.open[0]!.anchorGone).toBe(false);
    expect(list.open[0]!.root).toMatchObject({ anchorId: page.ids[0], quote: "Secondo" });
    const rows = await t.db.select({ anchorId: productComments.anchorId }).from(productComments).where(eq(productComments.pageId, page.id));
    expect(rows.every((r) => r.anchorId === page.ids[0])).toBe(true);
  });

  it("review di F2 (M4): il ⌘Z di un `merge` riporta i fili sul blocco rimesso; quelli nati sul primo restano", async () => {
    const page = await pageWith("Primo", "Secondo");
    const onFirst = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: "Sul primo" })).json() as ProductCommentView;
    const onSecond = (await comment(editor, page.id, { anchorId: page.ids[1], quote: "", body: "Sul secondo" })).json() as ProductCommentView;
    const session = randomUUID();
    const merged = await inject(editor, "POST", `/api/product-pages/${page.id}/ops`, { sessionId: session, baseSeq: page.seq, ops: [{ op: "merge", firstId: page.ids[0], secondId: page.ids[1] }] });
    expect(merged.statusCode, merged.body).toBe(200);
    const { seq, revisionId } = merged.json() as { seq: number; revisionId: string };
    const undo = await inject(editor, "POST", `/api/product-pages/${page.id}/ops`, {
      sessionId: session,
      baseSeq: seq,
      undoOf: revisionId,
      ops: [
        { op: "set", block: para(page.ids[0]!, "Primo") },
        { op: "insert", afterId: page.ids[0], block: para(page.ids[1]!, "Secondo") },
      ],
    });
    expect(undo.statusCode, undo.body).toBe(200);
    const anchors = new Map((await t.db.select().from(productComments).where(eq(productComments.pageId, page.id))).map((r) => [r.id, [r.anchorId, r.originalAnchorId]]));
    expect(anchors.get(onFirst.id)).toEqual([page.ids[0], null]);
    expect(anchors.get(onSecond.id)).toEqual([page.ids[1], null]);
    const list = await threads(editor, page.id);
    expect(list.open.map((th) => [th.root.id, th.anchorGone])).toEqual([[onFirst.id, false], [onSecond.id, false]]);
  });

  it("richiesta di 94: `openComments` sulla vista della pagina conta le radici aperte (ancora viva o no), non le risposte né le risolte", async () => {
    const page = await pageWith("Uno", "Due");
    const viewOf = async () => ((await inject(reader, "GET", `/api/product-pages/by-code/${page.code}`)).json() as ProductPageView).openComments;
    expect(await viewOf()).toBe(0);
    const a = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: "A" })).json() as ProductCommentView;
    await comment(editor, page.id, { anchorId: page.ids[1], quote: "", body: "B" });
    await comment(editor, page.id, { anchorId: "x", quote: "", body: "risposta", replyToId: a.id });
    expect(await viewOf()).toBe(2);
    await inject(editor, "POST", `/api/product-comments/${a.id}/resolve`);
    expect(await viewOf()).toBe(1);
    await inject(editor, "POST", `/api/product-pages/${page.id}/ops`, { sessionId: page.sessionId, baseSeq: page.seq, ops: [{ op: "delete", blockId: page.ids[1] }] });
    expect(await viewOf()).toBe(1);
  });

  it("«Resolve» e «Reopen» con `docs.edit`; una risposta 422; chi legge soltanto 403", async () => {
    const page = await pageWith("Da risolvere");
    const root = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: "Fatto?" })).json() as ProductCommentView;
    const reply = (await comment(editor, page.id, { anchorId: "x", quote: "", body: "Sì", replyToId: root.id })).json() as ProductCommentView;
    expect((await inject(reader, "POST", `/api/product-comments/${root.id}/resolve`)).statusCode).toBe(403);
    expect((await inject(editor, "POST", `/api/product-comments/${reply.id}/resolve`)).statusCode).toBe(422);
    expect((await inject(editor, "POST", `/api/product-comments/${root.id}/resolve`)).statusCode).toBe(204);
    let list = await threads(reader, page.id);
    expect(list.open).toHaveLength(0);
    expect(list.resolved[0]!.root.resolved).toMatchObject({ byId: editor.id, byName: "editor-c" });
    expect((await inject(editor, "POST", `/api/product-comments/${root.id}/reopen`)).statusCode).toBe(204);
    list = await threads(reader, page.id);
    expect(list.open).toHaveLength(1);
    expect((await inject(outsider, "POST", `/api/product-comments/${root.id}/resolve`)).statusCode).toBe(404);
  });
});

describe("review di F2: la frase citata è del blocco, e gli id di un'altra pagina non passano", () => {
  it("una frase che il blocco non contiene diventa il testo dell'ancora; una frase di soli spazi anche; un pezzo vero resta", async () => {
    const page = await pageWith("Il cliente paga a trenta giorni");
    const fake = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "Il cliente non paga mai", body: "x" })).json() as ProductCommentView;
    expect(fake.quote).toBe("Il cliente paga a trenta giorni");
    const blank = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "   ", body: "x" })).json() as ProductCommentView;
    expect(blank.quote).toBe("Il cliente paga a trenta giorni");
    const part = (await comment(editor, page.id, { anchorId: page.ids[0], quote: " paga a\ntrenta ", body: "x" })).json() as ProductCommentView;
    expect(part.quote).toBe("paga a trenta");
  });

  it("IDOR: una risposta a un filo di un'altra pagina è 404, e non scrive niente", async () => {
    const a = await pageWith("Pagina A");
    const b = await pageWith("Pagina B");
    const rootOnB = (await comment(editor, b.id, { anchorId: b.ids[0], quote: "", body: "Su B" })).json() as ProductCommentView;
    const res = await comment(editor, a.id, { anchorId: a.ids[0], quote: "", body: "Risposta furba", replyToId: rootOnB.id });
    expect(res.statusCode).toBe(404);
    expect((await threads(editor, a.id)).open).toHaveLength(0);
    expect((await threads(editor, b.id)).open[0]!.replies).toHaveLength(0);
  });

  it("IDOR: chi scrive i Docs di un ALTRO progetto non risolve un filo di questo (404)", async () => {
    const page = await pageWith("Da proteggere");
    const root = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: "Filo" })).json() as ProductCommentView;
    const { projectId: otherProject } = await seedRepository(t.db);
    const foreign = await createUserWithSession(app, `foreign-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, otherProject, foreign.id, "developer");
    expect((await inject(foreign, "POST", `/api/product-comments/${root.id}/resolve`)).statusCode).toBe(404);
    expect((await threads(editor, page.id)).open).toHaveLength(1);
  });
});

describe("le menzioni", () => {
  it("nel testo, fra chi legge i Docs: mai chi scrive, mai chi non legge i Docs, mai Claude", async () => {
    const page = await pageWith("Frase");
    const c = (await comment(editor, page.id, { anchorId: page.ids[0], quote: "", body: `@reader-c guarda, e anche @nodocs-c, @${claudeName} e @editor-c` })).json() as ProductCommentView;
    expect(c.mentionIds).toEqual([reader.id]);
    const [row] = await t.db.select({ mentions: productComments.mentions }).from(productComments).where(eq(productComments.id, c.id));
    expect(row!.mentions).toEqual([reader.id]);
  });

  it("i candidati: chi legge i Docs del progetto, senza sé stessi, Claude e chi non legge i Docs; `q` cerca nel nome", async () => {
    const res = await inject(editor, "GET", `/api/projects/${projectId}/product/mention-candidates`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json() as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(reader.id);
    expect(ids).not.toContain(editor.id);
    expect(ids).not.toContain(noDocs.id);
    expect(ids).not.toContain(claudeId);
    const q = (await inject(editor, "GET", `/api/projects/${projectId}/product/mention-candidates?q=READER`)).json() as { name: string }[];
    expect(q.map((p) => p.name)).toEqual(["reader-c"]);
    expect((await inject(outsider, "GET", `/api/projects/${projectId}/product/mention-candidates`)).statusCode).toBe(404);
    expect((await inject(noDocs, "GET", `/api/projects/${projectId}/product/mention-candidates`)).statusCode).toBe(403);
  });
});
