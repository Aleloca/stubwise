import {
  agentQuestions,
  aiJobs,
  aiProviders,
  comments,
  encrypt,
  gitAccounts,
  prCorrections,
  projects,
  repositories,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FakeAgentRunner } from "./agent/fake.js";
import type { AgentRunOptions } from "./agent/runner.js";
import { MirrorManager, mirrorSlug } from "./git/mirrors.js";
import { createHandler } from "./handler.js";
import { getContentLanguage } from "./settings.js";
import { pollLimitResumeOnce } from "./providers/limit-resume-poller.js";
import { t } from "@stubwise/i18n";
import type { SelectDeps } from "./providers/select.js";
import { claimNextJob, type AiJob } from "./queue.js";

/**
 * Scrive il "diff" del fix nel worktree del repo `repoUrl` (sottocartella
 * `mirrorSlug` di parentDir, dove ora gira l'agente) e il report nella RADICE del
 * progetto (parentDir). Riproduce ciò che l'agente reale fa quando modifica un
 * singolo repo del progetto: il worker committa+pusha SOLO i repo con un diff.
 */
async function writeFixDiff(cwd: string, repoUrl: string, report: string): Promise<void> {
  await writeFile(join(cwd, mirrorSlug(repoUrl), "app.js"), "exports.sum = (a, b) => a + b;\n");
  await writeFile(join(cwd, "STUBWISE_REPORT.md"), report);
}

// E2E del wiring: job `queued` reclamato → handler → triage (decisione fix)
// → fase di fix con push e PR finta. Più i test della serializzazione
// per-repository (due job dello stesso repository non devono mai sovrapporsi:
// il fetch --prune di un job cancellerebbe i ref stubwise/* dell'altro), e il
// parallelismo di repository diversi (anche dello stesso progetto).

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let uniq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

async function makeUpstream(): Promise<{ dir: string; url: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-handler-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  await writeFile(join(work, "app.js"), "exports.sum = (a, b) => a - b;\n");
  await git(["add", "."], work);
  await git(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"], work);
  await git(["push", "origin", "main"], work);
  return { dir, url: pathToFileURL(dir).href };
}

/** Pusha sull'upstream il branch della PR del ticket `number` (il primo giro del fix). */
async function pushPrBranch(upstream: { dir: string }, number: number): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "stubwise-handler-pr-"));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  await execa("git", ["clone", "--quiet", upstream.dir, work]);
  await git(["switch", "-c", `stubwise/ticket-${number}`], work);
  await writeFile(join(work, "app.js"), "exports.sum = (a, b) => a + b;\n");
  await git(["add", "."], work);
  await git(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "fix"], work);
  await git(["push", "origin", `stubwise/ticket-${number}`], work);
  return git(["rev-parse", "HEAD"], work);
}

/** Collega il ticket a una PR aperta di Stubwise sul repo. */
async function linkOpenPr(db: Db, ticketId: string, repositoryId: string, number: number): Promise<void> {
  await db.insert(ticketRepositories).values({
    ticketId,
    repositoryId,
    branch: `stubwise/ticket-${number}`,
    prUrl: `https://github.com/acme/repo/pull/${number}`,
    prState: "open",
    prNumber: number,
  });
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-handler-mirrors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new MirrorManager({ mirrorsDir: join(root, "mirrors") });
}

interface RepoRef {
  projectId: string;
  repositoryId: string;
}

// Crea un progetto (gruppo) — con l'eventuale aiProviderId, che ora vive sul gruppo —
// e un repository che vi appartiene. Ritorna entrambi gli id: il fix lavora sul
// repository, il provider AI è risolto dal progetto del repository. Per testare due
// repository dello STESSO progetto si passa `projectId`.
async function createRepository(
  db: Db,
  repoUrl: string,
  opts: { aiProviderId?: string; aiProviderExclusive?: boolean; projectId?: string } = {},
): Promise<RepoRef> {
  uniq++;
  const gitAccountId = await seedGitAccount(db, {
    provider: "github",
    encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
  });
  let projectId = opts.projectId;
  if (!projectId) {
    const [project] = await db
      .insert(projects)
      .values({
        name: `Gruppo ${uniq}`,
        slug: `gruppo-${uniq}`,
        ingestionKey: `ingestion-gruppo-${uniq}-${randomUUID()}`,
        ...(opts.aiProviderId !== undefined ? { aiProviderId: opts.aiProviderId } : {}),
        ...(opts.aiProviderExclusive !== undefined ? { aiProviderExclusive: opts.aiProviderExclusive } : {}),
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    projectId = project.id;
  }
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId,
      name: `Handler ${uniq}`,
      slug: `handler-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl,
      defaultBranch: "main",
    })
    .returning();
  if (!repository) throw new Error("insert del repository non ha restituito la riga");
  return { projectId, repositoryId: repository.id };
}

async function createQueuedJob(
  db: Db,
  ref: RepoRef,
  title: string,
  number: number,
  jobValues: Partial<typeof aiJobs.$inferInsert> = {},
): Promise<string> {
  const [ticket] = await db
    .insert(tickets)
    .values({
      projectId: ref.projectId,
      number,
      title,
      type: "bug",
      priority: "high",
      source: "sdk_error",
    })
    .returning();
  if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
  const [job] = await db.insert(aiJobs).values({ ticketId: ticket.id, ...jobValues }).returning();
  if (!job) throw new Error("insert del job non ha restituito la riga");
  return ticket.id;
}

/** Scelta dell'account contro il Postgres del test (selectProviders vero). */
function selectDeps(db: Db, extra: Partial<SelectDeps> = {}): SelectDeps {
  return { db, encryptionKey: ENCRYPTION_KEY, backgroundWeeklyThreshold: 90, ...extra };
}

async function insertProvider(
  db: Db,
  p: {
    position: number;
    kind: "account" | "api_key";
    label: string;
    secret: string;
    enabled?: boolean;
    limitedUntil?: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(aiProviders)
    .values({
      position: p.position,
      kind: p.kind,
      label: p.label,
      secretEncrypted: encrypt(p.secret, ENCRYPTION_KEY),
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      ...(p.limitedUntil !== undefined ? { limitedUntil: p.limitedUntil } : {}),
    })
    .returning();
  if (!row) throw new Error("insert provider non ha restituito la riga");
  return row.id;
}

async function limitedUntilById(db: Db): Promise<Map<string, Date | null>> {
  const rows = await db.select({ id: aiProviders.id, limitedUntil: aiProviders.limitedUntil }).from(aiProviders);
  return new Map(rows.map((r) => [r.id, r.limitedUntil]));
}

async function claim(db: Db): Promise<AiJob> {
  const job = await claimNextJob(db);
  if (!job) throw new Error("nessun job in coda da reclamare");
  return job;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createHandler", () => {
  it("e2e: job queued → triage decide fix → fase di fix con PR aperta", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 3);

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        if (opts.model === "haiku") {
          // Fase di triage: nessun file, solo la decisione.
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        // Fase di fix: scrive il "diff" e il report nel worktree.
        await writeFixDiff(opts.cwd, upstream.url, REPORT);
        return { output: "fix applicato", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/5" });

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // Triage (haiku) + fix in DUE FASI (plan opus, execute sonnet): TRE
    // chiamate al runner, in quest'ordine.
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]?.model).toBe("haiku");
    expect(runner.calls[1]?.model).toBe("opus");
    expect(runner.calls[1]?.permissionMode).toBe("plan");
    expect(runner.calls[2]?.model).toBe("sonnet");
    expect(runner.calls[2]?.permissionMode).toBe("acceptEdits");

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.prUrl).toBe("https://github.com/acme/repo/pull/5");
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
    // Il branch è davvero arrivato sull'origin di test.
    expect(await git(["branch", "--list", "stubwise/ticket-3"], upstream.dir)).toContain("stubwise/ticket-3");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("decisione skip → la fase di fix non parte (runner chiamato una sola volta)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 1);

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(1);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("skipped");
  });

  it("job con resume_mode=fix: salta il triage e va dritto al fix", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 7, {
      resumeMode: "fix",
    });

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        // Il triage gira con model haiku: se mai venisse invocato, qui lo
        // intercetteremmo e il test fallirebbe (nessuna call deve essere haiku).
        if (opts.model === "haiku") {
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        await writeFixDiff(opts.cwd, upstream.url, REPORT);
        return { output: "fix applicato", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/9" });

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // NIENTE triage: solo le DUE fasi del fix (plan opus + execute sonnet).
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.map((c) => c.model)).not.toContain("haiku");
    expect(runner.calls[0]?.model).toBe("opus");
    expect(runner.calls[0]?.permissionMode).toBe("plan");
    expect(runner.calls[1]?.model).toBe("sonnet");
    expect(runner.calls[1]?.permissionMode).toBe("acceptEdits");

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.prUrl).toBe("https://github.com/acme/repo/pull/9");
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("job che INIZIA queued con resume_mode=execute + planText: esegue direttamente dal piano, niente triage né pianificazione", async () => {
    // È il caso "run-ai su ticket con implementationPlan salvato": il job nasce
    // già in execute-diretto (resumeMode=execute + planText) SENZA una fase di
    // pianificazione pregressa. resolveFixMode → execute-only: il worker crea il
    // proprio worktree dal mirror e fa UN SOLO run (execute), niente triage
    // (haiku) né plan run (opus/plan).
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const PLAN = "## Piano salvato\n1. Correggi il segno in sum\n2. Aggiungi un test";
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 21, {
      resumeMode: "execute",
      planText: PLAN,
    });

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        // Né triage (haiku) né pianificazione (permission-mode plan) devono
        // girare: se accadesse, questi rami intercetterebbero e il test
        // fallirebbe sulle asserzioni sotto.
        if (opts.model === "haiku") {
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        // Il prompt di execute deve contenere il piano salvato: prova che il
        // worker esegue DAL piano fornito, non da uno ripianificato.
        expect(opts.prompt).toContain(PLAN);
        await writeFixDiff(opts.cwd, upstream.url, REPORT);
        return { output: "fix applicato", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/21" });

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // UN SOLO run: l'execute (sonnet, acceptEdits). Niente triage (haiku),
    // niente plan run (permission-mode plan).
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls.map((c) => c.model)).not.toContain("haiku");
    expect(runner.calls.map((c) => c.permissionMode)).not.toContain("plan");
    expect(runner.calls[0]?.model).toBe("sonnet");
    expect(runner.calls[0]?.permissionMode).toBe("acceptEdits");

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.prUrl).toBe("https://github.com/acme/repo/pull/21");
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("job con resume_mode=plan_continue: salta il triage e riprende la pianificazione", async () => {
    // La risposta umana ha rimesso il job in coda con resume_mode=plan_continue.
    // Ri-triagiarlo sarebbe un disastro: il triage potrebbe chiuderlo come
    // `skipped`/`duplicate` e buttare via sia la risposta sia la sessione CLI.
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "la cache va persistita?", 31, {
      resumeMode: "plan_continue",
      cliSessionId: "sess-1",
      // Regime plan-only: dopo la ripresa il job torna in attesa di approvazione.
      planApprovalRequired: true,
    });
    // La domanda già risposta da cui la ripresa riparte.
    const [job0] = await db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));
    if (!job0) throw new Error("job non trovato");
    await db.insert(agentQuestions).values({
      jobId: job0.id,
      ticketId,
      round: 1,
      question: "La cache va persistita?",
      options: [{ label: "Solo in memoria" }, { label: "Su Postgres" }],
      allowFreeText: true,
      answer: { optionIndex: 1 },
      answeredAt: new Date(),
    });

    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        if (opts.model === "haiku") {
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        return { output: "PIANO DOPO LA RISPOSTA", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn();

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
      // Riassunto "in breve" del piano SPENTO: questa ripresa finisce in
      // `awaiting_plan_approval`, quindi il riassunto girerebbe e aggiungerebbe
      // un run. Qui si sta contando che NON ci sia il triage, e il conteggio
      // deve restare leggibile per quello.
      fix: { summariesEnabled: false },
    });

    const job = await claim(db);
    await handler(job);

    // NIENTE triage: un solo run, ed è la RIPRESA della sessione CLI.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls.map((c) => c.model)).not.toContain("haiku");
    expect(runner.calls[0]?.permissionMode).toBe("plan");
    expect(runner.calls[0]?.resumeSessionId).toBe("sess-1");
    expect(runner.calls[0]?.prompt).toContain("Su Postgres");

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("awaiting_plan_approval");
    expect(jobAfter?.planText).toBe("PIANO DOPO LA RISPOSTA");
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it("resume_mode=fix con ownership persa: markFixing fallisce → il fix NON parte", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "job di ripresa orfano", 11, { resumeMode: "fix" });

    // Lo script lancerebbe se il runner venisse invocato: ci serve solo per
    // accorgerci se per errore il fix partisse (runner.calls dovrà restare vuoto).
    const runner = new FakeAgentRunner({ output: "non dovrei mai girare" });
    const openPullRequest = vi.fn();

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    // OWNERSHIP PERSA: claimNextJob ha marcato `triaging`, ma prima di invocare
    // l'handler portiamo il job a uno stato NON-ACTIVE (es. requeue + reclamo
    // da un altro worker). markFixing è status-guarded su [triaging, fixing]:
    // su `failed` non aggiorna nulla e restituisce false.
    await db.update(aiJobs).set({ status: "failed" }).where(eq(aiJobs.id, job.id));

    await handler(job);

    // Il runner non viene MAI chiamato: il fix non è partito.
    expect(runner.calls).toHaveLength(0);
    expect(openPullRequest).not.toHaveBeenCalled();
    // Il log del job riporta la perdita di ownership e lo stato resta failed.
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.log).toContain("ownership persa");
    expect(jobAfter?.status).toBe("failed");
  });

  it("serializza i job dello STESSO progetto: il secondo parte solo dopo la fine del primo", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/seriale");
    await createQueuedJob(db, repo, "primo job", 1);
    await createQueuedJob(db, repo, "secondo job", 2);

    const windows: Array<{ title: string; start: number; end: number }> = [];
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        const title = /Title: (.*)\n/.exec(opts.prompt)?.[1] ?? "?";
        const start = Date.now();
        await sleep(300);
        windows.push({ title, start, end: Date.now() });
        return {
          output: `{"decision":"skip","type":"bug","effort":1,"reason":"test di serializzazione"}`,
          exitCode: 0,
        };
      },
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job1 = await claim(db);
    const job2 = await claim(db);
    // Lanciati INSIEME, come farebbe runWorker con concurrency 2.
    await Promise.all([handler(job1), handler(job2)]);

    expect(windows).toHaveLength(2);
    const [first, second] = [...windows].sort((a, b) => a.start - b.start) as [
      (typeof windows)[number],
      (typeof windows)[number],
    ];
    // Nessuna sovrapposizione: il secondo inizia dopo la fine del primo.
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  });

  it("NON serializza job di PROGETTI DIVERSI: le esecuzioni si sovrappongono", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repoA = await createRepository(db, "https://github.com/acme/parallelo-a");
    const repoB = await createRepository(db, "https://github.com/acme/parallelo-b");
    await createQueuedJob(db, repoA, "job repo A", 1);
    await createQueuedJob(db, repoB, "job repo B", 1);

    const windows: Array<{ start: number; end: number }> = [];
    const runner = new FakeAgentRunner({
      script: async () => {
        const start = Date.now();
        await sleep(300);
        windows.push({ start, end: Date.now() });
        return {
          output: `{"decision":"skip","type":"bug","effort":1,"reason":"test di parallelismo"}`,
          exitCode: 0,
        };
      },
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job1 = await claim(db);
    const job2 = await claim(db);
    await Promise.all([handler(job1), handler(job2)]);

    expect(windows).toHaveLength(2);
    const [first, second] = [...windows].sort((a, b) => a.start - b.start) as [
      (typeof windows)[number],
      (typeof windows)[number],
    ];
    // Sovrapposizione: il secondo è partito PRIMA che il primo finisse.
    expect(second.start).toBeLessThan(first.end);
  });

  it("SERIALIZZA due ticket dello STESSO progetto (chiave = progetto, Fase 3)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    // Due ticket DELLO STESSO progetto (gruppo), anche se il progetto ha più repo:
    // la serializzazione è per PROGETTO (un fix di progetto tiene worktree su TUTTI
    // i suoi repo), quindi i due fix NON si sovrappongono.
    const repoA = await createRepository(db, "https://github.com/acme/gruppo-a");
    await createRepository(db, "https://github.com/acme/gruppo-b", {
      projectId: repoA.projectId,
    });
    await createQueuedJob(db, repoA, "primo ticket del progetto", 1);
    // Stesso progetto → numerazione ticket per-progetto: il secondo ticket ha numero 2.
    await createQueuedJob(db, repoA, "secondo ticket del progetto", 2);

    const windows: Array<{ start: number; end: number }> = [];
    const runner = new FakeAgentRunner({
      script: async () => {
        const start = Date.now();
        await sleep(300);
        windows.push({ start, end: Date.now() });
        return {
          output: `{"decision":"skip","type":"bug","effort":1,"reason":"test di serializzazione per-progetto"}`,
          exitCode: 0,
        };
      },
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job1 = await claim(db);
    const job2 = await claim(db);
    await Promise.all([handler(job1), handler(job2)]);

    expect(windows).toHaveLength(2);
    const [first, second] = [...windows].sort((a, b) => a.start - b.start) as [
      (typeof windows)[number],
      (typeof windows)[number],
    ];
    // Nessuna sovrapposizione: il secondo inizia dopo la fine del primo (chiave = progetto).
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  });

  // ── Scelta dell'account (Piano A, Task A4) ──────────────────────────────
  // La scelta vera (selectProviders) gira contro il Postgres del test: i casi
  // fini stanno in providers/select.test.ts, qui si prova il CABLAGGIO del
  // fix/triage/correzione su runWithProviders. SEMANTICA CAMBIATA rispetto al
  // failover storico: (1) il provider del progetto è PREFERITO, non rigido —
  // al limite si passa al successivo abbonamento, salvo «solo questo»; (2) la
  // chiave API non entra nel passaggio automatico se esiste un abbonamento.

  it("usa il PRIMO abbonamento in ordine di position, lo passa al runner e registra provider_id", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 11);

    const first = await insertProvider(db, { position: 1, kind: "account", label: "prima", secret: "oauth-1" });
    await insertProvider(db, { position: 2, kind: "account", label: "seconda", secret: "oauth-2" });

    // Triage decide skip → un solo run, basta per verificare il passaggio della
    // credenziale e la registrazione del provider_id.
    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls[0]?.provider).toEqual({ id: first, kind: "account", secret: "oauth-1" });
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBe(first);
  });

  it("SEMANTICA NUOVA: la chiave API in catena NON è usata se esiste un abbonamento (anche in position più alta)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 13);

    await insertProvider(db, { position: 1, kind: "api_key", label: "chiave", secret: "sk-ant-1" });
    const account = await insertProvider(db, { position: 2, kind: "account", label: "abbonamento", secret: "oauth-2" });

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.every((c) => c.provider?.secret === "oauth-2")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBe(account);
  });

  it("failover: abbonamento A al limite → si esegue con B, A marcato al limite, una riga di log del job, provider_id = B", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 21);

    const provA = await insertProvider(db, { position: 1, kind: "account", label: "A", secret: "oauth-A" });
    const provB = await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B" });

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        // Con A: ogni run risponde con un limite → fa fallire l'INTERO
        // tentativo (triage), poi failover su B.
        if (opts.provider?.secret === "oauth-A") {
          return { output: "Claude usage limit reached. Try again later.", exitCode: 1 };
        }
        if (opts.model === "haiku") {
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        await writeFixDiff(opts.cwd, upstream.url, REPORT);
        return { output: "fix applicato", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/21" });

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls[0]?.provider?.secret).toBe("oauth-A");
    expect(runner.calls.slice(1).every((c) => c.provider?.secret === "oauth-B")).toBe(true);

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.providerId).toBe(provB);
    // UNA riga per il passaggio A → B.
    expect(jobAfter?.log.match(/provider 1\/2 al limite: failover alla credenziale successiva/g)).toHaveLength(1);
    // A è marcato al limite (nel futuro), B no.
    const limits = await limitedUntilById(db);
    expect(limits.get(provA)!.getTime()).toBeGreaterThan(Date.now());
    expect(limits.get(provB)).toBeNull();
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("tre abbonamenti tutti al limite → una riga di log per ogni PASSAGGIO (due), job HELD limit con commento, nessuna PR", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "ticket al limite", 22);

    await insertProvider(db, { position: 1, kind: "account", label: "A", secret: "oauth-A" });
    await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B" });
    await insertProvider(db, { position: 3, kind: "account", label: "C", secret: "oauth-C" });

    const runner = new FakeAgentRunner({
      output: '{"type":"error","error":{"type":"rate_limit_error"}}',
      exitCode: 1,
    });
    const openPullRequest = vi.fn();
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.map((c) => c.provider?.secret)).toEqual(["oauth-A", "oauth-B", "oauth-C"]);
    expect(openPullRequest).not.toHaveBeenCalled();

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    expect(jobAfter?.log).toContain("provider 1/3 al limite: failover alla credenziale successiva");
    expect(jobAfter?.log).toContain("provider 2/3 al limite: failover alla credenziale successiva");
    expect(jobAfter?.log).not.toContain("provider 3/3 al limite");
    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    // Senza «solo questo» il commento è quello generico «tutti i provider».
    const lang = await getContentLanguage(db);
    expect(ticketComments.map((c) => c.body)).toEqual([t(lang, "comment.providersLimitHeld")]);
  });

  it("istanza con la SOLA chiave API: la chiave è usata come oggi; al limite → job HELD limit", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket al limite", 23);

    await insertProvider(db, { position: 1, kind: "api_key", label: "solo", secret: "sk-solo" });

    const runner = new FakeAgentRunner({ output: "usage limit reached", exitCode: 1 });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.provider?.secret).toBe("sk-solo");
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
  });

  it("tutti gli abbonamenti GIÀ al limite (limited_until futuro) → runner mai chiamato, job HELD limit", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "tutti al limite", 25);

    const future = new Date(Date.now() + 3_600_000);
    await insertProvider(db, { position: 1, kind: "account", label: "A", secret: "oauth-A", limitedUntil: future });
    await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B", limitedUntil: future });
    // La chiave API resta fuori anche con tutti gli abbonamenti al limite (D3).
    await insertProvider(db, { position: 3, kind: "api_key", label: "chiave", secret: "sk-ant" });

    const runner = new FakeAgentRunner({ output: "non dovrei mai girare" });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(0);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(ticketComments.some((c) => /limit/i.test(c.body))).toBe(true);
  });

  it("un account GIÀ al limite non viene nemmeno provato: si parte dal successivo", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 26);

    await insertProvider(db, {
      position: 1,
      kind: "account",
      label: "A",
      secret: "oauth-A",
      limitedUntil: new Date(Date.now() + 3_600_000),
    });
    const provB = await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B" });

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls.some((c) => c.provider?.secret === "oauth-A")).toBe(false);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBe(provB);
    expect(jobAfter?.log).not.toContain("al limite");
  });

  it("il testo del limite (triage) arriva a markProviderLimited: limited_until = ora del reset annunciata", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 27);

    const provA = await insertProvider(db, { position: 1, kind: "account", label: "A", secret: "oauth-A" });
    await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B" });

    const now = new Date("2026-10-15T10:00:00Z");
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) =>
        opts.provider?.secret === "oauth-A"
          ? { output: "You've hit your session limit · resets 6pm (UTC)", exitCode: 1 }
          : { output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`, exitCode: 0 },
    });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      select: selectDeps(db, { now: () => now }),
    });

    const job = await claim(db);
    await handler(job);

    expect((await limitedUntilById(db)).get(provA)?.toISOString()).toBe("2026-10-15T18:00:00.000Z");
  });

  it("il testo del limite (fix) arriva a markProviderLimited: limited_until = ora del reset annunciata", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    await createQueuedJob(db, repo, "sum sbaglia il segno", 28);

    const provA = await insertProvider(db, { position: 1, kind: "account", label: "A", secret: "oauth-A" });
    await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B" });

    const now = new Date("2026-10-15T10:00:00Z");
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        // Il triage passa con A; il limite arriva nella PIANIFICAZIONE del fix.
        if (opts.model === "haiku") return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        if (opts.provider?.secret === "oauth-A") {
          return { output: "You've hit your weekly limit · resets Oct 20, 9am (UTC)", exitCode: 1 };
        }
        // Con B il fix non produce modifiche: basta che il passaggio sia avvenuto.
        return { output: "niente da fare", exitCode: 0 };
      },
    });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      select: selectDeps(db, { now: () => now }),
      getProviderFn: () => ({ openPullRequest: vi.fn() }) as never,
    });

    const job = await claim(db);
    await handler(job);

    expect((await limitedUntilById(db)).get(provA)?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(runner.calls.some((c) => c.provider?.secret === "oauth-B")).toBe(true);
  });

  it("errore NON-limite (output triage invalido): NESSUN failover, comportamento attuale", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket rotto", 24);

    const provA = await insertProvider(db, { position: 1, kind: "account", label: "A", secret: "oauth-A" });
    await insertProvider(db, { position: 2, kind: "account", label: "B", secret: "oauth-B" });

    // Output NON-limite: il triage non riesce a parsare la decisione e dopo il
    // retry il job fallisce. NON è un limite → niente failover su B.
    const runner = new FakeAgentRunner({ output: "spazzatura non-json", exitCode: 0 });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.every((c) => c.provider?.secret === "oauth-A")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");
    expect(jobAfter?.providerId).toBe(provA);
  });

  it("SEMANTICA NUOVA: il provider del progetto è PREFERITO — provato per primo anche se non è il primo in position", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();

    await insertProvider(db, { position: 1, kind: "account", label: "altro", secret: "oauth-altro" });
    const assigned = await insertProvider(db, { position: 2, kind: "account", label: "progetto", secret: "oauth-progetto" });

    const repo = await createRepository(db, upstream.url, { aiProviderId: assigned });
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 31);

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        if (opts.model === "haiku") {
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        await writeFixDiff(opts.cwd, upstream.url, REPORT);
        return { output: "fix applicato", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/31" });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      select: selectDeps(db),
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.every((c) => c.provider?.secret === "oauth-progetto")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.providerId).toBe(assigned);
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
  });

  it("SEMANTICA NUOVA: provider del progetto al limite (senza «solo questo») → passa al successivo abbonamento", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();

    const assigned = await insertProvider(db, { position: 1, kind: "account", label: "progetto", secret: "oauth-progetto" });
    const other = await insertProvider(db, { position: 2, kind: "account", label: "altro", secret: "oauth-altro" });
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato", { aiProviderId: assigned });
    await createQueuedJob(db, repo, "ticket vago", 32);

    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) =>
        opts.provider?.secret === "oauth-progetto"
          ? { output: "usage limit reached", exitCode: 1 }
          : { output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`, exitCode: 0 },
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.map((c) => c.provider?.secret)).toEqual(["oauth-progetto", "oauth-altro"]);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("skipped");
    expect(jobAfter?.providerId).toBe(other);
  });

  it("provider del progetto con «solo questo» al limite → job HELD limit, nessun altro abbonamento provato", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();

    const assigned = await insertProvider(db, { position: 1, kind: "account", label: "progetto", secret: "oauth-progetto" });
    await insertProvider(db, { position: 2, kind: "account", label: "altro", secret: "oauth-altro" });
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato", {
      aiProviderId: assigned,
      aiProviderExclusive: true,
    });
    const ticketId = await createQueuedJob(db, repo, "ticket al limite", 34);

    const runner = new FakeAgentRunner({ output: "usage limit reached", exitCode: 1 });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.every((c) => c.provider?.secret === "oauth-progetto")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    // Il commento dice che è l'account DEL PROGETTO a essere al limite (gli
    // altri abbonamenti sono liberi: «tutti i provider» sarebbe falso).
    const lang = await getContentLanguage(db);
    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(ticketComments.map((c) => c.body)).toEqual([t(lang, "comment.providerExclusiveLimitHeld")]);
    expect(jobAfter?.log).toContain("account del progetto («solo questo») al limite");
  });

  it("«solo questo» su un provider DISABILITATO → job HELD other, runner MAI invocato", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();

    const assigned = await insertProvider(db, {
      position: 1,
      kind: "account",
      label: "progetto",
      secret: "oauth-progetto",
      enabled: false,
    });
    await insertProvider(db, { position: 2, kind: "account", label: "altro", secret: "oauth-altro" });
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato", {
      aiProviderId: assigned,
      aiProviderExclusive: true,
    });
    await createQueuedJob(db, repo, "provider disabilitato", 33);

    const runner = new FakeAgentRunner({ output: "non dovrei mai girare" });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(0);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    // NON 'limit': un provider disabilitato non si sblocca col reset del
    // limite, serve un intervento umano.
    expect(jobAfter?.heldReason).toBe("other");
    expect(jobAfter?.log).toContain("provider AI del progetto non disponibile");
  });

  it("provider del progetto disabilitato SENZA «solo questo» → si passa agli altri abbonamenti", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();

    const assigned = await insertProvider(db, {
      position: 1,
      kind: "account",
      label: "progetto",
      secret: "oauth-progetto",
      enabled: false,
    });
    const other = await insertProvider(db, { position: 2, kind: "account", label: "altro", secret: "oauth-altro" });
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato", { aiProviderId: assigned });
    await createQueuedJob(db, repo, "ticket vago", 35);

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.every((c) => c.provider?.secret === "oauth-altro")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBe(other);
  });

  it("tutti i provider con segreto NON decifrabile → job HELD other (configurazione, non quota)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "segreti rotti", 36);

    // Cifrato con un'altra chiave: decrypt fallisce.
    const otherKey = randomBytes(32);
    await db.insert(aiProviders).values({
      position: 1,
      kind: "account",
      label: "rotto",
      secretEncrypted: encrypt("oauth-rotto", otherKey),
    });

    const runner = new FakeAgentRunner({ output: "non dovrei mai girare" });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(0);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("other");
    expect(jobAfter?.log).toContain("nessun provider AI utilizzabile");
  });

  it("la scelta riceve il projectId del ticket e la classe interactive (selectProvidersFn finta)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 37);

    const selectProvidersFn = vi.fn().mockResolvedValue({
      candidates: [{ id: randomUUID(), kind: "account", secret: "oauth-finto" }],
      legacyAuth: false,
      emptyReason: null,
    });
    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      select: selectDeps(db, { selectProvidersFn }),
    });

    const job = await claim(db);
    await handler(job);

    expect(selectProvidersFn).toHaveBeenCalledWith(expect.anything(), {
      projectId: repo.projectId,
      workClass: "interactive",
    });
    expect(runner.calls[0]?.provider?.secret).toBe("oauth-finto");
  });

  it("catena vuota: nessun provider passato al runner (retro-compat)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 12);

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls[0]?.provider).toBeUndefined();
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBeNull();
  });

  it("catena vuota e run al limite (auth storica) → job HELD limit, non resta in fixing fino allo stale", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "auth storica al limite", 38);

    const runner = new FakeAgentRunner({ output: "You've hit your session limit · resets 6pm (UTC)", exitCode: 1 });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.provider).toBeUndefined();
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(ticketComments.some((c) => /limit/i.test(c.body))).toBe(true);
  });

  it("auth storica al limite, più giri del resume poller: dopo il primo hold zero commenti e zero run nuovi finché non passa l'ora, poi ripreso", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "auth storica in giro", 39);

    // Orologio della scelta: l'ora del limite è letta dal testo rispetto a questo.
    let clock = new Date();
    const select = selectDeps(db, { now: () => clock, legacyLimit: { until: null } });
    const runner = new FakeAgentRunner({
      output: "You've hit your session limit · resets Oct 20, 9am (UTC)",
      exitCode: 1,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select });
    const poll = () =>
      pollLimitResumeOnce({
        db,
        select,
        headroomPercent: 95,
        // Cooldown nullo: senza la memoria del limite il poller riaccoderebbe a ogni giro.
        cooldownMs: 0,
        maxSnapshotAgeMs: 15 * 60_000,
      });
    const aiComments = async () =>
      (await db.select().from(comments).where(eq(comments.ticketId, ticketId))).filter(
        (c) => c.authorType === "ai",
      ).length;

    const job = await claim(db);
    await handler(job);
    const runsAfterHold = runner.calls.length;
    expect(runsAfterHold).toBeGreaterThan(0);
    expect(await aiComments()).toBe(1);
    expect(select.legacyLimit?.until?.toISOString()).toBe("2026-10-20T09:00:00.000Z");

    for (let cycle = 1; cycle <= 3; cycle++) {
      await poll();
      // Se il poller avesse riaccodato, il worker lo riprenderebbe subito.
      const again = await claimNextJob(db);
      if (again) await handler(again);
      expect(await aiComments(), `commenti AI dopo il giro ${cycle}`).toBe(1);
      expect(runner.calls.length, `run dopo il giro ${cycle}`).toBe(runsAfterHold);
      const [after] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
      expect(after?.status).toBe("held");
    }

    // Passata l'ora del limite: il job è ripreso (un commento di ripresa).
    clock = new Date("2026-10-20T09:01:00.000Z");
    expect(await poll()).toBe(1);
    const [resumed] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(resumed?.status).toBe("queued");
    expect(await aiComments()).toBe(2);
  });

  it("job con correction_id: salta triage e resolveFixMode, esegue la correzione sul branch della PR", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const prSha = await pushPrBranch(upstream, 4);
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    // resume_mode=execute + plan_text: se il dispatch passasse da resolveFixMode
    // questo job diventerebbe un execute-only dal DEFAULT branch. È la condizione
    // che rende il test capace di sbagliare.
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 4);
    await linkOpenPr(db, ticketId, repo.repositoryId, 4);
    const [correction] = await db
      .insert(prCorrections)
      .values({
        ticketId,
        repositoryId: repo.repositoryId,
        prNumber: 4,
        trigger: "stubwise",
        status: "queued",
        note: "aggiungi un test per i negativi",
      })
      .returning();
    await db
      .update(aiJobs)
      .set({ correctionId: correction!.id, resumeMode: "execute", planText: "PIANO DA NON ESEGUIRE", manualTrigger: true })
      .where(eq(aiJobs.ticketId, ticketId));

    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        await writeFile(join(opts.cwd, mirrorSlug(upstream.url), "sum.test.js"), "// negativi\n");
        await writeFile(join(opts.cwd, "STUBWISE_REPORT.md"), "## x\nok\n");
        return { output: "corretto", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/99" });
    const provider = {
      openPullRequest,
      getPullRequestState: vi.fn().mockResolvedValue("open"),
      getPullRequestInfo: vi.fn().mockRejectedValue(new Error("non usato: nessuna PR adottata")),
      setCommitStatus: vi.fn().mockResolvedValue(undefined),
      listPrComments: vi.fn().mockResolvedValue([]),
      getAuthenticatedUserId: vi.fn().mockResolvedValue("me"),
    };
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => provider,
    });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.model).not.toBe("haiku");
    expect(runner.calls[0]?.permissionMode).toBe("acceptEdits");
    expect(runner.calls[0]?.prompt).toContain("<nota_della_richiesta>");
    expect(runner.calls[0]?.prompt).not.toContain("PIANO DA NON ESEGUIRE");
    expect(openPullRequest).not.toHaveBeenCalled();
    const head = await git(["rev-parse", "refs/heads/stubwise/ticket-4"], upstream.dir);
    expect(await git(["rev-parse", `${head}^`], upstream.dir)).toBe(prSha);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    const [corrAfter] = await db.select().from(prCorrections).where(eq(prCorrections.id, correction!.id));
    expect(corrAfter?.status).toBe("done");
  });

  it("job con correction_id e ownership persa: la correzione NON parte", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "correzione orfana", 12);
    const [correction] = await db
      .insert(prCorrections)
      .values({ ticketId, repositoryId: repo.repositoryId, prNumber: 12, trigger: "review", status: "queued" })
      .returning();
    await db.update(aiJobs).set({ correctionId: correction!.id }).where(eq(aiJobs.ticketId, ticketId));
    const runner = new FakeAgentRunner({ output: "non dovrei mai girare" });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await db.update(aiJobs).set({ status: "failed" }).where(eq(aiJobs.id, job.id));
    await handler(job);

    expect(runner.calls).toHaveLength(0);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.log).toContain("[correction] ownership persa");
    expect(jobAfter?.status).toBe("failed");
    // La correzione resta com'era: il job è di chi l'ha ripreso.
    const [corrAfter] = await db.select().from(prCorrections).where(eq(prCorrections.id, correction!.id));
    expect(corrAfter?.status).toBe("queued");
  });

  it("un fix che fallisce con una richiesta dal provider in attesa: la pending parte comunque", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "rilancio del fix", 5, { resumeMode: "fix" });
    await linkOpenPr(db, ticketId, repo.repositoryId, 5);
    // "Request changes" arrivato mentre il fix era in volo: salvato `pending`.
    const [pending] = await db
      .insert(prCorrections)
      .values({
        ticketId,
        repositoryId: repo.repositoryId,
        prNumber: 5,
        trigger: "provider",
        status: "pending",
        requestedByProviderLogin: "mario.rossi",
      })
      .returning();
    // Nessuna modifica: il fix fallisce con NoChangesError.
    const runner = new FakeAgentRunner({ output: "non trovo il bug" });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      // Doppio COMPLETO del Pick di HandlerDeps.getProviderFn, senza cast: un
      // metodo mancante lo dice il compilatore, non un test verde per caso. Ogni
      // metodo risponde comunque in modo valido, anche se qui nessuno lo chiama.
      getProviderFn: () => ({
        openPullRequest: vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/5" }),
        getPullRequestState: vi.fn().mockResolvedValue("open"),
        getPullRequestInfo: vi.fn().mockRejectedValue(new Error("non usato: nessuna PR adottata")),
        setCommitStatus: vi.fn().mockResolvedValue(undefined),
        listPrComments: vi.fn().mockResolvedValue([]),
        getAuthenticatedUserId: vi.fn().mockResolvedValue("me"),
        getCollaboratorPermission: vi.fn().mockResolvedValue("write"),
      }),
    });

    const job = await claim(db);
    await handler(job);

    const [fixJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(fixJob?.status).toBe("failed");
    const [after] = await db.select().from(prCorrections).where(eq(prCorrections.id, pending!.id));
    expect(after?.status).toBe("queued");
    const [correctionJob] = await db.select().from(aiJobs).where(eq(aiJobs.correctionId, pending!.id));
    expect(correctionJob?.status).toBe("queued");
    expect(fixJob?.log).toContain(`richiesta di correzione in attesa avviata (${pending!.id})`);
  });

  it("un fix che fallisce SENZA pending: nessuna correzione nasce", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "fix senza richieste", 6, { resumeMode: "fix" });
    await linkOpenPr(db, ticketId, repo.repositoryId, 6);
    const runner = new FakeAgentRunner({ output: "non trovo il bug" });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    const [fixJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(fixJob?.status).toBe("failed");
    expect(await db.select().from(prCorrections).where(eq(prCorrections.ticketId, ticketId))).toHaveLength(0);
  });

  it("un job saltato dal triage con una richiesta in attesa: la pending parte comunque", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "ticket vago", 7);
    await linkOpenPr(db, ticketId, repo.repositoryId, 7);
    const [pending] = await db
      .insert(prCorrections)
      .values({ ticketId, repositoryId: repo.repositoryId, prNumber: 7, trigger: "provider", status: "pending" })
      .returning();
    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY, select: selectDeps(db) });

    const job = await claim(db);
    await handler(job);

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("skipped");
    const [after] = await db.select().from(prCorrections).where(eq(prCorrections.id, pending!.id));
    expect(after?.status).toBe("queued");
  });

  it("job con correction_id al limite sul provider di progetto con «solo questo»: stesso percorso del fix, job HELD limit e correzione ancora in coda", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    await pushPrBranch(upstream, 9);
    const mirrors = await makeMirrors();
    const [assigned] = await db
      .insert(aiProviders)
      .values({ position: 1, kind: "api_key", label: "progetto", secretEncrypted: encrypt("sk-progetto", ENCRYPTION_KEY) })
      .returning();
    if (!assigned) throw new Error("insert provider non ha restituito la riga");
    const repo = await createRepository(db, upstream.url, { aiProviderId: assigned.id, aiProviderExclusive: true });
    const ticketId = await createQueuedJob(db, repo, "correzione al limite", 9);
    await linkOpenPr(db, ticketId, repo.repositoryId, 9);
    const [correction] = await db
      .insert(prCorrections)
      .values({
        ticketId,
        repositoryId: repo.repositoryId,
        prNumber: 9,
        trigger: "stubwise",
        status: "queued",
        note: "ripresa dopo il limite",
      })
      .returning();
    await db.update(aiJobs).set({ correctionId: correction!.id }).where(eq(aiJobs.ticketId, ticketId));
    // Qualunque run → limite di rate/usage.
    const runner = new FakeAgentRunner({ output: "usage limit reached", exitCode: 1 });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/9" });
    const provider = {
      openPullRequest,
      getPullRequestState: vi.fn().mockResolvedValue("open"),
      getPullRequestInfo: vi.fn().mockRejectedValue(new Error("non usato: nessuna PR adottata")),
      setCommitStatus: vi.fn().mockResolvedValue(undefined),
      listPrComments: vi.fn().mockResolvedValue([]),
      getAuthenticatedUserId: vi.fn().mockResolvedValue("me"),
      getCollaboratorPermission: vi.fn().mockResolvedValue("write"),
    };
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => provider,
    });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls.length).toBeGreaterThan(0);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    expect(runner.calls.every((c) => c.provider?.secret === "sk-progetto")).toBe(true);
    // «solo questo»: il log (e il commento) parlano dell'account del progetto.
    expect(jobAfter?.log).toContain("account del progetto («solo questo») al limite");
    // Lo STESSO job resta legato alla correzione: la ripresa deve ritrovarla.
    expect(jobAfter?.correctionId).toBe(correction!.id);
    const [corrAfter] = await db.select().from(prCorrections).where(eq(prCorrections.id, correction!.id));
    expect(corrAfter?.status).toBe("queued");

    // RIPRESA, come fa il resume poller (limit-resume-poller.ts): held → queued,
    // con `heldReason` lasciato com'è (storico dell'ultimo hold). Il job
    // riparte con quel residuo addosso, e deve tornare nel ramo della correzione.
    // Il limite ha marcato l'account (`limited_until`): al reset il poller
    // d'uso lo azzera, e solo allora la ripresa lo sceglie di nuovo.
    await db.update(aiProviders).set({ limitedUntil: null }).where(eq(aiProviders.id, assigned.id));
    await db
      .update(aiJobs)
      .set({ status: "queued", startedAt: null, finishedAt: null })
      .where(eq(aiJobs.id, job.id));
    const resumeRunner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        // Se la ripresa sbagliasse strada (triage in una tmpdir senza il repo)
        // lo script non lancia: il test deve fallire sulle asserzioni.
        const repoDir = join(opts.cwd, mirrorSlug(upstream.url));
        if (!existsSync(repoDir)) return { output: "strada sbagliata", exitCode: 0 };
        await writeFile(join(repoDir, "sum.test.js"), "// ripresa\n");
        await writeFile(join(opts.cwd, "STUBWISE_REPORT.md"), "## x\nok\n");
        return { output: "corretto", exitCode: 0 };
      },
    });
    const resumeHandler = createHandler({
      db,
      runner: resumeRunner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY, select: selectDeps(db),
      getProviderFn: () => provider,
    });

    const resumed = await claim(db);
    expect(resumed.id).toBe(job.id);
    expect(resumed.heldReason).toBe("limit");
    await resumeHandler(resumed);

    expect(resumeRunner.calls).toHaveLength(1);
    expect(resumeRunner.calls[0]?.prompt).toContain("<nota_della_richiesta>");
    expect(openPullRequest).not.toHaveBeenCalled();
    const [corrResumed] = await db.select().from(prCorrections).where(eq(prCorrections.id, correction!.id));
    expect(corrResumed?.status).toBe("done");
  });
});
