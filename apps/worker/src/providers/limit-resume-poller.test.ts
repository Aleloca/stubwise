import {
  aiJobs,
  aiProviders,
  aiUsageSnapshots,
  comments,
  docGenerationJobs,
  docGenerations,
  encrypt,
  projects,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { t } from "@stubwise/i18n";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resumeGeneration } from "../docs/nodes.js";
import { getContentLanguage } from "../settings.js";
import { pollLimitResumeOnce, type LimitResumeDeps } from "./limit-resume-poller.js";

// Il resume poller riprende automaticamente ciò che è fermo per LIMITE del
// provider: generazioni `paused`, ai_jobs `held` (held_reason "limit") e
// doc_generation_jobs `held` (held_reason "limit"). La decisione è per-provider:
//  - `account` con snapshot fresco e parsato → headroom = sessione < soglia% E
//    weekly < 100%;
//  - `api_key` o snapshot stantio/assente/non parsato → fallback A TEMPO
//    (cooldown dal momento della pausa), MAI eterno.
// Nessun agente coinvolto: solo DB (testcontainers).

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);
const MINUTE = 60_000;

let testDb: TestDb;
let uniq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
  await testDb.db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * MINUTE);
}

/** Deps di default del tick: soglia 95%, cooldown 60', snapshot fresco entro 15'. */
function makeDeps(overrides: Partial<LimitResumeDeps> = {}): LimitResumeDeps {
  return {
    db: testDb.db,
    encryptionKey: ENCRYPTION_KEY,
    headroomPercent: 95,
    cooldownMs: 60 * MINUTE,
    maxSnapshotAgeMs: 15 * MINUTE,
    ...overrides,
  };
}

async function seedProvider(
  db: Db,
  values: { position: number; kind: "api_key" | "account"; enabled?: boolean },
): Promise<string> {
  uniq++;
  const [row] = await db
    .insert(aiProviders)
    .values({
      position: values.position,
      kind: values.kind,
      label: `provider-${uniq}`,
      secretEncrypted: encrypt(`secret-${uniq}`, ENCRYPTION_KEY),
      enabled: values.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error("insert del provider non ha restituito la riga");
  return row.id;
}

/** Snapshot d'usage: percentuali usate di sessione/weekly, età e parse_ok. */
async function seedSnapshot(
  db: Db,
  providerId: string,
  values: {
    sessionUsed: number;
    weeklyUsed: number;
    capturedAt?: Date;
    parseOk?: boolean;
  },
): Promise<void> {
  await db.insert(aiUsageSnapshots).values({
    providerId,
    capturedAt: values.capturedAt ?? new Date(),
    sessionRemaining: {
      percentUsed: values.sessionUsed,
      percentRemaining: 100 - values.sessionUsed,
      resetsLabel: null,
    },
    weeklyRemaining: {
      percentUsed: values.weeklyUsed,
      percentRemaining: 100 - values.weeklyUsed,
      resetsLabel: null,
    },
    source: "deterministic",
    parseOk: values.parseOk ?? true,
  });
}

/** Progetto (con eventuale provider strict) + repository collegato. */
async function seedRepository(
  db: Db,
  opts: { aiProviderId?: string } = {},
): Promise<{ projectId: string; repositoryId: string }> {
  uniq++;
  const gitAccountId = await seedGitAccount(db, {
    encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
  });
  const [project] = await db
    .insert(projects)
    .values({
      name: `Gruppo ${uniq}`,
      slug: `gruppo-${uniq}`,
      ingestionKey: `ingestion-${uniq}-${randomUUID()}`,
      ...(opts.aiProviderId !== undefined ? { aiProviderId: opts.aiProviderId } : {}),
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project.id,
      name: `Repo ${uniq}`,
      slug: `repo-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl: `https://example.com/repo-${uniq}.git`,
      defaultBranch: "main",
    })
    .returning();
  if (!repository) throw new Error("insert del repository non ha restituito la riga");
  return { projectId: project.id, repositoryId: repository.id };
}

async function seedPausedGeneration(
  db: Db,
  repositoryId: string,
  values: { pinnedProviderId?: string; pausedAt?: Date } = {},
): Promise<string> {
  const [row] = await db
    .insert(docGenerations)
    .values({
      repositoryId,
      status: "paused",
      pausedAt: values.pausedAt ?? new Date(),
      pauseReason: "limite del provider",
      ...(values.pinnedProviderId !== undefined
        ? { pinnedProviderId: values.pinnedProviderId }
        : {}),
    })
    .returning();
  if (!row) throw new Error("insert della generazione non ha restituito la riga");
  return row.id;
}

/** Ticket + ai_job held con la ragione data (finishedAt = momento del hold). */
async function seedHeldJob(
  db: Db,
  projectId: string,
  values: { heldReason?: "limit" | "budget" | "other" | null; finishedAt?: Date } = {},
): Promise<{ ticketId: string; jobId: string }> {
  uniq++;
  const [ticket] = await db
    .insert(tickets)
    .values({
      projectId,
      number: uniq,
      title: `Ticket ${uniq}`,
      type: "bug",
      priority: "high",
      source: "sdk_error",
    })
    .returning();
  if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
  const [job] = await db
    .insert(aiJobs)
    .values({
      ticketId: ticket.id,
      status: "held",
      heldReason: values.heldReason === undefined ? "limit" : values.heldReason,
      finishedAt: values.finishedAt ?? new Date(),
    })
    .returning();
  if (!job) throw new Error("insert del job non ha restituito la riga");
  return { ticketId: ticket.id, jobId: job.id };
}

async function seedHeldDocJob(
  db: Db,
  repositoryId: string,
  values: { heldReason?: "limit" | "budget" | "other" | null; finishedAt?: Date } = {},
): Promise<string> {
  const [row] = await db
    .insert(docGenerationJobs)
    .values({
      repositoryId,
      status: "held",
      heldReason: values.heldReason === undefined ? "limit" : values.heldReason,
      finishedAt: values.finishedAt ?? new Date(),
      error: "limite del provider",
    })
    .returning();
  if (!row) throw new Error("insert del doc-job non ha restituito la riga");
  return row.id;
}

async function generationStatus(db: Db, id: string): Promise<string> {
  const [row] = await db
    .select({ status: docGenerations.status })
    .from(docGenerations)
    .where(eq(docGenerations.id, id));
  if (!row) throw new Error("generazione non trovata");
  return row.status;
}

describe("pollLimitResumeOnce", () => {
  it("generazione paused + provider account con headroom (snapshot fresco: sessione <95%, weekly <100%) → running", async () => {
    const { db } = testDb;
    const providerId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, providerId, { sessionUsed: 40, weeklyUsed: 70 });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      // Pausa recentissima: il fallback a tempo NON scatterebbe. Deve riprendere
      // grazie allo snapshot fresco con headroom.
      pausedAt: new Date(),
    });

    const resumed = await pollLimitResumeOnce(makeDeps());

    expect(resumed).toBe(1);
    expect(await generationStatus(db, generationId)).toBe("running");
  });

  it("senza headroom (sessione 100%) → resta paused", async () => {
    const { db } = testDb;
    const providerId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, providerId, { sessionUsed: 100, weeklyUsed: 70 });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      // Anche oltre il cooldown: lo snapshot fresco è AUTORITATIVO, niente
      // fallback a tempo con un dato attendibile che dice "ancora al limite".
      pausedAt: minutesAgo(120),
    });

    const resumed = await pollLimitResumeOnce(makeDeps());

    expect(resumed).toBe(0);
    expect(await generationStatus(db, generationId)).toBe("paused");
  });

  it("provider api_key: riprende solo dopo il cooldown (pausedAt vecchio sì, recente no)", async () => {
    const { db } = testDb;
    const providerId = await seedProvider(db, { position: 1, kind: "api_key" });
    const { repositoryId } = await seedRepository(db);
    const oldOne = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      pausedAt: minutesAgo(90),
    });
    const recent = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      pausedAt: minutesAgo(5),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    expect(await generationStatus(db, oldOne)).toBe("running");
    expect(await generationStatus(db, recent)).toBe("paused");
  });

  it("snapshot stantio su account → degrada al fallback a tempo (pausedAt oltre cooldown → riprende)", async () => {
    const { db } = testDb;
    const providerId = await seedProvider(db, { position: 1, kind: "account" });
    // Snapshot VECCHIO (oltre maxSnapshotAgeMs) che direbbe "al limite": non è
    // più attendibile, quindi si degrada al fallback a tempo.
    await seedSnapshot(db, providerId, {
      sessionUsed: 100,
      weeklyUsed: 100,
      capturedAt: minutesAgo(60),
    });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      pausedAt: minutesAgo(90),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    expect(await generationStatus(db, generationId)).toBe("running");
  });

  it("snapshot con parse_ok false → trattato come stantio (fallback a tempo)", async () => {
    const { db } = testDb;
    const providerId = await seedProvider(db, { position: 1, kind: "account" });
    // Snapshot FRESCO ma non parsato: i numeri (che direbbero "tutto libero")
    // non vanno creduti. Con pausa recente il fallback a tempo non è scattato
    // → resta paused.
    await seedSnapshot(db, providerId, { sessionUsed: 0, weeklyUsed: 0, parseOk: false });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      pausedAt: minutesAgo(5),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    expect(await generationStatus(db, generationId)).toBe("paused");
  });

  it("ai_jobs held con held_reason limit e headroom su UNA credenziale della catena → queued + commento AI limitResumed + log nel job", async () => {
    const { db } = testDb;
    // Catena di due credenziali: la prima (account) è ANCORA al limite secondo
    // lo snapshot fresco; la seconda (api_key) ha superato il cooldown. Basta
    // UNA credenziale con headroom per riaccodare.
    const accountId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, accountId, { sessionUsed: 100, weeklyUsed: 100 });
    await seedProvider(db, { position: 2, kind: "api_key" });
    const { projectId } = await seedRepository(db);
    const { ticketId, jobId } = await seedHeldJob(db, projectId, {
      heldReason: "limit",
      finishedAt: minutesAgo(90),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("queued");
    // finishedAt azzerato (coerenza con run-ai/claimNextJob: il job riparte).
    expect(job?.finishedAt).toBeNull();
    expect(job?.startedAt).toBeNull();
    // Il log del job documenta la ripresa automatica.
    expect(job?.log).toContain("riaccodato automaticamente");
    // Commento AI di sistema sul ticket, nella lingua dei contenuti.
    const lang = await getContentLanguage(db);
    const ticketComments = await db
      .select()
      .from(comments)
      .where(eq(comments.ticketId, ticketId));
    expect(ticketComments).toHaveLength(1);
    expect(ticketComments[0]).toMatchObject({
      authorType: "ai",
      body: t(lang, "comment.limitResumed"),
    });
  });

  it("ai_jobs held con progetto a provider strict: decide SOLO quel provider", async () => {
    const { db } = testDb;
    // Provider del progetto (strict): account ancora al limite (snapshot fresco).
    const pinnedId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, pinnedId, { sessionUsed: 100, weeklyUsed: 100 });
    // Nella catena c'è ANCHE una api_key con cooldown superato: NON deve contare.
    await seedProvider(db, { position: 2, kind: "api_key" });
    const { projectId } = await seedRepository(db, { aiProviderId: pinnedId });
    const { jobId } = await seedHeldJob(db, projectId, {
      heldReason: "limit",
      finishedAt: minutesAgo(90),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
  });

  it("held_reason budget o null → MAI riaccodato", async () => {
    const { db } = testDb;
    // Provider con headroom pieno: se la ragione non è "limit" non conta.
    const providerId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, providerId, { sessionUsed: 10, weeklyUsed: 10 });
    const { projectId } = await seedRepository(db);
    const budget = await seedHeldJob(db, projectId, {
      heldReason: "budget",
      finishedAt: minutesAgo(500),
    });
    const legacy = await seedHeldJob(db, projectId, {
      heldReason: null,
      finishedAt: minutesAgo(500),
    });

    const resumed = await pollLimitResumeOnce(makeDeps());

    expect(resumed).toBe(0);
    for (const { jobId } of [budget, legacy]) {
      const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
      expect(job?.status).toBe("held");
    }
  });

  it("doc_generation_jobs held reason limit → queued (senza commento)", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "api_key" });
    const { repositoryId } = await seedRepository(db);
    const docJobId = await seedHeldDocJob(db, repositoryId, {
      heldReason: "limit",
      finishedAt: minutesAgo(90),
    });
    // Un doc-job con ragione diversa resta fermo.
    const otherId = await seedHeldDocJob(db, repositoryId, {
      heldReason: "budget",
      finishedAt: minutesAgo(90),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    const [docJob] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, docJobId));
    expect(docJob?.status).toBe("queued");
    expect(docJob?.finishedAt).toBeNull();
    expect(docJob?.log).toContain("riaccodato automaticamente");
    const [other] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, otherId));
    expect(other?.status).toBe("held");
    // Nessun commento AI: i doc-job non hanno un ticket.
    expect(await db.select().from(comments)).toHaveLength(0);
  });

  it("un item che lancia non blocca gli altri; il tick non propaga", async () => {
    const { db } = testDb;
    const providerId = await seedProvider(db, { position: 1, kind: "api_key" });
    const { repositoryId } = await seedRepository(db);
    const broken = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      pausedAt: minutesAgo(90),
    });
    const healthy = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: providerId,
      pausedAt: minutesAgo(90),
    });

    const deps = makeDeps({
      cooldownMs: 60 * MINUTE,
      // La prima generazione fa esplodere il resume: la seconda deve comunque
      // riprendere e il tick non deve propagare l'errore.
      resumeGenerationFn: async (dbOrTx, id) => {
        if (id === broken) throw new Error("boom simulato");
        return resumeGeneration(dbOrTx, id);
      },
    });

    const resumed = await pollLimitResumeOnce(deps);

    expect(resumed).toBe(1);
    expect(await generationStatus(db, broken)).toBe("paused");
    expect(await generationStatus(db, healthy)).toBe("running");
  });
});
