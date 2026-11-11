import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatChannels, chatMessageCitations, chatMessages, docGenerations, docPageCodes, docPages, projects, repositories } from "./schema.js";
import { ensureDocPageCodes } from "./doc-page-codes.js";
import { seedRepository, seedRepositoryInProject, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0142 (11 nov 2026, area 5, fetta 1): i codici `<PRJ>-D<n>` delle
 * pagine Docs, stabili alle rigenerazioni. Un codice per (repository, slug),
 * numerato per progetto, dato da un TRIGGER a ogni pagina nuova che non sia una
 * nota di rilascio. Il backfill delle pagine e delle citazioni della Chat sta
 * nella migrazione (provato dal suo SQL, qui sotto, con le pagine di prima).
 */

let t: TestDb;
let projectId: string;
let repositoryId: string;

beforeAll(async () => {
  t = await startTestDb();
  ({ projectId, repositoryId } = await seedRepository(t.db));
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function generation(repo: string): Promise<string> {
  const [g] = await t.db.insert(docGenerations).values({ repositoryId: repo, status: "succeeded" }).returning({ id: docGenerations.id });
  return g!.id;
}
async function codeOf(repo: string, slug: string) {
  const [row] = await t.db
    .select()
    .from(docPageCodes)
    .where(and(eq(docPageCodes.repositoryId, repo), eq(docPageCodes.slug, slug)));
  return row ?? null;
}

describe("0142 i codici delle pagine Docs", () => {
  it("una pagina nuova prende il codice dopo l'ultimo del progetto; una rigenerazione con lo stesso slug lo tiene", async () => {
    const g1 = await generation(repositoryId);
    await t.db.insert(docPages).values([
      { repositoryId, generationId: g1, kind: "technical", slug: "overview", title: "Overview" },
      { repositoryId, generationId: g1, kind: "functional", slug: "login", title: "Login" },
    ]);
    const overview = await codeOf(repositoryId, "overview");
    const login = await codeOf(repositoryId, "login");
    expect(overview).toMatchObject({ projectId, number: 1 });
    expect(login).toMatchObject({ projectId, number: 2 });
    // La generazione dopo: righe nuove, stessi slug, stessi codici; uno slug nuovo prende il 3.
    const g2 = await generation(repositoryId);
    await t.db.insert(docPages).values([
      { repositoryId, generationId: g2, kind: "technical", slug: "overview", title: "Overview (nuova)" },
      { repositoryId, generationId: g2, kind: "functional", slug: "logout", title: "Logout" },
    ]);
    expect((await codeOf(repositoryId, "overview"))!.id).toBe(overview!.id);
    expect(await codeOf(repositoryId, "logout")).toMatchObject({ number: 3 });
    // La potatura della generazione vecchia non tocca i codici.
    await t.db.delete(docGenerations).where(eq(docGenerations.id, g1));
    expect((await codeOf(repositoryId, "login"))!.id).toBe(login!.id);
  });

  it("le pagine manuali prendono il codice; le note di rilascio no; un numero non si riusa", async () => {
    const [manual] = await t.db
      .insert(docPages)
      .values({ repositoryId, kind: "manual", slug: "runbook", title: "Runbook", isManual: true })
      .returning({ id: docPages.id });
    const runbook = await codeOf(repositoryId, "runbook");
    expect(runbook).not.toBeNull();
    await t.db.insert(docPages).values({ repositoryId, kind: "releases", slug: "release-20261111-0900-abc1234", title: "Release" });
    expect(await codeOf(repositoryId, "release-20261111-0900-abc1234")).toBeNull();
    // Eliminata la pagina, il codice resta: un'altra pagina con un altro slug prende il numero dopo.
    await t.db.delete(docPages).where(eq(docPages.id, manual!.id));
    expect((await codeOf(repositoryId, "runbook"))!.number).toBe(runbook!.number);
    await t.db.insert(docPages).values({ repositoryId, kind: "manual", slug: "oncall", title: "On call", isManual: true });
    expect((await codeOf(repositoryId, "oncall"))!.number).toBe(runbook!.number + 1);
  });

  it("la numerazione è per progetto: un altro repository dello stesso progetto continua la serie, un altro progetto riparte da 1", async () => {
    const repo2 = await seedRepositoryInProject(t.db, projectId);
    const before = (await t.db.select({ n: docPageCodes.number }).from(docPageCodes).where(eq(docPageCodes.projectId, projectId)).orderBy(asc(docPageCodes.number))).at(-1)!.n;
    await t.db.insert(docPages).values({ repositoryId: repo2, kind: "manual", slug: "overview", title: "Overview 2", isManual: true });
    expect(await codeOf(repo2, "overview")).toMatchObject({ projectId, number: before + 1 });
    const other = await seedRepository(t.db);
    await t.db.insert(docPages).values({ repositoryId: other.repositoryId, kind: "manual", slug: "overview", title: "Altro", isManual: true });
    expect(await codeOf(other.repositoryId, "overview")).toMatchObject({ projectId: other.projectId, number: 1 });
    const [p] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, other.projectId));
    expect(p!.code).toMatch(/^[A-Z]/);
  });

  it("molte pagine in una transazione (una generazione) prendono numeri distinti in ordine", async () => {
    const repo3 = await seedRepositoryInProject(t.db, projectId);
    const g = await generation(repo3);
    const started = performance.now();
    await t.db.insert(docPages).values(Array.from({ length: 300 }, (_, i) => ({ repositoryId: repo3, generationId: g, kind: "technical" as const, slug: `p-${i}`, title: `P ${i}` })));
    console.log(`[0142] 300 pagine in un INSERT: ${(performance.now() - started).toFixed(0)} ms`);
    const numbers = (await t.db.select({ n: docPageCodes.number }).from(docPageCodes).where(eq(docPageCodes.repositoryId, repo3))).map((r) => r.n);
    expect(new Set(numbers).size).toBe(300);
  });

  it("una transazione LUNGA che inserisce pagine coi codici già dati da `ensureDocPageCodes` non blocca una pagina manuale nuova dello stesso progetto", async () => {
    const repo4 = await seedRepositoryInProject(t.db, projectId);
    const g = await generation(repo4);
    const slugs = ["long-a", "long-b"];
    // Il passo breve, fuori dalla transazione lunga (come finalize e il giro notturno).
    await ensureDocPageCodes(t.db, repo4, slugs);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => (inserted = r));
    const long = t.db.transaction(async (tx) => {
      await tx.insert(docPages).values(slugs.map((slug) => ({ repositoryId: repo4, generationId: g, kind: "technical" as const, slug, title: slug })));
      inserted();
      await gate; // gli embedding: minuti, in produzione
    });
    try {
      await didInsert;
      const manual = t.db.insert(docPages).values({ repositoryId: repositoryId, kind: "manual", slug: "while-long", title: "Mentre", isManual: true });
      const outcome = await Promise.race([manual.then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 3000))]);
      expect(outcome).toBe("done");
      expect(await codeOf(repositoryId, "while-long")).not.toBeNull();
    } finally {
      release();
      await long;
    }
    const numbers = (await t.db.select({ n: docPageCodes.number }).from(docPageCodes).where(eq(docPageCodes.projectId, projectId))).map((r) => r.n);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(await codeOf(repo4, "long-a")).not.toBeNull();
  });

  it("`ensureDocPageCodes` è idempotente: un codice per slug, una volta sola, in numeri consecutivi", async () => {
    const repo5 = await seedRepositoryInProject(t.db, projectId);
    await ensureDocPageCodes(t.db, repo5, ["x", "y", "x"]);
    const first = await codeOf(repo5, "x");
    await ensureDocPageCodes(t.db, repo5, ["x", "z"]);
    expect((await codeOf(repo5, "x"))!.id).toBe(first!.id);
    const numbers = (await t.db.select({ n: docPageCodes.number }).from(docPageCodes).where(eq(docPageCodes.repositoryId, repo5))).map((r) => r.n).sort((a, b) => a - b);
    expect(numbers).toHaveLength(3);
    expect(numbers[1]).toBe(numbers[0]! + 1);
    await ensureDocPageCodes(t.db, repo5, []);
  });

  it("il backfill dei codici: le pagine visibili, per repository, tipo e posizione; le generazioni vecchie no", async () => {
    const { projectId: p, repositoryId: r } = await seedRepository(t.db);
    const old = await generation(r);
    const current = await generation(r);
    await t.db.update(repositories).set({ currentDocGenerationId: current }).where(eq(repositories.id, r));
    await t.db.insert(docPages).values([
      { repositoryId: r, generationId: old, kind: "technical", slug: "vecchia", title: "Vecchia" },
      { repositoryId: r, generationId: current, kind: "functional", slug: "b", title: "B", position: 0 },
      { repositoryId: r, generationId: current, kind: "technical", slug: "a2", title: "A2", position: 1 },
      { repositoryId: r, generationId: current, kind: "technical", slug: "a1", title: "A1", position: 0 },
      { repositoryId: r, kind: "manual", slug: "m", title: "M", isManual: true },
    ]);
    // Come prima della 0142: nessun codice.
    await t.db.delete(docPageCodes).where(eq(docPageCodes.projectId, p));
    await t.db.execute(sql`select stubwise_backfill_doc_page_codes()`);
    const codes = await t.db.select().from(docPageCodes).where(eq(docPageCodes.projectId, p)).orderBy(asc(docPageCodes.number));
    expect(codes.map((c) => [c.slug, c.number])).toEqual([
      ["a1", 1],
      ["a2", 2],
      ["b", 3],
      ["m", 4],
    ]);
    // Idempotente.
    await t.db.execute(sql`select stubwise_backfill_doc_page_codes()`);
    expect(await t.db.select().from(docPageCodes).where(eq(docPageCodes.projectId, p))).toHaveLength(4);
  });

  it("il backfill delle citazioni della Chat: dall'id della pagina all'id del codice; una pagina che non c'è più se ne va", async () => {
    const [g] = await t.db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
    const [msg] = await t.db.insert(chatMessages).values({ channelId: g!.id, body: "vedi Overview" }).returning({ id: chatMessages.id });
    const [page] = await t.db
      .select({ id: docPages.id })
      .from(docPages)
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.slug, "overview")))
      .limit(1);
    const gone = crypto.randomUUID();
    await t.db.insert(chatMessageCitations).values([
      { messageId: msg!.id, kind: "doc", refId: page!.id, position: 0 },
      { messageId: msg!.id, kind: "doc", refId: gone, position: 1 },
    ]);
    await t.db.execute(sql`select stubwise_doc_citations_to_codes()`);
    const rows = await t.db.select().from(chatMessageCitations).where(eq(chatMessageCitations.messageId, msg!.id));
    expect(rows.map((r) => r.refId)).toEqual([(await codeOf(repositoryId, "overview"))!.id]);
  });
});
