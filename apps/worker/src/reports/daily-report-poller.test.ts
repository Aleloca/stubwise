import {
  activityCommits,
  activityReports,
  encrypt,
  gitAccounts,
  gitAuthorsSeen,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
import type { MirrorManager, MirrorProject, RangeCommit } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import type { ResolvedProvider } from "../providers/chain.js";
import {
  pollDailyReportsOnce,
  previousUtcDay,
  utcDayWindow,
  type PollDailyReportsDeps,
} from "./daily-report-poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // activity_reports/commits cascano da projects; git_authors_seen è globale.
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(gitAuthorsSeen);
});

afterAll(async () => {
  await testDb.stop();
});

/** Progetto (con toggle) + un repository con credenziali git cifrate. */
async function createProject(
  db: Db,
  opts: { dailyReportEnabled: boolean },
): Promise<{ projectId: string; repositoryId: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account daily ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      name: "Progetto daily",
      slug: `daily-${randomUUID()}`,
      ingestionKey: randomUUID(),
      dailyReportEnabled: opts.dailyReportEnabled,
    })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo daily",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
    })
    .returning();
  return { projectId: project!.id, repositoryId: repository!.id };
}

/** Aggiunge un secondo repository (con proprio account cifrato) a un progetto. */
async function addRepository(db: Db, projectId: string): Promise<string> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account daily ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
    })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId,
      name: "Repo daily 2",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: `https://example.com/owner/repo-${randomUUID()}`,
      defaultBranch: "main",
    })
    .returning();
  return repository!.id;
}

/** Serializer fake: registra i projectId ed esegue subito il task. */
function makeSerializer(): { serializer: ProjectSerializer; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    serializer: {
      run: async <T,>(projectId: string, task: () => Promise<T>): Promise<T> => {
        calls.push(projectId);
        return task();
      },
    },
  };
}

function commit(overrides: Partial<RangeCommit>): RangeCommit {
  return {
    sha: "a".repeat(40),
    authorName: "Alice",
    authorEmail: "alice@example.com",
    date: "2026-07-14T10:00:00Z",
    subject: "Fix qualcosa",
    isMerge: false,
    additions: 10,
    deletions: 2,
    ...overrides,
  };
}

const FAKE_PROVIDER: ResolvedProvider = { id: "prov-1", kind: "api_key", secret: "sk-fake" };

/** "adesso" fisso a metà giornata UTC: il giorno precedente è 2026-07-14. */
const NOW = new Date("2026-07-15T12:00:00Z");

interface MakeDepsOverrides {
  commitsByCall?: RangeCommit[][];
  /** Impl custom di getCommitsInRange (per testare i lanci per-repo). Vince su commitsByCall. */
  getCommitsImpl?: (project: MirrorProject, since: Date, until: Date) => Promise<RangeCommit[]>;
  /** Impl custom di getCommitDiff (default: diff finto non vuoto). */
  getCommitDiffImpl?: (
    project: MirrorProject,
    sha: string,
  ) => Promise<{ diff: string; truncated: boolean }>;
  runResult?: (opts: { prompt: string }) => Promise<AgentRunResult>;
  retentionDays?: number;
  provider?: ResolvedProvider | null;
  /** Override della risoluzione della catena provider (per forzare un errore interno). */
  loadProviderChainFn?: PollDailyReportsDeps["loadProviderChainFn"];
  now?: () => Date;
}

function makeDeps(o: MakeDepsOverrides = {}): {
  deps: PollDailyReportsDeps;
  runSpy: ReturnType<typeof vi.fn>;
  getCommitsSpy: ReturnType<typeof vi.fn>;
  getCommitDiffSpy: ReturnType<typeof vi.fn>;
} {
  const commitsByCall = o.commitsByCall ?? [[]];
  let call = 0;
  const getCommitsSpy = vi.fn(
    o.getCommitsImpl ??
      (async () => commitsByCall[Math.min(call++, commitsByCall.length - 1)] ?? []),
  );
  const getCommitDiffSpy = vi.fn(
    o.getCommitDiffImpl ??
      (async () => ({ diff: "--- a/foo\n+++ b/foo\n@@\n+riga", truncated: false })),
  );
  const ensureMirror = vi.fn(async () => "/tmp/fake-mirror");
  const runSpy = vi.fn(
    o.runResult ??
      // Distingue il run del RIASSUNTO-progetto (il suo prompt contiene
      // "resoconto") dagli run per-commit: così le asserzioni distinguono le due
      // fonti. runResult custom (se passato) vale per TUTTI i run.
      (async (opts: { prompt: string }): Promise<AgentRunResult> => ({
        output: opts.prompt.includes("resoconto") ? "riassunto finto" : "descrizione finta",
        exitCode: 0,
      })),
  );
  const { serializer } = makeSerializer();
  const deps: PollDailyReportsDeps = {
    db: testDb.db,
    mirrors: {
      getCommitsInRange: getCommitsSpy,
      getCommitDiff: getCommitDiffSpy,
      ensureMirror,
    } as unknown as Pick<MirrorManager, "getCommitsInRange" | "getCommitDiff" | "ensureMirror">,
    runner: { run: runSpy } as unknown as AgentRunner,
    encryptionKey: ENCRYPTION_KEY,
    serializer,
    maxAuthorsPerProject: 25, // deprecato: non più usato dal modello per-commit.
    retentionDays: o.retentionDays ?? 90,
    model: "sonnet",
    agentTimeoutMs: 60_000,
    now: o.now ?? (() => NOW),
    // Bypassa la risoluzione reale del provider: iniettiamo una catena finta
    // così runner.run viene comunque invocato (testiamo la logica del poller,
    // non l'integrazione col CLI). provider === null → nessun provider.
    loadProviderChainFn:
      o.loadProviderChainFn ??
      (async () => (o.provider === null ? [] : [o.provider ?? FAKE_PROVIDER])),
    loadProviderByIdFn: async () => o.provider ?? FAKE_PROVIDER,
  };
  return { deps, runSpy, getCommitsSpy, getCommitDiffSpy };
}

describe("previousUtcDay", () => {
  it("ritorna la finestra half-open del giorno UTC precedente", () => {
    const { since, until, date } = previousUtcDay(new Date("2026-07-15T12:34:56Z"));
    expect(since.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(date).toBe("2026-07-14");
  });
});

describe("utcDayWindow", () => {
  it("calcola la finestra half-open [since, until) del giorno UTC dato", () => {
    const { since, until, date } = utcDayWindow("2026-07-12");
    expect(since.toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(date).toBe("2026-07-12");
  });
});

describe("pollDailyReportsOnce", () => {
  it("genera un report done con UNA riga per commit e la descrizione AI, e registra gli autori", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: true,
    });
    const { deps, runSpy, getCommitDiffSpy } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), authorEmail: "Alice@Example.com", authorName: "Alice" }),
          commit({
            sha: "2".repeat(40),
            authorEmail: "bob@example.com",
            authorName: "Bob",
            subject: "Aggiunge feature",
            additions: 5,
            deletions: 1,
          }),
        ],
      ],
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(report?.status).toBe("done");
    expect(report?.date).toBe("2026-07-14");
    expect(report?.finishedAt).not.toBeNull();
    // Riassunto narrativo del progetto, dal run di aggregazione (prompt "resoconto").
    expect(report?.summary).toBe("riassunto finto");

    const commits = await testDb.db
      .select()
      .from(activityCommits)
      .where(eq(activityCommits.reportId, report!.id));
    expect(commits).toHaveLength(2); // una riga per commit non-merge.

    // Email normalizzate a lowercase, dati grezzi corretti, descrizione dal runner.
    const alice = commits.find((c) => c.sha === "1".repeat(40));
    expect(alice).toBeDefined();
    expect(alice?.authorEmail).toBe("alice@example.com");
    expect(alice?.authorName).toBe("Alice");
    expect(alice?.repoId).toBe(repositoryId);
    expect(alice?.subject).toBe("Fix qualcosa");
    expect(alice?.additions).toBe(10);
    expect(alice?.deletions).toBe(2);
    expect(alice?.aiDescription).toBe("descrizione finta");
    expect(alice?.committedAt).toBeInstanceOf(Date);
    // Valore ESATTO: la committer date del commit fixture, non `now` né l'author
    // date — blocca una regressione sulla sorgente della data persistita.
    expect(alice?.committedAt).toEqual(new Date("2026-07-14T10:00:00.000Z"));

    const bob = commits.find((c) => c.sha === "2".repeat(40));
    expect(bob?.authorEmail).toBe("bob@example.com");
    expect(bob?.subject).toBe("Aggiunge feature");
    expect(bob?.additions).toBe(5);
    expect(bob?.deletions).toBe(1);
    expect(bob?.aiDescription).toBe("descrizione finta");

    // Un run dell'agente e un diff recuperato per commit, PIÙ un run per il
    // riassunto narrativo del progetto (2 commit + 1 riassunto = 3 run).
    expect(runSpy).toHaveBeenCalledTimes(3);
    expect(getCommitDiffSpy).toHaveBeenCalledTimes(2);

    // Autori osservati registrati.
    const seen = await testDb.db.select().from(gitAuthorsSeen);
    expect(new Set(seen.map((s) => s.email))).toEqual(
      new Set(["alice@example.com", "bob@example.com"]),
    );
  });

  it("non genera nulla per un progetto con dailyReportEnabled=false", async () => {
    await createProject(testDb.db, { dailyReportEnabled: false });
    const { deps, getCommitsSpy } = makeDeps({ commitsByCall: [[commit({})]] });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(0);
    expect(getCommitsSpy).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(activityReports)).toHaveLength(0);
  });

  it("è idempotente: un secondo tick non crea un secondo report", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const first = makeDeps({ commitsByCall: [[commit({})]] });
    expect(await pollDailyReportsOnce(first.deps)).toBe(1);

    const second = makeDeps({ commitsByCall: [[commit({})]] });
    expect(await pollDailyReportsOnce(second.deps)).toBe(0);
    // Il secondo tick non ha nemmeno letto i commit (skip alla creazione riga).
    expect(second.getCommitsSpy).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(activityReports)).toHaveLength(1);
  });

  it("rigenera un report ORFANO 'running' del giorno invece di saltarlo", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: true,
    });
    // Simula un tentativo precedente killato tra l'insert 'running' e il 'done':
    // riga 'running' con una activity_commits parziale rimasta appesa.
    const [orphan] = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14", status: "running" })
      .returning();
    await testDb.db.insert(activityCommits).values({
      reportId: orphan!.id,
      repoId: repositoryId,
      sha: "9".repeat(40),
      authorEmail: "stale@example.com",
      committedAt: new Date("2026-07-14T00:00:00Z"),
      subject: "commit stantio",
    });

    const { deps, runSpy } = makeDeps({
      commitsByCall: [
        [commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice" })],
      ],
    });
    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1); // rigenerato, non saltato.

    // La riga è la STESSA (reclaim in-place), ora 'done'.
    const reports = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe(orphan!.id);
    expect(reports[0]?.status).toBe("done");
    expect(reports[0]?.finishedAt).not.toBeNull();

    // Righe FRESCHE: la parziale del tentativo precedente è sparita.
    const commits = await testDb.db
      .select()
      .from(activityCommits)
      .where(eq(activityCommits.reportId, orphan!.id));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.sha).toBe("1".repeat(40));
    expect(commits.find((c) => c.sha === "9".repeat(40))).toBeUndefined();
    // Il run dell'agente è stato eseguito (rigenerazione vera, non skip): 1 per il
    // commit + 1 per il riassunto del progetto.
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("recovery: un orfano 'running' per una data PASSATA e progetto disabilitato viene rigenerato", async () => {
    // Backfill manuale killato a metà: riga 'running' per 3 giorni fa su un
    // progetto disabilitato. Né la fase queued (filtra status='queued') né il
    // gate notturno (solo ieri + progetto abilitato) lo ripescherebbero: senza la
    // FASE 0 di recovery resterebbe 'running' per sempre.
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    const [orphan] = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-12", status: "running" })
      .returning();
    await testDb.db.insert(activityCommits).values({
      reportId: orphan!.id,
      repoId: repositoryId,
      sha: "9".repeat(40),
      authorEmail: "stale@example.com",
      committedAt: new Date("2026-07-12T00:00:00Z"),
      subject: "commit stantio",
    });

    const { deps, runSpy } = makeDeps({
      commitsByCall: [
        [commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice" })],
      ],
    });
    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1); // recuperato e rigenerato, non bloccato.

    const reports = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe(orphan!.id); // stessa riga (reclaim in-place).
    expect(reports[0]?.status).toBe("done");
    expect(reports[0]?.date).toBe("2026-07-12");
    expect(reports[0]?.finishedAt).not.toBeNull();

    // Righe fresche: la parziale del tentativo precedente è sparita.
    const commits = await testDb.db
      .select()
      .from(activityCommits)
      .where(eq(activityCommits.reportId, orphan!.id));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.sha).toBe("1".repeat(40));
    expect(commits.find((c) => c.sha === "9".repeat(40))).toBeUndefined();
    // 1 run per il commit + 1 per il riassunto del progetto.
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("best-effort fase queued: un 'queued' il cui repo LANCIA non blocca l'altro, il tick non crasha", async () => {
    // Due progetti disabilitati con un 'queued' ciascuno (così il gate notturno
    // non interferisce). Il primo getCommitsInRange chiamato LANCIA: il suo report
    // si chiude comunque (repo saltato, 0 righe) e l'altro viene generato.
    const a = await createProject(testDb.db, { dailyReportEnabled: false });
    const b = await createProject(testDb.db, { dailyReportEnabled: false });
    await testDb.db
      .insert(activityReports)
      .values({ projectId: a.projectId, date: "2026-07-12", status: "queued" });
    await testDb.db
      .insert(activityReports)
      .values({ projectId: b.projectId, date: "2026-07-12", status: "queued" });

    let n = 0;
    const { deps } = makeDeps({
      getCommitsImpl: async () => {
        if (n++ === 0) throw new Error("git log fallito");
        return [commit({ authorEmail: "alice@example.com", authorName: "Alice" })];
      },
    });

    const generated = await pollDailyReportsOnce(deps); // non deve lanciare.
    expect(generated).toBe(2); // entrambi i report chiusi 'done'.

    const reports = await testDb.db.select().from(activityReports);
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.status === "done")).toBe(true);
    // Una sola riga in tutto: il repo che ha lanciato non ne ha prodotte.
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.authorEmail).toBe("alice@example.com");
  });

  it("più 'queued' su più progetti in un tick: tutti generati", async () => {
    const a = await createProject(testDb.db, { dailyReportEnabled: false });
    const b = await createProject(testDb.db, { dailyReportEnabled: false });
    const c = await createProject(testDb.db, { dailyReportEnabled: false });
    for (const p of [a, b, c]) {
      await testDb.db
        .insert(activityReports)
        .values({ projectId: p.projectId, date: "2026-07-12", status: "queued" });
    }

    const { deps, getCommitsSpy } = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(3); // tutti e tre generati.
    expect(getCommitsSpy).toHaveBeenCalledTimes(3);

    const reports = await testDb.db.select().from(activityReports);
    expect(reports).toHaveLength(3);
    expect(reports.every((r) => r.status === "done")).toBe(true);
  });

  it("un 'queued' oltre la retention NON viene generato e viene rimosso dalla retention", async () => {
    // retentionDays=90, NOW=2026-07-15 → cutoff ~2026-04-16. Un 'queued' per
    // 2026-01-01 è oltre la retention: non va generato (spreco di run AI) e viene
    // cancellato dal blocco retention nello stesso tick.
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: false });
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-01-01", status: "queued" });

    const { deps, getCommitsSpy } = makeDeps({
      retentionDays: 90,
      commitsByCall: [[commit({})]],
    });
    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(0); // non generato.
    expect(getCommitsSpy).not.toHaveBeenCalled(); // nemmeno letto i commit.
    // Rimosso dalla retention: nessuna riga resta.
    expect(await testDb.db.select().from(activityReports)).toHaveLength(0);
  });

  it("esclude i commit di merge: nessuna riga per il merge", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), isMerge: false }),
          commit({ sha: "2".repeat(40), isMerge: true, subject: "Merge branch" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1); // solo il non-merge.
    expect(commits[0]?.sha).toBe("1".repeat(40));
    expect(commits.find((c) => c.sha === "2".repeat(40))).toBeUndefined();
  });

  it("un run che LANCIA per UN commit: quella riga ha aiDescription null, gli altri commit ok", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    let n = 0;
    const { deps, runSpy } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice" }),
          commit({ sha: "2".repeat(40), authorEmail: "bob@example.com", authorName: "Bob" }),
        ],
      ],
      runResult: async () => {
        // Il PRIMO run lancia, il secondo va a buon fine.
        if (n++ === 0) throw new Error("agente esploso");
        return { output: "descrizione finta", exitCode: 0 };
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    // Un run tentato per commit (2) + 1 per il riassunto del progetto.
    expect(runSpy).toHaveBeenCalledTimes(3);

    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(2); // entrambe le righe esistono coi dati grezzi.
    const first = commits.find((c) => c.sha === "1".repeat(40));
    const second = commits.find((c) => c.sha === "2".repeat(40));
    expect(first?.aiDescription).toBeNull(); // il run che ha lanciato.
    expect(first?.authorEmail).toBe("alice@example.com");
    expect(second?.aiDescription).toBe("descrizione finta");
  });

  it("retention: cancella i report più vecchi di retentionDays", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: false });
    // Report vecchio (100 giorni fa rispetto a NOW=2026-07-15) → sotto il cutoff.
    await testDb.db.insert(activityReports).values({
      projectId,
      date: "2026-01-01",
      status: "done",
    });
    // Report recente → sopra il cutoff, resta.
    await testDb.db.insert(activityReports).values({
      projectId,
      date: "2026-07-10",
      status: "done",
    });

    const { deps } = makeDeps({ retentionDays: 90 });
    await pollDailyReportsOnce(deps);

    const remaining = await testDb.db.select().from(activityReports);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.date).toBe("2026-07-10");
  });

  it("best-effort: se runner.run lancia, la riga esiste con aiDescription null e il report è done", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps } = makeDeps({
      commitsByCall: [[commit({})]],
      runResult: async () => {
        throw new Error("agente esploso");
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);

    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    expect(report?.summary).toBeNull(); // anche il run del riassunto lancia → null.
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.aiDescription).toBeNull();
    expect(commits[0]?.subject).toBe("Fix qualcosa");
  });

  it("diff non recuperabile (getCommitDiff LANCIA): riga coi dati grezzi, aiDescription null, nessun run", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      commitsByCall: [[commit({})]],
      getCommitDiffImpl: async () => {
        throw new Error("git show fallito");
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    // Nessun run PER-COMMIT (senza diff non si genera la descrizione), ma il
    // riassunto del progetto gira comunque (c'è un commit, seppur senza descrizione).
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]?.prompt).toContain("resoconto");
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.aiDescription).toBeNull();
    expect(commits[0]?.sha).toBe("a".repeat(40));
  });

  it("senza provider disponibile: persiste i dati grezzi con aiDescription null, senza toccare il diff", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy, getCommitDiffSpy } = makeDeps({
      provider: null,
      commitsByCall: [[commit({})]],
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    expect(runSpy).not.toHaveBeenCalled();
    expect(getCommitDiffSpy).not.toHaveBeenCalled(); // nessun git show sprecato.
    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.summary).toBeNull(); // niente provider → niente riassunto.
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.aiDescription).toBeNull();
    expect(commits[0]?.subject).toBe("Fix qualcosa");
  });

  it("best-effort riassunto: se il run del riassunto LANCIA, summary è null ma il report è done", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    // Le descrizioni per-commit vanno a buon fine; SOLO il run del riassunto
    // (prompt "resoconto") lancia: summary null, ma le righe e il report restano.
    const { deps } = makeDeps({
      commitsByCall: [[commit({})]],
      runResult: async (opts) => {
        if (opts.prompt.includes("resoconto")) throw new Error("riassunto esploso");
        return { output: "descrizione finta", exitCode: 0 };
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);

    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    expect(report?.summary).toBeNull(); // il run del riassunto ha lanciato.
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    // La descrizione per-commit è comunque stata salvata (non toccata dal fallimento).
    expect(commits[0]?.aiDescription).toBe("descrizione finta");
  });

  it("progetto con soli commit di merge (0 non-merge): nessun run e nessun riassunto, report done", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      commitsByCall: [[commit({ isMerge: true, subject: "Merge branch" })]],
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    // Nessun run: niente commit da descrivere né da riassumere.
    expect(runSpy).not.toHaveBeenCalled();
    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    expect(report?.summary).toBeNull(); // niente commit → niente riassunto.
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(0);
  });

  it("un repo il cui getCommitsInRange LANCIA è saltato, gli altri producono righe", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });
    await addRepository(testDb.db, projectId);
    // Primo repo (prima chiamata) esplode, il secondo restituisce un commit.
    let n = 0;
    const { deps } = makeDeps({
      getCommitsImpl: async () => {
        if (n++ === 0) throw new Error("git log fallito");
        return [commit({ authorEmail: "alice@example.com", authorName: "Alice" })];
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1); // il report NON è azzerato dal repo rotto.

    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1); // solo il repo sopravvissuto.
    expect(commits[0]?.authorEmail).toBe("alice@example.com");
  });

  it("stesso autore su DUE repo: una riga per commit, con il repoId giusto", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: true,
    });
    const repositoryId2 = await addRepository(testDb.db, projectId);
    const { deps } = makeDeps({
      commitsByCall: [
        [commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice", additions: 10, deletions: 2 })],
        [commit({ sha: "2".repeat(40), authorEmail: "alice@example.com", authorName: "Alice", additions: 5, deletions: 3 })],
      ],
    });

    await pollDailyReportsOnce(deps);
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(2); // una riga per commit, NON aggregate.
    const first = commits.find((c) => c.sha === "1".repeat(40));
    const second = commits.find((c) => c.sha === "2".repeat(40));
    expect(first?.repoId).toBe(repositoryId);
    expect(first?.additions).toBe(10);
    expect(second?.repoId).toBe(repositoryId2);
    expect(second?.additions).toBe(5);
    expect(new Set(commits.map((c) => c.authorEmail))).toEqual(new Set(["alice@example.com"]));

    // Un solo autore osservato, su entrambi i repo.
    const seen = await testDb.db.select().from(gitAuthorsSeen);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.email).toBe("alice@example.com");
  });

  it("run con exitCode != 0 (senza lanciare): aiDescription null, report done", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      commitsByCall: [[commit({})]],
      runResult: async () => ({ output: "output parziale", exitCode: 1 }),
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    // Il run è stato tentato per il commit (1) e per il riassunto (1); entrambi
    // con exit ≠ 0 → nessun testo salvato.
    expect(runSpy).toHaveBeenCalledTimes(2);
    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    expect(report?.summary).toBeNull(); // exit ≠ 0 → nessun riassunto.
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.aiDescription).toBeNull(); // nessuna descrizione da un exit non-zero.
    expect(commits[0]?.subject).toBe("Fix qualcosa");
  });

  it("un errore interno porta il report a 'failed' senza far crashare il tick", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });
    // La risoluzione del provider esplode DOPO il claim → cade nel catch (h).
    const { deps } = makeDeps({
      commitsByCall: [[commit({})]],
      loadProviderChainFn: async () => {
        throw new Error("provider chain esplosa");
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(0); // fallito, non contato come done.

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(report?.status).toBe("failed");
    expect(report?.error).toContain("provider chain esplosa");
    expect(report?.finishedAt).not.toBeNull();
    // Nessuna riga persistita (l'errore precede la transazione righe+done).
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(0);
  });

  it("genera un report accodato 'queued' su una data PASSATA, con la finestra di QUEL giorno", async () => {
    // Progetto disabilitato: così l'unica generazione è quella del 'queued' e la
    // finestra catturata è inequivocabilmente la sua (il gate notturno non gira).
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: false });
    // Richiesta manuale: riga 'queued' per 3 giorni fa (2026-07-12), non ieri.
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-12", status: "queued" });

    let queuedWindow: { since: Date; until: Date } | undefined;
    const { deps } = makeDeps({
      getCommitsImpl: async (_project, since, until) => {
        queuedWindow = { since, until };
        return [commit({ authorEmail: "alice@example.com", authorName: "Alice" })];
      },
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);

    // La finestra passata a getCommitsInRange è quella del giorno RICHIESTO,
    // non del giorno precedente a NOW.
    expect(queuedWindow?.since.toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(queuedWindow?.until.toISOString()).toBe("2026-07-13T00:00:00.000Z");

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(report?.status).toBe("done");
    expect(report?.date).toBe("2026-07-12");
    const commits = await testDb.db
      .select()
      .from(activityCommits)
      .where(eq(activityCommits.reportId, report!.id));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.authorEmail).toBe("alice@example.com");
  });

  it("è idempotente: un 'queued' già portato a 'done' non viene rigenerato al tick successivo", async () => {
    // Progetto DISABILITATO così il gate notturno non interferisce: isoliamo la
    // sola fase queued.
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: false });
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-12", status: "queued" });

    const first = makeDeps({ commitsByCall: [[commit({})]] });
    expect(await pollDailyReportsOnce(first.deps)).toBe(1);

    const second = makeDeps({ commitsByCall: [[commit({})]] });
    // Non più 'queued' (ora 'done') → non raccolto di nuovo.
    expect(await pollDailyReportsOnce(second.deps)).toBe(0);
    // Il secondo tick non ha nemmeno letto i commit (nessuna riga da processare).
    expect(second.getCommitsSpy).not.toHaveBeenCalled();
    // Una sola riga per 2026-07-12, invariata a 'done'.
    const july12 = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.date, "2026-07-12"));
    expect(july12).toHaveLength(1);
    expect(july12[0]?.status).toBe("done");
    expect(await testDb.db.select().from(activityReports)).toHaveLength(1);
  });

  it("genera un 'queued' anche per un progetto con dailyReportEnabled=false", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: false });
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-12", status: "queued" });

    const { deps, getCommitsSpy } = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1); // richiesto esplicitamente: generato malgrado il toggle off.
    expect(getCommitsSpy).toHaveBeenCalledTimes(1);

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(report?.status).toBe("done");
    expect(report?.date).toBe("2026-07-12");
  });

  it("un 'queued' per IERI coincide col gate notturno e NON viene duplicato", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });
    // Richiesta manuale per ieri (2026-07-14), lo stesso giorno del gate notturno.
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14", status: "queued" });

    const { deps, getCommitsSpy } = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });

    const generated = await pollDailyReportsOnce(deps);
    // Un solo report done (la fase queued lo genera, il gate notturno lo salta).
    expect(generated).toBe(1);
    // Una sola riga per (progetto, 2026-07-14).
    const reports = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.projectId, projectId));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.status).toBe("done");
    // Una sola generazione: getCommits chiamato una volta (fase queued), il gate
    // notturno ha saltato via onConflictDoNothing (riga già 'done').
    expect(getCommitsSpy).toHaveBeenCalledTimes(1);
    const commits = await testDb.db.select().from(activityCommits);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.authorEmail).toBe("alice@example.com");
  });

  it("git_authors_seen: il nome NON regredisce a null se un commit successivo ha nome vuoto", async () => {
    // Progetto disabilitato: isoliamo la sola fase queued (nessun gate notturno).
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: false });

    // Tick 1 — 2026-07-12: l'autore compare con un nome.
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-12", status: "queued" });
    const first = makeDeps({
      commitsByCall: [[commit({ authorEmail: "carol@example.com", authorName: "Carol" })]],
    });
    expect(await pollDailyReportsOnce(first.deps)).toBe(1);
    let seen = await testDb.db
      .select()
      .from(gitAuthorsSeen)
      .where(eq(gitAuthorsSeen.email, "carol@example.com"));
    expect(seen[0]?.authorName).toBe("Carol");

    // Tick 2 — 2026-07-13: STESSO autore (stessa email) ma con nome VUOTO. Il
    // coalesce dell'upsert deve tenere il nome già registrato, non azzerarlo.
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-13", status: "queued" });
    const second = makeDeps({
      commitsByCall: [[commit({ authorEmail: "carol@example.com", authorName: "" })]],
    });
    expect(await pollDailyReportsOnce(second.deps)).toBe(1);
    seen = await testDb.db
      .select()
      .from(gitAuthorsSeen)
      .where(eq(gitAuthorsSeen.email, "carol@example.com"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorName).toBe("Carol"); // NON regredito a null.
  });
});
