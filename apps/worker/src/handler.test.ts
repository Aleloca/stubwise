import {
  agentQuestions,
  aiJobs,
  aiProviders,
  comments,
  encrypt,
  gitAccounts,
  projects,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
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
  opts: { aiProviderId?: string; projectId?: string } = {},
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
      encryptionKey: ENCRYPTION_KEY,
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
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

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
      encryptionKey: ENCRYPTION_KEY,
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
      encryptionKey: ENCRYPTION_KEY,
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
      encryptionKey: ENCRYPTION_KEY,
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
      encryptionKey: ENCRYPTION_KEY,
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
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

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
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

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
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

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

  it("seleziona la PRIMA credenziale della catena, la passa al runner e registra provider_id", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 11);

    // Due provider abilitati: il primo (position 1) è quello atteso.
    const [first] = await db
      .insert(aiProviders)
      .values({
        position: 1,
        kind: "api_key",
        label: "prima",
        secretEncrypted: encrypt("sk-ant-1", ENCRYPTION_KEY),
      })
      .returning();
    await db.insert(aiProviders).values({
      position: 2,
      kind: "account",
      label: "seconda",
      secretEncrypted: encrypt("oauth-2", ENCRYPTION_KEY),
    });
    if (!first) throw new Error("insert provider non ha restituito la riga");

    // Triage decide skip → un solo run, basta per verificare il passaggio della
    // credenziale e la registrazione del provider_id.
    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job = await claim(db);
    await handler(job);

    // La credenziale della PRIMA voce è arrivata al runner.
    expect(runner.calls[0]?.provider).toEqual({ id: first.id, kind: "api_key", secret: "sk-ant-1" });
    // E il provider usato è registrato sul job.
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBe(first.id);
  });

  it("failover: provider A al limite → si esegue con B, job completa, provider_id = B", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, upstream.url);
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 21);

    const [provA] = await db
      .insert(aiProviders)
      .values({
        position: 1,
        kind: "api_key",
        label: "A",
        secretEncrypted: encrypt("sk-A", ENCRYPTION_KEY),
      })
      .returning();
    const [provB] = await db
      .insert(aiProviders)
      .values({
        position: 2,
        kind: "account",
        label: "B",
        secretEncrypted: encrypt("oauth-B", ENCRYPTION_KEY),
      })
      .returning();
    if (!provA || !provB) throw new Error("insert provider non ha restituito la riga");

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        // Con la credenziale A (sk-A): ogni run risponde con un limite → fa
        // fallire l'INTERO tentativo (triage), poi failover su B.
        if (opts.provider?.secret === "sk-A") {
          return { output: "Claude usage limit reached. Try again later.", exitCode: 1 };
        }
        // Con la credenziale B: triage decide fix, poi il fix scrive il diff.
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
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // Il primo tentativo (A) ha tentato il triage e ha visto il limite; poi B
    // ha fatto triage + plan + execute. La prima call è con A, le altre con B.
    expect(runner.calls[0]?.provider?.secret).toBe("sk-A");
    expect(runner.calls.slice(1).every((c) => c.provider?.secret === "oauth-B")).toBe(true);

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    // provider_id riflette la credenziale che ha effettivamente eseguito: B.
    expect(jobAfter?.providerId).toBe(provB.id);
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("failover: catena [A,B] entrambe al limite → job HELD con commento, nessuna PR", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    const ticketId = await createQueuedJob(db, repo, "ticket al limite", 22);

    await db.insert(aiProviders).values({
      position: 1,
      kind: "api_key",
      label: "A",
      secretEncrypted: encrypt("sk-A", ENCRYPTION_KEY),
    });
    await db.insert(aiProviders).values({
      position: 2,
      kind: "account",
      label: "B",
      secretEncrypted: encrypt("oauth-B", ENCRYPTION_KEY),
    });

    // Qualunque credenziale → limite.
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
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // Due tentativi, uno per credenziale; nessuna PR aperta.
    expect(runner.calls.map((c) => c.provider?.secret)).toEqual(["sk-A", "oauth-B"]);
    expect(openPullRequest).not.toHaveBeenCalled();

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    // held_reason 'limit': il resume poller riaccoderà il job al reset del limite.
    expect(jobAfter?.heldReason).toBe("limit");
    // Commento di sistema sul ticket che spiega il limite di tutti i provider.
    const ticketComments = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(ticketComments.some((c) => /limit/i.test(c.body))).toBe(true);
  });

  it("failover: credenziale SINGOLA al limite → job HELD (niente failover possibile)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket al limite", 23);

    await db.insert(aiProviders).values({
      position: 1,
      kind: "api_key",
      label: "solo",
      secretEncrypted: encrypt("sk-solo", ENCRYPTION_KEY),
    });

    const runner = new FakeAgentRunner({ output: "usage limit reached", exitCode: 1 });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.provider?.secret).toBe("sk-solo");
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
  });

  it("errore NON-limite (output triage invalido): NESSUN failover, comportamento attuale", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket rotto", 24);

    const [provA] = await db
      .insert(aiProviders)
      .values({
        position: 1,
        kind: "api_key",
        label: "A",
        secretEncrypted: encrypt("sk-A", ENCRYPTION_KEY),
      })
      .returning();
    await db.insert(aiProviders).values({
      position: 2,
      kind: "account",
      label: "B",
      secretEncrypted: encrypt("oauth-B", ENCRYPTION_KEY),
    });
    if (!provA) throw new Error("insert provider non ha restituito la riga");

    // Output NON-limite: il triage non riesce a parsare la decisione (output
    // invalido) e dopo il retry il job fallisce. NON è un limite → niente
    // failover su B: la seconda credenziale non viene mai usata.
    const runner = new FakeAgentRunner({ output: "spazzatura non-json", exitCode: 0 });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job = await claim(db);
    await handler(job);

    // Solo la credenziale A è stata usata (triage + retry = 2 call, tutte A);
    // nessuna call con B.
    expect(runner.calls.every((c) => c.provider?.secret === "sk-A")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");
    // provider_id resta quello tentato (A): nessun failover.
    expect(jobAfter?.providerId).toBe(provA.id);
  });

  it("provider di progetto (strict): usa SOLO quel provider, catena MAI consultata", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();

    // Provider assegnato al progetto (FK valida): la riga serve solo per l'id,
    // la risoluzione è mockata via loadProviderByIdFn.
    const [assigned] = await db
      .insert(aiProviders)
      .values({
        position: 1,
        kind: "api_key",
        label: "progetto",
        secretEncrypted: encrypt("sk-progetto", ENCRYPTION_KEY),
      })
      .returning();
    if (!assigned) throw new Error("insert provider non ha restituito la riga");

    const repo = await createRepository(db, upstream.url, { aiProviderId: assigned.id });
    const ticketId = await createQueuedJob(db, repo, "sum sbaglia il segno", 31);

    const resolved = { id: assigned.id, kind: "api_key" as const, secret: "sk-progetto" };
    const loadProviderByIdFn = vi.fn().mockResolvedValue(resolved);
    const loadProviderChainFn = vi.fn(); // non deve MAI essere chiamata

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
      loadProviderByIdFn,
      loadProviderChainFn,
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // La catena non è MAI stata consultata: solo il provider del progetto.
    expect(loadProviderChainFn).not.toHaveBeenCalled();
    expect(loadProviderByIdFn).toHaveBeenCalledWith(db, ENCRYPTION_KEY, assigned.id);
    expect(runner.calls.every((c) => c.provider?.secret === "sk-progetto")).toBe(true);

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.providerId).toBe(assigned.id);
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
  });

  it("provider di progetto (strict): esito LIMIT → job HELD, nessun failover", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();

    const [assigned] = await db
      .insert(aiProviders)
      .values({
        position: 1,
        kind: "api_key",
        label: "progetto",
        secretEncrypted: encrypt("sk-progetto", ENCRYPTION_KEY),
      })
      .returning();
    if (!assigned) throw new Error("insert provider non ha restituito la riga");

    const repo = await createRepository(db, "https://github.com/acme/mai-clonato", {
      aiProviderId: assigned.id,
    });
    await createQueuedJob(db, repo, "ticket al limite", 32);

    const loadProviderByIdFn = vi
      .fn()
      .mockResolvedValue({ id: assigned.id, kind: "api_key" as const, secret: "sk-progetto" });
    const loadProviderChainFn = vi.fn();

    // Qualunque run → limite di rate/usage.
    const runner = new FakeAgentRunner({ output: "usage limit reached", exitCode: 1 });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      loadProviderByIdFn,
      loadProviderChainFn,
    });

    const job = await claim(db);
    await handler(job);

    // Niente failover: la catena non viene consultata e si è usato solo il
    // provider del progetto.
    expect(loadProviderChainFn).not.toHaveBeenCalled();
    expect(runner.calls.every((c) => c.provider?.secret === "sk-progetto")).toBe(true);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    expect(jobAfter?.heldReason).toBe("limit");
    expect(jobAfter?.log).toContain("provider AI del progetto al limite");
  });

  it("provider di progetto (strict): non risolvibile (null) → job HELD, runner MAI invocato", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();

    const [assigned] = await db
      .insert(aiProviders)
      .values({
        position: 1,
        kind: "api_key",
        label: "progetto",
        secretEncrypted: encrypt("sk-progetto", ENCRYPTION_KEY),
      })
      .returning();
    if (!assigned) throw new Error("insert provider non ha restituito la riga");

    const repo = await createRepository(db, "https://github.com/acme/mai-clonato", {
      aiProviderId: assigned.id,
    });
    await createQueuedJob(db, repo, "provider disabilitato", 33);

    // Provider non disponibile (disabilitato/cancellato/non decifrabile).
    const loadProviderByIdFn = vi.fn().mockResolvedValue(null);
    const loadProviderChainFn = vi.fn();
    const runner = new FakeAgentRunner({ output: "non dovrei mai girare" });
    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      loadProviderByIdFn,
      loadProviderChainFn,
    });

    const job = await claim(db);
    await handler(job);

    // Nessun tentativo: il runner non è mai stato chiamato, niente catena.
    expect(runner.calls).toHaveLength(0);
    expect(loadProviderChainFn).not.toHaveBeenCalled();
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
    // NON 'limit': un provider disabilitato/cancellato non si sblocca col reset
    // del limite, serve un intervento umano.
    expect(jobAfter?.heldReason).toBe("other");
    expect(jobAfter?.log).toContain("provider AI del progetto non disponibile");
  });

  it("catena vuota: nessun provider passato al runner (retro-compat)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const repo = await createRepository(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, repo, "ticket vago", 12);

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls[0]?.provider).toBeUndefined();
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.providerId).toBeNull();
  });
});
