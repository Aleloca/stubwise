import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { productPages, productSectionHolds, projectMembers, projects, roles, users } from "@stubwise/db";
import { PRODUCT_LIVE_NOTIFY, notifyProductWireframe } from "../services/product-live-notify.js";
import { saveProductBlocks } from "../services/product-docs-ops.js";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { parseProductLiveFrame, type ProductLiveFrame, type ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { actorAs, addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

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
  // Tempi corti per il test: permessi riletti ogni 200 ms, presenza che scade a 1,5 s.
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), productLive: { permsTtlMs: 200, presenceTtlMs: 1500 } });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-live@example.com");
  reader = await createUserWithSession(app, "reader-live@example.com");
  await addMember(app, projectId, editor.id, "developer");
  await addMember(app, projectId, reader.id, "viewer");
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  // Review di F4 (M12): la LISTEN vera, come index.ts, così le NOTIFY scritte nel DB arrivano al canale.
  await t.client.listen(PRODUCT_LIVE_NOTIFY, (payload) => app.productLive.handleNotify(payload));
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
    // Senza battiti la presenza scade (1,5 s nel test) e la lista torna vuota.
    expect(await b.wait((f) => f.type === "presence" && f.presence.length === 0, 5000)).toBeDefined();
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

  it("revisione del lotto 2, M4: nei frame chi scrive e chi tiene una sezione, se chi guarda non li conosce, sono `hidden-<n>` (né id né nome)", async () => {
    const p = await page();
    const [stranger] = await t.db.insert(users).values({ email: `stranger-live-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member", displayName: "Zorro" }).returning({ id: users.id });
    const b = await stream(reader, p.id);
    await b.wait((f) => f.type === "state");
    app.productLive.handleNotify(JSON.stringify({ type: "revision", pageId: p.id, seq: p.seq + 3, kind: "edit", actorId: stranger!.id, sessionId: null }));
    const rev = await b.wait((f) => f.type === "revision");
    expect(rev).toMatchObject({ actorId: expect.stringMatching(/^hidden-\d+$/) });
    await t.db.insert(productSectionHolds).values({ pageId: p.id, sectionId: "top", userId: stranger!.id, expiresAt: new Date(Date.now() + 60_000) });
    await app.productLive.refreshHolds(p.id);
    const hold = await b.wait((f) => f.type === "hold");
    expect(hold).toMatchObject({ hold: { sectionId: "top", by: { id: expect.stringMatching(/^hidden-\d+$/), name: null } } });
    expect(JSON.stringify(b.frames)).not.toContain(stranger!.id);
    expect(JSON.stringify(b.frames)).not.toContain("Zorro");
    // Chi si conosce resta vero (il primo caso del file: `actorId: editor.id`).
    b.close();
  });

  it("chi non vede la pagina: 404 sullo stream e sul battito", async () => {
    const p = await page();
    const outsider = await createUserWithSession(app, `out-live-${randomUUID().slice(0, 6)}@example.com`);
    const res = await fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: outsider.headers.cookie } });
    expect(res.status).toBe(404);
    expect((await inject(outsider, "POST", `/api/product-pages/${p.id}/live/presence`, {})).statusCode).toBe(404);
  });

  it("review di F4 (I3): aperture CONCORRENTI della stessa persona: ne passano 10, le altre 429", async () => {
    const p = await page();
    const who = await createUserWithSession(app, `conc-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, who.id, "viewer");
    const ctrls = Array.from({ length: 15 }, () => new AbortController());
    const res = await Promise.all(ctrls.map((c) => fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: who.headers.cookie }, signal: c.signal })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(10);
    expect(res.filter((r) => r.status === 429)).toHaveLength(5);
    for (const c of ctrls) c.abort();
  });

  it("review di F4 (M12): il tetto per pagina, 50 stream; il cinquantunesimo 429", async () => {
    const p = await page();
    const ctrls: AbortController[] = [];
    // Le risposte si TENGONO: una risposta abbandonata col corpo non letto può
    // essere raccolta e chiusa da Node, e il suo posto si libererebbe.
    const open: Response[] = [];
    for (let i = 0; i < 5; i++) {
      const who = await createUserWithSession(app, `cap-${i}-${randomUUID().slice(0, 6)}@example.com`);
      await addMember(app, projectId, who.id, "viewer");
      for (let k = 0; k < 10; k++) {
        const c = new AbortController();
        ctrls.push(c);
        const res = await fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: who.headers.cookie }, signal: c.signal });
        open.push(res);
        expect(res.status).toBe(200);
      }
    }
    expect(app.productLive.count(p.id)).toBe(50);
    const lastCtrl = new AbortController();
    ctrls.push(lastCtrl);
    const last = await fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: reader.headers.cookie }, signal: lastCtrl.signal });
    expect(last.status).toBe(429);
    for (const c of ctrls) c.abort();
    expect(open).toHaveLength(50);
  });

  it("review di F4 (I2): chi se ne va mentre lo stream si apre non resta nei tetti", async () => {
    const p = await page();
    for (let i = 0; i < 12; i++) {
      const c = new AbortController();
      const f = fetch(`${base}/api/product-pages/${p.id}/live`, { headers: { cookie: reader.headers.cookie }, signal: c.signal }).catch(() => undefined);
      setTimeout(() => c.abort(), i % 3);
      await f;
    }
    const deadline = Date.now() + 3000;
    while (app.productLive.count(p.id) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(app.productLive.count(p.id)).toBe(0);
    // E la persona apre ancora uno stream (nessun orfano che le occupi i 10 posti).
    const s2 = await stream(reader, p.id);
    expect(s2.res.status).toBe(200);
    s2.close();
  });

  it("review di F4 (I6): un progetto eliminato chiude lo stream anche a un full admin", async () => {
    const { projectId: doomed } = await seedRepository(t.db);
    const created = (await inject(editor, "POST", `/api/projects/${doomed}/product/pages`, { title: "Condannata" }).catch(() => null))?.json() as { id: string } | undefined;
    const admin = await createUserWithSession(app, `adm-${randomUUID().slice(0, 6)}@example.com`);
    const [adminRole] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin"));
    await t.db.update(users).set({ instanceRoleId: adminRole!.id }).where(eq(users.id, admin.id));
    const pageId = created?.id ?? (await t.db.insert(productPages).values({ projectId: doomed, title: "Condannata" }).returning())[0]!.id;
    const s2 = await stream(admin, pageId);
    expect(await s2.wait((f) => f.type === "state")).toBeDefined();
    await t.db.delete(projects).where(eq(projects.id, doomed));
    expect(await s2.wait((f) => f.type === "gone", 3000)).toBeDefined();
  });

  it("review di F4 (M12): una scrittura che arriva SOLO dalla NOTIFY vera (pg_notify + LISTEN) porta la revisione, senza operazioni", async () => {
    const p = await page();
    const b = await stream(reader, p.id);
    await b.wait((f) => f.type === "state");
    // Scrive il servizio, senza la rotta: come farà il worker (F5).
    const saved = await saveProductBlocks(t.db, actorAs(editor.id, "member"), p.id, { sessionId: "srv", baseSeq: p.seq, ops: [{ op: "set", block: { id: p.first, type: "paragraph", content: { text: "Dal servizio", marks: [] } } }] });
    expect(await b.wait((f) => f.type === "revision")).toMatchObject({ seq: saved.seq, ops: [], sessionId: "srv" });
    b.close();
  });

  it("F6 (46 sul Task 3): il frame `wireframe` dalla NOTIFY vera, con il payload del worker; un'altra pagina non lo riceve", async () => {
    const p = await page();
    const other = await page();
    const b = await stream(reader, p.id);
    const o = await stream(reader, other.id);
    await b.wait((f) => f.type === "state");
    await o.wait((f) => f.type === "state");
    const wireframeId = randomUUID();
    // Lo stesso SQL del worker (`apps/worker/src/product-docs/wireframe.ts`, `notifyWireframe`), nel DB: nessuna chiamata a `handleNotify`.
    await t.db.execute(sql`select pg_notify('product_page_events', ${JSON.stringify({ type: "wireframe", pageId: p.id, wireframeId, status: "ready" })})`);
    expect(await b.wait((f) => f.type === "wireframe")).toEqual({ type: "wireframe", wireframeId, status: "ready" });
    // E quello del server («Redraw» rimette `drawing`).
    await notifyProductWireframe(t.db, { pageId: p.id, wireframeId, status: "drawing" });
    expect(await b.wait((f) => f.type === "wireframe" && f.status === "drawing")).toEqual({ type: "wireframe", wireframeId, status: "drawing" });
    await new Promise((r) => setTimeout(r, 300));
    expect(o.frames.filter((f) => f.type === "wireframe")).toEqual([]);
    b.close();
    o.close();
  });

  it("review di F4 (I4): il battito vuole una sezione VERA della pagina, e una persona tiene al più una sezione", async () => {
    const p = await page();
    expect((await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: "blk-inventata" })).statusCode).toBe(422);
    const heading = `blk-${randomUUID()}`;
    await inject(editor, "POST", `/api/product-pages/${p.id}/ops`, { sessionId: "h", baseSeq: p.seq, ops: [{ op: "insert", afterId: p.first, block: { id: heading, type: "heading", level: 2, content: { text: "Sezione", marks: [] } } }] });
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    expect((await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: "top" })).json()).toMatchObject({ hold: { sectionId: "top" } });
    expect((await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { sectionId: heading })).json()).toMatchObject({ hold: { sectionId: heading } });
    const held = await t.db.select({ sectionId: productSectionHolds.sectionId }).from(productSectionHolds).where(and(eq(productSectionHolds.pageId, p.id), eq(productSectionHolds.userId, editor.id)));
    expect(held.map((h) => h.sectionId)).toEqual([heading]);
  });

  it("review di F4 (M4): due schede della stessa persona: quella che non scrive non lascia la presa dell'altra", async () => {
    const p = await page();
    await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { sessionId: "scheda-1", sectionId: "top" });
    await inject(editor, "POST", `/api/product-pages/${p.id}/live/presence`, { sessionId: "scheda-2", sectionId: null });
    const held = await t.db.select().from(productSectionHolds).where(eq(productSectionHolds.pageId, p.id));
    expect(held.map((h) => [h.sectionId, h.userId])).toEqual([["top", editor.id]]);
  });

  it("revisione del lotto 1: il modulo Docs spento a stream aperto: `gone` e lo stream si chiude", async () => {
    const p = await page();
    const m = await createUserWithSession(app, `mod-live-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, m.id, "viewer");
    const s = await stream(m, p.id);
    await s.wait((f) => f.type === "state");
    await t.db.update(projects).set({ modules: ["releases"] }).where(eq(projects.id, projectId));
    try {
      expect(await s.wait((f) => f.type === "gone", 3000)).toBeDefined();
      await s.done;
      expect(s.isEnded()).toBe(true);
    } finally {
      await t.db.update(projects).set({ modules: ["docs", "releases", "support", "servers"] }).where(eq(projects.id, projectId));
    }
  });

  it("review di F4 (M5): chi perde `docs.view` esce dalla presenza al giro, senza aspettare la scadenza", async () => {
    const p = await page();
    const d = await createUserWithSession(app, `d-live-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, d.id, "viewer");
    await inject(d, "POST", `/api/product-pages/${p.id}/live/presence`, {});
    const b = await stream(editor, p.id);
    expect(await b.wait((f) => f.type === "state")).toMatchObject({ presence: [{ userId: d.id }] });
    const [blind] = await t.db.insert(roles).values({ name: `Cieco ${randomUUID().slice(0, 4)}`, scope: "project", permissions: ["tickets.view_all"] }).returning({ id: roles.id });
    await t.db.update(projectMembers).set({ roleId: blind!.id }).where(and(eq(projectMembers.userId, d.id), eq(projectMembers.projectId, projectId)));
    // Prima della scadenza (1,5 s): il giro (200 ms) la toglie.
    expect(await b.wait((f) => f.type === "presence" && f.presence.every((x) => x.userId !== d.id), 1200)).toBeDefined();
    b.close();
  });
});
