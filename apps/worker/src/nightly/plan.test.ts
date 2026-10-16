import {
  commitSummaries,
  docGenerations,
  docPagePendingCommits,
  docPages,
  nightlyItems,
  repositories,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ReleaseNotes } from "@stubwise/docs-engine";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeSelect } from "../providers/select-fake.js";
import {
  fakeNightlyDeps,
  fakeNightlyRepo,
  seedCommitSummary,
  seedCurrentGeneration,
  seedGenerationPage,
  sha,
} from "./nightly-fake.js";
import { isPlanSkip, planDocs, planPages, SUPERSEDED_BY_GENERATION, type DocsPlan } from "./plan.js";
import { enqueueItems, upsertTargetItems } from "./queue.js";
import type { NightlyDeps } from "./types.js";

let testDb: TestDb;
let repositoryId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ repositoryId, projectId } = await seedRepository(testDb.db));
}, 120_000);

afterEach(async () => {
  const db = testDb.db;
  await db.delete(docPagePendingCommits);
  await db.delete(nightlyItems);
  await db.update(repositories).set({ currentDocGenerationId: null });
  await db.delete(docPages);
  await db.delete(docGenerations);
  await db.delete(commitSummaries);
});

afterAll(async () => {
  await testDb.stop();
});

const NIGHT = "2026-10-16";
const NOW = new Date("2026-10-16T00:30:00Z");
const BOOKMARK = sha("0");
const HEAD = sha("f");

interface MirrorScript {
  commits: string[];
  headSha?: string;
  fallback?: boolean;
  /** sha → antenato del commit della generazione? */
  ancestors?: Set<string>;
}

function makeDeps(m: MirrorScript, o: { alertRuns?: number; publish?: NightlyDeps["publish"]; log?: (s: string) => void } = {}) {
  const listDefaultBranchCommitsSince = vi.fn(async () => ({
    commits: m.commits,
    headSha: m.headSha ?? HEAD,
    fallback: m.fallback ?? false,
  }));
  const isAncestor = vi.fn(async (_p: unknown, a: string) => m.ancestors?.has(a) ?? false);
  const run = vi.fn();
  const deps = fakeNightlyDeps(testDb.db, {
    runner: { run },
    mirrors: { listDefaultBranchCommitsSince, isAncestor } as never,
    select: fakeSelect(testDb.db, "legacy"),
    config: o.alertRuns !== undefined ? { alertRuns: o.alertRuns } : {},
    ...(o.publish ? { publish: o.publish } : {}),
    ...(o.log ? { log: o.log } : {}),
    now: () => NOW,
  });
  return { deps, listDefaultBranchCommitsSince, isAncestor, run };
}

const repoFor = (generationId: string | null) => fakeNightlyRepo(repositoryId, projectId, generationId);

async function plan(deps: NightlyDeps, generationId: string): Promise<DocsPlan> {
  const p = await planDocs(deps, repoFor(generationId));
  if (isPlanSkip(p)) throw new Error(`piano saltato: ${p.skipped}`);
  return p;
}

async function items(db: Db, phase?: "page_update" | "page_create" | "release") {
  const rows = await db.select().from(nightlyItems).where(eq(nightlyItems.repositoryId, repositoryId));
  return phase ? rows.filter((r) => r.phase === phase) : rows;
}

async function summary(db: Db, s: string) {
  const [row] = await db
    .select()
    .from(commitSummaries)
    .where(and(eq(commitSummaries.repositoryId, repositoryId), eq(commitSummaries.sha, s)));
  return row!;
}

function notes(affectedSlugs: string[]): ReleaseNotes {
  return { significant: true, title: "T", body: "B", affectedSlugs };
}

describe("planDocs: salti", () => {
  it("nessuna generazione corrente → no_generation, nessun git", async () => {
    const { deps, listDefaultBranchCommitsSince } = makeDeps({ commits: [] });
    expect(await planDocs(deps, repoFor(null))).toEqual({ skipped: "no_generation" });
    expect(listDefaultBranchCommitsSince).not.toHaveBeenCalled();
  });

  it("generazione completa running/paused sul repository → generation_running", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await testDb.db.insert(docGenerations).values({ repositoryId, status: "paused" });
    const { deps, listDefaultBranchCommitsSince } = makeDeps({ commits: [] });
    expect(await planDocs(deps, repoFor(gen))).toEqual({ skipped: "generation_running" });
    expect(listDefaultBranchCommitsSince).not.toHaveBeenCalled();
  });
});

describe("planDocs: commit in produzione", () => {
  it("branch vecchio mergiato tardi (Review Focus #1): tutti i suoi commit nel piano, missingSummaries per quello fuori finestra", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    const auth = await seedGenerationPage(db, repositoryId, gen, { slug: "auth", sourcePath: "src/auth" });
    const billing = await seedGenerationPage(db, repositoryId, gen, { slug: "billing", sourcePath: "src/billing" });
    const fresh = sha("c");
    const old20 = sha("b"); // 20 giorni fa: riassunto c'è, ma non era in produzione
    const old40 = sha("a"); // 40 giorni fa: fuori dalla finestra, nessun riassunto
    await seedCommitSummary(db, repositoryId, fresh, { files: ["src/auth/login.ts", "pnpm-lock.yaml"] });
    await seedCommitSummary(db, repositoryId, old20, {
      files: ["src/new-area/x.ts", "src/new-area/y.ts"],
      committedAt: new Date("2026-09-26T10:00:00Z"),
    });
    const { deps, listDefaultBranchCommitsSince } = makeDeps({ commits: [fresh, old20, old40] });

    const p = await plan(deps, gen);

    expect(listDefaultBranchCommitsSince).toHaveBeenCalledWith(
      expect.anything(),
      BOOKMARK,
      new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
      { skipFetch: true },
    );
    expect(p).toMatchObject({ generationId: gen, fromSha: BOOKMARK, toSha: HEAD, commits: [fresh, old20, old40] });
    expect(p.missingSummaries).toEqual([old40]);
    expect(p.changedFiles).toEqual(["src/auth/login.ts", "src/new-area/x.ts", "src/new-area/y.ts"]);
    expect(p.mapped.map((m) => m.id)).toEqual([auth]);
    expect(p.newAreas).toEqual(["src/new-area/x.ts", "src/new-area/y.ts"]);
    expect((await summary(db, fresh)).onDefaultBranch).toBe(true);
    expect((await summary(db, old20)).onDefaultBranch).toBe(true);

    // La fase 1 scrive il riassunto mancante; planPages lo vede e lo segna in produzione.
    await seedCommitSummary(db, repositoryId, old40, {
      files: ["src/billing/invoice.ts"],
      committedAt: new Date("2026-09-06T10:00:00Z"),
    });
    const r = await planPages(deps, repoFor(gen), p, null, NIGHT);
    expect(r).toEqual({ candidates: 2, newAreas: 1, alarm: false });
    expect((await summary(db, old40)).onDefaultBranch).toBe(true);
    const updates = await items(db, "page_update");
    const billingItem = updates.find((i) => i.payload.pageId === billing)!;
    expect(billingItem.key).toBe(`${billing}@${HEAD}`);
    expect(billingItem.payload).toMatchObject({
      generationId: gen,
      fromSha: BOOKMARK,
      toSha: HEAD,
      files: ["src/billing/invoice.ts"],
      commits: [old40],
      via: "map",
    });
    const creates = await items(db, "page_create");
    expect(creates.map((c) => c.key)).toEqual([`src/new-area@${HEAD}`]);
    expect(creates[0]!.payload).toEqual({
      generationId: gen,
      toSha: HEAD,
      area: "src/new-area",
      files: ["src/new-area/x.ts", "src/new-area/y.ts"],
    });
  });

  it("segnalibro non più nel branch di default → riga di log del ripiego", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const log = vi.fn();
    const { deps } = makeDeps({ commits: [], fallback: true }, { log });
    await plan(deps, gen);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ripiego"));
  });
});

describe("planPages", () => {
  it("candidate = mappa ∪ nota, con i file di D13 per pagina, genitore e pagina della nota", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    const overview = await seedGenerationPage(db, repositoryId, gen, { slug: "overview" });
    const auth = await seedGenerationPage(db, repositoryId, gen, {
      slug: "auth",
      sourcePath: "src/auth",
      parentId: overview,
    });
    const guide = await seedGenerationPage(db, repositoryId, gen, { slug: "guide" });
    const ui = await seedGenerationPage(db, repositoryId, gen, { slug: "ui", sourcePath: "src/ui" });
    const c1 = sha("1");
    const c2 = sha("2");
    await seedCommitSummary(db, repositoryId, c1, { files: ["src/auth/a.ts"] });
    await seedCommitSummary(db, repositoryId, c2, { files: ["src/other/b.ts", "src/other/c.ts"] });
    const { deps } = makeDeps({ commits: [c1, c2] });
    const p = await plan(deps, gen);

    const r = await planPages(deps, repoFor(gen), p, notes(["guide", "auth", "invented"]), NIGHT);

    expect(r.candidates).toBe(3);
    const byPage = new Map((await items(db, "page_update")).map((i) => [i.payload.pageId, i.payload]));
    expect([...byPage.keys()].sort()).toEqual([auth, guide, overview].sort());
    expect(byPage.has(ui)).toBe(false);
    expect(byPage.get(auth)).toMatchObject({ via: "map", files: ["src/auth/a.ts"], commits: [c1] });
    expect(byPage.get(overview)).toMatchObject({ via: "parent", files: ["src/auth/a.ts"], commits: [c1] });
    // Entra solo dalla nota e non copre niente: tutti i file e tutti i commit del piano.
    expect(byPage.get(guide)).toMatchObject({
      via: "note",
      files: ["src/auth/a.ts", "src/other/b.ts", "src/other/c.ts"],
      commits: [c1, c2],
    });
  });

  it("senza nota (fallita o assente): solo la mappa", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    const auth = await seedGenerationPage(db, repositoryId, gen, { slug: "auth", sourcePath: "src/auth" });
    await seedGenerationPage(db, repositoryId, gen, { slug: "guide" });
    await seedCommitSummary(db, repositoryId, sha("1"), { files: ["src/auth/a.ts"] });
    const { deps } = makeDeps({ commits: [sha("1")] });
    const p = await plan(deps, gen);
    expect(await planPages(deps, repoFor(gen), p, null, NIGHT)).toEqual({ candidates: 1, newAreas: 0, alarm: false });
    expect((await items(db, "page_update")).map((i) => i.payload.pageId)).toEqual([auth]);
  });

  it("commit pendenti di un'escalation (D31): solo la candidata li riceve, coi loro file", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    const auth = await seedGenerationPage(db, repositoryId, gen, { slug: "auth", sourcePath: "src/auth" });
    const ui = await seedGenerationPage(db, repositoryId, gen, { slug: "ui", sourcePath: "src/ui" });
    const old = sha("9");
    const oldUi = sha("8");
    await seedCommitSummary(db, repositoryId, old, { files: ["src/auth/old.ts", "src/ui/elsewhere.ts"], onDefaultBranch: true });
    await seedCommitSummary(db, repositoryId, oldUi, { files: ["src/ui/x.ts"], onDefaultBranch: true });
    await db.insert(docPagePendingCommits).values([
      { pageId: auth, repositoryId, sha: old },
      { pageId: ui, repositoryId, sha: oldUi },
    ]);
    const fresh = sha("1");
    await seedCommitSummary(db, repositoryId, fresh, { files: ["src/auth/a.ts"] });
    const { deps } = makeDeps({ commits: [fresh] });
    const p = await plan(deps, gen);

    await planPages(deps, repoFor(gen), p, null, NIGHT);

    const updates = await items(db, "page_update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      pageId: auth,
      commits: [fresh, old],
      // Del commit pendente, solo i file che la pagina copre (D13).
      files: ["src/auth/a.ts", "src/auth/old.ts"],
    });
  });

  it("allarme sopra soglia: pubblicato una volta sola per notte, e si procede", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedGenerationPage(db, repositoryId, gen, { slug: "auth", sourcePath: "src/auth" });
    await seedCommitSummary(db, repositoryId, sha("1"), { files: ["src/auth/a.ts", "lib/new/x.ts"] });
    await enqueueItems(db, [{ repositoryId, projectId, phase: "release", key: `${BOOKMARK}..${HEAD}` }], NIGHT);
    const publish = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
    const { deps } = makeDeps({ commits: [sha("1")] }, { alertRuns: 2, publish: publish as never });
    const p = await plan(deps, gen);

    // nota (1) + 1 pagina + 1 area = 3 > 2.
    expect(await planPages(deps, repoFor(gen), p, null, NIGHT)).toEqual({ candidates: 1, newAreas: 1, alarm: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![1]).toMatchObject({
      kind: "docs.nightly_attention",
      reason: "plan_oversized",
      repositoryId,
      night: NIGHT,
      counts: { commits: 1, candidates: 1, newAreas: 1 },
      runs: 3,
      threshold: 2,
      docsUrl: `https://stubwise.test/docs/${repositoryId}`,
    });
    expect(await items(db, "page_update")).toHaveLength(1);
    expect(await items(db, "page_create")).toHaveLength(1);

    // Rieseguita nella stessa notte: niente di nuovo, nessun secondo avviso.
    expect((await planPages(deps, repoFor(gen), p, null, NIGHT)).alarm).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("sotto soglia: nessun avviso", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedGenerationPage(db, repositoryId, gen, { slug: "auth", sourcePath: "src/auth" });
    await seedCommitSummary(db, repositoryId, sha("1"), { files: ["src/auth/a.ts"] });
    const publish = vi.fn(async () => undefined);
    const { deps } = makeDeps({ commits: [sha("1")] }, { alertRuns: 1, publish: publish as never });
    const p = await plan(deps, gen);
    expect((await planPages(deps, repoFor(gen), p, null, NIGHT)).alarm).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("planDocs: riallineamento dopo una rigenerazione completa (D32)", () => {
  it("elementi della generazione vecchia chiusi senza run, commit_sha nuovo intatto, documented_at per ascendenza esatta", async () => {
    const db = testDb.db;
    const oldGen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    const oldPage = await seedGenerationPage(db, repositoryId, oldGen, { slug: "auth", sourcePath: "src/auth" });
    const waiting = sha("1");
    const lateOld = sha("2"); // vecchio ma mergiato tardi: la data non lo dice, l'ascendenza sì
    const after = sha("3"); // arrivato DOPO la rigenerazione: non è antenato
    await seedCommitSummary(db, repositoryId, waiting, { files: ["src/auth/a.ts"], onDefaultBranch: true });
    await seedCommitSummary(db, repositoryId, lateOld, {
      files: ["src/auth/b.ts"],
      onDefaultBranch: true,
      committedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await seedCommitSummary(db, repositoryId, after, { files: ["src/auth/c.ts"], onDefaultBranch: true });
    // Notte 1, generazione vecchia: elementi pending (es. una pagina che fallisce).
    await upsertTargetItems(
      db,
      [
        {
          repositoryId,
          projectId,
          phase: "page_update",
          target: oldPage,
          toSha: sha("e"),
          payload: { generationId: oldGen, pageId: oldPage, commits: [waiting] },
        },
        {
          repositoryId,
          projectId,
          phase: "page_create",
          target: "lib/x",
          toSha: sha("e"),
          payload: { generationId: oldGen, area: "lib/x", files: [] },
        },
      ],
      "2026-10-15",
    );

    // Rigenerazione completa fra le due notti, al commit NEW_SHA (la contabilità
    // di finalizeGeneration non è girata).
    const NEW_SHA = sha("d");
    const newGen = await seedCurrentGeneration(db, repositoryId, NEW_SHA);
    await seedGenerationPage(db, repositoryId, newGen, { slug: "auth", sourcePath: "src/auth" });
    const { deps, run } = makeDeps({ commits: [after], ancestors: new Set([waiting, lateOld]) });

    const p = await plan(deps, newGen);

    expect(p.fromSha).toBe(NEW_SHA);
    expect(run).not.toHaveBeenCalled();
    const stale = await items(db);
    expect(stale).toHaveLength(2);
    for (const it of stale) {
      expect(it.status).toBe("done");
      expect(it.lastError).toBe(SUPERSEDED_BY_GENERATION);
    }
    const [g] = await db.select().from(docGenerations).where(eq(docGenerations.id, newGen));
    expect(g!.commitSha).toBe(NEW_SHA);
    expect((await summary(db, waiting)).documentedAt).not.toBeNull();
    expect((await summary(db, lateOld)).documentedAt).not.toBeNull();
    expect((await summary(db, after)).documentedAt).toBeNull();

    // Gli elementi nuovi portano la generazione nuova, e un secondo piano non li chiude.
    await planPages(deps, repoFor(newGen), p, null, NIGHT);
    await plan(deps, newGen);
    const fresh = (await items(db, "page_update")).filter((i) => i.status === "pending");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.payload.generationId).toBe(newGen);
  });
});
