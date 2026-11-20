import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { projectMembers } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { parseProductLiveFrame, type ProductLiveFrame, type ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F4, Task 3: il canale dal vivo di una pagina. Due lettori, un
// salvataggio: l'altro riceve la revisione con le operazioni; un accesso tolto
// chiude lo stream (`gone`); il battito con una sezione vuole `docs.edit`; la
// presenza scade; nessuno vede la presenza di chi non vede (R-G5).

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let base: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let editor: U;
let reader: U;
let projectId: string;

beforeAll(async () => {
  t = await startTestDb();
  // Tempi corti per il test: permessi riletti ogni 200 ms, presenza che scade a 600 ms.
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), productLive: { permsTtlMs: 200, presenceTtlMs: 600 } });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-live@example.com");
  reader = await createUserWithSession(app, "reader-live@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
  base = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

async function page() {
  const created = (await inject(editor, "POST", `/api/projects/${projectId}/product/pages`, { title: `Live ${randomUUID().slice(0, 6)}` })).json() as { id: string; code: string };
  const view = (await inject(editor, "GET", `/api/product-pages/by-code/${created.code}`)).json() as ProductPageView;
  return { ...created, first: view.blocks[0]!.id as string, seq: view.seq };
}

/** Uno stream aperto: i frame letti finora, e un'attesa del primo frame che soddisfa `match`. */
async function stream(who: U, pageId: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/product-pages/${pageId}/live`, { headers: { cookie: who.headers.cookie }, signal: ctrl.signal });
  const frames: ProductLiveFrame[] = [];
  let ended = false;
  let buf = "";
  const pump = (async () => {
    if (!res.body) return;
    const r = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        buf += decoder.decode(value);
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) frames.push(...parseProductLiveFrame(p));
      }
    } catch {
      // abort
    }
    ended = true;
  })();
  const wait = async (match: (f: ProductLiveFrame) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = frames.find(match);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    return undefined;
  };
  return { res, frames, wait, isEnded: () => ended, close: () => ctrl.abort(), done: pump };
}

describe("il canale dal vivo", () => {
  it("due lettori: lo stato all'apertura, e la revisione dell'uno arriva all'altro con le operazioni", async () => {
    const p = await page();
    const a = await stream(editor, p.id);
    const b = await stream(reader, p.id);
    expect(b.res.headers.get("content-type")).toContain("text/event-stream");
    expect(await b.wait((f) => f.type === "state")).toMatchObject({ type: "state", seq: p.seq, presence: [], holds: [] });
    const ops = [{ op: "set", block: { id: p.first, type: "paragraph", content: { text: "Dal vivo", marks: [] } } }];
    const saved = await inject(editor, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "sess-ed", baseSeq: p.seq, ops });
    expect(saved.statusCode, saved.body).toBe(200);
    const rev = await b.wait((f) => f.type === "revision");
    expect(rev).toMatchObject({ type: "revision", seq: (saved.json() as { seq: number }).seq, kind: "edit", actorId: editor.id, sessionId: "sess-ed", ops });
    // La sezione presa dalla scrittura arriva come `hold`.
    expect(await b.wait((f) => f.type === "hold")).toMatchObject({ hold: { sectionId: "top", by: { id: editor.id, name: "editor-live" } } });
    a.close();
    b.close();
  });

  it("una rinomina arriva col titolo; l'eliminazione della pagina manda `gone` e chiude", async () => {
    const p = await page();
    const b = await stream(reader, p.id);
    await b.wait((f) => f.type === "state");
    await app.inject({ method: "PATCH", url: `/api/product-pages/${p.id}`, headers: { cookie: editor.headers.cookie }, payload: { title: "Nuovo titolo" } });
    expect(await b.wait((f) => f.type === "revision")).toMatchObject({ kind: "rename", title: "Nuovo titolo" });
    await app.inject({ method: "DELETE", url: `/api/product-pages/${p.id}`, headers: { cookie: editor.headers.cookie } });
    expect(await b.wait((f) => f.type === "gone")).toBeDefined();
    await b.done;
    expect(b.isEnded()).toBe(true);
  });

  it("un accesso tolto a stream aperto: `gone` e lo stream si chiude, anche senza eventi", async () => {
    const p = await page();
    const gone = await createUserWithSession(app, `gone-live-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, gone.id, "viewer");
    const s = await stream(gone, p.id);
    await s.wait((f) => f.type === "state");
    await t.db.delete(projectMembers).where(and(eq(projectMembers.userId, gone.id), eq(projectMembers.projectId, projectId)));
    expect(await s.wait((f) => f.type === "gone", 3000)).toBeDefined();
    await s.done;
    expect(s.isEnded()).toBe(true);
  });

  it("il battito: con una sezione serve `docs.edit` (403 a chi legge); la presa di uno, l'altro la trova occupata", async () => {
    const p = await page();
    expect((await inject(reader, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: "top" })).statusCode).toBe(403);
    expect((await inject(reader, "POST", `/api/product-pages/${p.id}/live/presence`, { cursor: { blockId: p.first, offset: 0 } })).statusCode).toBe(200);
    const mine = (await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: "top", cursor: { blockId: p.first, offset: 2 } })).json();
    expect(mine).toMatchObject({ hold: { sectionId: "top", by: { id: editor.id } }, busy: null });
    const other = await createUserWithSession(app, `other-live-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, other.id, "developer");
    const theirs = (await inject(other, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: "top" })).json();
    expect(theirs).toMatchObject({ hold: null, busy: { sectionId: "top", by: { id: editor.id, name: "editor-live" } } });
  });

  it("la presenza: gli altri (non sé stessi), il cursore che si muove, e la scadenza senza battiti", async () => {
    const p = await page();
    const b = await stream(reader, p.id);
    await b.wait((f) => f.type === "state");
    await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { cursor: { blockId: p.first, offset: 1 } });
    expect(await b.wait((f) => f.type === "presence" && f.presence.some((x) => x.userId === editor.id))).toMatchObject({
      presence: [{ userId: editor.id, name: "editor-live", cursor: { blockId: p.first, offset: 1 }, sectionId: null }],
    });
    await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { cursor: { blockId: p.first, offset: 5 } });
    expect(await b.wait((f) => f.type === "cursor")).toMatchObject({ userId: editor.id, cursor: { offset: 5 } });
    // Chi guarda non vede sé stesso.
    await inject(reader, "POST", `/api/product-pages/${p.id}/live/presence`, {});
    expect(b.frames.filter((f) => f.type === "presence").every((f) => f.type === "presence" && f.presence.every((x) => x.userId !== reader.id))).toBe(true);
    // Senza battiti la presenza scade (600 ms nel test) e la lista torna vuota.
    expect(await b.wait((f) => f.type === "presence" && f.presence.length === 0, 3000)).toBeDefined();
    b.close();
  });

  it("R-G5: chi non si vede più (fuori dal progetto e da ogni altro in comune) sparisce dalla presenza di chi guarda", async () => {
    const p = await page();
    const c = await createUserWithSession(app, `c-live-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, c.id, "viewer");
    await inject(c, "POST", `/api/product-pages/${p.id}/live/presence`, { cursor: { blockId: p.first, offset: 0 } });
    const b = await stream(reader, p.id);
    expect(await b.wait((f) => f.type === "state")).toMatchObject({ presence: [{ userId: c.id }] });
    await t.db.delete(projectMembers).where(and(eq(projectMembers.userId, c.id), eq(projectMembers.projectId, projectId)));
    // Un battito di un altro rimanda la presenza: c'è lui, non `c`.
    await new Promise((r) => setTimeout(r, 250));
    await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { cursor: { blockId: p.first, offset: 0 } });
    const after = await b.wait((f) => f.type === "presence" && f.presence.some((x) => x.userId === editor.id));
    expect(after && after.type === "presence" ? after.presence.map((x) => x.userId) : []).not.toContain(c.id);
    b.close();
  });

  it("i tetti: al più 10 stream per persona (l'undicesimo 429 `too_many_streams`)", async () => {
    const p = await page();
    const opened = [];
    for (let i = 0; i < 10; i++) opened.push(await stream(editor, p.id));
    for (const o of opened) await o.wait((f) => f.type === "state");
    const extra = await fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: editor.headers.cookie } });
    expect(extra.status).toBe(429);
    expect(await extra.json()).toMatchObject({ code: "too_many_streams" });
    for (const o of opened) o.close();
  });

  it("una revisione scritta da un altro processo (la NOTIFY, F5) arriva senza operazioni: il client rilegge", async () => {
    const p = await page();
    const b = await stream(reader, p.id);
    await b.wait((f) => f.type === "state");
    app.productLive.handleNotify(JSON.stringify({ type: "revision", pageId: p.id, seq: p.seq + 7, kind: "edit", actorId: null, sessionId: null }));
    expect(await b.wait((f) => f.type === "revision")).toMatchObject({ seq: p.seq + 7, actorId: null, ops: [] });
    // La stessa revisione una seconda volta (la rotta dopo la NOTIFY, o viceversa) non riarriva.
    app.productLive.handleNotify(JSON.stringify({ type: "revision", pageId: p.id, seq: p.seq + 7, kind: "edit", actorId: null, sessionId: null }));
    await new Promise((r) => setTimeout(r, 400));
    expect(b.frames.filter((f) => f.type === "revision")).toHaveLength(1);
    b.close();
  });

  it("chi non vede la pagina: 404 sullo stream e sul battito", async () => {
    const p = await page();
    const outsider = await createUserWithSession(app, `out-live-${randomUUID().slice(0, 6)}@example.com`);
    const res = await fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: outsider.headers.cookie } });
    expect(res.status).toBe(404);
    expect((await inject(outsider, "POST", `/api/product-pages/${p.id}/live/presence`, {})).statusCode).toBe(404);
  });
});
