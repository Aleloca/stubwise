import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { aiProviders, docGenerationJobs, docGenerations, docNodes, projects } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { DOCS_WORKER_RESTART_ERROR } from "@stubwise/notifications";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Docs, area 5 fetta 1: lo stato della generazione dice PERCHÉ è ferma o
// fallita (un codice), QUANDO riprende se il server lo sa, e quanto è avanti.
// Niente stime: un campo che il server non sa resta null.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let admin: string;
const adminCookie = async () => admin;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example", embeddingClient: createFakeEmbeddingClient() });
  admin = (await seedUsers(app)).adminCookie;
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-ds@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

type Status = { reasonCode: string | null; resumesAt: string | null; progress: { done: number; total: number } | null };
const status = async (repositoryId: string) =>
  (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/docs/status`, headers: { cookie: lead.headers.cookie } })).json() as Status;
async function repo(): Promise<string> {
  const { repositoryId } = await seedRepository(t.db);
  return repositoryId;
}
async function repoInProject(): Promise<string> {
  const { seedRepositoryInProject } = await import("@stubwise/db/testing");
  return seedRepositoryInProject(t.db, projectId);
}

describe("lo stato della generazione dei Docs", () => {
  it("niente di fermo: i campi nuovi sono null", async () => {
    const r = await repoInProject();
    expect(await status(r)).toMatchObject({ reasonCode: null, resumesAt: null, progress: null });
  });

  it("in pausa sul limite: usage_limit, il rientro vero degli account, e l'avanzamento dai nodi", async () => {
    const r = await repoInProject();
    const [g] = await t.db
      .insert(docGenerations)
      .values({ repositoryId: r, status: "paused", pausedAt: new Date(), pauseReason: "provider_limit" })
      .returning({ id: docGenerations.id });
    await t.db.insert(docNodes).values(
      (["done", "pending", "exploring"] as const).map((status, i) => ({ generationId: g!.id, repositoryId: r, tree: "technical" as const, slug: `n${i}`, status })),
    );
    const until = new Date(Date.now() + 2 * 3_600_000);
    await t.db.insert(aiProviders).values([
      { position: 1, kind: "account", label: "A", secretEncrypted: "x", limitedUntil: until },
      { position: 2, kind: "account", label: "B", secretEncrypted: "x", limitedUntil: new Date(Date.now() + 5 * 3_600_000) },
      { position: 3, kind: "account", label: "spento", secretEncrypted: "x", enabled: false, limitedUntil: new Date(Date.now() + 60_000) },
    ]);
    const s = await status(r);
    expect(s.reasonCode).toBe("usage_limit");
    expect(s.resumesAt).toBe(until.toISOString());
    expect(s.progress).toEqual({ done: 1, total: 3 });
  });

  it("il rientro si calcola sugli account del PROVIDER DEL PROGETTO: con «solo questo» conta solo il suo (review F1)", async () => {
    const { projectId: other, repositoryId: r } = await seedRepository(t.db);
    const mine = new Date(Date.now() + 9 * 3_600_000);
    const [only] = await t.db
      .insert(aiProviders)
      .values([
        { position: 10, kind: "account", label: "solo del progetto", secretEncrypted: "x", limitedUntil: mine },
        { position: 11, kind: "account", label: "altro, rientra prima", secretEncrypted: "x", limitedUntil: new Date(Date.now() + 30 * 60_000) },
      ])
      .returning({ id: aiProviders.id });
    await t.db.update(projects).set({ aiProviderId: only!.id, aiProviderExclusive: true }).where(eq(projects.id, other));
    await t.db.insert(docGenerations).values({ repositoryId: r, status: "paused", pausedAt: new Date(), pauseReason: "provider_limit" });
    const s = (await app.inject({ method: "GET", url: `/api/repositories/${r}/docs/status`, headers: { cookie: (await adminCookie()) } })).json() as Status;
    expect(s.reasonCode).toBe("usage_limit");
    expect(s.resumesAt).toBe(mine.toISOString());
  });

  it("una generazione fissata a un provider («solo questo» alla nascita) rientra quando rientra QUEL provider", async () => {
    const { repositoryId: r } = await seedRepository(t.db);
    const pinnedAt = new Date(Date.now() + 7 * 3_600_000);
    const [pinned] = await t.db
      .insert(aiProviders)
      .values({ position: 12, kind: "account", label: "fissato", secretEncrypted: "x", limitedUntil: pinnedAt })
      .returning({ id: aiProviders.id });
    await t.db.insert(docGenerations).values({ repositoryId: r, status: "paused", pausedAt: new Date(), pauseReason: "provider_limit", pinnedProviderId: pinned!.id });
    const s = (await app.inject({ method: "GET", url: `/api/repositories/${r}/docs/status`, headers: { cookie: (await adminCookie()) } })).json() as Status;
    expect(s.resumesAt).toBe(pinnedAt.toISOString());
  });

  it("in pausa per la SOGLIA settimanale dello sfondo: usage_limit, ma nessuna ora di rientro (non è il limited_until degli account)", async () => {
    const r = await repoInProject();
    await t.db.insert(aiProviders).values({ position: 13, kind: "account", label: "al limite", secretEncrypted: "x", limitedUntil: new Date(Date.now() + 3_600_000) });
    await t.db.insert(docGenerations).values({ repositoryId: r, status: "paused", pausedAt: new Date(), pauseReason: "background_threshold" });
    expect(await status(r)).toMatchObject({ reasonCode: "usage_limit", resumesAt: null });
    const legacy = await repoInProject();
    await t.db.insert(docGenerations).values({
      repositoryId: legacy,
      status: "paused",
      pausedAt: new Date(),
      pauseReason: "soglia del limite settimanale (lavoro di sfondo) superata su tutti gli account AI: riprende al reset settimanale",
    });
    expect(await status(legacy)).toMatchObject({ reasonCode: "usage_limit", resumesAt: null });
  });

  it("un job fermo per il budget del mese: monthly_budget, senza ora di ripresa", async () => {
    const r = await repoInProject();
    await t.db.insert(docGenerationJobs).values({ repositoryId: r, status: "held", heldReason: "budget", trigger: "manual", error: "budget" });
    expect(await status(r)).toMatchObject({ reasonCode: "monthly_budget", resumesAt: null });
  });

  it("fallita per un riavvio del worker: worker_restart; un altro errore: other", async () => {
    const r = await repoInProject();
    await t.db.insert(docGenerationJobs).values({ repositoryId: r, status: "failed", trigger: "manual", error: DOCS_WORKER_RESTART_ERROR });
    expect((await status(r)).reasonCode).toBe("worker_restart");
    const other = await repoInProject();
    await t.db.insert(docGenerationJobs).values({ repositoryId: other, status: "failed", trigger: "manual", error: "boom" });
    expect((await status(other)).reasonCode).toBe("other");
  });

  it("gli spazi dicono il loro progetto", async () => {
    void repo;
    const { docPages } = await import("@stubwise/db");
    const r = await repoInProject();
    await t.db.insert(docPages).values({ repositoryId: r, kind: "manual", slug: "x", title: "X", isManual: true });
    const spaces = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/docs/spaces`, headers: { cookie: lead.headers.cookie } })).json() as { projectId: string | null }[];
    expect(spaces.length).toBeGreaterThan(0);
    expect(spaces.every((s) => s.projectId === projectId)).toBe(true);
  });
});
