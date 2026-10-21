import { commitSummaries, docGenerations, docPages, nightlyItems, repositories } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { isPlanSkip, planDocs, planPages, type DocsPlan } from "./plan.js";
import { claimNext, enqueueItems, failItem, releaseItem } from "./queue.js";
import { enqueueReleaseItem, runReleaseItem } from "./release.js";
import { appendRelatedLinks } from "./release-page.js";

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

const NIGHT1 = "2026-10-15";
const NIGHT2 = "2026-10-16";
const NOW = new Date("2026-10-16T00:30:00Z");
const BOOKMARK = sha("0");
const HEAD1 = sha("e");
const HEAD2 = sha("f");
const PROVIDER = { id: "p1", kind: "account" } as unknown as ResolvedProvider;

const GOOD = [
  "===RELEASE NOTES===",
  "SIGNIFICANT: true",
  "TITLE: Login rifatto",
  "===AFFECTED SLUGS===",
  "- auth",
  "- invented",
  "===END AFFECTED SLUGS===",
  "===RELEASE BODY===",
  "## Changed\n- Login.",
  "===END RELEASE BODY===",
  "===END RELEASE NOTES===",
].join("\n");

function makeDeps(
  o: {
    output?: string;
    run?: (opts: AgentRunOptions) => Promise<AgentRunResult>;
    select?: SelectDeps;
    list?: { commits: string[]; headSha: string; fallback?: boolean };
  } = {},
) {
  const run = vi.fn(
    o.run ?? (async () => ({ output: o.output ?? GOOD, exitCode: 0, usage: { totalCostUsd: 0.2 } }) as AgentRunResult),
  );
  const listDefaultBranchCommitsSince = vi.fn(async () => ({ fallback: false, ...(o.list ?? { commits: [], headSha: HEAD1 }) }));
  const deps = fakeNightlyDeps(testDb.db, {
    runner: { run },
    mirrors: { listDefaultBranchCommitsSince, listAncestorsSince: vi.fn(async () => []) } as never,
    select: o.select ?? fakeSelect(testDb.db, [PROVIDER]),
    now: () => NOW,
  });
  return { deps, run, listDefaultBranchCommitsSince };
}

const repoFor = (gen: string | null) => fakeNightlyRepo(repositoryId, projectId, gen);

function planOf(gen: string, commits: string[], toSha = HEAD1, mapped: DocsPlan["mapped"] = []): DocsPlan {
  return {
    generationId: gen,
    fromSha: BOOKMARK,
    toSha,
    commits,
    changedFiles: [],
    mapped,
    newAreas: [],
    missingSummaries: [],
  };
}

async function releaseItems() {
  return testDb.db
    .select()
    .from(nightlyItems)
    .where(and(eq(nightlyItems.repositoryId, repositoryId), eq(nightlyItems.phase, "release")));
}

async function releasePages() {
  return testDb.db
    .select()
    .from(docPages)
    .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.kind, "releases")));
}

async function seedTwoCommits(gen: string) {
  await seedGenerationPage(testDb.db, repositoryId, gen, { slug: "auth", title: "Authentication", sourcePath: "src/auth" });
  await seedCommitSummary(testDb.db, repositoryId, sha("1"), {
    subject: "feat: login nuovo",
    summary: "Rifà il login con OTP.",
    files: ["src/auth/login.ts"],
  });
  await seedCommitSummary(testDb.db, repositoryId, sha("2"), {
    subject: "fix: logout",
    summary: "Il logout ora svuota la sessione.",
    files: ["src/auth/logout.ts", "src/brand-new/x.ts", "pnpm-lock.yaml"],
  });
}

describe("enqueueReleaseItem", () => {
  it("primo giro: un elemento `<segnalibro>..<head>` coi commit del piano", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const { deps, listDefaultBranchCommitsSince } = makeDeps();
    const key = await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("2"), sha("1")]), NIGHT1);
    expect(key).toBe(`${BOOKMARK}..${HEAD1}`);
    const [item] = await releaseItems();
    expect(item!.payload).toEqual({ fromSha: BOOKMARK, toSha: HEAD1, commits: [sha("2"), sha("1")] });
    expect(listDefaultBranchCommitsSince).not.toHaveBeenCalled();
    // Rieseguito: nessun doppione.
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("2"), sha("1")]), NIGHT1);
    expect(await releaseItems()).toHaveLength(1);
  });

  it("nessun commit nell'intervallo della nota → nessun elemento, nessun run", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const { deps, run } = makeDeps();
    expect(await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, []), NIGHT1)).toBeNull();
    expect(await releaseItems()).toHaveLength(0);
    expect(await claimNext(testDb.db, repositoryId, "release")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("nota fallita: riprovata la notte dopo sul SUO intervallo, e una seconda nota per i commit nuovi", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const { deps } = makeDeps({ output: "niente marcatori" });
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("2"), sha("1")]), NIGHT1);
    const first = (await claimNext(db, repositoryId, "release"))!;
    expect(await runReleaseItem(deps, repoFor(gen), first)).toMatchObject({ status: "failed" });
    expect(await failItem(db, first.id, "output non valido", NIGHT1)).toBe("retry");

    // Notte 2: il segnalibro dei Docs aspetta ancora (fromSha invariato), arriva sha("3").
    await seedCommitSummary(db, repositoryId, sha("3"), { subject: "feat: tre", files: ["src/auth/three.ts"] });
    const night2 = makeDeps({ list: { commits: [sha("3")], headSha: HEAD2 } });
    const key2 = await enqueueReleaseItem(
      night2.deps,
      repoFor(gen),
      planOf(gen, [sha("3"), sha("2"), sha("1")], HEAD2),
      NIGHT2,
    );
    expect(key2).toBe(`${HEAD1}..${HEAD2}`);
    expect(night2.listDefaultBranchCommitsSince).toHaveBeenCalledWith(expect.anything(), HEAD1, expect.any(Date), {
      skipFetch: true,
    });
    const all = await releaseItems();
    expect(all).toHaveLength(2);
    expect(all.find((i) => i.key === key2)!.payload).toEqual({ fromSha: HEAD1, toSha: HEAD2, commits: [sha("3")] });

    // Il più vecchio si riprende per primo, sul suo intervallo.
    const retried = (await claimNext(db, repositoryId, "release"))!;
    expect(retried.id).toBe(first.id);
    expect(retried.payload).toEqual({ fromSha: BOOKMARK, toSha: HEAD1, commits: [sha("2"), sha("1")] });
    const out = await runReleaseItem(night2.deps, repoFor(gen), retried);
    expect(out.status).toBe("done");
    expect(night2.run.mock.calls[0]![0].prompt).not.toContain("feat: tre");
  });
});

describe("runReleaseItem", () => {
  it("nota con 2 commit: subject e riassunto nel prompt, pagina inserita, elemento chiuso col pageId", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const { deps, run } = makeDeps();
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("2"), sha("1")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;

    const out = await runReleaseItem(deps, repoFor(gen), item);

    expect(run).toHaveBeenCalledTimes(1);
    const opts = run.mock.calls[0]![0];
    expect(opts.model).toBe("sonnet-notes");
    expect(opts.usage).toEqual({ operation: "release_notes", projectId });
    expect(opts.permissionMode).toBe("plan");
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.provider).toBe(PROVIDER);
    expect(opts.prompt).toContain("feat: login nuovo");
    expect(opts.prompt).toContain("Rifà il login con OTP.");
    expect(opts.prompt).toContain("fix: logout");
    expect(opts.prompt).toContain("Il logout ora svuota la sessione.");
    expect(opts.prompt).toContain("SAME language as the existing");
    expect(opts.prompt).not.toContain("pnpm-lock.yaml");
    // Aree nuove dalla mappa delle pagine.
    expect(opts.prompt).toContain("- src/brand-new/x.ts");

    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.notes?.affectedSlugs).toEqual(["auth", "invented"]);
    const [page] = await releasePages();
    expect(page).toMatchObject({
      id: out.pageId,
      generationId: null,
      title: "Login rifatto",
      significant: true,
      // Le aree nuove si elencano sempre, in modo deterministico.
      body: "## Changed\n- Login.\n## Aree nuove non documentate\n\n- src/brand-new/x.ts\n\n_Valuta una rigenerazione completa per coprirle._",
      links: [{ type: "related", slug: "auth", title: "Authentication" }],
    });
    expect(page!.slug).toBe(`release-20261016-0030-${HEAD1.slice(0, 7)}`);
    const [closed] = await releaseItems();
    expect(closed).toMatchObject({ status: "done", claimedAt: null });
    expect(closed!.payload.pageId).toBe(out.pageId);
  });

  it("output non valido → failed, nessuna pagina; planPages procede con la sola mappa", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    await seedGenerationPage(db, repositoryId, gen, { slug: "guide" });
    const { deps } = makeDeps({ output: "===RELEASE NOTES===\nTITLE: x\n===END RELEASE NOTES===" });
    const listed = { commits: [sha("2"), sha("1")], headSha: HEAD1 };
    deps.mirrors.listDefaultBranchCommitsSince = vi.fn(async () => ({ ...listed, fallback: false }));
    const plan = await planDocs(deps, repoFor(gen));
    if (isPlanSkip(plan)) throw new Error("salto inatteso");
    await enqueueReleaseItem(deps, repoFor(gen), plan, NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;

    const out = await runReleaseItem(deps, repoFor(gen), item);
    expect(out).toEqual({ status: "failed", error: "output della nota senza i marcatori del contratto" });
    expect(await releasePages()).toHaveLength(0);
    await failItem(db, item.id, out.status === "failed" ? out.error : "", NIGHT1);
    expect((await releaseItems())[0]).toMatchObject({ status: "pending", failedNights: 1 });

    const r = await planPages(deps, repoFor(gen), plan, [], NIGHT1);
    expect(r.candidates).toBe(1);
  });

  it("limite dell'auth del container (legacy_limited) → unavailable all_limited_now, mai un fallimento", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const { deps } = makeDeps({
      select: fakeSelect(db, "legacy", { legacyLimit: { until: null } }),
      run: async () => ({ output: "usage limit reached", exitCode: 1 }) as AgentRunResult,
    });
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("1")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;
    expect(await runReleaseItem(deps, repoFor(gen), item)).toEqual({ status: "unavailable", reason: "all_limited_now" });
  });

  it("nessun provider usabile → unavailable col motivo, nessun run", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const { deps, run } = makeDeps({ select: fakeSelect(db, { emptyReason: "all_over_threshold" }) });
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("1")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;
    expect(await runReleaseItem(deps, repoFor(gen), item)).toEqual({ status: "unavailable", reason: "all_over_threshold" });
    expect(run).not.toHaveBeenCalled();
  });

  it("un riassunto ancora da fare (summary pending) → la nota aspetta, nessun run, nessun fallimento contato", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const late = sha("3"); // il suo riassunto è fallito stanotte: riprovato domani
    await enqueueItems(db, [{ repositoryId, projectId, phase: "summary", key: late }], NIGHT1);
    const { deps, run } = makeDeps();
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [late, sha("2"), sha("1")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;

    const out = await runReleaseItem(deps, repoFor(gen), item);

    expect(out).toEqual({ status: "waiting", reason: "summaries_pending", missing: [late] });
    expect(run).not.toHaveBeenCalled();
    await releaseItem(db, item.id);
    expect((await releaseItems())[0]).toMatchObject({ status: "pending", failedNights: 0, lastFailedNight: null });
    expect(await releasePages()).toHaveLength(0);
  });

  it("tutti i riassunti mancanti, e nessun elemento summary ancora accodato → aspetta (non failed)", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    const { deps, run } = makeDeps();
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("7")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;
    expect(await runReleaseItem(deps, repoFor(gen), item)).toMatchObject({ status: "waiting", missing: [sha("7")] });
    expect(run).not.toHaveBeenCalled();
  });

  it("riassunto in escalation → la nota si scrive senza quel commit, con una riga di log", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const lost = sha("3");
    await enqueueItems(db, [{ repositoryId, projectId, phase: "summary", key: lost }], NIGHT1);
    await db.update(nightlyItems).set({ status: "escalated" }).where(eq(nightlyItems.key, lost));
    const log = vi.fn();
    const { deps, run } = makeDeps();
    deps.log = log;
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [lost, sha("2"), sha("1")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;

    const out = await runReleaseItem(deps, repoFor(gen), item);

    expect(out.status).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].prompt).toContain("feat: login nuovo");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 commit col riassunto in escalation, esclusi"));
  });

  it("intervallo di solo rumore → elemento chiuso, nessun run né pagina", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedCommitSummary(db, repositoryId, sha("1"), { files: ["pnpm-lock.yaml"], noise: true });
    const { deps, run } = makeDeps();
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("1")]), NIGHT1);
    const item = (await claimNext(db, repositoryId, "release"))!;
    expect(await runReleaseItem(deps, repoFor(gen), item)).toEqual({ status: "done", notes: null, pageId: null });
    expect(run).not.toHaveBeenCalled();
    expect(await releasePages()).toHaveLength(0);
    expect((await releaseItems())[0]!.status).toBe("done");
  });
});

describe("appendRelatedLinks (fine fase 4)", () => {
  it("completa i link della nota con le pagine aggiornate/create, senza doppioni", async () => {
    const db = testDb.db;
    const gen = await seedCurrentGeneration(db, repositoryId, BOOKMARK);
    await seedTwoCommits(gen);
    const { deps } = makeDeps();
    await enqueueReleaseItem(deps, repoFor(gen), planOf(gen, [sha("1")]), NIGHT1);
    const out = await runReleaseItem(deps, repoFor(gen), (await claimNext(db, repositoryId, "release"))!);
    if (out.status !== "done" || out.pageId === null) throw new Error("nota non scritta");

    const added = await appendRelatedLinks(db, out.pageId, [
      { slug: "auth", title: "Authentication" },
      { slug: "billing", title: "Billing" },
    ]);
    expect(added).toBe(1);
    const [page] = await releasePages();
    expect(page!.links).toEqual([
      { type: "related", slug: "auth", title: "Authentication" },
      { type: "related", slug: "billing", title: "Billing" },
    ]);
    expect(await appendRelatedLinks(db, out.pageId, [{ slug: "billing", title: "Billing" }])).toBe(0);
  });
});
