import {
  activityCommits,
  activityDayRollups,
  activityDevSummaries,
  activityRecountJobs,
  activityReports,
  aiProviders,
  encrypt,
  gitAccounts,
  gitAuthorsSeen,
  gitIdentities,
  projects,
  repositories,
  users,
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
  SUMMARY_INPUT_MAX_CHARS,
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
  // activity_reports/commits cascano da projects; le tabelle globali (non legate a
  // un progetto via FK) vanno pulite a mano per isolare i test. activity_dev_summaries
  // prima di users (userId → set null) e activity_day_rollups/git_authors_seen sono
  // slegate; git_identities cascade da users.
  await testDb.db.delete(activityDevSummaries);
  await testDb.db.delete(activityDayRollups);
  await testDb.db.delete(gitIdentities);
  await testDb.db.delete(projects);
  await testDb.db.delete(aiProviders);
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(gitAuthorsSeen);
  await testDb.db.delete(users);
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

/** Crea un membro (users) con N identità git (git_identities) associate, tutte
 * lowercase. Ritorna lo userId. Serve al rollup per risolvere gli autori. */
async function createMember(db: Db, emails: string[]): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `member-${randomUUID()}@example.com`,
      passwordHash: "x",
      role: "member",
    })
    .returning();
  for (const email of emails) {
    await db.insert(gitIdentities).values({ userId: user!.id, email: email.toLowerCase() });
  }
  return user!.id;
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
  /** Override della risoluzione per-id (per simulare un pin rotto → undefined). */
  loadProviderByIdFn?: PollDailyReportsDeps["loadProviderByIdFn"];
  now?: () => Date;
}

function makeDeps(o: MakeDepsOverrides = {}): {
  deps: PollDailyReportsDeps;
  runSpy: ReturnType<typeof vi.fn>;
  getCommitsSpy: ReturnType<typeof vi.fn>;
  getCommitRefsSpy: ReturnType<typeof vi.fn>;
  getCommitDiffSpy: ReturnType<typeof vi.fn>;
} {
  const commitsByCall = o.commitsByCall ?? [[]];
  // Sorgente unica dei commit finti: sia la GENERAZIONE (getCommitsInRange) sia il
  // RECOUNT (getCommitRefsInRange) leggono da qui. commitsByCall è indicizzato per
  // chiamata (una call per repo); getCommitsImpl vince se passato.
  let call = 0;
  const commitsImpl =
    o.getCommitsImpl ??
    (async (): Promise<RangeCommit[]> =>
      commitsByCall[Math.min(call++, commitsByCall.length - 1)] ?? []);
  const getCommitsSpy = vi.fn(commitsImpl);
  // Il recount usa la variante LEGGERA getCommitRefsInRange: deriva {sha,date,isMerge}
  // dalla stessa sorgente. Spy separato dalla generazione (che usa getCommitsInRange).
  const getCommitRefsSpy = vi.fn(
    async (project: MirrorProject, since: Date, until: Date) => {
      const commits = await commitsImpl(project, since, until);
      return commits.map((c) => ({ sha: c.sha, date: c.date, isMerge: c.isMerge }));
    },
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
      getCommitRefsInRange: getCommitRefsSpy,
      getCommitDiff: getCommitDiffSpy,
      ensureMirror,
    } as unknown as Pick<
      MirrorManager,
      "getCommitsInRange" | "getCommitRefsInRange" | "getCommitDiff" | "ensureMirror"
    >,
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
    loadProviderByIdFn: o.loadProviderByIdFn ?? (async () => o.provider ?? FAKE_PROVIDER),
  };
  return { deps, runSpy, getCommitsSpy, getCommitRefsSpy, getCommitDiffSpy };
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
    // riassunto narrativo del progetto, PIÙ un run per il riassunto per-sviluppatore
    // di ciascuno dei due autori non risolti (2 commit + 1 progetto + 2 dev = 5 run).
    expect(runSpy).toHaveBeenCalledTimes(5);
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
    // commit + 1 per il riassunto del progetto + 1 per il dev-summary di alice.
    expect(runSpy).toHaveBeenCalledTimes(3);
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
    // 1 run per il commit + 1 per il riassunto del progetto + 1 per il dev-summary.
    expect(runSpy).toHaveBeenCalledTimes(3);
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
    // Un run tentato per commit (2) + 1 per il riassunto del progetto + 1 per il
    // dev-summary di ciascun autore non risolto (alice, bob) = 5 run.
    expect(runSpy).toHaveBeenCalledTimes(5);

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
    // riassunto del progetto gira comunque (c'è un commit, seppur senza descrizione),
    // e nella fase di rollup il dev-summary di alice: 1 progetto + 1 dev = 2 run.
    expect(runSpy).toHaveBeenCalledTimes(2);
    // Il primo run è quello del riassunto di progetto (prima della fase di rollup).
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
    // Il run è stato tentato per il commit (1), per il riassunto di progetto (1) e
    // per il dev-summary di alice nel rollup (1); tutti con exit ≠ 0 → nessun testo
    // salvato.
    expect(runSpy).toHaveBeenCalledTimes(3);
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

  it("il prompt del riassunto aggrega subject, descrizioni e nome del progetto", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), subject: "Rework del parser" }),
          commit({ sha: "2".repeat(40), subject: "Aggiunge cache LRU" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    // Il prompt del RIASSUNTO (quello con "resoconto") deve contenere l'elenco
    // aggregato: subject di ogni commit, le descrizioni per-commit generate e il
    // nome del progetto. Protegge buildProjectSummaryPrompt da regressioni che
    // perdano l'aggregazione.
    const summaryCall = runSpy.mock.calls.find((c) => c[0]?.prompt?.includes("resoconto"));
    expect(summaryCall).toBeDefined();
    const prompt = summaryCall![0].prompt as string;
    expect(prompt).toContain("Progetto: Progetto daily.");
    expect(prompt).toContain("Rework del parser");
    expect(prompt).toContain("Aggiunge cache LRU");
    expect(prompt).toContain("descrizione finta"); // le descrizioni per-commit aggregate.
    expect(prompt).not.toContain("[elenco troncato"); // pochi commit: nessun troncamento.
  });

  it("cap: molti commit con descrizioni lunghe → prompt del riassunto troncato entro il budget", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    // 60 commit, ognuno con una descrizione per-commit di 3000 caratteri:
    // ~180k di contenuto aggregato, ben oltre SUMMARY_INPUT_MAX_CHARS (80k).
    const many = Array.from({ length: 60 }, (_, i) =>
      commit({ sha: String(i).padStart(40, "0"), subject: `Commit numero ${i}` }),
    );
    const longDesc = "X".repeat(3000);
    const { deps, runSpy } = makeDeps({
      commitsByCall: [many],
      // Descrizioni per-commit lunghe; il riassunto resta corto ("riassunto finto").
      runResult: async (opts) =>
        opts.prompt.includes("resoconto")
          ? { output: "riassunto finto", exitCode: 0 }
          : { output: longDesc, exitCode: 0 },
    });

    await pollDailyReportsOnce(deps);

    const summaryCall = runSpy.mock.calls.find((c) => c[0]?.prompt?.includes("resoconto"));
    expect(summaryCall).toBeDefined();
    const prompt = summaryCall![0].prompt as string;
    // Elenco troncato con marcatore che indica quanti commit sono esclusi.
    expect(prompt).toMatch(/\[elenco troncato per lunghezza: \d+ commit non inclusi\]/);
    // Il prompt non supera di molto il budget (l'elenco intero sarebbe ~180k):
    // il preambolo fisso è di poche centinaia di caratteri.
    expect(prompt.length).toBeLessThan(SUMMARY_INPUT_MAX_CHARS + 5_000);
  });

  it("rollup: un giorno tutto done crea un dev-summary per membro risolto e uno per email non risolta", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    // alice è associata a un membro; bob no.
    const userId = await createMember(testDb.db, ["alice@example.com"]);
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice" }),
          commit({ sha: "2".repeat(40), authorEmail: "bob@example.com", authorName: "Bob" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const devSummaries = await testDb.db
      .select()
      .from(activityDevSummaries)
      .where(eq(activityDevSummaries.date, "2026-07-14"));
    expect(devSummaries).toHaveLength(2);
    // Membro risolto: userId valorizzato, gitEmail null.
    const member = devSummaries.find((d) => d.userId === userId);
    expect(member).toBeDefined();
    expect(member?.gitEmail).toBeNull();
    expect(member?.summary).toBe("riassunto finto"); // il prompt dev contiene "resoconto".
    // Autore non risolto: gitEmail valorizzato, userId null.
    const byEmail = devSummaries.find((d) => d.gitEmail === "bob@example.com");
    expect(byEmail).toBeDefined();
    expect(byEmail?.userId).toBeNull();
    expect(byEmail?.summary).toBe("riassunto finto");

    // Il giorno è marcato come rollupato.
    const rollups = await testDb.db.select().from(activityDayRollups);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.date).toBe("2026-07-14");
  });

  it("rollup: un membro con due email git produce UN solo dev-summary, aggregando i commit di entrambe", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const userId = await createMember(testDb.db, ["work@example.com", "perso@example.com"]);
    const { deps, runSpy } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), authorEmail: "work@example.com", authorName: "Dev", subject: "Commit lavoro" }),
          commit({ sha: "2".repeat(40), authorEmail: "perso@example.com", authorName: "Dev", subject: "Commit personale" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const devSummaries = await testDb.db.select().from(activityDevSummaries);
    expect(devSummaries).toHaveLength(1); // un'unica riga per il membro.
    expect(devSummaries[0]?.userId).toBe(userId);
    expect(devSummaries[0]?.gitEmail).toBeNull();

    // Il prompt del dev-summary (unico gruppo membro) aggrega i commit di ENTRAMBE
    // le email. Distinto dal riassunto di progetto dal marcatore "SVILUPPATORE".
    const devCall = runSpy.mock.calls.find((c) => c[0]?.prompt?.includes("SVILUPPATORE"));
    expect(devCall).toBeDefined();
    expect(devCall![0].prompt).toContain("Commit lavoro");
    expect(devCall![0].prompt).toContain("Commit personale");
  });

  it("rollup: idempotente — un secondo tick con rollup già presente non rigenera i dev-summary", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const first = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });
    await pollDailyReportsOnce(first.deps);
    const after1 = await testDb.db.select().from(activityDevSummaries);
    expect(after1).toHaveLength(1);
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(1);

    // Secondo tick: il report è done (skip generazione) e il rollup è già marcato →
    // nessun nuovo run e righe invariate (stessa riga, non ricreata).
    const second = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });
    await pollDailyReportsOnce(second.deps);
    expect(second.runSpy).not.toHaveBeenCalled();
    const after2 = await testDb.db.select().from(activityDevSummaries);
    expect(after2).toHaveLength(1);
    expect(after2[0]?.id).toBe(after1[0]?.id);
  });

  it("rollup: un giorno con un report non-done NON viene rollupato finché non sono tutti done", async () => {
    // Il gate del rollup richiede bool_and(status='done') sul giorno: un report
    // 'failed' (non recuperato da FASE 0, né rigenerato: progetto disabilitato) lo
    // tiene fuori dai candidati. Modella l'attesa di "tutti done" (un report ancora
    // in corso in un altro progetto blocca il rollup del giorno).
    const a = await createProject(testDb.db, { dailyReportEnabled: false });
    const b = await createProject(testDb.db, { dailyReportEnabled: false });
    const [done] = await testDb.db
      .insert(activityReports)
      .values({ projectId: a.projectId, date: "2026-07-12", status: "done" })
      .returning();
    await testDb.db.insert(activityCommits).values({
      reportId: done!.id,
      repoId: a.repositoryId,
      sha: "1".repeat(40),
      authorEmail: "alice@example.com",
      committedAt: new Date("2026-07-12T00:00:00Z"),
      subject: "Commit fatto",
    });
    await testDb.db
      .insert(activityReports)
      .values({ projectId: b.projectId, date: "2026-07-12", status: "failed" });

    const { deps, runSpy } = makeDeps();
    await pollDailyReportsOnce(deps);

    expect(runSpy).not.toHaveBeenCalled(); // nessun run del rollup.
    expect(await testDb.db.select().from(activityDevSummaries)).toHaveLength(0);
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(0);
  });

  it("rollup: invalidato quando un report del giorno viene rigenerato, poi rifatto al tick successivo", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });

    // Tick 1: genera il report del giorno + il rollup dev-summary.
    const t1 = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });
    await pollDailyReportsOnce(t1.deps);
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(1);
    expect(await testDb.db.select().from(activityDevSummaries)).toHaveLength(1);

    // Rigenerazione manuale: rimetti il report 'queued'.
    await testDb.db
      .update(activityReports)
      .set({ status: "queued" })
      .where(eq(activityReports.projectId, projectId));

    // Tick 2 SENZA provider: il reclaim (in generateForProject) invalida rollup +
    // dev-summary del giorno; la fase di rollup NON li riscrive (niente provider) →
    // restano cancellati, provando l'invalidazione.
    const t2 = makeDeps({
      provider: null,
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });
    await pollDailyReportsOnce(t2.deps);
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(0);
    expect(await testDb.db.select().from(activityDevSummaries)).toHaveLength(0);

    // Tick 3 con provider: il report è di nuovo done → la fase di rollup lo rifà.
    const t3 = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
    });
    await pollDailyReportsOnce(t3.deps);
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(1);
    expect(await testDb.db.select().from(activityDevSummaries)).toHaveLength(1);
  });

  it("rollup best-effort: un gruppo il cui run lancia non ha summary, gli altri sì, e il rollup è scritto", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice", subject: "Lavoro di alice" }),
          commit({ sha: "2".repeat(40), authorEmail: "bob@example.com", authorName: "Bob", subject: "Lavoro di bob" }),
        ],
      ],
      // Solo il run del dev-summary di bob (prompt "SVILUPPATORE" col suo subject)
      // lancia; tutti gli altri run vanno a buon fine.
      runResult: async (opts) => {
        if (opts.prompt.includes("SVILUPPATORE") && opts.prompt.includes("Lavoro di bob")) {
          throw new Error("dev summary di bob esploso");
        }
        return {
          output: opts.prompt.includes("resoconto") ? "riassunto finto" : "descrizione finta",
          exitCode: 0,
        };
      },
    });

    await pollDailyReportsOnce(deps);

    const devSummaries = await testDb.db.select().from(activityDevSummaries);
    expect(devSummaries).toHaveLength(1); // solo alice ha un summary.
    expect(devSummaries[0]?.gitEmail).toBe("alice@example.com");
    // Il giorno è comunque marcato come rollupato (best-effort).
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(1);
  });

  it("rollup: un giorno done ma senza commit → rollup scritto, 0 dev-summary", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    // 0 commit non-merge → report done senza righe.
    const { deps, runSpy } = makeDeps({ commitsByCall: [[]] });

    await pollDailyReportsOnce(deps);

    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    // Nessun run (né descrizioni né riassunti né dev-summary) e nessun dev-summary.
    expect(runSpy).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(activityDevSummaries)).toHaveLength(0);
    // Il giorno è comunque marcato, così non resta pending all'infinito.
    const rollups = await testDb.db.select().from(activityDayRollups);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.date).toBe("2026-07-14");
  });

  it("rollup: un pin di progetto NON risolvibile non blocca il rollup — usa la chain globale", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });
    // Il progetto ha un provider PINNED (FK reale) che però NON è risolvibile
    // (loadProviderByIdFn → undefined, es. credenziale illeggibile).
    const [pinned] = await testDb.db
      .insert(aiProviders)
      .values({ position: 0, kind: "api_key", label: "pin rotto", secretEncrypted: "x" })
      .returning();
    await testDb.db
      .update(projects)
      .set({ aiProviderId: pinned!.id })
      .where(eq(projects.id, projectId));

    const { deps } = makeDeps({
      commitsByCall: [[commit({ authorEmail: "alice@example.com", authorName: "Alice" })]],
      // Pin rotto: la risoluzione per-id fallisce sempre (null)...
      loadProviderByIdFn: async () => null,
      // ...ma la chain globale è valida.
      loadProviderChainFn: async () => [FAKE_PROVIDER],
    });

    await pollDailyReportsOnce(deps);

    // Il rollup, cross-progetto, ha risolto il provider dalla CHAIN (non dal pin
    // rotto del progetto): ha generato il dev-summary e marcato il giorno. Con la
    // vecchia logica (pin del progetto) il giorno sarebbe restato pending per sempre.
    const devSummaries = await testDb.db.select().from(activityDevSummaries);
    expect(devSummaries).toHaveLength(1);
    expect(devSummaries[0]?.summary).toBe("riassunto finto");
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(1);
  });

  it("rollup: un dev-summary già presente (crash parziale) NON viene rigenerato, gli altri sì", async () => {
    // Progetto DISABILITATO col report del giorno GIÀ `done`: così questo tick NON
    // lo rigenera (nessuna invalidazione dei dev-summary del giorno) e la fase di
    // rollup lo vede tra i candidati con la riga di alice pre-esistente.
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    // alice è un membro risolto; bob resta email non risolta.
    const userId = await createMember(testDb.db, ["alice@example.com"]);
    const [done] = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14", status: "done" })
      .returning();
    await testDb.db.insert(activityCommits).values([
      {
        reportId: done!.id,
        repoId: repositoryId,
        sha: "1".repeat(40),
        authorEmail: "alice@example.com",
        committedAt: new Date("2026-07-14T10:00:00Z"),
        subject: "Lavoro di alice",
      },
      {
        reportId: done!.id,
        repoId: repositoryId,
        sha: "2".repeat(40),
        authorEmail: "bob@example.com",
        committedAt: new Date("2026-07-14T11:00:00Z"),
        subject: "Lavoro di bob",
      },
    ]);
    // Simula un tick precedente crashato DOPO l'insert del dev-summary di alice ma
    // PRIMA di marcare il rollup: la riga di alice esiste già per il giorno.
    await testDb.db.insert(activityDevSummaries).values({
      date: "2026-07-14",
      userId,
      gitEmail: null,
      summary: "PRE-ESISTENTE",
    });

    const { deps, runSpy } = makeDeps();
    await pollDailyReportsOnce(deps);

    // Il gruppo di alice è saltato (già presente): nessun run del suo dev-summary.
    // Solo bob genera un run "SVILUPPATORE".
    const devRuns = runSpy.mock.calls.filter((c) => c[0]?.prompt?.includes("SVILUPPATORE"));
    expect(devRuns).toHaveLength(1);
    expect(devRuns[0]![0].prompt).toContain("Lavoro di bob");
    expect(devRuns[0]![0].prompt).not.toContain("Lavoro di alice");

    const summaries = await testDb.db
      .select()
      .from(activityDevSummaries)
      .where(eq(activityDevSummaries.date, "2026-07-14"));
    expect(summaries).toHaveLength(2);
    // La riga di alice resta quella pre-esistente (non riscritta).
    const aliceRow = summaries.find((s) => s.userId === userId);
    expect(aliceRow?.summary).toBe("PRE-ESISTENTE");
    // bob è stato generato normalmente.
    const bobRow = summaries.find((s) => s.gitEmail === "bob@example.com");
    expect(bobRow?.summary).toBe("riassunto finto");
    // Il giorno è marcato come rollupato.
    expect(await testDb.db.select().from(activityDayRollups)).toHaveLength(1);
  });
});

describe("recountStaleReports (fase recount)", () => {
  /** Inserisce un report done con N activity_commits (sha dati) per un giorno. */
  async function seedDoneReport(
    projectId: string,
    repositoryId: string,
    date: string,
    shas: string[],
    staleCommitCount = 0,
  ): Promise<string> {
    const [report] = await testDb.db
      .insert(activityReports)
      .values({ projectId, date, status: "done", staleCommitCount })
      .returning();
    if (shas.length > 0) {
      await testDb.db.insert(activityCommits).values(
        shas.map((sha) => ({
          reportId: report!.id,
          repoId: repositoryId,
          sha,
          authorEmail: "alice@example.com",
          committedAt: new Date(`${date}T10:00:00Z`),
          subject: `Commit ${sha.slice(0, 4)}`,
        })),
      );
    }
    return report!.id;
  }

  /** Accoda un recount job per il progetto con notBefore relativo a ORA reale. */
  async function enqueueRecount(projectId: string, offsetMs: number): Promise<void> {
    await testDb.db
      .insert(activityRecountJobs)
      .values({ projectId, notBefore: new Date(Date.now() + offsetMs) });
  }

  it("un commit del giorno assente dal report → stale_commit_count = 1, e il job è consumato", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    const reportId = await seedDoneReport(projectId, repositoryId, "2026-07-14", [
      "1".repeat(40),
      "2".repeat(40),
    ]);
    await enqueueRecount(projectId, -60_000); // scaduto.

    // git restituisce gli stessi due sha PIÙ uno nuovo (mancante), nel giorno del report.
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" }),
          commit({ sha: "2".repeat(40), date: "2026-07-14T11:00:00Z" }),
          commit({ sha: "3".repeat(40), date: "2026-07-14T12:00:00Z" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, reportId));
    expect(report?.staleCommitCount).toBe(1);
    // Il job è stato reclamato (DELETE).
    expect(await testDb.db.select().from(activityRecountJobs)).toHaveLength(0);
  });

  it("ricalcolo pieno idempotente: nessun commit mancante → stale_commit_count torna 0", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    // Il report parte con uno stale pre-esistente (3): il recount deve azzerarlo.
    const reportId = await seedDoneReport(
      projectId,
      repositoryId,
      "2026-07-14",
      ["1".repeat(40), "2".repeat(40)],
      3,
    );
    await enqueueRecount(projectId, -60_000);

    // git restituisce SOLO gli sha già presenti: nessun mancante.
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" }),
          commit({ sha: "2".repeat(40), date: "2026-07-14T11:00:00Z" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, reportId));
    expect(report?.staleCommitCount).toBe(0);
  });

  it("raggruppa i commit per giorno UTC, non per giorno locale del committer", async () => {
    // Committer in un fuso -08:00 vicino alla mezzanotte: 2026-07-14T18:00-08:00
    // = 2026-07-15T02:00Z. Il commit appartiene al giorno UTC 07-15 (come lo
    // registra la generazione, che usa istanti UTC), NON al 07-14 locale.
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    // Il report del 07-15 ha già il commit registrato → deve risultare presente.
    const report15 = await seedDoneReport(projectId, repositoryId, "2026-07-15", [
      "1".repeat(40),
    ]);
    // Il report del 07-14 non ha commit: NON deve ereditare un falso mancante.
    const report14 = await seedDoneReport(projectId, repositoryId, "2026-07-14", []);
    await enqueueRecount(projectId, -60_000);

    const { deps } = makeDeps({
      commitsByCall: [[commit({ sha: "1".repeat(40), date: "2026-07-14T18:00:00-08:00" })]],
    });

    await pollDailyReportsOnce(deps);

    const [r15] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, report15));
    // Il commit è attribuito al 07-15 UTC ed è presente → nessun mancante.
    expect(r15?.staleCommitCount).toBe(0);

    const [r14] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, report14));
    // Con lo slice locale il commit finirebbe nel bucket 07-14 → falso mancante (1).
    expect(r14?.staleCommitCount).toBe(0);
  });

  it("un recount job con notBefore FUTURO non viene processato", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    const reportId = await seedDoneReport(
      projectId,
      repositoryId,
      "2026-07-14",
      ["1".repeat(40)],
      5,
    );
    await enqueueRecount(projectId, 5 * 60_000); // futuro.

    const { deps, getCommitRefsSpy } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" }),
          commit({ sha: "2".repeat(40), date: "2026-07-14T11:00:00Z" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    // Recount non ha reclamato nulla: git non è stato interrogato.
    expect(getCommitRefsSpy).not.toHaveBeenCalled();
    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, reportId));
    expect(report?.staleCommitCount).toBe(5); // invariato.
    // Il job resta accodato per un tick futuro.
    expect(await testDb.db.select().from(activityRecountJobs)).toHaveLength(1);
  });

  it("best-effort + fail-closed: un progetto il cui git LANCIA non blocca gli altri e non azzera il suo stale", async () => {
    const a = await createProject(testDb.db, { dailyReportEnabled: false });
    const b = await createProject(testDb.db, { dailyReportEnabled: false });
    // Entrambi partono con uno stale pre-esistente (5): simmetrici, così
    // l'asserzione è indipendente da QUALE dei due venga processato per primo.
    await seedDoneReport(a.projectId, a.repositoryId, "2026-07-14", ["1".repeat(40)], 5);
    await seedDoneReport(b.projectId, b.repositoryId, "2026-07-14", ["1".repeat(40)], 5);
    await enqueueRecount(a.projectId, -60_000);
    await enqueueRecount(b.projectId, -60_000);

    // Il PRIMO progetto processato LANCIA (repo irraggiungibile) → il suo recount
    // aborta senza aggiornare (fail-closed); il secondo restituisce un commit
    // mancante e viene ricontrollato normalmente.
    let n = 0;
    const { deps } = makeDeps({
      getCommitsImpl: async () => {
        if (n++ === 0) throw new Error("git irraggiungibile");
        return [
          commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" }),
          commit({ sha: "2".repeat(40), date: "2026-07-14T11:00:00Z" }),
        ];
      },
    });

    await pollDailyReportsOnce(deps); // non deve lanciare.

    // Entrambi i job reclamati (best-effort: il fallito non viene riaccodato qui).
    expect(await testDb.db.select().from(activityRecountJobs)).toHaveLength(0);
    // Fail-closed: il progetto col git rotto CONSERVA il suo stale=5 (l'abort NON
    // lo sovrascrive a 0). Il progetto sopravvissuto scende a stale=1 (un mancante).
    const reports = await testDb.db.select().from(activityReports);
    expect(reports.map((r) => r.staleCommitCount).sort()).toEqual([1, 5]);
  });

  it("i commit di merge non contano tra i mancanti", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    const reportId = await seedDoneReport(projectId, repositoryId, "2026-07-14", ["1".repeat(40)]);
    await enqueueRecount(projectId, -60_000);

    // git: sha1 (presente), sha2 non-merge (mancante → conta), sha3 MERGE (escluso).
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" }),
          commit({ sha: "2".repeat(40), date: "2026-07-14T11:00:00Z" }),
          commit({ sha: "3".repeat(40), date: "2026-07-14T12:00:00Z", isMerge: true }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, reportId));
    expect(report?.staleCommitCount).toBe(1); // solo il non-merge mancante.
  });

  it("solo i report done sono ricontrollati: un report failed dello stesso progetto non è toccato", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    const doneId = await seedDoneReport(projectId, repositoryId, "2026-07-14", ["1".repeat(40)]);
    // Report FAILED per un altro giorno, con uno stale pre-esistente: non va toccato.
    const [failed] = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-13", status: "failed", staleCommitCount: 7 })
      .returning();
    await enqueueRecount(projectId, -60_000);

    // git nel range restituisce commit di ENTRAMBI i giorni: 14 (1 presente + 1
    // mancante) e 13 (uno che sarebbe mancante SE il failed venisse ricontrollato).
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" }),
          commit({ sha: "2".repeat(40), date: "2026-07-14T11:00:00Z" }),
          commit({ sha: "9".repeat(40), date: "2026-07-13T10:00:00Z" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const [done] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, doneId));
    expect(done?.staleCommitCount).toBe(1); // il done: un mancante nel suo giorno.
    const [failedAfter] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, failed!.id));
    expect(failedAfter?.staleCommitCount).toBe(7); // il failed NON è stato ricontrollato.
  });

  it("nessun recount job scaduto → fase no-op (git non interrogato)", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    await seedDoneReport(projectId, repositoryId, "2026-07-14", ["1".repeat(40)], 4);
    // Nessun job accodato.

    const { deps, getCommitRefsSpy } = makeDeps({
      commitsByCall: [[commit({ sha: "1".repeat(40), date: "2026-07-14T10:00:00Z" })]],
    });

    await pollDailyReportsOnce(deps);

    expect(getCommitRefsSpy).not.toHaveBeenCalled();
    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.staleCommitCount).toBe(4); // invariato.
  });

  it("aggrega i commit di TUTTI i repo del progetto: l'expected del giorno è l'unione", async () => {
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    // Secondo repo dello stesso progetto: i suoi commit del giorno concorrono
    // allo stesso report (l'expected del giorno è l'UNIONE dei due repo).
    await addRepository(testDb.db, projectId);
    // Il report ha registrato SOLO a1: a2 (repo A) e b1 (repo B) sono mancanti.
    const reportId = await seedDoneReport(projectId, repositoryId, "2026-07-14", ["a".repeat(40)]);
    await enqueueRecount(projectId, -60_000);

    // Una call per repo (l'ordine dei repo non conta: si uniscono in expectedByDay).
    const { deps } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "a".repeat(40), date: "2026-07-14T10:00:00Z" }), // presente
          commit({ sha: "b".repeat(40), date: "2026-07-14T11:00:00Z" }), // mancante (repo A)
        ],
        [
          commit({ sha: "c".repeat(40), date: "2026-07-14T12:00:00Z" }), // mancante (repo B)
        ],
      ],
    });

    await pollDailyReportsOnce(deps);

    const [report] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, reportId));
    // Unione {a,b,c} − registrati {a} = 2 mancanti (uno per repo).
    expect(report?.staleCommitCount).toBe(2);
  });

  it("un report done oltre la retention (più vecchio del cutoff) NON viene ricontrollato", async () => {
    // Il recount filtra i report con `date >= cutoffDate` (cutoff = now - retentionDays,
    // lo STESSO della retention). Un report più vecchio del cutoff è FUORI dalla
    // finestra del recount: non viene ricontrollato — git non è nemmeno interrogato
    // per lui — e la fase di retention dello stesso tick lo elimina.
    const { projectId, repositoryId } = await createProject(testDb.db, {
      dailyReportEnabled: false,
    });
    // SOLO un report molto vecchio (2026-01-01), ben oltre il cutoff (~2026-04-16
    // con retention 90gg da NOW=2026-07-15), con uno stale pre-esistente (3).
    const oldId = await seedDoneReport(projectId, repositoryId, "2026-01-01", [], 3);
    await enqueueRecount(projectId, -60_000);

    // git AVREBBE un commit mancante per quel giorno, ma non deve mai essere
    // consultato: il report è fuori retention e il recount lo salta.
    const { deps, getCommitRefsSpy } = makeDeps({
      commitsByCall: [[commit({ sha: "9".repeat(40), date: "2026-01-01T10:00:00Z" })]],
    });

    await pollDailyReportsOnce(deps);

    // Recount NON ha interrogato git: nessun report done entro la retention da
    // ricontrollare (il vecchio è escluso dal filtro `date >= cutoffDate`).
    expect(getCommitRefsSpy).not.toHaveBeenCalled();
    // Il report vecchio è stato eliminato dalla retention (mai ricontato).
    const [old] = await testDb.db
      .select()
      .from(activityReports)
      .where(eq(activityReports.id, oldId));
    expect(old).toBeUndefined();
  });
});
