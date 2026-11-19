import { agentRuns, aiJobs, aiModelSettings, aiProviders, aiUsageSnapshots, encrypt } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "./fake.js";
import { createModelResolver } from "./model-settings.js";
import type { RateLimitInfo } from "./rate-limit-event.js";
import type { AgentRunOptions, AgentRunUsage, UsageTag } from "./runner.js";
import { TrackingAgentRunner } from "./tracking-runner.js";

// Un container per file: il decoratore legge `ai_model_settings` e scrive
// `agent_runs` sul DB vero (CHECK e FK compresi), il runner interno è finto.
let testDb: TestDb;
let projectId: string;
let ticketId: string;
let providerId: string;
let cwd: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ projectId, ticketId } = await seedTicket(testDb.db));
  const [provider] = await testDb.db
    .insert(aiProviders)
    .values({ position: 1, kind: "api_key", label: "test", secretEncrypted: "x" })
    .returning();
  providerId = provider!.id;
  cwd = await mkdtemp(join(tmpdir(), "stubwise-tracking-"));
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(agentRuns);
  await testDb.db.delete(aiModelSettings);
  await testDb.db.delete(aiJobs);
  await testDb.db.delete(aiUsageSnapshots);
});

afterAll(async () => {
  await testDb.stop();
});

const USAGE: AgentRunUsage = {
  totalCostUsd: 0.3,
  models: [
    {
      model: "claude-sonnet-5-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 7,
      costUsd: 0.25,
    },
    {
      model: "claude-haiku-5-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 1,
      costUsd: 0.05,
    },
  ],
};

function tracking(inner: FakeAgentRunner): TrackingAgentRunner {
  const log = { warn: vi.fn() };
  return new TrackingAgentRunner({
    inner,
    db: testDb.db,
    models: createModelResolver(testDb.db, log),
  });
}

function opts(usage: UsageTag, extra: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return { cwd, prompt: "p", maxTurns: 1, timeoutMs: 1000, model: "sonnet", usage, ...extra };
}

describe("TrackingAgentRunner — modello", () => {
  it("(a) l'impostazione dell'operazione vince sul modello delle opzioni", async () => {
    await testDb.db.insert(aiModelSettings).values({ operation: "fix_execute", model: "claude-opus-5-5" });
    const inner = new FakeAgentRunner();
    await tracking(inner).run(opts({ operation: "fix_execute", projectId }));
    expect(inner.calls[0]!.model).toBe("claude-opus-5-5");
  });

  it("(b) senza riga resta il modello delle opzioni", async () => {
    const inner = new FakeAgentRunner();
    await tracking(inner).run(opts({ operation: "fix_execute", projectId }));
    expect(inner.calls[0]!.model).toBe("sonnet");
  });

  it("(c) modelLocked tiene il modello delle opzioni anche con la riga", async () => {
    await testDb.db.insert(aiModelSettings).values({ operation: "docs_generation", model: "haiku" });
    const inner = new FakeAgentRunner();
    await tracking(inner).run(
      opts({ operation: "docs_generation", projectId, modelLocked: true }, { model: "opus" }),
    );
    expect(inner.calls[0]!.model).toBe("opus");
  });

  it("(d) un'operazione tecnica non viene mai sostituita", async () => {
    // La riga è ammessa dal CHECK (operation in AI_OPERATIONS), ma
    // `credential_test` non è configurabile: il decoratore non la legge.
    await testDb.db.insert(aiModelSettings).values({ operation: "credential_test", model: "opus" });
    const inner = new FakeAgentRunner();
    await tracking(inner).run(opts({ operation: "credential_test", projectId: null }, { model: "haiku" }));
    expect(inner.calls[0]!.model).toBe("haiku");
  });

  it("senza modello nelle opzioni né riga, il modello resta assente (default del CLI)", async () => {
    const inner = new FakeAgentRunner();
    const noModel = opts({ operation: "summary", projectId });
    delete noModel.model;
    await tracking(inner).run(noModel);
    expect(inner.calls[0]!.model).toBeUndefined();
  });

  it("non tocca il provider scelto dal chiamante", async () => {
    const inner = new FakeAgentRunner();
    const provider = { id: providerId, kind: "api_key" as const, secret: "s" };
    await tracking(inner).run(opts({ operation: "summary", projectId }, { provider }));
    expect(inner.calls[0]!.provider).toEqual(provider);
  });
});

describe("TrackingAgentRunner — consumi", () => {
  it("(e) una riga per modello con operation, progetto, provider, run_id e cache_creation", async () => {
    const inner = new FakeAgentRunner({ usage: USAGE });
    const provider = { id: providerId, kind: "api_key" as const, secret: "s" };
    const result = await tracking(inner).run(
      opts({ operation: "daily_report", projectId }, { provider }),
    );

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await testDb.db.select().from(agentRuns);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.operation).toBe("daily_report");
      expect(row.projectId).toBe(projectId);
      expect(row.providerId).toBe(providerId);
      expect(row.runId).toBe(result.runId);
      expect(row.phase).toBeNull();
      expect(row.jobId).toBeNull();
    }
    const sonnet = rows.find((r) => r.model === "claude-sonnet-5-5")!;
    expect(sonnet.inputTokens).toBe(100);
    expect(sonnet.outputTokens).toBe(50);
    expect(sonnet.cacheReadTokens).toBe(20);
    expect(sonnet.cacheCreationTokens).toBe(7);
    expect(Number(sonnet.costUsd)).toBeCloseTo(0.25);
    const haiku = rows.find((r) => r.model === "claude-haiku-5-5")!;
    expect(haiku.cacheCreationTokens).toBe(1);
  });

  it("con un owner job scrive job_id e phase", async () => {
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId }).returning();
    const inner = new FakeAgentRunner({ usage: USAGE });
    await tracking(inner).run(
      opts({ operation: "summary", projectId, jobId: job!.id, phase: "fix" }),
    );
    const rows = await testDb.db.select().from(agentRuns);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.jobId === job!.id && r.phase === "fix")).toBe(true);
  });

  it("senza provider, provider_id è null; ogni run ha il suo run_id", async () => {
    const inner = new FakeAgentRunner({ usage: USAGE });
    const runner = tracking(inner);
    const first = await runner.run(opts({ operation: "release_notes", projectId }));
    const second = await runner.run(opts({ operation: "release_notes", projectId }));
    expect(first.runId).not.toBe(second.runId);
    const rows = await testDb.db.select().from(agentRuns);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.providerId === null)).toBe(true);
  });

  it("(f) record: false non scrive righe ma restituisce comunque il runId", async () => {
    const inner = new FakeAgentRunner({ usage: USAGE });
    const result = await tracking(inner).run(
      opts({ operation: "fix_execute", projectId, record: false }),
    );
    expect(result.runId).toBeDefined();
    expect(await testDb.db.select().from(agentRuns)).toHaveLength(0);
  });

  it("(g) un insert che fallisce (owner doppio) non fa lanciare run", async () => {
    const inner = new FakeAgentRunner({ usage: USAGE, output: "ok" });
    const result = await tracking(inner).run(
      opts({
        operation: "pr_review",
        projectId,
        jobId: randomUUID(),
        prReviewId: randomUUID(),
        phase: "review",
      }),
    );
    expect(result.output).toBe("ok");
    expect(await testDb.db.select().from(agentRuns)).toHaveLength(0);
  });

  it("senza usage nel risultato non scrive nulla", async () => {
    const inner = new FakeAgentRunner();
    await tracking(inner).run(opts({ operation: "weekly_brief", projectId }));
    expect(await testDb.db.select().from(agentRuns)).toHaveLength(0);
  });

  it("un errore del runner interno si propaga e non scrive righe", async () => {
    const inner = new FakeAgentRunner({
      script: () => {
        throw new Error("boom");
      },
    });
    await expect(tracking(inner).run(opts({ operation: "summary", projectId }))).rejects.toThrow("boom");
    expect(await testDb.db.select().from(agentRuns)).toHaveLength(0);
  });

  it("recordsSessions è quello del runner interno", () => {
    expect(tracking(new FakeAgentRunner({ recordsSessions: true })).recordsSessions).toBe(true);
    expect(tracking(new FakeAgentRunner()).recordsSessions).toBe(false);
  });
});

describe("TrackingAgentRunner — snapshot d'uso dal rate_limit_event", () => {
  const AT = new Date("2026-11-19T09:00:00.000Z");
  const info = (status: string, usedPercent: number): RateLimitInfo => ({
    status,
    rateLimitType: "five_hour",
    windows: { five_hour: { usedPercent, resetsAt: new Date("2026-11-19T12:00:00.000Z") } },
  });

  async function newAccount(label: string, limitedUntil: Date | null = null): Promise<string> {
    const [row] = await testDb.db
      .insert(aiProviders)
      .values({
        position: 2,
        kind: "account",
        label,
        secretEncrypted: encrypt("x", randomBytes(32)),
        limitedUntil,
      })
      .returning();
    return row!.id;
  }

  // Il runner finto emette l'evento e ASPETTA la promessa della callback, come
  // farebbe un chiamante che vuole sincronizzarsi: lo streaming vero non la attende.
  function emitting(i: RateLimitInfo): FakeAgentRunner {
    return new FakeAgentRunner({
      script: async (o) => {
        await o.onRateLimit?.(i, AT);
        return { output: "ok", exitCode: 0 };
      },
    });
  }

  const snapshots = (id: string) =>
    testDb.db.select().from(aiUsageSnapshots).where(eq(aiUsageSnapshots.providerId, id));

  it("account: una riga con captured_at = at, anche con record: false", async () => {
    const id = await newAccount("snap1");
    const provider = { id, kind: "account" as const, secret: "s" };
    await tracking(emitting(info("allowed", 40))).run(
      opts({ operation: "summary", projectId, record: false }, { provider }),
    );
    const rows = await snapshots(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capturedAt).toEqual(AT);
    expect(rows[0]!.sessionRemaining).toEqual({ percentUsed: 40, percentRemaining: 60, resetsLabel: null });
  });

  it("allowed sotto il 100: azzera limited_until", async () => {
    const id = await newAccount("snap2", new Date(Date.now() + 3_600_000));
    const provider = { id, kind: "account" as const, secret: "s" };
    await tracking(emitting(info("allowed", 40))).run(opts({ operation: "summary", projectId }, { provider }));
    const [row] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(row!.limitedUntil).toBeNull();
  });

  it("rejected: limited_until invariato", async () => {
    const until = new Date(Date.now() + 3_600_000);
    const id = await newAccount("snap3", until);
    const provider = { id, kind: "account" as const, secret: "s" };
    await tracking(emitting(info("rejected", 100))).run(opts({ operation: "summary", projectId }, { provider }));
    const [row] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(row!.limitedUntil).toEqual(until);
  });

  it("api_key: nessuna riga, e la callback del chiamante riceve l'evento", async () => {
    const onRateLimit = vi.fn();
    const provider = { id: providerId, kind: "api_key" as const, secret: "s" };
    await tracking(emitting(info("allowed", 40))).run(
      opts({ operation: "summary", projectId }, { provider, onRateLimit }),
    );
    expect(await snapshots(providerId)).toHaveLength(0);
    expect(onRateLimit).toHaveBeenCalledWith(info("allowed", 40), AT);
  });

  it("nessun provider: nessuna riga, la callback del chiamante riceve l'evento", async () => {
    const onRateLimit = vi.fn();
    await tracking(emitting(info("allowed", 40))).run(opts({ operation: "summary", projectId }, { onRateLimit }));
    expect(onRateLimit).toHaveBeenCalledWith(info("allowed", 40), AT);
    expect(await testDb.db.select().from(aiUsageSnapshots)).toHaveLength(0);
  });

  it("account: la callback del chiamante è chiamata e, se lancia, lo snapshot si scrive lo stesso", async () => {
    const id = await newAccount("snap4");
    const provider = { id, kind: "account" as const, secret: "s" };
    const onRateLimit = vi.fn(() => {
      throw new Error("boom");
    });
    await tracking(emitting(info("allowed", 40))).run(
      opts({ operation: "summary", projectId }, { provider, onRateLimit }),
    );
    expect(onRateLimit).toHaveBeenCalledOnce();
    expect(await snapshots(id)).toHaveLength(1);
  });

  it("insert fallito (provider inesistente): il run ritorna il suo risultato, nessun throw", async () => {
    const provider = { id: randomUUID(), kind: "account" as const, secret: "s" };
    const result = await tracking(emitting(info("allowed", 40))).run(
      opts({ operation: "summary", projectId, record: false }, { provider }),
    );
    expect(result.output).toBe("ok");
  });
});
