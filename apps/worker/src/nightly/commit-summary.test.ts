import { commitSummaries } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions, AgentRunner, AgentRunResult } from "../agent/runner.js";
import type { CommitWithFiles, MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { fakeSelect } from "../providers/select-fake.js";
import type { SelectDeps } from "../providers/select.js";
import {
  buildCommitSummaryPrompt,
  DIFF_CUT_MARKER,
  noiseSummary,
  parseCommitSummary,
  summarizeCommit,
} from "./commit-summary.js";
import type { CommitSummaryDeps } from "./types.js";

let testDb: TestDb;
let repositoryId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ repositoryId, projectId } = await seedRepository(testDb.db));
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(commitSummaries);
});

afterAll(async () => {
  await testDb.stop();
});

const SHA = "a".repeat(40);
const PROVIDER = { id: "p1", kind: "account" } as unknown as ResolvedProvider;
const project = { repoUrl: "https://example.test/x.git" } as unknown as MirrorProject;

function commit(over: Partial<CommitWithFiles> = {}): CommitWithFiles {
  return {
    sha: SHA,
    authorName: "Dev",
    authorEmail: "dev@x.it",
    date: "2026-10-14T10:00:00Z",
    subject: "feat: nuova cosa",
    isMerge: false,
    additions: 12,
    deletions: 3,
    files: [
      { path: "src/app.ts", additions: 10, deletions: 2 },
      { path: "pnpm-lock.yaml", additions: 2, deletions: 1 },
    ],
    ...over,
  };
}

const GOOD_OUTPUT = [
  "Here you go.",
  "===SUMMARY===",
  "Aggiunge la cosa nuova. Chi sviluppa trova un modulo in più.",
  "===END SUMMARY===",
  "===AREAS===",
  "src/app.ts",
  "===END AREAS===",
].join("\n");

function makeDeps(
  o: {
    run?: (opts: AgentRunOptions) => Promise<AgentRunResult>;
    select?: SelectDeps;
    diff?: { diff: string; truncated: boolean };
    diffMaxChars?: number;
  } = {},
) {
  const run = vi.fn(o.run ?? (async () => ({ output: GOOD_OUTPUT, exitCode: 0, usage: { totalCostUsd: 0.0123 } }) as AgentRunResult));
  const getCommitDiff = vi.fn(async () => o.diff ?? { diff: "diff --git a/src/app.ts b/src/app.ts\n+x", truncated: false });
  const deps: CommitSummaryDeps = {
    db: testDb.db,
    mirrors: { getCommitDiff } as unknown as MirrorManager,
    runner: { run } as unknown as AgentRunner,
    select: o.select ?? fakeSelect(testDb.db, [PROVIDER]),
    model: "haiku",
    diffMaxChars: o.diffMaxChars ?? 20_000,
    log: () => undefined,
  };
  return { deps, run, getCommitDiff };
}

async function rows() {
  return testDb.db.select().from(commitSummaries).where(eq(commitSummaries.repositoryId, repositoryId));
}

const repo = () => ({ repositoryId, projectId, project });

describe("buildCommitSummaryPrompt", () => {
  it("contiene subject, numstat completo, diff e i marcatori del contratto", () => {
    const prompt = buildCommitSummaryPrompt({
      subject: "feat: nuova cosa",
      files: commit().files,
      diff: "+riga del diff",
      diffTruncated: false,
    });
    expect(prompt).toContain("feat: nuova cosa");
    expect(prompt).toContain("+10 -2 src/app.ts");
    expect(prompt).toContain("+2 -1 pnpm-lock.yaml");
    expect(prompt).toContain("+riga del diff");
    expect(prompt).toContain("===SUMMARY===");
    expect(prompt).toContain("===END AREAS===");
    expect(prompt).not.toContain(DIFF_CUT_MARKER);
  });

  it("dice del taglio quando il diff è tagliato", () => {
    const prompt = buildCommitSummaryPrompt({ subject: "s", files: [], diff: "x", diffTruncated: true });
    expect(prompt).toContain(DIFF_CUT_MARKER);
  });
});

describe("parseCommitSummary", () => {
  it("estrae riassunto e aree, tollerando spazi intorno ai marcatori", () => {
    const out = parseCommitSummary(
      ["  ===SUMMARY===  ", "Testo.", " ===END SUMMARY===", "===AREAS===", " - apps/web ", "", "packages/db", "===END AREAS==="].join("\n"),
    );
    expect(out).toEqual({ summary: "Testo.", areas: ["apps/web", "packages/db"] });
  });

  it("senza marcatori → null", () => {
    expect(parseCommitSummary("Solo testo libero.")).toBeNull();
    expect(parseCommitSummary("===SUMMARY===\n\n===END SUMMARY===\n===AREAS===\na\n===END AREAS===")).toBeNull();
  });

  it("aree oltre 10 troncate, aree assenti → elenco vuoto", () => {
    const areas = Array.from({ length: 14 }, (_, i) => `area${i}`);
    const out = parseCommitSummary(`===SUMMARY===\nX.\n===END SUMMARY===\n===AREAS===\n${areas.join("\n")}\n===END AREAS===`);
    expect(out?.areas).toEqual(areas.slice(0, 10));
    expect(parseCommitSummary("===SUMMARY===\nX.\n===END SUMMARY===")).toEqual({ summary: "X.", areas: [] });
  });
});

describe("noiseSummary", () => {
  it("una riga per categoria presente, al più 5 file, poi «e altri N»", () => {
    const docs = Array.from({ length: 7 }, (_, i) => `docs/p${i}.md`);
    const out = noiseSummary([...docs, "pnpm-lock.yaml", "packages/db/dist/index.js", ".github/workflows/ci.yml"]);
    const lines = out.summary.split("\n");
    expect(lines).toEqual([
      "Documentazione e piani: docs/p0.md, docs/p1.md, docs/p2.md, docs/p3.md, docs/p4.md e altri 2",
      "Lockfile: pnpm-lock.yaml",
      "Codice generato o vendorizzato: packages/db/dist/index.js",
      "Configurazione CI: .github/workflows/ci.yml",
    ]);
    expect(out.areas).toEqual(["docs", "packages", ".github"]);
  });

  it("solo le categorie presenti", () => {
    expect(noiseSummary(["plans/x.md"]).summary).toBe("Documentazione e piani: plans/x.md");
  });
});

describe("summarizeCommit", () => {
  it("riassume col modello e salva testo, aree, tutti i file, modello e costo", async () => {
    const { deps, run, getCommitDiff } = makeDeps();
    const out = await summarizeCommit(deps, repo(), commit());
    expect(out).toEqual({ status: "done" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].model).toBe("haiku");
    expect(run.mock.calls[0]![0].provider).toBe(PROVIDER);
    expect(getCommitDiff).toHaveBeenCalledWith(project, SHA, { skipFetch: true });
    const [row] = await rows();
    expect(row).toMatchObject({
      sha: SHA,
      subject: "feat: nuova cosa",
      authorName: "Dev",
      authorEmail: "dev@x.it",
      summary: "Aggiunge la cosa nuova. Chi sviluppa trova un modulo in più.",
      areas: ["src/app.ts"],
      files: ["src/app.ts", "pnpm-lock.yaml"],
      noise: false,
      model: "haiku",
      costUsd: "0.0123",
    });
    expect(row!.committedAt.toISOString()).toBe("2026-10-14T10:00:00.000Z");
  });

  it("commit gigante: diff tagliato a diffMaxChars col marcatore, numstat completo", async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, additions: i, deletions: 0 }));
    const { deps, run } = makeDeps({ diff: { diff: "x".repeat(5000), truncated: false }, diffMaxChars: 100 });
    await summarizeCommit(deps, repo(), commit({ files }));
    const prompt = run.mock.calls[0]![0].prompt;
    expect(prompt).toContain(DIFF_CUT_MARKER);
    expect(prompt).not.toContain("x".repeat(101));
    expect(prompt).toContain("+29 -0 src/f29.ts");
  });

  it("commit di solo rumore → nessun run, noise = true, testo per categoria", async () => {
    const { deps, run, getCommitDiff } = makeDeps();
    const out = await summarizeCommit(
      deps,
      repo(),
      commit({ files: [{ path: "plans/a.md", additions: 3, deletions: 0 }, { path: "pnpm-lock.yaml", additions: 1, deletions: 1 }] }),
    );
    expect(out).toEqual({ status: "done" });
    expect(run).not.toHaveBeenCalled();
    expect(getCommitDiff).not.toHaveBeenCalled();
    const [row] = await rows();
    expect(row).toMatchObject({
      noise: true,
      summary: "Documentazione e piani: plans/a.md\nLockfile: pnpm-lock.yaml",
      areas: ["plans"],
      files: ["plans/a.md", "pnpm-lock.yaml"],
      model: null,
      costUsd: null,
    });
  });

  it("limite su tutti i candidati → unavailable col motivo, nessuna riga", async () => {
    const { deps } = makeDeps({
      run: async () => ({ output: "You've hit your session limit · resets 3am", exitCode: 1 }),
    });
    expect(await summarizeCommit(deps, repo(), commit())).toEqual({ status: "unavailable", reason: "all_limited_now" });
    expect(await rows()).toHaveLength(0);
  });

  it("nessun account per quota → unavailable col motivo della scelta, nessun run", async () => {
    const { deps, run } = makeDeps({ select: fakeSelect(testDb.db, { emptyReason: "all_over_threshold" }) });
    expect(await summarizeCommit(deps, repo(), commit())).toEqual({ status: "unavailable", reason: "all_over_threshold" });
    expect(run).not.toHaveBeenCalled();
  });

  it("auth del container al limite (legacy_limited) → attesa di quota, mai un fallimento (R1)", async () => {
    const { deps } = makeDeps({
      select: fakeSelect(testDb.db, "legacy", { legacyLimit: { until: null } }),
      run: async () => ({ output: "usage limit reached", exitCode: 1 }),
    });
    expect(await summarizeCommit(deps, repo(), commit())).toEqual({ status: "unavailable", reason: "all_limited_now" });
  });

  it("auth del container senza provider: il run parte (R2)", async () => {
    const { deps, run } = makeDeps({ select: fakeSelect(testDb.db, "legacy") });
    expect(await summarizeCommit(deps, repo(), commit())).toEqual({ status: "done" });
    expect(run.mock.calls[0]![0].provider).toBeUndefined();
  });

  it("output non valido → failed, nessuna riga", async () => {
    const { deps } = makeDeps({ run: async () => ({ output: "testo libero senza marcatori", exitCode: 0 }) });
    const out = await summarizeCommit(deps, repo(), commit());
    expect(out.status).toBe("failed");
    expect(await rows()).toHaveLength(0);
  });

  it("errore del run (non un limite) → failed", async () => {
    const { deps } = makeDeps({
      run: async () => {
        throw new Error("spawn fallito");
      },
    });
    const out = await summarizeCommit(deps, repo(), commit());
    expect(out).toEqual({ status: "failed", error: expect.stringContaining("spawn fallito") });
  });

  it("un riassunto non si rifà: secondo summarizeCommit sullo stesso sha → nessun run", async () => {
    const { deps, run } = makeDeps();
    await summarizeCommit(deps, repo(), commit());
    expect(await summarizeCommit(deps, repo(), commit({ subject: "altro" }))).toEqual({ status: "done" });
    expect(run).toHaveBeenCalledTimes(1);
    const [row] = await rows();
    expect(row!.subject).toBe("feat: nuova cosa");
  });
});
