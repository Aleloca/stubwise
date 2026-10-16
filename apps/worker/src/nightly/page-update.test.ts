import {
  commitSummaries,
  docChunks,
  docGenerations,
  docPagePendingCommits,
  docPages,
  nightlyItems,
  repositories,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { REFRESH_NO_CHANGE_MARKER, REFRESH_UPDATED_END_MARKER, REFRESH_UPDATED_START_MARKER } from "@stubwise/docs-engine";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sensitiveReadDenyRules } from "../agent/read-scope.js";
import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { fakeSelect } from "../providers/select-fake.js";
import type { SelectDeps } from "../providers/select.js";
import {
  fakeNightlyDeps,
  fakeNightlyRepo,
  seedCommitSummary,
  seedCurrentGeneration,
  seedGenerationPage,
  sha,
} from "./nightly-fake.js";
import { advanceBookmarkIfDone, runPageUpdateItem } from "./page-update.js";
import { SUPERSEDED_BY_GENERATION, type DocsPlan } from "./plan.js";
import { claimNext, enqueueItems, failItem, releaseItem, upsertTargetItems, type NightlyItem } from "./queue.js";
import type { NightlyDeps } from "./types.js";

let testDb: TestDb;
let repositoryId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ repositoryId, projectId } = await seedRepository(testDb.db));
}, 120_000);

afterEach(async () => {
  const db = testDb.db;
  await db.delete(docPagePendingCommits);
  await db.delete(nightlyItems);
  await db.update(repositories).set({ currentDocGenerationId: null });
  await db.delete(docPages);
  await db.delete(docGenerations);
  await db.delete(commitSummaries);
});

afterAll(async () => {
  await testDb.stop();
});

const NIGHT1 = "2026-10-14";
const NIGHT2 = "2026-10-15";
const NIGHT3 = "2026-10-16";
const BOOKMARK = sha("0");
const HEAD = sha("f");
const WT = "/srv/none/stubwise-wt/repo";
const PROVIDER = { id: "p1", kind: "account" } as unknown as ResolvedProvider;
const OLD_BODY = "## Login\n\nIl login usa la password.";
const NEW_BODY = "## Login\n\nIl login usa un codice OTP.";

const UPDATED = [REFRESH_UPDATED_START_MARKER, NEW_BODY, REFRESH_UPDATED_END_MARKER].join("\n");

function ok(output: string): AgentRunResult {
  return { output, exitCode: 0, usage: { totalCostUsd: 0.1 } } as AgentRunResult;
}

function makeDeps(
  o: { run?: (opts: AgentRunOptions) => Promise<AgentRunResult>; output?: string; select?: SelectDeps } = {},
) {
  const run = vi.fn(o.run ?? (async () => ok(o.output ?? UPDATED)));
  const log = vi.fn();
  const base = fakeNightlyDeps(testDb.db, {
    runner: { run },
    mirrors: {},
    select: o.select ?? fakeSelect(testDb.db, [PROVIDER]),
    log,
  });
  const deps: NightlyDeps = { ...base, embeddingClient: createFakeEmbeddingClient() };
  return { deps, run, log };
}

const repo = () => fakeNightlyRepo(repositoryId, projectId, null);

async function seedPage(gen: string, o: { slug?: string; sourcePath?: string | null; kind?: "technical" | "product" } = {}) {
  const id = await seedGenerationPage(testDb.db, repositoryId, gen, {
    slug: o.slug ?? "auth",
    title: "Authentication",
    sourcePath: o.sourcePath === undefined ? "src/auth" : o.sourcePath,
  });
  await testDb.db
    .update(docPages)
    .set({ body: OLD_BODY, ...(o.kind ? { kind: o.kind } : {}) })
    .where(eq(docPages.id, id));
  return id;
}

async function enqueuePage(
  gen: string,
  pageId: string,
  o: { files?: string[]; commits?: string[]; toSha?: string; night?: string } = {},
): Promise<void> {
  const toSha = o.toSha ?? HEAD;
  await upsertTargetItems(
    testDb.db,
    [
      {
        repositoryId,
        projectId,
        phase: "page_update",
        target: pageId,
        toSha,
        payload: {
          generationId: gen,
          pageId,
          fromSha: BOOKMARK,
          toSha,
          files: o.files ?? ["src/auth/login.ts"],
          commits: o.commits ?? [sha("1")],
          via: "map",
        },
      },
    ],
    o.night ?? NIGHT3,
  );
}

async function claim(): Promise<NightlyItem> {
  const item = await claimNext(testDb.db, repositoryId, "page_update");
  if (!item) throw new Error("nessun elemento");
  return item;
}

async function itemById(id: string) {
  const [row] = await testDb.db.select().from(nightlyItems).where(eq(nightlyItems.id, id));
  return row!;
}

async function pageBody(id: string) {
  const [row] = await testDb.db.select({ body: docPages.body }).from(docPages).where(eq(docPages.id, id));
  return row?.body;
}

async function chunkCount(pageId: string) {
  return (await testDb.db.select().from(docChunks).where(eq(docChunks.pageId, pageId))).length;
}

async function pendingShas(pageId: string) {
  const rows = await testDb.db
    .select({ sha: docPagePendingCommits.sha })
    .from(docPagePendingCommits)
    .where(eq(docPagePendingCommits.pageId, pageId));
  return rows.map((r) => r.sha).sort();
}

async function generationSha(id: string) {
  const [row] = await testDb.db.select({ s: docGenerations.commitSha }).from(docGenerations).where(eq(docGenerations.id, id));
  return row?.s ?? null;
}

async function documentedAt(s: string) {
  const [row] = await testDb.db
    .select({ d: commitSummaries.documentedAt })
    .from(commitSummaries)
    .where(and(eq(commitSummaries.repositoryId, repositoryId), eq(commitSummaries.sha, s)));
  return row?.d ?? null;
}

function planOf(gen: string, commits: string[] = [sha("1")]): DocsPlan {
  return {
    generationId: gen,
    fromSha: BOOKMARK,
    toSha: HEAD,
    commits,
    changedFiles: [],
    mapped: [],
    newAreas: [],
    missingSummaries: [],
  };
}

describe("runPageUpdateItem: il run", () => {
  it("allowlist CHIUSA per file: una regola Read/Grep per file, mai nuda, senza `/**`, default mode, cwd fuori dal worktree", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), {
      files: ["src/auth/login.ts"],
      subject: "feat: otp",
      summary: "Il login passa a OTP.",
      onDefaultBranch: true,
    });
    await enqueuePage(gen, page, { files: ["src/auth/login.ts", "src/auth/otp.ts"] });
    const { deps, run } = makeDeps();
    await runPageUpdateItem(deps, repo(), WT, await claim());

    expect(run).toHaveBeenCalledTimes(1);
    const opts = run.mock.calls[0]![0];
    expect(opts.permissionMode).toBe("default");
    expect(opts.model).toBe("sonnet");
    expect(opts.maxTurns).toBe(10);
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.provider).toBe(PROVIDER);
    expect(opts.allowedTools).toEqual([
      `Read(/${WT}/src/auth/login.ts)`,
      `Grep(/${WT}/src/auth/login.ts)`,
      `Read(/${WT}/src/auth/otp.ts)`,
      `Grep(/${WT}/src/auth/otp.ts)`,
    ]);
    for (const rule of opts.allowedTools!) expect(rule).not.toContain("**");
    for (const bare of ["Read", "Grep", "Glob", "Write", "Edit", "Bash"]) expect(opts.allowedTools).not.toContain(bare);
    expect(opts.disallowedTools).toEqual(sensitiveReadDenyRules());
    expect(opts.cwd).not.toBe(WT);
    expect(opts.cwd!.startsWith(WT)).toBe(false);
    expect(opts.prompt).toContain(`- ${WT}/src/auth/login.ts`);
    expect(opts.prompt).toContain("Il login passa a OTP.");
    expect(opts.prompt).toContain("SAME language as the CURRENT PAGE BODY");
  });

  it("«nessun cambiamento» (Review Focus #5): pagina e chunk intatti, elemento done", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"] });
    await enqueuePage(gen, page);
    const { deps } = makeDeps({ output: `Ho letto il codice.\n${REFRESH_NO_CHANGE_MARKER}` });
    const item = await claim();
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toBe("unchanged");
    expect(await pageBody(page)).toBe(OLD_BODY);
    expect(await chunkCount(page)).toBe(0);
    const row = await itemById(item.id);
    expect(row.status).toBe("done");
    expect(row.claimedAt).toBeNull();
    expect(row.payload).toMatchObject({ outcome: "unchanged" });
    expect(row.payload).not.toHaveProperty("resultPageId");
  });

  it("aggiornata: corpo nuovo e chunk ri-embeddati, elemento done", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"] });
    await enqueuePage(gen, page);
    const { deps } = makeDeps();
    const item = await claim();
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toBe("updated");
    expect(await pageBody(page)).toBe(NEW_BODY);
    expect(await chunkCount(page)).toBeGreaterThan(0);
    const row = await itemById(item.id);
    expect(row.status).toBe("done");
    expect(row.payload).toMatchObject({ outcome: "updated", resultPageId: page });
  });

  it("payload senza file né commit: unchanged senza run", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await enqueuePage(gen, page, { files: [], commits: [] });
    const { deps, run } = makeDeps();
    const item = await claim();
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toBe("unchanged");
    expect(run).not.toHaveBeenCalled();
    expect((await itemById(item.id)).status).toBe("done");
  });

  it("output senza marcatori o exit ≠ 0: fallimento, pagina intatta, coda non toccata", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"] });
    await enqueuePage(gen, page);
    const item = await claim();
    const { deps } = makeDeps({ output: "La pagina mi sembra corretta." });
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toEqual({
      failed: "output della pagina senza i marcatori del contratto",
    });
    const { deps: deps2 } = makeDeps({ run: async () => ({ output: UPDATED, exitCode: 1 }) as AgentRunResult });
    expect(await runPageUpdateItem(deps2, repo(), WT, item)).toEqual({
      failed: "run della pagina terminato con exit 1",
    });
    expect(await pageBody(page)).toBe(OLD_BODY);
    expect((await itemById(item.id)).status).toBe("pending");
  });

  it("limite dell'auth del container (legacy_limited) → unavailable all_limited_now; scelta vuota → il suo motivo", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await enqueuePage(gen, page);
    const item = await claim();
    const { deps } = makeDeps({
      select: fakeSelect(testDb.db, "legacy"),
      run: async () => ({ output: "usage limit reached", exitCode: 1 }) as AgentRunResult,
    });
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toEqual({ unavailable: "all_limited_now" });
    const { deps: deps2, run } = makeDeps({ select: fakeSelect(testDb.db, { emptyReason: "exclusive_unavailable" }) });
    expect(await runPageUpdateItem(deps2, repo(), WT, item)).toEqual({ unavailable: "exclusive_unavailable" });
    expect(run).not.toHaveBeenCalled();
    expect((await itemById(item.id)).status).toBe("pending");
  });

  it("generazione sostituita (D32): chiuso done senza run, superseded_by_generation", async () => {
    const oldGen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(oldGen);
    await enqueuePage(oldGen, page);
    await seedCurrentGeneration(testDb.db, repositoryId, HEAD);
    const { deps, run } = makeDeps();
    const item = await claim();
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toBe("unchanged");
    expect(run).not.toHaveBeenCalled();
    expect(await itemById(item.id)).toMatchObject({ status: "done", lastError: SUPERSEDED_BY_GENERATION });
    expect(await pageBody(page)).toBe(OLD_BODY);
  });

  it("pagina product bocciata dal verificatore segreti: NON aggiornata, fallimento contato dal chiamante", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await testDb.db
      .update(docGenerations)
      .set({ brief: { confidentialFacts: [{ fact: "il cliente X", reason: "contratto", source: "src/auth", avoid: "nome del cliente" }] } as never })
      .where(eq(docGenerations.id, gen));
    const page = await seedPage(gen, { kind: "product" });
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"] });
    await enqueuePage(gen, page);
    const outputs = [UPDATED, "===AUDIT===\nVERDICT: VIOLATION\nDETAIL: cita il cliente X\n===END AUDIT==="];
    const { deps, run } = makeDeps({ run: async () => ok(outputs.shift()!) });
    const item = await claim();
    const out = await runPageUpdateItem(deps, repo(), WT, item);
    expect(out).toMatchObject({ failed: expect.stringContaining("guardia product") });
    expect(run).toHaveBeenCalledTimes(2);
    expect(await pageBody(page)).toBe(OLD_BODY);
    expect((await itemById(item.id)).status).toBe("pending");
  });
});

describe("runPageUpdateItem: pagina product", () => {
  it("verificatore segreti CLEAN: aggiornata, audit in sola lettura di testo col modello notturno", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await testDb.db
      .update(docGenerations)
      .set({ brief: { confidentialFacts: [{ fact: "f", reason: "r", source: "s", avoid: "a" }] } as never })
      .where(eq(docGenerations.id, gen));
    const page = await seedPage(gen, { kind: "product" });
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"] });
    await enqueuePage(gen, page);
    const outputs = [UPDATED, "===VERDICT===\nCLEAN\n===DETAIL===\n"];
    const { deps, run } = makeDeps({ run: async () => ok(outputs.shift()!) });
    expect(await runPageUpdateItem(deps, repo(), WT, await claim())).toBe("updated");
    const audit = run.mock.calls[1]![0];
    expect(audit.model).toBe("sonnet");
    expect(audit.permissionMode).toBe("plan");
    expect(audit.cwd).not.toBe(WT);
    expect(await pageBody(page)).toBe(NEW_BODY);
  });
});

describe("runPageUpdateItem: commit pendenti di un'escalation (D31)", () => {
  for (const [label, output, expected] of [
    ["aggiornata", UPDATED, "updated"],
    ["nessun cambiamento", REFRESH_NO_CHANGE_MARKER, "unchanged"],
  ] as const) {
    it(`${label}: cancellate le sole righe con sha nel payload, quella scritta dopo la pianificazione resta`, async () => {
      const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
      const page = await seedPage(gen);
      const [seen, old, late] = [sha("1"), sha("2"), sha("3")];
      for (const s of [seen, old, late]) {
        await seedCommitSummary(testDb.db, repositoryId, s, { files: ["src/auth/login.ts"], onDefaultBranch: true });
      }
      await testDb.db.insert(docPagePendingCommits).values([
        { pageId: page, repositoryId, sha: old },
      ]);
      await enqueuePage(gen, page, { commits: [seen, old] });
      // Dopo la pianificazione: un'altra escalation porta `late`.
      await testDb.db.insert(docPagePendingCommits).values([{ pageId: page, repositoryId, sha: late }]);
      const { deps } = makeDeps({ output });
      expect(await runPageUpdateItem(deps, repo(), WT, await claim())).toBe(expected);
      expect(await pendingShas(page)).toEqual([late]);
    });
  }
});

describe("advanceBookmarkIfDone", () => {
  it("fine fase: segnalibro e documented_at avanzano INSIEME, anche con la nota fallita", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    const [c1, c2] = [sha("1"), sha("2")];
    await seedCommitSummary(testDb.db, repositoryId, c1, { files: ["src/auth/login.ts"], onDefaultBranch: true });
    await seedCommitSummary(testDb.db, repositoryId, c2, { files: ["docs/x.md"], onDefaultBranch: true });
    // Un commit di un altro intervallo, fuori dal piano: non si tocca.
    await seedCommitSummary(testDb.db, repositoryId, sha("9"), { files: ["src/auth/a.ts"], onDefaultBranch: true });
    // La nota della notte è fallita (resta pending): non conta.
    await enqueueItems(
      testDb.db,
      [{ repositoryId, projectId, phase: "release", key: `${BOOKMARK}..${HEAD}`, payload: { toSha: HEAD } }],
      NIGHT3,
    );
    await enqueuePage(gen, page, { commits: [c1] });
    const { deps } = makeDeps();
    const item = await claim();
    expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen, [c1, c2]))).toBe(false);
    expect(await runPageUpdateItem(deps, repo(), WT, item)).toBe("updated");

    expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen, [c1, c2]))).toBe(true);
    expect(await generationSha(gen)).toBe(HEAD);
    expect(await documentedAt(c1)).not.toBeNull();
    expect(await documentedAt(c2)).not.toBeNull();
    expect(await documentedAt(sha("9"))).toBeNull();
  });

  it("limite a metà (Review Focus #3): fatti done, restanti pending, segnalibro fermo", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const p1 = await seedPage(gen, { slug: "auth" });
    const p2 = await seedPage(gen, { slug: "billing", sourcePath: "src/billing" });
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"], onDefaultBranch: true });
    await enqueuePage(gen, p1);
    await enqueuePage(gen, p2, { files: ["src/billing/x.ts"] });
    const outputs: AgentRunResult[] = [ok(UPDATED), { output: "usage limit reached", exitCode: 1 } as AgentRunResult];
    const { deps } = makeDeps({ select: fakeSelect(testDb.db, "legacy"), run: async () => outputs.shift()! });

    // Il ciclo dell'orchestratore: si ferma al primo limite e libera l'elemento.
    const seen: string[] = [];
    for (;;) {
      const item = await claimNext(testDb.db, repositoryId, "page_update");
      if (!item) break;
      seen.push(item.id);
      const out = await runPageUpdateItem(deps, repo(), WT, item);
      if (typeof out === "object" && "unavailable" in out) {
        await releaseItem(testDb.db, item.id);
        break;
      }
    }
    expect(seen).toHaveLength(2);
    const statuses = await Promise.all(seen.map(async (id) => (await itemById(id)).status));
    expect(statuses).toEqual(["done", "pending"]);
    expect((await itemById(seen[1]!)).failedNights).toBe(0);
    expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen))).toBe(false);
    expect(await generationSha(gen)).toBe(BOOKMARK);
    expect(await documentedAt(sha("1"))).toBeNull();
  });

  it("una pagina che fallisce (Review Focus #6): segnalibro fermo due notti, alla terza escalated, segnalibro avanzato e righe pendenti ancora lì", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"], onDefaultBranch: true });
    await enqueuePage(gen, page);
    const { deps } = makeDeps({ output: "boh" });
    for (const [night, expectedAdvance] of [
      [NIGHT1, false],
      [NIGHT2, false],
      [NIGHT3, true],
    ] as const) {
      const item = await claim();
      const out = await runPageUpdateItem(deps, repo(), WT, item);
      expect(out).toHaveProperty("failed");
      await failItem(testDb.db, item.id, (out as { failed: string }).failed, night);
      expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen))).toBe(expectedAdvance);
    }
    const [row] = await testDb.db.select().from(nightlyItems).where(eq(nightlyItems.phase, "page_update"));
    expect(row!.status).toBe("escalated");
    expect(await generationSha(gen)).toBe(HEAD);
    expect(await documentedAt(sha("1"))).not.toBeNull();
    // L'avviso resta sulla pagina: i suoi commit sono legati a lei (D31).
    expect(await pendingShas(page)).toEqual([sha("1")]);
  });

  it("aspetta un riassunto pending di un commit del piano", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await enqueueItems(testDb.db, [{ repositoryId, projectId, phase: "summary", key: sha("1") }], NIGHT3);
    const { deps } = makeDeps();
    expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen))).toBe(false);
    // Un riassunto pending di un commit FUORI dal piano non blocca.
    await testDb.db.delete(nightlyItems);
    await enqueueItems(testDb.db, [{ repositoryId, projectId, phase: "summary", key: sha("8") }], NIGHT3);
    expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen))).toBe(true);
  });

  it("guardato dalla generazione (D32): un piano di una generazione sostituita non scrive niente, il segnalibro nuovo non va all'indietro", async () => {
    const oldGen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"], onDefaultBranch: true });
    const NEWER = sha("e");
    const newGen = await seedCurrentGeneration(testDb.db, repositoryId, NEWER);
    const { deps } = makeDeps();
    expect(await advanceBookmarkIfDone(deps, repo(), { ...planOf(oldGen), toSha: HEAD })).toBe(false);
    expect(await generationSha(oldGen)).toBe(BOOKMARK);
    expect(await generationSha(newGen)).toBe(NEWER);
    expect(await documentedAt(sha("1"))).toBeNull();
  });

  it("completa i link «related» della nota della notte con le pagine aggiornate", async () => {
    const gen = await seedCurrentGeneration(testDb.db, repositoryId, BOOKMARK);
    const page = await seedPage(gen);
    await seedCommitSummary(testDb.db, repositoryId, sha("1"), { files: ["src/auth/login.ts"], onDefaultBranch: true });
    const [note] = await testDb.db
      .insert(docPages)
      .values({ repositoryId, generationId: null, kind: "releases", slug: "release-x", title: "Release", body: "x" })
      .returning({ id: docPages.id });
    await enqueueItems(
      testDb.db,
      [{ repositoryId, projectId, phase: "release", key: `${BOOKMARK}..${HEAD}`, payload: { toSha: HEAD, pageId: note!.id } }],
      NIGHT3,
    );
    await testDb.db.update(nightlyItems).set({ status: "done" }).where(eq(nightlyItems.phase, "release"));
    await enqueuePage(gen, page);
    const { deps } = makeDeps();
    expect(await runPageUpdateItem(deps, repo(), WT, await claim())).toBe("updated");
    expect(await advanceBookmarkIfDone(deps, repo(), planOf(gen))).toBe(true);
    const [row] = await testDb.db.select({ links: docPages.links }).from(docPages).where(eq(docPages.id, note!.id));
    expect(row!.links).toEqual([{ type: "related", slug: "auth", title: "Authentication" }]);
  });
});
