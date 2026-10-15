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
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resumeGeneration } from "../docs/nodes.js";
import { getContentLanguage } from "../settings.js";
import { pollLimitResumeOnce, type LimitResumeDeps } from "./limit-resume-poller.js";
import { QuotaWaitLog } from "./quota-wait.js";

// Il resume poller riprende automaticamente ciò che è fermo per LIMITE del
// provider: generazioni `paused`, ai_jobs `held` (held_reason "limit") e
// doc_generation_jobs `held` (held_reason "limit"). La decisione è LA STESSA
// della scelta del run (selectProviders, preflight D7): si riprende solo se la
// scelta ha un candidato e il PRIMO candidato ha margine:
//  - `account` con snapshot fresco e parsato → headroom = sessione < soglia% E
//    weekly < 100%;
//  - `api_key` o snapshot stantio/assente/non parsato → fallback A TEMPO
//    (cooldown dal momento della pausa), MAI eterno.
// Un account «al limite» (limited_until futuro) non è un candidato, e con
// almeno un abbonamento abilitato la chiave API non lo è mai: niente più
// ripresa sulla chiave che il run rimetterebbe subito in held.
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

function inMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * MINUTE);
}

/** Deps di default del tick: soglia 95%, cooldown 60', snapshot fresco entro 15'. */
function makeDeps(overrides: Partial<LimitResumeDeps> = {}): LimitResumeDeps {
  return {
    db: testDb.db,
    select: { db: testDb.db, encryptionKey: ENCRYPTION_KEY, backgroundWeeklyThreshold: 90 },
    headroomPercent: 95,
    cooldownMs: 60 * MINUTE,
    maxSnapshotAgeMs: 15 * MINUTE,
    ...overrides,
  };
}

async function seedProvider(
  db: Db,
  values: {
    position: number;
    kind: "api_key" | "account";
    enabled?: boolean;
    limitedUntil?: Date;
  },
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
      limitedUntil: values.limitedUntil ?? null,
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
  opts: { aiProviderId?: string; exclusive?: boolean } = {},
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
      aiProviderExclusive: opts.exclusive ?? false,
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

  // SEMANTICA CAMBIATA (Task A6, dichiarato): prima bastava che UNA credenziale
  // della catena avesse margine, chiave API compresa; ora decide il PRIMO
  // candidato della scelta, e la chiave non è un candidato se esiste un
  // abbonamento abilitato.
  it("ai_jobs held per limite, primo abbonamento al limite e un secondo libero → queued + commento AI limitResumed + log nel job", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "account", limitedUntil: inMinutes(180) });
    await seedProvider(db, { position: 2, kind: "account" });
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

  it("un abbonamento tornato disponibile (snapshot fresco con margine) → ripreso subito, senza aspettare il cooldown", async () => {
    const { db } = testDb;
    const accountId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, accountId, { sessionUsed: 10, weeklyUsed: 30 });
    await seedProvider(db, { position: 2, kind: "api_key" });
    const { projectId } = await seedRepository(db);
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(2) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("queued");
  });

  it("primo candidato senza margine (snapshot fresco al 100%) e un secondo abbonamento libero → ripreso (failover come il run)", async () => {
    const { db } = testDb;
    const first = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, first, { sessionUsed: 100, weeklyUsed: 40 });
    const second = await seedProvider(db, { position: 2, kind: "account" });
    await seedSnapshot(db, second, { sessionUsed: 10, weeklyUsed: 40 });
    const { projectId } = await seedRepository(db);
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(2) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("queued");
  });

  it("«solo questo» su un provider disabilitato: resta fermo, UNA riga di log all'ingresso nell'attesa, non a ogni giro", async () => {
    const { db } = testDb;
    const exclusive = await seedProvider(db, { position: 1, kind: "account", enabled: false });
    await seedProvider(db, { position: 2, kind: "account" });
    const { projectId } = await seedRepository(db, { aiProviderId: exclusive, exclusive: true });
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });
    const deps = makeDeps({ cooldownMs: 60 * MINUTE, waitLog: new QuotaWaitLog() });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pollLimitResumeOnce(deps);
      await pollLimitResumeOnce(deps);
      await pollLimitResumeOnce(deps);
      const lines = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes(`fix job ${jobId} resta fermo`));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("solo questo");
    } finally {
      spy.mockRestore();
    }
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
  });

  it("tutti gli abbonamenti al limite + chiave API in catena → job NON ripreso", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "account", limitedUntil: inMinutes(180) });
    await seedProvider(db, { position: 2, kind: "account", limitedUntil: inMinutes(240) });
    // La chiave API ha «margine» (cooldown superato): prima faceva riprendere il
    // job, che runWithProviders rimetteva subito in held.
    await seedProvider(db, { position: 3, kind: "api_key" });
    const { projectId } = await seedRepository(db);
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
  });

  it("nessun commento AI ripetuto sul ticket: più giri con tutti gli account al limite (chiave API in catena) → zero commenti nuovi dopo il primo hold", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "account", limitedUntil: inMinutes(300) });
    await seedProvider(db, { position: 2, kind: "account", limitedUntil: inMinutes(300) });
    await seedProvider(db, { position: 3, kind: "api_key" });
    const { projectId } = await seedRepository(db);
    const { ticketId, jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });
    // Il PRIMO hold: il commento che l'handler scrive mettendo il job in held.
    const lang = await getContentLanguage(db);
    await db
      .insert(comments)
      .values({ ticketId, authorType: "ai", body: t(lang, "comment.providersLimitHeld") });

    const aiComments = async (): Promise<number> =>
      (
        await db
          .select({ id: comments.id })
          .from(comments)
          .where(and(eq(comments.ticketId, ticketId), eq(comments.authorType, "ai")))
      ).length;
    expect(await aiComments()).toBe(1);

    for (let cycle = 0; cycle < 4; cycle++) {
      await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));
      // Un ciclo completo: se il poller avesse riaccodato, l'handler avrebbe
      // ritrovato tutti gli account al limite e rimesso il job in held con un
      // secondo commento (quello che succedeva prima, due commenti a giro).
      const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
      if (job?.status === "queued") {
        await db
          .update(aiJobs)
          .set({ status: "held", heldReason: "limit", finishedAt: minutesAgo(90) })
          .where(eq(aiJobs.id, jobId));
        await db
          .insert(comments)
          .values({ ticketId, authorType: "ai", body: t(lang, "comment.providersLimitHeld") });
      }
      expect(await aiComments(), `commenti AI dopo il giro ${cycle + 1}`).toBe(1);
    }
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
  });

  it("progetto esclusivo col suo account al limite → NON ripreso anche se altri abbonamenti sono liberi", async () => {
    const { db } = testDb;
    const exclusiveId = await seedProvider(db, {
      position: 1,
      kind: "account",
      limitedUntil: inMinutes(120),
    });
    await seedProvider(db, { position: 2, kind: "account" });
    const { projectId } = await seedRepository(db, { aiProviderId: exclusiveId, exclusive: true });
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
  });

  it("provider del progetto PREFERITO (senza «solo questo») al limite e un altro abbonamento libero → ripreso", async () => {
    const { db } = testDb;
    const preferredId = await seedProvider(db, {
      position: 1,
      kind: "account",
      limitedUntil: inMinutes(120),
    });
    await seedProvider(db, { position: 2, kind: "account" });
    const { projectId } = await seedRepository(db, { aiProviderId: preferredId });
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("queued");
  });

  it("provider preferito senza margine (snapshot fresco al 100%) e solo la chiave API dietro → resta held", async () => {
    const { db } = testDb;
    const preferredId = await seedProvider(db, { position: 1, kind: "account" });
    await seedSnapshot(db, preferredId, { sessionUsed: 100, weeklyUsed: 100 });
    await seedProvider(db, { position: 2, kind: "api_key" });
    const { projectId } = await seedRepository(db, { aiProviderId: preferredId });
    const { jobId } = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
  });

  it("nessun provider abilitato (auth storica) → ripreso dopo il cooldown, non resta fermo per sempre", async () => {
    const { db } = testDb;
    const { projectId } = await seedRepository(db);
    const old = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(90) });
    const recent = await seedHeldJob(db, projectId, { finishedAt: minutesAgo(5) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    const [oldJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, old.jobId));
    const [recentJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, recent.jobId));
    expect(oldJob?.status).toBe("queued");
    expect(recentJob?.status).toBe("held");
  });

  it("generazione paused con tutti gli abbonamenti oltre la soglia settimanale (sfondo) → resta paused", async () => {
    const { db } = testDb;
    const a = await seedProvider(db, { position: 1, kind: "account" });
    const b = await seedProvider(db, { position: 2, kind: "account" });
    // Sessione libera ma settimana al 95% (soglia 90): un lavoro di sfondo non li sceglie.
    await seedSnapshot(db, a, { sessionUsed: 10, weeklyUsed: 95 });
    await seedSnapshot(db, b, { sessionUsed: 10, weeklyUsed: 92 });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, { pausedAt: minutesAgo(90) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    expect(await generationStatus(db, generationId)).toBe("paused");
  });

  it("generazione paused con un abbonamento sotto la soglia settimanale → ripresa", async () => {
    const { db } = testDb;
    const a = await seedProvider(db, { position: 1, kind: "account" });
    const b = await seedProvider(db, { position: 2, kind: "account" });
    await seedSnapshot(db, a, { sessionUsed: 10, weeklyUsed: 95 });
    await seedSnapshot(db, b, { sessionUsed: 10, weeklyUsed: 50 });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, { pausedAt: minutesAgo(2) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(1);
    expect(await generationStatus(db, generationId)).toBe("running");
  });

  it("generazione con pin («solo questo») sul suo account al limite → resta paused anche con altri liberi", async () => {
    const { db } = testDb;
    const pinned = await seedProvider(db, {
      position: 1,
      kind: "account",
      limitedUntil: inMinutes(120),
    });
    await seedProvider(db, { position: 2, kind: "account" });
    const { repositoryId } = await seedRepository(db);
    const generationId = await seedPausedGeneration(db, repositoryId, {
      pinnedProviderId: pinned,
      pausedAt: minutesAgo(90),
    });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    expect(await generationStatus(db, generationId)).toBe("paused");
  });

  it("doc job held per limite con tutti gli abbonamenti al limite → resta held", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "account", limitedUntil: inMinutes(120) });
    await seedProvider(db, { position: 2, kind: "api_key" });
    const { repositoryId } = await seedRepository(db);
    const docJobId = await seedHeldDocJob(db, repositoryId, { finishedAt: minutesAgo(90) });

    const resumed = await pollLimitResumeOnce(makeDeps({ cooldownMs: 60 * MINUTE }));

    expect(resumed).toBe(0);
    const [docJob] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, docJobId));
    expect(docJob?.status).toBe("held");
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
