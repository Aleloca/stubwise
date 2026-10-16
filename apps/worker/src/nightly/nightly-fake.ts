import { commitSummaries, docGenerations, docPages, repositories, type Db } from "@stubwise/db";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { eq } from "drizzle-orm";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import type { SelectDeps } from "../providers/select.js";
import type { NightlyConfig, NightlyDeps, NightlyRepo } from "./types.js";

/**
 * Fixture dei test del giro notturno (come `providers/select-fake.ts`): deps
 * con runner e mirror finti, e i seed di generazione, pagine e riassunti.
 */

export const FAKE_NIGHTLY_CONFIG: NightlyConfig = {
  start: "02:00",
  alertRuns: 50,
  summaryWindowDays: 30,
  diffMaxChars: 20_000,
  commitSummaryModel: "haiku",
  releaseNotesModel: "sonnet-notes",
  docsNightlyModel: "sonnet",
  docAgentTimeoutMs: 60_000,
  docModuleMaxTurns: 10,
};

export function fakeNightlyDeps(
  db: Db,
  o: {
    runner: Partial<AgentRunner>;
    mirrors: Partial<MirrorManager>;
    select: SelectDeps;
    config?: Partial<NightlyConfig>;
    publish?: NightlyDeps["publish"];
    log?: (m: string) => void;
    now?: () => Date;
  },
): NightlyDeps {
  return {
    db,
    mirrors: o.mirrors as MirrorManager,
    runner: o.runner as AgentRunner,
    serializer: { run: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as ProjectSerializer,
    select: o.select,
    embeddingClient: {} as EmbeddingClient,
    ...(o.publish ? { publish: o.publish } : {}),
    publicUrl: "https://stubwise.test",
    config: { ...FAKE_NIGHTLY_CONFIG, ...o.config },
    log: o.log ?? (() => undefined),
    ...(o.now ? { now: o.now } : {}),
  };
}

export function fakeNightlyRepo(repositoryId: string, projectId: string, generationId: string | null): NightlyRepo {
  return {
    repositoryId,
    repositoryName: "repo",
    projectId,
    projectName: "Progetto",
    project: { repoUrl: "https://example.test/x.git", defaultBranch: "main" } as unknown as MirrorProject,
    dailyReport: false,
    docsNightly: true,
    currentGenerationId: generationId,
  };
}

/** Una generazione `succeeded` col suo `commit_sha`, resa la corrente del repository. */
export async function seedCurrentGeneration(db: Db, repositoryId: string, commitSha: string | null): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "succeeded", commitSha })
    .returning({ id: docGenerations.id });
  await db.update(repositories).set({ currentDocGenerationId: gen!.id }).where(eq(repositories.id, repositoryId));
  return gen!.id;
}

export async function seedGenerationPage(
  db: Db,
  repositoryId: string,
  generationId: string,
  p: { slug: string; title?: string; sourcePath?: string | null; parentId?: string | null },
): Promise<string> {
  const [page] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId,
      kind: "technical",
      slug: p.slug,
      title: p.title ?? p.slug,
      sourcePath: p.sourcePath ?? null,
      parentId: p.parentId ?? null,
    })
    .returning({ id: docPages.id });
  return page!.id;
}

export async function seedCommitSummary(
  db: Db,
  repositoryId: string,
  sha: string,
  o: { files?: string[]; subject?: string; summary?: string; noise?: boolean; committedAt?: Date; onDefaultBranch?: boolean } = {},
): Promise<void> {
  await db.insert(commitSummaries).values({
    repositoryId,
    sha,
    committedAt: o.committedAt ?? new Date("2026-10-14T10:00:00Z"),
    authorName: "Dev",
    authorEmail: "dev@x.it",
    subject: o.subject ?? `commit ${sha.slice(0, 7)}`,
    summary: o.summary ?? `riassunto di ${sha.slice(0, 7)}`,
    files: o.files ?? [],
    noise: o.noise ?? false,
    onDefaultBranch: o.onDefaultBranch ?? false,
  });
}

/** Uno sha valido e leggibile nei test: `sha("a")` → 40 «a». */
export function sha(c: string): string {
  return c.repeat(40).slice(0, 40);
}
