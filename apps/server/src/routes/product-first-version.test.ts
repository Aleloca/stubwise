import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { driveFiles, emailProposals, instanceSettings, productDocJobs, productFirstVersions, productPages, productSectionHolds } from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeFirstVersionPage } from "@stubwise/notifications";
import type { ProductFirstVersionSources, ProductFirstVersionView, ProductPageView } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 11, F6 — la prima versione di Claude: le fonti viste da chi chiede,
// l'avvio (e i rifiuti), la lettura, «Accept this page», «Stop», «Undo».
// Le pagine le scrive lo scrittore VERO (`writeFirstVersionPage`), come il worker.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let ada: U;
let bea: U;
let vic: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ada = await createUserWithSession(app, "ada-fv@example.com");
  bea = await createUserWithSession(app, "bea-fv@example.com");
  vic = await createUserWithSession(app, "vic-fv@example.com");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const inject = (who: U, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });

/** Un progetto vuoto con Ada e Bea (developer) e Vic (viewer), un'email di ciascuna e un file del Drive. */
async function space() {
  const { projectId } = await seedRepository(t.db);
  await addMember(app, projectId, ada.id, "developer");
  await addMember(app, projectId, bea.id, "developer");
  await addMember(app, projectId, vic.id, "viewer");
  const adaMail = await seedEmailMessage(t.db, { userId: ada.id, subject: "Il cliente vuole i pagamenti a 60 giorni" });
  const beaMail = await seedEmailMessage(t.db, { userId: bea.id, subject: "Riservata di Bea" });
  for (const m of [adaMail, beaMail]) await t.db.insert(emailProposals).values({ emailMessageId: m.messageId, projectId, status: "proposed", classification: {} });
  const [file] = await t.db.insert(driveFiles).values({ projectId, number: 1, name: "Specifica.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `k-${randomUUID()}` } as typeof driveFiles.$inferInsert).returning();
  const [hidden] = await t.db.insert(driveFiles).values({ projectId, number: 2, name: "Nascosto.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `k-${randomUUID()}`, hidden: true } as typeof driveFiles.$inferInsert).returning();
  return { projectId, adaMail, beaMail, file: file!, hidden: hidden! };
}
type Space = Awaited<ReturnType<typeof space>>;

const view = async (who: U, s: Space) => {
  const res = await inject(who, "GET", `/api/projects/${s.projectId}/product/first-version`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ProductFirstVersionView | null;
};
const start = (who: U, s: Space, sources: object[]) => inject(who, "POST", `/api/projects/${s.projectId}/product/first-version`, { sources });

/** La bozza che il worker avrebbe salvato, e le sue pagine scritte. */
async function draftAndWrite(groupId: string, pages = [{ title: "Overview", depth: 0 }, { title: "Pagamenti", depth: 1 }, { title: "Spedizioni", depth: 0 }], upTo = pages.length) {
  const draft = pages.map((p) => ({ ...p, blocks: [{ id: "draft", type: "paragraph", content: { text: `Su ${p.title}.`, marks: [] } }] }));
  await t.db.update(productFirstVersions).set({ draft, plan: pages }).where(eq(productFirstVersions.id, groupId));
  for (let i = 0; i < upTo; i++) await writeFirstVersionPage(t.db, groupId, i);
}

describe("le fonti", () => {
  it("chi chiede vede SOLO la sua posta (mai quella di un altro, admin o no) e i file visibili, non i nascosti", async () => {
    const s = await space();
    const res = await inject(ada, "GET", `/api/projects/${s.projectId}/product/first-version/sources`);
    expect(res.statusCode).toBe(200);
    const sources = res.json() as ProductFirstVersionSources;
    expect(sources.emails.map((e) => e.id)).toEqual([s.adaMail.messageId]);
    expect(sources.files.map((f) => f.id)).toEqual([s.file.id]);
    expect(res.body).not.toContain("Riservata di Bea");
  });
});

describe("l'avvio", () => {
  it("rifiuti: l'email di un altro (422 invalid_source), nessuna fonte (422), chi legge soltanto (403), il budget finito (409 ai_blocked)", async () => {
    const s = await space();
    expect((await start(ada, s, [{ kind: "email", id: s.beaMail.messageId }])).json()).toMatchObject({ code: "invalid_source" });
    expect((await start(ada, s, [{ kind: "drive", fileId: s.hidden.id }])).json()).toMatchObject({ code: "invalid_source" });
    expect((await start(ada, s, [{ kind: "text", text: "   " }])).json()).toMatchObject({ code: "no_sources" });
    expect((await start(vic, s, [{ kind: "text", text: "note" }])).statusCode).toBe(403);
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "0" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "0" } });
    try {
      expect((await start(ada, s, [{ kind: "text", text: "note" }])).json()).toMatchObject({ code: "ai_blocked" });
    } finally {
      await t.db.delete(instanceSettings);
    }
    expect(await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.projectId, s.projectId))).toEqual([]);
  });

  it("parte: la riga e il lavoro della coda; il testo incollato c'è solo per il lavoro; uno spazio non vuoto è 409", async () => {
    const s = await space();
    const res = await start(ada, s, [{ kind: "email", id: s.adaMail.messageId }, { kind: "drive", fileId: s.file.id }, { kind: "text", text: "Le mie note" }]);
    expect(res.statusCode, res.body).toBe(202);
    const { groupId } = res.json() as { groupId: string };
    const [fv] = await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, groupId));
    expect(fv).toMatchObject({ status: "writing", startedBy: ada.id, pastedText: "Le mie note", sources: [{ kind: "email", id: s.adaMail.messageId }, { kind: "drive", fileId: s.file.id }, { kind: "text" }] });
    expect(await t.db.select().from(productDocJobs).where(eq(productDocJobs.sourceId, groupId))).toHaveLength(1);
    // Una seconda mentre la prima scrive.
    expect((await start(bea, s, [{ kind: "text", text: "x" }])).json()).toMatchObject({ code: "space_not_empty" });
    const other = await space();
    await t.db.insert(productPages).values({ projectId: other.projectId, title: "C'è già", blocks: [] });
    expect((await start(ada, other, [{ kind: "text", text: "x" }])).json()).toMatchObject({ code: "space_not_empty" });
  });
});

describe("la lettura, «Accept this page», «Stop»", () => {
  it("le pagine con lo stato, le fonti nella forma di chi guarda (l'email di Ada senza oggetto per Bea), la riga in cima finché non si accetta", async () => {
    const s = await space();
    const { groupId } = (await start(ada, s, [{ kind: "email", id: s.adaMail.messageId }, { kind: "text", text: "n" }])).json() as { groupId: string };
    expect(await view(ada, s)).toMatchObject({ status: "writing", pagesDone: 0, permissions: { edit: true, stop: true } });
    await draftAndWrite(groupId, undefined, 2);
    let v = (await view(bea, s))!;
    expect(v).toMatchObject({ status: "writing", pagesDone: 2, pagesTotal: 3, byId: ada.id, byName: "ada-fv", interrupted: false });
    expect(v.pages.map((p) => p.state)).toEqual(["written", "written", "writing"]);
    expect(v.pages[0]!.code).toMatch(/-D\d+$/);
    expect(v.sources).toEqual([expect.objectContaining({ kind: "email", canOpen: false, title: null }), expect.objectContaining({ kind: "text", canOpen: false })]);
    expect(JSON.stringify(v)).not.toContain("pagamenti a 60 giorni");
    expect((await view(ada, s))!.sources[0]).toMatchObject({ canOpen: true, title: "Il cliente vuole i pagamenti a 60 giorni" });
    expect(v.bannerPageIds).toHaveLength(2);
    // La gerarchia: «Pagamenti» sotto «Overview».
    const pages = await t.db.select().from(productPages).where(eq(productPages.projectId, s.projectId));
    expect(pages.find((p) => p.title === "Pagamenti")!.parentId).toBe(pages.find((p) => p.title === "Overview")!.id);
    expect((await inject(bea, "POST", `/api/product-pages/${v.pages[0]!.pageId}/first-version/accept`)).statusCode).toBe(204);
    v = (await view(ada, s))!;
    expect(v.bannerPageIds).toEqual([v.pages[1]!.pageId]);
    expect(v.acceptedPageIds).toEqual([v.pages[0]!.pageId]);
    // «Stop»: la pagina dopo non si scrive, la prima versione finisce interrotta.
    expect((await inject(ada, "POST", `/api/projects/${s.projectId}/product/first-version/stop`)).statusCode).toBe(204);
    expect(await writeFirstVersionPage(t.db, groupId, 2)).toEqual({ kind: "stopped" });
    expect(await view(ada, s)).toMatchObject({ status: "done", interrupted: true, pagesDone: 2, permissions: { stop: false } });
    expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, groupId)))[0]!.pastedText).toBeNull();
  });

  it("«Accept» di una pagina che non è della prima versione: 422", async () => {
    const s = await space();
    const { groupId } = (await start(ada, s, [{ kind: "text", text: "n" }])).json() as { groupId: string };
    await draftAndWrite(groupId);
    const created = (await inject(ada, "POST", `/api/projects/${s.projectId}/product/pages`, { title: "Mia" })).json() as { id: string };
    expect((await inject(ada, "POST", `/api/product-pages/${created.id}/first-version/accept`)).json()).toMatchObject({ code: "invalid_page" });
  });
});

describe("«Undo the first version»", () => {
  it("toglie tutte le sue pagine finché nessuno le ha toccate; poi è già annullata", async () => {
    const s = await space();
    const { groupId } = (await start(ada, s, [{ kind: "text", text: "n" }])).json() as { groupId: string };
    await draftAndWrite(groupId);
    expect((await view(bea, s))!.undo).toMatchObject({ enabled: true });
    expect((await inject(bea, "POST", `/api/projects/${s.projectId}/product/first-version/undo`)).statusCode).toBe(204);
    expect(await t.db.select().from(productPages).where(eq(productPages.projectId, s.projectId))).toEqual([]);
    expect(await view(ada, s)).toMatchObject({ status: "undone", bannerPageIds: [], undo: { enabled: false, reason: "already_undone" } });
    expect((await inject(bea, "POST", `/api/projects/${s.projectId}/product/first-version/undo`)).json()).toMatchObject({ code: "already_undone" });
  });

  it("dopo una modifica di una persona: 409 changed_after con chi, la pagina e come; le pagine restano", async () => {
    const s = await space();
    const { groupId } = (await start(ada, s, [{ kind: "text", text: "n" }])).json() as { groupId: string };
    await draftAndWrite(groupId);
    const [page] = await t.db.select().from(productPages).where(and(eq(productPages.title, "Spedizioni"), eq(productPages.projectId, s.projectId)));
    const pv = (await inject(bea, "GET", `/api/product-pages/by-code/${(await view(bea, s))!.pages[2]!.code}`)).json() as ProductPageView;
    const block = pv.blocks.at(-1)!;
    const edit = await inject(bea, "POST", `/api/product-pages/${page!.id}/ops`, { sessionId: "s", baseSeq: pv.seq, ops: [{ op: "set", block: { ...block, content: { text: "di Bea", marks: [] } } }] });
    expect(edit.statusCode, edit.body).toBe(200);
    await t.db.delete(productSectionHolds).where(eq(productSectionHolds.pageId, page!.id));
    const res = await inject(ada, "POST", `/api/projects/${s.projectId}/product/first-version/undo`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "changed_after", byId: bea.id, byName: "bea-fv", pageId: page!.id, pageTitle: "Spedizioni", touch: "edit" });
    expect(await t.db.select().from(productPages).where(eq(productPages.projectId, s.projectId))).toHaveLength(3);
  });
});
