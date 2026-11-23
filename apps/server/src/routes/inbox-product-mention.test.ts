import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { notifications, productComments, projectMembers, projects, roles } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { InboxItem, ProductCommentView, ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F2, Task 3: la menzione in un commento della doc di prodotto. La
// card nasce per il menzionato, mai per chi scrive, nella transazione del
// commento; titolo, codice, chi ha scritto e `objectGone` si DERIVANO a
// lettura (CLAUDE.md, «I campi che un client legge su una card… si DERIVANO»).

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let editor: U;
let reader: U;
let other: U;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-m@example.com");
  reader = await createUserWithSession(app, "reader-m@example.com");
  other = await createUserWithSession(app, "other-m@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
  await addMember(app, projectId, other.id, "viewer");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

/** Una pagina, e un commento di `editor` sul suo primo blocco col testo dato. */
async function mention(body: string) {
  const created = (await inject(editor, "POST", `/api/projects/${projectId}/product/pages`, { title: `Pagina ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(editor, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const res = await inject(editor, "POST", `/api/product-pages/${created.id}/comments`, { anchorId: view.blocks[0]!.id, quote: "", body });
  expect(res.statusCode, res.body).toBe(201);
  return { page: created, comment: res.json() as ProductCommentView };
}

const rowsFor = (commentId: string) => t.db.select().from(notifications).where(and(eq(notifications.kind, "product_doc.mention"), sql`${notifications.event}->>'commentId' = ${commentId}`));

/** Le card di `who` per il commento: per id della notifica (una card sparita non ha più `productDoc`). */
async function cardsOf(who: U, commentId: string): Promise<InboxItem[]> {
  const ids = new Set((await rowsFor(commentId)).filter((r) => r.userId === who.id).map((r) => r.id));
  const res = await inject(who, "GET", "/api/inbox");
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: InboxItem[] }).items.filter((i) => ids.has(i.id));
}

describe("la menzione nella doc di prodotto", () => {
  it("la card nasce per il menzionato, da obbligatorio (`mentioned`), mai per chi scrive; chi non è nominato niente", async () => {
    const { page, comment } = await mention("@reader-m dai un'occhiata (e @editor-m)");
    const rows = await rowsFor(comment.id);
    expect(rows.map((r) => r.userId)).toEqual([reader.id]);
    expect(rows[0]!.event).toMatchObject({ pageId: page.id, pageCode: page.code, commentId: comment.id, authorUserId: editor.id });
    // Nel jsonb mai il testo della pagina né del commento.
    expect(JSON.stringify(rows[0]!.event)).not.toContain("occhiata");
    const [card] = await cardsOf(reader, comment.id);
    expect(card).toMatchObject({ objectGone: false, alertMandatory: "mentioned", productDoc: { pageId: page.id, pageCode: page.code, commentId: comment.id, threadRootId: comment.id, authorName: "editor-m" } });
    expect(card!.text).toContain("editor-m");
    expect(card!.text).toContain(page.code);
    // Senza PUBLIC_URL nel test l'«Apri» non c'è: il link lo copre `actions.test.ts` di notifications.
    expect(await cardsOf(other, comment.id)).toHaveLength(0);
    expect((await rowsFor(comment.id)).some((r) => r.userId === editor.id)).toBe(false);
  });

  it("una risposta che menziona: la card porta la radice del filo", async () => {
    const { page, comment: root } = await mention("Senza menzioni");
    const reply = (await inject(editor, "POST", `/api/product-pages/${page.id}/comments`, { anchorId: "x", quote: "", body: "@other-m tu che dici?", replyToId: root.id })).json() as ProductCommentView;
    const [card] = await cardsOf(other, reply.id);
    expect(card!.productDoc).toMatchObject({ commentId: reply.id, threadRootId: root.id });
  });

  it("CARD VECCHIA: il titolo cambiato dopo la publish si legge nuovo, e il derivato scavalca un jsonb che dice altro", async () => {
    const { page, comment } = await mention("@reader-m guarda");
    const renamed = await inject(editor, "PATCH", `/api/product-pages/${page.id}`, { title: "Titolo di adesso" });
    expect(renamed.statusCode, renamed.body).toBeLessThan(300);
    // Il jsonb di allora, riscritto apposta diverso: la card non deve leggerlo.
    await t.db
      .update(notifications)
      .set({ event: sql`${notifications.event} || '{"pageCode":"VEC-D1","projectCode":"VEC","authorName":"Vecchio nome"}'::jsonb` })
      .where(and(eq(notifications.userId, reader.id), sql`${notifications.event}->>'commentId' = ${comment.id}`));
    const [card] = await cardsOf(reader, comment.id);
    expect(card!.productDoc).toMatchObject({ pageTitle: "Titolo di adesso", pageCode: page.code });
    expect(card!.productDoc!.pageCode).not.toBe("VEC-D1");
    expect(card!.text).toContain(page.code);
    expect(card!.text).not.toContain("VEC-D1");
    expect(card!.text).not.toContain("Vecchio nome");
    expect(card!.url ?? "").not.toContain("VEC-D1");
  });

  it("pagina eliminata: `objectGone`, niente link, e la frase non dice né codice né chi ha scritto", async () => {
    const { page, comment } = await mention("@reader-m prima che sparisca");
    expect((await inject(editor, "DELETE", `/api/product-pages/${page.id}`)).statusCode).toBeLessThan(300);
    const [card] = await cardsOf(reader, comment.id);
    expect(card).toMatchObject({ objectGone: true, productDoc: null });
    expect(card!.url).toBeUndefined();
    expect(card!.text).not.toContain(page.code);
    expect(card!.text).not.toContain("editor-m");
  });

  it("revisione del lotto 1: col modulo Docs spento la card è `objectGone` con la frase neutra, senza titolo né codice", async () => {
    const { page, comment } = await mention("@reader-m guarda qui");
    const [before] = await cardsOf(reader, comment.id);
    expect(before).toMatchObject({ objectGone: false });
    await t.db.update(projects).set({ modules: ["releases"] }).where(eq(projects.id, projectId));
    try {
      const [card] = await cardsOf(reader, comment.id);
      expect(card).toMatchObject({ objectGone: true, productDoc: null, text: "A product page you can no longer see" });
      expect(card!.text).not.toContain(page.code);
    } finally {
      await t.db.update(projects).set({ modules: ["docs", "releases", "support", "servers"] }).where(eq(projects.id, projectId));
    }
  });

  it("chi non legge più i Docs del progetto: la card resta, ma `objectGone` e senza nulla della pagina (R-G5)", async () => {
    const { page, comment } = await mention("@other-m questa è per te");
    const [blind] = await t.db.insert(roles).values({ name: `Senza Docs ${randomUUID().slice(0, 4)}`, scope: "project", permissions: ["tickets.view_all"] }).returning({ id: roles.id });
    await t.db.update(projectMembers).set({ roleId: blind!.id }).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, other.id)));
    const [card] = await cardsOf(other, comment.id);
    expect(card).toMatchObject({ objectGone: true, productDoc: null });
    expect(card!.text).not.toContain(page.code);
    // Chi non legge i Docs non riceve una menzione nuova (nemmeno da obbligatorio).
    const again = await mention("@other-m ancora");
    expect(await rowsFor(again.comment.id)).toHaveLength(0);
  });

  it("46 (R11-2): l'estratto è il testo del commento di ADESSO, anche su una CARD VECCHIA, mai dal jsonb; un commento eliminato non dà testo", async () => {
    const long = `@reader-m ${"parola ".repeat(60)}`;
    const { comment } = await mention(long);
    // La card vecchia: un jsonb con un `body` scritto apposta, che la card non deve leggere.
    await t.db
      .update(notifications)
      .set({ event: sql`${notifications.event} || '{"body":"testo del jsonb"}'::jsonb` })
      .where(and(eq(notifications.userId, reader.id), sql`${notifications.event}->>'commentId' = ${comment.id}`));
    let [card] = await cardsOf(reader, comment.id);
    expect(card!.productDoc!.excerpt).toBe(`${long.slice(0, 199).trimEnd()}…`);
    expect(JSON.stringify(card)).not.toContain("testo del jsonb");
    // Eliminato (come fa la regola dei commenti: `body = ''`): niente più testo, e la card è sparita.
    await t.db.update(productComments).set({ deletedAt: new Date(), body: "" }).where(eq(productComments.id, comment.id));
    [card] = await cardsOf(reader, comment.id);
    expect(card).toMatchObject({ objectGone: true, productDoc: null });
    expect(JSON.stringify(card)).not.toContain("parola parola");
  });

  it("review di F3 (M3): l'estratto si taglia per code point, un emoji al confine non si spezza", async () => {
    const body = `@reader-m ${"a".repeat(188)}😀😀😀😀😀`;
    const { comment } = await mention(body);
    const [card] = await cardsOf(reader, comment.id);
    const excerpt = card!.productDoc!.excerpt!;
    expect(Array.from(excerpt)).toHaveLength(200);
    expect(excerpt.endsWith("😀…")).toBe(true);
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("review di F2: una pagina che non c'è più con il commento che c'è ancora (il ramo della pagina, da solo) è `objectGone`", async () => {
    const { comment } = await mention("@reader-m resta il commento");
    await t.db
      .update(notifications)
      .set({ event: sql`jsonb_set(${notifications.event}, '{pageId}', to_jsonb(${randomUUID()}::text))` })
      .where(and(eq(notifications.userId, reader.id), sql`${notifications.event}->>'commentId' = ${comment.id}`));
    const [card] = await cardsOf(reader, comment.id);
    expect(card).toMatchObject({ objectGone: true, productDoc: null });
  });
});

describe("review di F2, riscritta con F5: `updated` e `question` senza revisione né domanda", () => {
  it("una card che non nomina la sua revisione o la sua domanda è `objectGone` con la frase neutra (il prototipo: «una riga senza si legge come objectGone»)", async () => {
    const created = (await inject(editor, "POST", `/api/projects/${projectId}/product/pages`, { title: "Aggiornata" })).json() as { id: string; code: string };
    const ids: string[] = [];
    for (const kind of ["product_doc.updated", "product_doc.question"] as const) {
      const extra = kind === "product_doc.updated" ? { revisionId: null } : { questionId: null };
      const [row] = await t.db
        .insert(notifications)
        .values({ userId: reader.id, projectId, kind, status: "open", event: { kind, pageId: created.id, pageCode: "VEC-D1", projectId, projectCode: "VEC", ...extra } })
        .returning({ id: notifications.id });
      ids.push(row!.id);
    }
    const cards = ((await inject(reader, "GET", "/api/inbox")).json() as { items: InboxItem[] }).items.filter((i) => ids.includes(i.id));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card, card.kind).toMatchObject({ objectGone: true, productDoc: null });
      expect(card.text, card.kind).not.toContain("VEC-D1");
    }
  });
});
