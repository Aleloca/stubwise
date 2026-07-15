import {
  activityReportEntries,
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
  // activity_reports/entries cascano da projects; git_authors_seen è globale.
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
  runResult?: () => Promise<AgentRunResult>;
  maxAuthorsPerProject?: number;
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
} {
  const commitsByCall = o.commitsByCall ?? [[]];
  let call = 0;
  const getCommitsSpy = vi.fn(
    o.getCommitsImpl ??
      (async () => commitsByCall[Math.min(call++, commitsByCall.length - 1)] ?? []),
  );
  const ensureMirror = vi.fn(async () => "/tmp/fake-mirror");
  const runSpy = vi.fn(
    o.runResult ?? (async (): Promise<AgentRunResult> => ({ output: "riassunto finto", exitCode: 0 })),
  );
  const { serializer } = makeSerializer();
  const deps: PollDailyReportsDeps = {
    db: testDb.db,
    mirrors: { getCommitsInRange: getCommitsSpy, ensureMirror } as unknown as Pick<
      MirrorManager,
      "getCommitsInRange" | "ensureMirror"
    >,
    runner: { run: runSpy } as unknown as AgentRunner,
    encryptionKey: ENCRYPTION_KEY,
    serializer,
    maxAuthorsPerProject: o.maxAuthorsPerProject ?? 25,
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
  return { deps, runSpy, getCommitsSpy };
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
  it("genera un report done con entries e riassunti, e registra gli autori", async () => {
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      commitsByCall: [
        [
          commit({ sha: "1".repeat(40), authorEmail: "Alice@Example.com", authorName: "Alice" }),
          commit({ sha: "2".repeat(40), authorEmail: "bob@example.com", authorName: "Bob", additions: 5, deletions: 1 }),
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

    const entries = await testDb.db
      .select()
      .from(activityReportEntries)
      .where(eq(activityReportEntries.reportId, report!.id));
    expect(entries).toHaveLength(2);
    // Email normalizzate a lowercase.
    const alice = entries.find((e) => e.gitEmail === "alice@example.com");
    expect(alice).toBeDefined();
    expect(alice?.commitCount).toBe(1);
    expect(alice?.aiSummary).toBe("riassunto finto");
    expect(alice?.commits).toHaveLength(1);
    expect(alice?.repoIds).toHaveLength(1);

    // Un run dell'agente per autore.
    expect(runSpy).toHaveBeenCalledTimes(2);

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
    const { projectId } = await createProject(testDb.db, { dailyReportEnabled: true });
    // Simula un tentativo precedente killato tra l'insert 'running' e il 'done':
    // riga 'running' con una entry parziale rimasta appesa.
    const [orphan] = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14", status: "running" })
      .returning();
    await testDb.db.insert(activityReportEntries).values({
      reportId: orphan!.id,
      gitEmail: "stale@example.com",
      authorName: "Stale",
      commitCount: 99,
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

    // Entries FRESCHE: la parziale del tentativo precedente è sparita.
    const entries = await testDb.db
      .select()
      .from(activityReportEntries)
      .where(eq(activityReportEntries.reportId, orphan!.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.gitEmail).toBe("alice@example.com");
    expect(entries.find((e) => e.gitEmail === "stale@example.com")).toBeUndefined();
    // Il run dell'agente è stato eseguito (rigenerazione vera, non skip).
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("esclude i commit di merge dal conteggio", async () => {
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
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.commitCount).toBe(1); // il merge non conta.
  });

  it("oltre maxAuthorsPerProject: l'autore in eccesso ha aiSummary null ma l'entry esiste", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      maxAuthorsPerProject: 1,
      commitsByCall: [
        [
          // Alice ha 2 commit (top per commitCount), Bob 1 (oltre il cap).
          commit({ sha: "1".repeat(40), authorEmail: "alice@example.com", authorName: "Alice" }),
          commit({ sha: "2".repeat(40), authorEmail: "alice@example.com", authorName: "Alice" }),
          commit({ sha: "3".repeat(40), authorEmail: "bob@example.com", authorName: "Bob" }),
        ],
      ],
    });

    await pollDailyReportsOnce(deps);
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(2);
    const alice = entries.find((e) => e.gitEmail === "alice@example.com");
    const bob = entries.find((e) => e.gitEmail === "bob@example.com");
    expect(alice?.aiSummary).toBe("riassunto finto");
    expect(bob?.aiSummary).toBeNull();
    expect(bob?.commitCount).toBe(1); // dati grezzi comunque presenti.
    // Un solo run: solo per l'autore entro il cap.
    expect(runSpy).toHaveBeenCalledTimes(1);
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

  it("best-effort: se runner.run lancia, l'entry esiste con aiSummary null e il report è done", async () => {
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
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.aiSummary).toBeNull();
    expect(entries[0]?.commitCount).toBe(1);
  });

  it("senza provider disponibile: persiste i dati grezzi con aiSummary null", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({ provider: null, commitsByCall: [[commit({})]] });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    expect(runSpy).not.toHaveBeenCalled();
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.aiSummary).toBeNull();
    expect(entries[0]?.commitCount).toBe(1);
  });

  it("un repo il cui getCommitsInRange LANCIA è saltato, gli altri aggregano", async () => {
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
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1); // aggregato solo il repo sopravvissuto.
    expect(entries[0]?.gitEmail).toBe("alice@example.com");
    expect(entries[0]?.commitCount).toBe(1);
  });

  it("stesso autore su DUE repo: repoIds ha entrambi e i conteggi si sommano", async () => {
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
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1); // un solo autore.
    const alice = entries[0]!;
    expect(alice.commitCount).toBe(2); // 1 + 1.
    expect(alice.additions).toBe(15); // 10 + 5.
    expect(alice.deletions).toBe(5); // 2 + 3.
    expect(new Set(alice.repoIds)).toEqual(new Set([repositoryId, repositoryId2]));
    expect(alice.commits).toHaveLength(2);
  });

  it("run con exitCode != 0 (senza lanciare): aiSummary null, report done", async () => {
    await createProject(testDb.db, { dailyReportEnabled: true });
    const { deps, runSpy } = makeDeps({
      commitsByCall: [[commit({})]],
      runResult: async () => ({ output: "output parziale", exitCode: 1 }),
    });

    const generated = await pollDailyReportsOnce(deps);
    expect(generated).toBe(1);
    expect(runSpy).toHaveBeenCalledTimes(1); // il run è stato tentato.
    const [report] = await testDb.db.select().from(activityReports);
    expect(report?.status).toBe("done");
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.aiSummary).toBeNull(); // nessun riassunto da un exit non-zero.
    expect(entries[0]?.commitCount).toBe(1);
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
    // Nessuna entry persistita (l'errore precede la transazione entries+done).
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(0);
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
    const entries = await testDb.db
      .select()
      .from(activityReportEntries)
      .where(eq(activityReportEntries.reportId, report!.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.gitEmail).toBe("alice@example.com");
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
    const entries = await testDb.db.select().from(activityReportEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.gitEmail).toBe("alice@example.com");
  });
});
