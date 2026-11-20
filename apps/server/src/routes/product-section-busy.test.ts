import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { productSectionHolds } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F4, Task 2: le operazioni rispettano la sezione presa. Chi scrive
// prende la sezione dei blocchi che tocca; un altro riceve 409 `section_busy`
// e NIENTE cambia (nemmeno le prese chieste nella stessa richiesta).

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let bea: U;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  ada = await createUserWithSession(app, "ada-sb@example.com");
  bea = await createUserWithSession(app, "bea-sb@example.com");
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, bea.id, "developer");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const rich = (text: string) => ({ text, marks: [] });
const para = (id: string, text: string) => ({ id, type: "paragraph", content: rich(text) });
const h2 = (id: string, text: string) => ({ id, type: "heading", level: 2, content: rich(text) });

/** Una pagina: in cima `top`, poi la sezione A (hA, a1, a2) e la B (hB, b1). Ogni persona ha la sua sessione. */
async function page() {
  const created = (await inject(ada, "POST", `/api/projects/${projectId}/product/pages`, { title: `P ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(ada, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  const top = view.blocks[0]!.id as string;
  const ids = { top, hA: `blk-${randomUUID()}`, a1: `blk-${randomUUID()}`, a2: `blk-${randomUUID()}`, hB: `blk-${randomUUID()}`, b1: `blk-${randomUUID()}` };
  const ops = [
    { op: "insert", afterId: top, block: h2(ids.hA, "A") },
    { op: "insert", afterId: ids.hA, block: para(ids.a1, "a uno") },
    { op: "insert", afterId: ids.a1, block: para(ids.a2, "a due") },
    { op: "insert", afterId: ids.a2, block: h2(ids.hB, "B") },
    { op: "insert", afterId: ids.hB, block: para(ids.b1, "b uno") },
  ];
  const res = await inject(ada, "POST", `/api/product-pages/${created.id}/ops`, { sessionId: "setup", baseSeq: view.seq, ops });
  expect(res.statusCode, res.body).toBe(200);
  // La pagina costruita non tiene nessuno: le prese del montaggio via.
  await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, created.id));
  return { ...created, ids };
}

const state = async (p: { code: string }) => (await inject(ada, "GET", `/api/product-pages/by-code/${p.code}`)).json() as ProductPageView;
const save = (who: U, p: { id: string }, session: string, baseSeq: number, ops: object[]) => inject(who, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: session, baseSeq, ops });
const holdsOf = async (pageId: string) =>
  (await t.db.select({ sectionId: productSectionHolds.sectionId, userId: productSectionHolds.userId }).from(productSectionHolds).where(eq(productSectionHolds.pageId, pageId))).sort((x, y) => x.sectionId.localeCompare(y.sectionId));

describe("le operazioni rispettano la sezione presa", () => {
  it("chi scrive prende la sezione; l'altro nella stessa sezione 409 `section_busy` con chi la tiene, e la pagina resta com'era; in un'altra sezione passa", async () => {
    const p = await page();
    let s = await state(p);
    expect((await save(ada, p, "ada", s.seq, [{ op: "set", block: para(p.ids.a1, "Ada scrive") }])).statusCode).toBe(200);
    expect(await holdsOf(p.id)).toEqual([{ sectionId: p.ids.hA, userId: ada.id }]);
    s = await state(p);
    const busy = await save(bea, p, "bea", s.seq, [{ op: "set", block: para(p.ids.a2, "Bea anche") }]);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json()).toEqual({ code: "section_busy", message: expect.any(String), sectionId: p.ids.hA, by: { id: ada.id, name: "ada-sb" } });
    const after = await state(p);
    expect(after.seq).toBe(s.seq);
    expect(after.blocks.find((b) => b.id === p.ids.a2)).toMatchObject({ content: { text: "a due" } });
    expect((await save(bea, p, "bea", s.seq, [{ op: "set", block: para(p.ids.b1, "Bea in B") }])).statusCode).toBe(200);
  });

  it("dopo la scadenza della presa, l'altro scrive", async () => {
    const p = await page();
    let s = await state(p);
    await save(ada, p, "ada", s.seq, [{ op: "set", block: para(p.ids.a1, "Ada") }]);
    await t.db.update(productSectionHolds).set({ expiresAt: sql`now() - interval '1 second'` }).where(and(eq(productSectionHolds.pageId, p.id), eq(productSectionHolds.userId, ada.id)));
    s = await state(p);
    expect((await save(bea, p, "bea", s.seq, [{ op: "set", block: para(p.ids.a2, "Bea") }])).statusCode).toBe(200);
    expect(await holdsOf(p.id)).toEqual([{ sectionId: p.ids.hA, userId: bea.id }]);
  });

  it("un `move` verso una sezione presa è rifiutato, e un `delete` in una sezione presa anche", async () => {
    const p = await page();
    let s = await state(p);
    await save(ada, p, "ada", s.seq, [{ op: "set", block: para(p.ids.a1, "Ada") }]);
    s = await state(p);
    const move = await save(bea, p, "bea", s.seq, [{ op: "move", blockId: p.ids.b1, afterId: p.ids.a1 }]);
    expect(move.statusCode).toBe(409);
    expect(move.json()).toMatchObject({ code: "section_busy", sectionId: p.ids.hA });
    const del = await save(bea, p, "bea", s.seq, [{ op: "delete", blockId: p.ids.a2 }]);
    expect(del.statusCode).toBe(409);
    expect((await state(p)).blocks.map((b) => b.id)).toContain(p.ids.a2);
  });

  it("nessuna operazione a metà: con una in una sezione libera e una in una presa, niente cambia, nemmeno la presa della libera", async () => {
    const p = await page();
    let s = await state(p);
    await save(ada, p, "ada", s.seq, [{ op: "set", block: para(p.ids.a1, "Ada") }]);
    s = await state(p);
    const mixed = await save(bea, p, "bea", s.seq, [
      { op: "set", block: para(p.ids.b1, "Bea in B") },
      { op: "set", block: para(p.ids.a2, "Bea in A") },
    ]);
    expect(mixed.statusCode).toBe(409);
    const after = await state(p);
    expect(after.seq).toBe(s.seq);
    expect(after.blocks.find((b) => b.id === p.ids.b1)).toMatchObject({ content: { text: "b uno" } });
    expect(await holdsOf(p.id)).toEqual([{ sectionId: p.ids.hA, userId: ada.id }]);
  });

  it("la sezione in cima ha la sua presa (`top`), e un inserimento in cima la chiede", async () => {
    const p = await page();
    let s = await state(p);
    await save(ada, p, "ada", s.seq, [{ op: "set", block: para(p.ids.top, "Ada in cima") }]);
    s = await state(p);
    const res = await save(bea, p, "bea", s.seq, [{ op: "insert", afterId: null, block: para(`blk-${randomUUID()}`, "Bea prima di tutto") }]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ sectionId: "top" });
  });
});
