import {
  activityReports,
  aiProviders,
  commitSummaries,
  docGenerations,
  docPages,
  encrypt,
  gitAccounts,
  nightlyItems,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { REFRESH_NO_CHANGE_MARKER } from "@stubwise/docs-engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import type { CommitWithFiles, MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { ResolvedProvider } from "../providers/chain.js";
import type { EmptyReason, ProviderSelection, SelectDeps, SelectInput } from "../providers/select.js";
import { nightOf, romeMinutes } from "./clock.js";
import { fakeNightlyDeps, seedCurrentGeneration, seedGenerationPage, sha } from "./nightly-fake.js";
import {
  initialSchedulerState,
  NIGHTLY_RESUME_MS,
  runNight,
  schedulerAction,
  startNightlyScheduler,
} from "./orchestrator.js";
import type { NightlyDeps, NightResult } from "./types.js";

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-10-16T00:30:00Z"); // 02:30 a Roma (CEST)
const NIGHT = "2026-10-16";
const YESTERDAY_UTC = "2026-10-15";
const PROVIDER = { id: "p1", kind: "account" } as unknown as ResolvedProvider;

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(nightlyItems);
  await db.delete(activityReports);
  await db.update(repositories).set({ currentDocGenerationId: null });
  await db.delete(docPages);
  await db.delete(docGenerations);
  await db.delete(commitSummaries);
  await db.delete(repositories);
  await db.delete(projects);
  await db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

interface SeededRepo {
  projectId: string;
  repositoryId: string;
  url: string;
}

/** Un progetto con un repository, credenziali cifrate davvero (o rotte), interruttori a scelta. */
async function seedNightRepo(
  name: string,
  o: { dailyReport?: boolean; docs?: boolean; brokenCredentials?: boolean; exclusive?: boolean } = {},
): Promise<SeededRepo> {
  const { projectId, repositoryId } = await seedRepository(db);
  const url = `https://example.test/${name}.git`;
  const [repo] = await db
    .update(repositories)
    .set({ repoUrl: url, name })
    .where(eq(repositories.id, repositoryId))
    .returning({ gitAccountId: repositories.gitAccountId });
  if (!o.brokenCredentials) {
    await db
      .update(gitAccounts)
      .set({ encryptedCredentials: encrypt(JSON.stringify({ token: "t" }), KEY) })
      .where(eq(gitAccounts.id, repo!.gitAccountId!));
  }
  await db
    .update(projects)
    .set({
      name: `Progetto ${name}`,
      dailyReportEnabled: o.dailyReport ?? false,
      docAutoUpdate: o.docs ?? false,
      // «Solo questo» vale solo con un id: il test che lo usa imposta anche l'id.
      aiProviderExclusive: o.exclusive ?? false,
    })
    .where(eq(projects.id, projectId));
  return { projectId, repositoryId, url };
}

function commit(c: string, subject: string): CommitWithFiles {
  return {
    sha: sha(c),
    authorName: "Dev",
    authorEmail: "dev@x.it",
    date: "2026-10-15T10:00:00Z",
    subject,
    isMerge: false,
    additions: 1,
    deletions: 0,
    files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
  };
}

const SUMMARY_OK = (s: string) => `===SUMMARY===\nriassunto di ${s}\n===END SUMMARY===\n===AREAS===\nsrc\n===END AREAS===`;

function ok(output: string): AgentRunResult {
  return { output, exitCode: 0, usage: { totalCostUsd: 0.01 } } as AgentRunResult;
}

/** Il subject del commit dal prompt del riassunto. */
function subjectOf(prompt: string): string {
  return /Commit subject: (.*)/.exec(prompt)?.[1] ?? "?";
}

interface Harness {
  deps: NightlyDeps;
  run: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  ensureMirror: ReturnType<typeof vi.fn>;
}

/**
 * Deps del giro con mirror finti (commit per URL) e una scelta dell'account
 * programmabile per chiamata (`select(input, n)`: n = numero della chiamata).
 */
function harness(o: {
  commitsByUrl: Record<string, CommitWithFiles[]>;
  run?: (opts: AgentRunOptions) => Promise<AgentRunResult>;
  select?: (input: SelectInput, n: number) => ProviderSelection;
  unreachableUrls?: string[];
  mirrors?: Partial<MirrorManager>;
}): Harness {
  const run = vi.fn(o.run ?? (async (opts: AgentRunOptions) => ok(SUMMARY_OK(subjectOf(opts.prompt)))));
  const publish = vi.fn(async () => undefined);
  const log = vi.fn();
  const ensureMirror = vi.fn(async (p: MirrorProject) => {
    if (o.unreachableUrls?.includes(p.repoUrl)) throw new Error("fetch: authentication failed");
    return "/mirror";
  });
  let calls = 0;
  const select: SelectDeps = {
    db,
    encryptionKey: KEY,
    backgroundWeeklyThreshold: 90,
    selectProvidersFn: async (_d, input) => {
      calls++;
      return o.select ? o.select(input, calls) : { candidates: [PROVIDER], legacyAuth: false, emptyReason: null };
    },
    markProviderLimitedFn: async () => undefined,
  };
  const deps = fakeNightlyDeps(db, {
    runner: { run },
    mirrors: {
      ensureMirror,
      listRecentCommits: vi.fn(async (p: MirrorProject) => o.commitsByUrl[p.repoUrl] ?? []),
      getCommitDiff: vi.fn(async () => ({ diff: "+x", truncated: false })),
      ...o.mirrors,
    } as never,
    select,
    publish: publish as never,
    log,
    now: () => NOW,
  });
  return { deps, run, publish, log, ensureMirror };
}

const empty = (reason: EmptyReason): ProviderSelection => ({ candidates: [], legacyAuth: false, emptyReason: reason });
const usable: ProviderSelection = { candidates: [PROVIDER], legacyAuth: false, emptyReason: null };

async function itemsOf(repositoryId: string, phase?: string) {
  const rows = await db.select().from(nightlyItems).where(eq(nightlyItems.repositoryId, repositoryId));
  return phase ? rows.filter((r) => r.phase === phase) : rows;
}

describe("runNight: riassunti a turno", () => {
  it("due repository: un elemento per repository per giro (alternanza), tutto fatto", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    const b = await seedNightRepo("beta", { dailyReport: true });
    const h = harness({
      commitsByUrl: {
        [a.url]: [commit("1", "a1"), commit("2", "a2"), commit("3", "a3"), commit("4", "a4")],
        [b.url]: [commit("5", "b1"), commit("6", "b2")],
      },
    });
    const res = await runNight(h.deps, NOW);
    const order = h.run.mock.calls.map(([opts]) => subjectOf((opts as AgentRunOptions).prompt));
    expect(order).toEqual(["a1", "b1", "a2", "b2", "a3", "a4"]);
    expect(res).toMatchObject({ night: NIGHT, repositories: 2, stoppedForQuota: false, itemsPending: 0, skipped: [] });
    // I 6 riassunti (i daily_report si consumano a parte, in testa alla notte).
    expect(res.itemsDone).toBe(6);
    expect(await db.select().from(commitSummaries)).toHaveLength(6);
    // Il serializer ha fatto UN fetch per repository.
    expect(h.ensureMirror).toHaveBeenCalledTimes(2);
  });

  it("quota finita al 2° elemento → giro fermo; la ripresa continua senza rifare nulla; un riavvio non rifà niente", async () => {
    const a = await seedNightRepo("alpha");
    const b = await seedNightRepo("beta");
    await db.update(projects).set({ dailyReportEnabled: true });
    let quotaBack = false;
    const h = harness({
      commitsByUrl: {
        [a.url]: [commit("1", "a1"), commit("2", "a2")],
        [b.url]: [commit("5", "b1"), commit("6", "b2")],
      },
      select: (_i, n) => (n === 2 && !quotaBack ? empty("all_limited") : usable),
    });

    const first = await runNight(h.deps, NOW);
    expect(first.stoppedForQuota).toBe(true);
    expect(h.run).toHaveBeenCalledTimes(1);
    const pendingAfterStop = await db.select().from(nightlyItems).where(eq(nightlyItems.status, "pending"));
    expect(pendingAfterStop.filter((i) => i.phase === "summary")).toHaveLength(3);
    // Nessun fallimento contato, nessuna lease rimasta.
    expect(pendingAfterStop.every((i) => i.failedNights === 0 && i.claimedAt === null)).toBe(true);

    quotaBack = true;
    const resumed = await runNight(h.deps, new Date(NOW.getTime() + NIGHTLY_RESUME_MS), { night: NIGHT });
    expect(resumed.stoppedForQuota).toBe(false);
    expect(resumed.itemsPending).toBe(0);
    const subjects = h.run.mock.calls.map(([opts]) => subjectOf((opts as AgentRunOptions).prompt));
    expect(subjects.sort()).toEqual(["a1", "a2", "b1", "b2"]);

    // Riavvio simulato: un orchestratore nuovo, stessa coda → nessun run.
    const restarted = await runNight({ ...h.deps }, new Date(NOW.getTime() + 2 * NIGHTLY_RESUME_MS));
    expect(restarted.itemsDone).toBe(0);
    expect(h.run).toHaveBeenCalledTimes(4);
  });

  it("legacy_limited (auth del container al limite) è uno stop per quota, mai un fallimento", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")] },
      select: () => ({ candidates: [], legacyAuth: true, emptyReason: null }),
      run: async () => ({ output: "Claude AI usage limit reached|1792195200", exitCode: 1 }) as AgentRunResult,
    });
    const res = await runNight(h.deps, NOW);
    expect(res.stoppedForQuota).toBe(true);
    const [item] = await itemsOf(a.repositoryId, "summary");
    expect(item).toMatchObject({ status: "pending", failedNights: 0 });
  });

  it("progetto «solo questo» al limite → saltato DA SOLO (provider_quota), l'altro completato", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true, exclusive: true });
    const b = await seedNightRepo("beta", { dailyReport: true });
    // «Solo questo» vale solo con un id valorizzato: un provider vero.
    const [prov] = await db
      .insert(aiProviders)
      .values({ kind: "account", label: "solo", secretEncrypted: "x", position: 0 })
      .returning({ id: aiProviders.id });
    await db.update(projects).set({ aiProviderId: prov!.id }).where(eq(projects.id, a.projectId));
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1"), commit("2", "a2")], [b.url]: [commit("5", "b1"), commit("6", "b2")] },
      select: (input) => (input.projectId === a.projectId ? empty("all_limited") : usable),
    });
    const res = await runNight(h.deps, NOW);
    expect(res.stoppedForQuota).toBe(false);
    expect(res.skipped).toEqual([{ repositoryId: a.repositoryId, reason: "provider_quota" }]);
    expect(h.run.mock.calls.map(([opts]) => subjectOf((opts as AgentRunOptions).prompt))).toEqual(["b1", "b2"]);
    expect((await itemsOf(a.repositoryId, "summary")).every((i) => i.status === "pending" && i.failedNights === 0)).toBe(true);
  });

  it("exclusive_unavailable su un progetto → quel progetto saltato (provider_config), l'altro completato", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    const b = await seedNightRepo("beta", { dailyReport: true });
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")], [b.url]: [commit("5", "b1"), commit("6", "b2")] },
      select: (input) => (input.projectId === a.projectId ? empty("exclusive_unavailable") : usable),
    });
    const res = await runNight(h.deps, NOW);
    expect(res.stoppedForQuota).toBe(false);
    expect(res.skipped).toEqual([{ repositoryId: a.repositoryId, reason: "provider_config" }]);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("credenziali rotte o mirror irraggiungibile → repository saltato (unreachable), gli altri completati", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true, brokenCredentials: true });
    const b = await seedNightRepo("beta", { dailyReport: true });
    const c = await seedNightRepo("gamma", { dailyReport: true });
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")], [b.url]: [commit("5", "b1")], [c.url]: [commit("7", "c1")] },
      unreachableUrls: [c.url],
    });
    const res = await runNight(h.deps, NOW);
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { repositoryId: a.repositoryId, reason: "unreachable" },
        { repositoryId: c.repositoryId, reason: "unreachable" },
      ]),
    );
    expect(h.run.mock.calls.map(([opts]) => subjectOf((opts as AgentRunOptions).prompt))).toEqual(["b1"]);
    // Il daily report del progetto irraggiungibile si accoda comunque (non serve git).
    expect(await db.select().from(activityReports)).toHaveLength(3);
  });

  it("un solo runNight alla volta", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")] },
      run: async (opts) => {
        await gate;
        return ok(SUMMARY_OK(subjectOf(opts.prompt)));
      },
    });
    const first = runNight(h.deps, NOW);
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    const second = await runNight(h.deps, NOW);
    expect(second.busy).toBe(true);
    release();
    expect((await first).itemsDone).toBe(1);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("escalation: un riassunto che fallisce tre notti diverse → una card item_failing (alla terza)", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")] },
      run: async () => ok("niente marcatori " + "x".repeat(800)),
    });
    await runNight(h.deps, NOW, { night: "2026-10-14" });
    // Stessa notte, di nuovo: l'elemento fallito non si riprova.
    await runNight(h.deps, NOW, { night: "2026-10-14" });
    expect(h.run).toHaveBeenCalledTimes(1);
    await runNight(h.deps, NOW, { night: "2026-10-15" });
    expect(h.publish).not.toHaveBeenCalled();
    await runNight(h.deps, NOW, { night: "2026-10-16" });
    expect(h.publish).toHaveBeenCalledTimes(1);
    const [, event, opts] = h.publish.mock.calls[0] as unknown as [unknown, Record<string, unknown>, unknown];
    expect(event).toMatchObject({
      kind: "docs.nightly_attention",
      reason: "item_failing",
      repositoryId: a.repositoryId,
      phase: "summary",
      key: sha("1"),
      night: "2026-10-16",
    });
    expect((event.lastError as string).length).toBeLessThanOrEqual(501);
    expect(opts).toEqual({ projectId: a.projectId });
    const [item] = await itemsOf(a.repositoryId, "summary");
    expect(item!.status).toBe("escalated");
  });
});

describe("runNight: daily report", () => {
  it("un elemento daily_report → UNA riga activity_reports queued per il giorno UTC chiuso, una sola anche rieseguendo", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    const h = harness({ commitsByUrl: {} });
    await runNight(h.deps, NOW);
    await runNight(h.deps, new Date(NOW.getTime() + 60_000));
    const reports = await db.select().from(activityReports);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ projectId: a.projectId, date: YESTERDAY_UTC, status: "queued" });
    const items = await itemsOf(a.repositoryId, "daily_report");
    expect(items).toEqual([expect.objectContaining({ key: YESTERDAY_UTC, status: "done" })]);
  });

  it("un report già presente (manuale o generato) non si tocca; progetto senza report acceso → nessuna riga", async () => {
    const a = await seedNightRepo("alpha", { dailyReport: true });
    await seedNightRepo("beta", { docs: true });
    await db.insert(activityReports).values({ projectId: a.projectId, date: YESTERDAY_UTC, status: "done", summary: "fatto" });
    const h = harness({ commitsByUrl: {} });
    await runNight(h.deps, NOW);
    const reports = await db.select().from(activityReports);
    expect(reports).toEqual([expect.objectContaining({ projectId: a.projectId, status: "done", summary: "fatto" })]);
    // L'elemento si chiude comunque: la riga c'era già (ON CONFLICT DO NOTHING).
    expect(await itemsOf(a.repositoryId, "daily_report")).toEqual([expect.objectContaining({ status: "done" })]);
  });
});

describe("runNight: Docs", () => {
  const BOOKMARK = sha("0");
  const HEAD = sha("f");
  const RELEASE = [
    "===RELEASE NOTES===",
    "SIGNIFICANT: true",
    "TITLE: App nuova",
    "===AFFECTED SLUGS===",
    "- app",
    "===END AFFECTED SLUGS===",
    "===RELEASE BODY===",
    "## Changed\n- App.",
    "===END RELEASE BODY===",
    "===END RELEASE NOTES===",
  ].join("\n");

  function docsRunner() {
    return async (opts: AgentRunOptions) => {
      if (opts.prompt.includes("Commit subject:")) return ok(SUMMARY_OK(subjectOf(opts.prompt)));
      if (opts.prompt.includes("===RELEASE NOTES===")) return ok(RELEASE);
      return ok(REFRESH_NO_CHANGE_MARKER);
    };
  }

  it("riassunti → nota → pagine → segnalibro avanzato; il worktree si apre e si chiude", async () => {
    const a = await seedNightRepo("alpha", { docs: true });
    const gen = await seedCurrentGeneration(db, a.repositoryId, BOOKMARK);
    await seedGenerationPage(db, a.repositoryId, gen, { slug: "app", sourcePath: "src" });
    const remove = vi.fn(async () => undefined);
    const openWorktreeAtSha = vi.fn(async () => ({ dir: "/srv/none/wt", remove }));
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")] },
      run: docsRunner(),
      mirrors: {
        listDefaultBranchCommitsSince: vi.fn(async () => ({ commits: [sha("1")], headSha: HEAD, fallback: false })),
        listAncestorsSince: vi.fn(async () => []),
        openWorktreeAtSha,
      } as never,
    });
    const res = await runNight(h.deps, NOW);
    expect(res).toMatchObject({ stoppedForQuota: false, itemsPending: 0, skipped: [] });
    const phases = (await itemsOf(a.repositoryId)).map((i) => [i.phase, i.status]);
    expect(phases).toEqual(
      expect.arrayContaining([
        ["summary", "done"],
        ["release", "done"],
        ["page_update", "done"],
      ]),
    );
    expect(openWorktreeAtSha).toHaveBeenCalledWith(expect.anything(), HEAD, { skipFetch: true });
    expect(remove).toHaveBeenCalledTimes(1);
    const [g] = await db.select().from(docGenerations).where(eq(docGenerations.id, gen));
    expect(g!.commitSha).toBe(HEAD);
  });

  it("generazione completa in corso → riassunti sì, Docs no (generation_running)", async () => {
    const a = await seedNightRepo("alpha", { docs: true });
    await seedCurrentGeneration(db, a.repositoryId, BOOKMARK);
    await db.insert(docGenerations).values({ repositoryId: a.repositoryId, status: "running" });
    const listDefault = vi.fn();
    const h = harness({
      commitsByUrl: { [a.url]: [commit("1", "a1")] },
      run: docsRunner(),
      mirrors: { listDefaultBranchCommitsSince: listDefault } as never,
    });
    const res = await runNight(h.deps, NOW);
    expect(res.skipped).toEqual([{ repositoryId: a.repositoryId, reason: "generation_running" }]);
    expect(await itemsOf(a.repositoryId, "summary")).toEqual([expect.objectContaining({ status: "done" })]);
    expect(await itemsOf(a.repositoryId, "release")).toEqual([]);
    expect(listDefault).not.toHaveBeenCalled();
    // Il worktree della generazione è su un branch stubwise/*: nessun fetch --prune.
    expect(h.ensureMirror).not.toHaveBeenCalled();
  });

  it("quota a metà delle pagine: i fatti restano done, il segnalibro NON avanza, la ripresa finisce", async () => {
    const a = await seedNightRepo("alpha", { docs: true });
    const gen = await seedCurrentGeneration(db, a.repositoryId, BOOKMARK);
    await seedGenerationPage(db, a.repositoryId, gen, { slug: "app", sourcePath: "src/app" });
    await seedGenerationPage(db, a.repositoryId, gen, { slug: "lib", sourcePath: "src/lib" });
    const c1 = { ...commit("1", "a1"), files: [{ path: "src/app/x.ts", additions: 1, deletions: 0 }] };
    const c2 = { ...commit("2", "a2"), files: [{ path: "src/lib/y.ts", additions: 1, deletions: 0 }] };
    let pageRuns = 0;
    let quotaOut = true;
    const h = harness({
      commitsByUrl: { [a.url]: [c1, c2] },
      run: docsRunner(),
      // Le selezioni: 2 riassunti + nota + 1ª pagina ok, poi quota (finché quotaOut).
      select: () => {
        pageRuns++;
        return pageRuns === 5 && quotaOut ? empty("all_over_threshold") : usable;
      },
      mirrors: {
        listDefaultBranchCommitsSince: vi.fn(async () => ({ commits: [sha("2"), sha("1")], headSha: HEAD, fallback: false })),
        listAncestorsSince: vi.fn(async () => []),
        openWorktreeAtSha: vi.fn(async () => ({ dir: "/srv/none/wt", remove: async () => undefined })),
      } as never,
    });
    const first = await runNight(h.deps, NOW);
    expect(first.stoppedForQuota).toBe(true);
    const pages = await itemsOf(a.repositoryId, "page_update");
    expect(pages.map((p) => p.status).sort()).toEqual(["done", "pending"]);
    const [g1] = await db.select().from(docGenerations).where(eq(docGenerations.id, gen));
    expect(g1!.commitSha).toBe(BOOKMARK);

    quotaOut = false;
    const runsBefore = h.run.mock.calls.length;
    const resumed = await runNight(h.deps, new Date(NOW.getTime() + NIGHTLY_RESUME_MS), { night: NIGHT });
    expect(resumed.itemsPending).toBe(0);
    // Solo la pagina rimasta: nessun riassunto né nota rifatti.
    expect(h.run.mock.calls.length - runsBefore).toBe(1);
    const [g2] = await db.select().from(docGenerations).where(eq(docGenerations.id, gen));
    expect(g2!.commitSha).toBe(HEAD);
  });
});

describe("scheduler", () => {
  it("parte all'orario di Roma, estate e inverno; una volta per notte", () => {
    // 00:30 UTC = 02:30 CEST.
    expect(schedulerAction({ lastStartedNight: null, resume: null }, NOW, "02:00")).toEqual({
      kind: "start",
      night: NIGHT,
    });
    expect(schedulerAction({ lastStartedNight: NIGHT, resume: null }, NOW, "02:00")).toBeNull();
    // 23:30 UTC del 15 = 01:30 del 16 a Roma: non ancora.
    expect(schedulerAction({ lastStartedNight: "2026-10-15", resume: null }, new Date("2026-10-15T23:30:00Z"), "02:00")).toBeNull();
    // Inverno: 01:00 UTC = 02:00 CET.
    expect(schedulerAction({ lastStartedNight: null, resume: null }, new Date("2026-12-01T01:00:00Z"), "2:00")).toEqual({
      kind: "start",
      night: "2026-12-01",
    });
    expect(schedulerAction({ lastStartedNight: null, resume: null }, new Date("2026-12-01T00:59:00Z"), "02:00")).toBeNull();
  });

  it("ripresa: alla sua ora, con la notte dell'avvio", () => {
    const state = { lastStartedNight: NIGHT, resume: { night: NIGHT, at: NOW.getTime() + NIGHTLY_RESUME_MS } };
    expect(schedulerAction(state, new Date(NOW.getTime() + 60_000), "02:00")).toBeNull();
    expect(schedulerAction(state, new Date(NOW.getTime() + NIGHTLY_RESUME_MS), "02:00")).toEqual({
      kind: "resume",
      night: NIGHT,
    });
  });

  it("all'avvio del processo: dopo l'orario la notte conta avviata; lavoro pendente → ripresa al primo tick", () => {
    expect(initialSchedulerState(NOW, "02:00", false)).toEqual({ lastStartedNight: NIGHT, resume: null });
    expect(initialSchedulerState(NOW, "02:00", true)).toEqual({
      lastStartedNight: NIGHT,
      resume: { night: NIGHT, at: NOW.getTime() },
    });
    const beforeStart = new Date("2026-10-15T23:30:00Z"); // 01:30 del 16 a Roma
    expect(initialSchedulerState(beforeStart, "02:00", true)).toEqual({
      lastStartedNight: null,
      resume: { night: "2026-10-15", at: beforeStart.getTime() },
    });
  });

  it("orologio di Roma", () => {
    expect(nightOf(new Date("2026-10-15T22:30:00Z"))).toBe("2026-10-16");
    expect(romeMinutes(new Date("2026-10-15T22:30:00Z"))).toBe(30);
  });

  it("startNightlyScheduler: notte all'orario, poi ripresa ogni 15′ finché serve", async () => {
    // Avvio del processo PRIMA dell'orario (01:30 a Roma): nessuna notte già avviata.
    let clock = new Date("2026-10-15T23:30:00Z").getTime();
    const results: NightResult[] = [
      { night: NIGHT, repositories: 1, itemsDone: 1, itemsPending: 3, stoppedForQuota: true, skipped: [] },
      { night: NIGHT, repositories: 1, itemsDone: 3, itemsPending: 0, stoppedForQuota: false, skipped: [] },
    ];
    const runNightFn = vi.fn<(d: NightlyDeps, now: Date, o?: { night?: string }) => Promise<NightResult>>(async () => results.shift()!);
    const controller = new AbortController();
    const h = harness({ commitsByUrl: {} });
    startNightlyScheduler({
      ...h.deps,
      now: () => new Date(clock),
      signal: controller.signal,
      tickMs: 5,
      runNightFn,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(runNightFn).not.toHaveBeenCalled();
    clock = NOW.getTime();
    await vi.waitFor(() => expect(runNightFn).toHaveBeenCalledTimes(1));
    expect(runNightFn.mock.calls[0]![2]).toEqual({ night: NIGHT });
    await new Promise((r) => setTimeout(r, 30));
    expect(runNightFn).toHaveBeenCalledTimes(1);
    clock += NIGHTLY_RESUME_MS;
    await vi.waitFor(() => expect(runNightFn).toHaveBeenCalledTimes(2));
    expect(runNightFn.mock.calls[1]![2]).toEqual({ night: NIGHT });
    clock += NIGHTLY_RESUME_MS;
    await new Promise((r) => setTimeout(r, 30));
    expect(runNightFn).toHaveBeenCalledTimes(2);
    controller.abort();
  });
});
