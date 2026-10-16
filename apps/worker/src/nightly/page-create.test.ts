import { commitSummaries, docChunks, docGenerations, docPages, nightlyItems, repositories } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  GROW_PROPOSAL_END_MARKER,
  GROW_PROPOSAL_START_MARKER,
  mapAffectedPages,
} from "@stubwise/docs-engine";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sensitiveReadDenyRules } from "../agent/read-scope.js";
import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { fakeSelect } from "../providers/select-fake.js";
import type { SelectDeps } from "../providers/select.js";
import {
  fakeNightlyDeps,
  fakeNightlyRepo,
  seedCommitSummary,
  seedCurrentGeneration,
  seedGenerationPage,
  sha,
} from "./nightly-fake.js";
import { runPageCreateItem } from "./page-create.js";
import { advanceBookmarkIfDone } from "./page-update.js";
import { loadPageRefs, SUPERSEDED_BY_GENERATION, type DocsPlan } from "./plan.js";
import { claimNext, enqueueItems, releaseItem, upsertTargetItems, type NightlyItem } from "./queue.js";
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
const BOOKMARK = sha("0");
const HEAD = sha("f");
const WT = "/srv/none/stubwise-wt/repo";
const PROVIDER = { id: "p1", kind: "account" } as unknown as ResolvedProvider;
const BODY = [
  "### Cosa fa",
  "Il modulo di fatturazione emette le fatture dei clienti a fine mese, con abbastanza testo",
  "da superare la soglia minima di lunghezza di una pagina vera e non di uno stub.",
  "",
  "### Come funziona",
  "Calcola gli importi, applica l'IVA e salva il documento.",
].join("\n");

function ok(output: string): AgentRunResult {
  return { output, exitCode: 0, usage: { totalCostUsd: 0.25 } } as AgentRunResult;
}

function orientOutput(proposals: { title: string; kind?: string; parent?: string; paths: string }[]): string {
  return proposals
    .map((p) =>
      [
        GROW_PROPOSAL_START_MARKER,
        `title: ${p.title}`,
        `kind: ${p.kind ?? "technical"}`,
        `parent: ${p.parent ?? ""}`,
        `paths: ${p.paths}`,
        GROW_PROPOSAL_END_MARKER,
      ].join("\n"),
    )
    .join("\n");
}

const EXPLORED = [
  EXPLORE_BODY_START_MARKER,
  BODY,
  EXPLORE_BODY_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
].join("\n");

const isOrient = (prompt: string) => prompt.includes("deciding which NEW pages");

/** Il run finto: l'orient propone una pagina per l'area del prompt (titolo = area), l'explore scrive il corpo. */
async function defaultRun(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (isOrient(opts.prompt)) {
    const area = /- AREA (\S+):/.exec(opts.prompt)![1]!;
    return ok(orientOutput([{ title: `Area ${area}`, paths: area }]));
  }
  return ok(EXPLORED);
}

function makeDeps(o: { run?: (opts: AgentRunOptions) => Promise<AgentRunResult>; select?: SelectDeps } = {}) {
  const run = vi.fn(o.run ?? defaultRun);
  const base = fakeNightlyDeps(testDb.db, {
    runner: { run },
    mirrors: {},
    select: o.select ?? fakeSelect(testDb.db, [PROVIDER]),
  });
  const deps: NightlyDeps = { ...base, embeddingClient: createFakeEmbeddingClient() };
  return { deps, run };
}

const repo = () => fakeNightlyRepo(repositoryId, projectId, null);

async function enqueueArea(gen: string, area: string, files: string[], toSha = HEAD): Promise<void> {
  await upsertTargetItems(
    testDb.db,
    [
      {
        repositoryId,
        projectId,
        phase: "page_create",
        target: area,
        toSha,
        payload: { generationId: gen, toSha, area, files },
      },
    ],
    NIGHT,
  );
}

async function claim(): Promise<NightlyItem> {
  const item = await claimNext(testDb.db, repositoryId, "page_create");
  if (!item) throw new Error("nessun elemento");
  return item;
}

async function itemById(id: string) {
  const [row] = await testDb.db.select().from(nightlyItems).where(eq(nightlyItems.id, id));
  return row!;
}

async function pagesOf(gen: string) {
  return testDb.db.select().from(docPages).where(eq(docPages.generationId, gen));
}

async function chunkCount(pageId: string) {
  return (await testDb.db.select().from(docChunks).where(eq(docChunks.pageId, pageId))).length;
}

const BILLING = ["src/billing/invoice.ts", "src/billing/tax.ts"];

describe("runPageCreateItem", () => {
  it("area nuova → pagina creata nella generazione corrente, con chunk, sotto il genitore indicato e in coda; elemento done con resultPageId", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const parent = await seedGenerationPage(testDb.db, repositoryId, gen, { slug: "backend", title: "Backend" });
    await testDb.db.update(docPages).set({ position: 4 }).where(eq(docPages.id, parent));
    await testDb.db
      .update(docGenerations)
      .set({ stats: { pages: 1, chunks: 3, nodes: 9 }, cost: "1.000000" })
      .where(eq(docGenerations.id, gen));
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps, run } = makeDeps({
      run: async (opts) =>
        isOrient(opts.prompt)
          ? ok(orientOutput([{ title: "Fatturazione", parent: "backend", paths: "src/billing" }]))
          : ok(EXPLORED),
    });
    const item = await claim();

    expect(await runPageCreateItem(deps, repo(), WT, item)).toBe("created");
    expect(run).toHaveBeenCalledTimes(2);
    const created = (await pagesOf(gen)).find((p) => p.title === "Fatturazione")!;
    expect(created).toMatchObject({
      kind: "technical",
      parentId: parent,
      position: 5,
      sourcePath: "src/billing",
      body: BODY,
      repositoryId,
    });
    expect(await chunkCount(created.id)).toBeGreaterThan(0);
    const row = await itemById(item.id);
    expect(row.status).toBe("done");
    expect(row.claimedAt).toBeNull();
    expect(row.payload).toMatchObject({ outcome: "created", resultPageId: created.id, resultPageIds: [created.id] });
    const [g] = await testDb.db.select().from(docGenerations).where(eq(docGenerations.id, gen));
    expect(g!.stats).toMatchObject({ pages: 2, nodes: 9 });
    expect((g!.stats as { chunks: number }).chunks).toBeGreaterThan(3);
    expect(Number(g!.cost)).toBeCloseTo(1.5);
  });

  it("allowlist CHIUSA sui soli file dell'area, orient ed explore: default mode, cwd fuori dal worktree, nessun tetto, lingua della Docs", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await seedGenerationPage(testDb.db, repositoryId, gen, { slug: "panoramica", title: "Panoramica" });
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), {
      files: ["src/billing/invoice.ts"],
      subject: "feat: fatture",
      summary: "Aggiunge l'emissione delle fatture.",
      onDefaultBranch: true,
    });
    await seedCommitSummary(testDb.db, repositoryId, sha("2"), {
      files: ["src/other/x.ts"],
      summary: "Riassunto di un'altra area.",
      onDefaultBranch: true,
    });
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps, run } = makeDeps();
    await runPageCreateItem(deps, repo(), WT, await claim());

    expect(run).toHaveBeenCalledTimes(2);
    for (const [opts] of run.mock.calls) {
      expect(opts.permissionMode).toBe("default");
      expect(opts.model).toBe("sonnet");
      expect(opts.provider).toBe(PROVIDER);
      expect(opts.allowedTools).toEqual([
        `Read(/${WT}/src/billing/invoice.ts)`,
        `Grep(/${WT}/src/billing/invoice.ts)`,
        `Read(/${WT}/src/billing/tax.ts)`,
        `Grep(/${WT}/src/billing/tax.ts)`,
      ]);
      for (const bare of ["Read", "Grep", "Glob", "Write", "Edit", "Bash"]) expect(opts.allowedTools).not.toContain(bare);
      expect(opts.disallowedTools).toEqual(sensitiveReadDenyRules());
      expect(opts.cwd!.startsWith(WT)).toBe(false);
      expect(opts.prompt).toContain(`- ${WT}/src/billing/invoice.ts`);
      expect(opts.prompt).toContain("Aggiunge l'emissione delle fatture.");
      expect(opts.prompt).not.toContain("Riassunto di un'altra area.");
      expect(opts.prompt).toContain('"Panoramica"');
      expect(opts.prompt).toContain("do NOT switch to their language");
    }
    expect(run.mock.calls[0]![0].prompt).not.toContain("AT MOST");
  });

  it("due aree → due orient, due pagine; molte aree → nessun tetto", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const areas = Array.from({ length: 12 }, (_, i) => `app${i}/src`);
    for (const a of areas) await enqueueArea(gen, a, [`${a}/a.ts`, `${a}/b.ts`]);
    const { deps, run } = makeDeps();
    for (let i = 0; i < areas.length; i++) {
      expect(await runPageCreateItem(deps, repo(), WT, await claim())).toBe("created");
    }
    expect(await claimNext(testDb.db, repositoryId, "page_create")).toBeNull();
    expect(run.mock.calls.filter(([o]) => isOrient(o.prompt))).toHaveLength(12);
    const pages = await pagesOf(gen);
    expect(pages.map((p) => p.sourcePath).sort()).toEqual([...areas].sort());
    // Una sola area per orient: il prompt non vede le altre.
    expect(run.mock.calls[0]![0].prompt).not.toContain("app1/src/a.ts");
  });

  it("più proposte nella stessa area: più pagine, resultPageIds tutte; un path fuori dall'area è scartato", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps } = makeDeps({
      run: async (opts) =>
        isOrient(opts.prompt)
          ? ok(
              orientOutput([
                { title: "Fatture", paths: "src/billing/invoice.ts" },
                { title: "Imposte", kind: "functional", paths: "src/billing/tax.ts" },
                { title: "Fuori", paths: "src/auth" },
              ]),
            )
          : ok(EXPLORED),
    });
    const item = await claim();
    expect(await runPageCreateItem(deps, repo(), WT, item)).toBe("created");
    const pages = await pagesOf(gen);
    expect(pages.map((p) => p.title).sort()).toEqual(["Fatture", "Imposte"]);
    expect(pages.find((p) => p.title === "Imposte")!.kind).toBe("functional");
    const row = await itemById(item.id);
    expect((row.payload as { resultPageIds: string[] }).resultPageIds.sort()).toEqual(pages.map((p) => p.id).sort());
  });

  it("limite a metà (fra orient ed explore) → unavailable, NESSUNA pagina parziale, elemento pending dopo il release", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(gen, "src/billing", BILLING);
    const outputs: AgentRunResult[] = [
      ok(
        orientOutput([
          { title: "Fatture", paths: "src/billing/invoice.ts" },
          { title: "Imposte", paths: "src/billing/tax.ts" },
        ]),
      ),
      ok(EXPLORED),
      { output: "usage limit reached", exitCode: 1 } as AgentRunResult,
    ];
    const { deps } = makeDeps({ select: fakeSelect(testDb.db, "legacy"), run: async () => outputs.shift()! });
    const item = await claim();
    expect(await runPageCreateItem(deps, repo(), WT, item)).toEqual({ unavailable: "all_limited_now" });
    expect(await pagesOf(gen)).toHaveLength(0);
    await releaseItem(testDb.db, item.id);
    const row = await itemById(item.id);
    expect(row).toMatchObject({ status: "pending", failedNights: 0, claimedAt: null });
  });

  it("scelta vuota → il suo motivo, nessun run; exit ≠ 0 → failed, nessuna pagina", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(gen, "src/billing", BILLING);
    const item = await claim();
    const { deps, run } = makeDeps({ select: fakeSelect(testDb.db, { emptyReason: "exclusive_unavailable" }) });
    expect(await runPageCreateItem(deps, repo(), WT, item)).toEqual({ unavailable: "exclusive_unavailable" });
    expect(run).not.toHaveBeenCalled();
    const { deps: deps2 } = makeDeps({ run: async () => ({ output: "", exitCode: 2 }) as AgentRunResult });
    expect(await runPageCreateItem(deps2, repo(), WT, item)).toMatchObject({
      failed: expect.stringContaining("exit 2"),
    });
    expect(await pagesOf(gen)).toHaveLength(0);
    expect((await itemById(item.id)).status).toBe("pending");
  });

  it("corpo dell'explore non valido per ogni proposta → failed (si riprova), nessuna pagina", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps } = makeDeps({
      run: async (opts) => (isOrient(opts.prompt) ? defaultRun(opts) : ok("Ecco la pagina.")),
    });
    const item = await claim();
    expect(await runPageCreateItem(deps, repo(), WT, item)).toMatchObject({
      failed: expect.stringContaining("nessuna pagina valida"),
    });
    expect(await pagesOf(gen)).toHaveLength(0);
  });

  it("genitore inventato → radice; nessuna proposta → skipped, done senza pagine", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps } = makeDeps({
      run: async (opts) =>
        isOrient(opts.prompt) ? ok(orientOutput([{ title: "Fatture", parent: "non-esiste", paths: "src/billing" }])) : ok(EXPLORED),
    });
    expect(await runPageCreateItem(deps, repo(), WT, await claim())).toBe("created");
    expect((await pagesOf(gen))[0]!.parentId).toBeNull();

    await enqueueArea(gen, "src/other", ["src/other/a.ts", "src/other/b.ts"]);
    const { deps: deps2, run } = makeDeps({ run: async () => ok("Nessuna pagina merita.") });
    const item = await claim();
    expect(await runPageCreateItem(deps2, repo(), WT, item)).toBe("skipped");
    expect(run).toHaveBeenCalledTimes(1);
    expect(await itemById(item.id)).toMatchObject({ status: "done", lastError: "no_page_proposed" });
  });

  it("generazione sostituita (D32) → skipped senza run; area già coperta → skipped senza run", async () => {
    const oldGen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(oldGen, "src/billing", BILLING);
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, HEAD);
    const { deps, run } = makeDeps();
    const item = await claim();
    expect(await runPageCreateItem(deps, repo(), WT, item)).toBe("skipped");
    expect(await itemById(item.id)).toMatchObject({ status: "done", lastError: SUPERSEDED_BY_GENERATION });

    await seedGenerationPage(testDb.db, repositoryId, gen, { slug: "src", sourcePath: "src" });
    await enqueueArea(gen, "src/billing", BILLING, sha("e"));
    const item2 = await claim();
    expect(await runPageCreateItem(deps, repo(), WT, item2)).toBe("skipped");
    expect(await itemById(item2.id)).toMatchObject({ status: "done", lastError: "area_already_covered" });
    expect(run).not.toHaveBeenCalled();
  });

  it("la notte dopo l'area non è più nuova (mapAffectedPages la vede coperta, anche un file fratello nuovo)", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps } = makeDeps();
    expect(await runPageCreateItem(deps, repo(), WT, await claim())).toBe("created");
    const refs = await loadPageRefs(testDb.db, gen);
    const { newAreas, affected } = mapAffectedPages(
      [...BILLING, "src/billing/credit-note.ts"],
      refs,
      Number.MAX_SAFE_INTEGER,
    );
    expect(newAreas).toEqual([]);
    expect(affected).toHaveLength(1);
  });

  it("la pagina creata entra nei link «related» della nota della notte (advanceBookmarkIfDone)", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const [note] = await testDb.db
      .insert(docPages)
      .values({ repositoryId, generationId: null, kind: "releases", slug: "release-x", title: "Release", body: "x" })
      .returning({ id: docPages.id });
    await enqueueItems(
      testDb.db,
      [{ repositoryId, projectId, phase: "release", key: `${BOOKMARK}..${HEAD}`, payload: { toSha: HEAD, pageId: note!.id } }],
      NIGHT,
    );
    await testDb.db.update(nightlyItems).set({ status: "done" }).where(eq(nightlyItems.phase, "release"));
    await enqueueArea(gen, "src/billing", BILLING);
    const { deps } = makeDeps({
      run: async (opts) =>
        isOrient(opts.prompt)
          ? ok(
              orientOutput([
                { title: "Fatture", paths: "src/billing/invoice.ts" },
                { title: "Imposte", paths: "src/billing/tax.ts" },
              ]),
            )
          : ok(EXPLORED),
    });
    expect(await runPageCreateItem(deps, repo(), WT, await claim())).toBe("created");
    const plan: DocsPlan = {
      generationId: gen,
      fromSha: BOOKMARK,
      toSha: HEAD,
      commits: [],
      changedFiles: [],
      mapped: [],
      newAreas: [],
      missingSummaries: [],
    };
    expect(await advanceBookmarkIfDone(deps, repo(), plan)).toBe(true);
    const [row] = await testDb.db.select({ links: docPages.links }).from(docPages).where(eq(docPages.id, note!.id));
    expect((row!.links as { title: string }[]).map((l) => l.title).sort()).toEqual(["Fatture", "Imposte"]);
  });
});
