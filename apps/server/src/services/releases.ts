import { createTicket, prReleaseNotes, projects, releaseCiRuns, releaseCodeSeqs, releases, repositories, tickets, type Db } from "@stubwise/db";
import { productionForStatus, releaseProductionOf } from "@stubwise/notifications";
import { releaseStatusOf, sameCommit, type ReleaseDetail, type ReleasePipeline, type ReleaseRow, type ReleaseStatus } from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * IL RILASCIO NASCE DAL MERGE (area 8, F1, S3). Un rilascio = un merge di una
 * PR sul ramo di rilascio del repository (`release_branch`, null = il ramo di
 * default), da Stubwise o da fuori (S-3 = a *(M)*). Lo creano DUE strade che
 * possono arrivare in qualunque ordine:
 *
 * - il merge da Stubwise (`releasePullRequest`), che sa chi l'ha fatto
 *   (`merged_by`, `via_stubwise`);
 * - il webhook `merged` del provider (anche per il merge da Stubwise, che lo
 *   fa scattare), che sa il ramo di destinazione e il nome git di chi ha
 *   mergiato.
 *
 * Una funzione sola per entrambe, IDEMPOTENTE: una PR si mergia una volta sola
 * (`(repository_id, pr_number)` unico; senza numero, `(repository_id,
 * merge_sha)`), e sul conflitto non si duplica ma si UNISCONO i fatti —
 * `via_stubwise` vero se una delle due lo sa, la persona se nota, il nome git
 * se arriva. Il codice `<PRJ>-V<n>` si prende da `release_code_seqs` solo per
 * un rilascio nuovo (un numero consumato da una corsa persa non torna: come
 * le automazioni, un codice non si riusa). Le note della PR si fermano qui.
 */

export interface RecordReleaseInput {
  repositoryId: string;
  /** Il ramo su cui è stata mergiata la PR: se non è quello di rilascio, non è un rilascio. */
  targetBranch: string;
  prNumber: number | null;
  prUrl: string;
  title: string;
  mergeSha: string;
  mergedAt: Date;
  mergedBy: string | null;
  mergedGitName: string | null;
  viaStubwise: boolean;
}

export type RecordReleaseResult = { recorded: true; releaseId: string; code: string; created: boolean } | { recorded: false; reason: "not_release_branch" | "repository_gone" };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function nextSeq(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .insert(releaseCodeSeqs)
    .values({ projectId, next: 2 })
    .onConflictDoUpdate({ target: releaseCodeSeqs.projectId, set: { next: sql`${releaseCodeSeqs.next} + 1` } })
    .returning({ next: releaseCodeSeqs.next });
  return row!.next - 1;
}

export async function recordRelease(db: Db, input: RecordReleaseInput): Promise<RecordReleaseResult> {
  return db.transaction(async (tx) => {
    const [repo] = await tx
      .select({ projectId: repositories.projectId, defaultBranch: repositories.defaultBranch, releaseBranch: repositories.releaseBranch, projectCode: projects.code })
      .from(repositories)
      .innerJoin(projects, eq(projects.id, repositories.projectId))
      .where(eq(repositories.id, input.repositoryId));
    if (!repo) return { recorded: false, reason: "repository_gone" } as const;
    if (input.targetBranch !== (repo.releaseBranch ?? repo.defaultBranch)) return { recorded: false, reason: "not_release_branch" } as const;

    // Già c'è (l'altra strada è arrivata prima): si uniscono i fatti, non si duplica.
    const existing = await findExisting(tx, input);
    if (existing) {
      await mergeFacts(tx, existing.id, input);
      return { recorded: true, releaseId: existing.id, code: existing.code, created: false } as const;
    }

    const [notes] = input.prNumber !== null
      ? await tx.select({ body: prReleaseNotes.body }).from(prReleaseNotes).where(and(eq(prReleaseNotes.repositoryId, input.repositoryId), eq(prReleaseNotes.prNumber, input.prNumber)))
      : [];
    const seq = await nextSeq(tx, repo.projectId);
    const code = `${repo.projectCode}-V${seq}`;
    const [row] = await tx
      .insert(releases)
      .values({
        code,
        seq,
        projectId: repo.projectId,
        repositoryId: input.repositoryId,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        title: input.title,
        mergeSha: input.mergeSha,
        mergedAt: input.mergedAt,
        mergedBy: input.mergedBy,
        mergedGitName: input.mergedGitName,
        viaStubwise: input.viaStubwise,
        releaseNotes: notes?.body?.trim() ? notes.body : null,
      })
      .onConflictDoNothing()
      .returning({ id: releases.id });
    if (row) return { recorded: true, releaseId: row.id, code, created: true } as const;
    // Una corsa persa fra il controllo e l'insert: l'altra strada l'ha creato, si uniscono i fatti.
    const raced = await findExisting(tx, input);
    if (!raced) throw new Error("release conflict without a row");
    await mergeFacts(tx, raced.id, input);
    return { recorded: true, releaseId: raced.id, code: raced.code, created: false } as const;
  });
}

/** Unisce ai fatti del rilascio quelli che questa strada conosce (mai li toglie). */
async function mergeFacts(tx: Tx, releaseId: string, input: RecordReleaseInput): Promise<void> {
  await tx
    .update(releases)
    .set({
      viaStubwise: sql`${releases.viaStubwise} OR ${input.viaStubwise}`,
      ...(input.mergedBy ? { mergedBy: sql`coalesce(${releases.mergedBy}, ${input.mergedBy}::uuid)` } : {}),
      ...(input.mergedGitName ? { mergedGitName: sql`coalesce(${releases.mergedGitName}, ${input.mergedGitName})` } : {}),
    })
    .where(eq(releases.id, releaseId));
}

async function findExisting(tx: Tx, input: RecordReleaseInput): Promise<{ id: string; code: string } | null> {
  const where =
    input.prNumber !== null
      ? and(eq(releases.repositoryId, input.repositoryId), eq(releases.prNumber, input.prNumber))
      : and(eq(releases.repositoryId, input.repositoryId), eq(releases.mergeSha, input.mergeSha));
  const [row] = await tx.select({ id: releases.id, code: releases.code }).from(releases).where(where).for("update");
  return row ?? null;
}

// --- le letture (S5) ---------------------------------------------------------------------

/**
 * LE LETTURE DEI RILASCI (area 8, F1, S5). Nascosto = inesistente: un
 * rilascio di un progetto che chi guarda non vede risponde come uno che non
 * esiste (404). Lo stato si DERIVA a ogni lettura (`releaseStatusOf`) dalle
 * run salvate e dalla produzione (`releaseProductionOf`, la stessa lettura del
 * worker), mai da una colonna.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type ReleaseRecord = typeof releases.$inferSelect;

export class ReleaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const notFound = () => new ReleaseError(404, "not_found", "Not found");

async function sees(db: Db, viewer: Viewer, projectId: string): Promise<boolean> {
  return (await projectPermissionsFor(db, viewer, projectId)) !== null;
}

/** Lo stato derivato di un rilascio, dalle righe e dalla produzione di adesso. */
async function statusOf(db: Db, release: ReleaseRecord, repo: { ciProvider: string | null; releasePipeline: unknown }, runs: (typeof releaseCiRuns.$inferSelect)[], now: Date): Promise<ReleaseStatus> {
  const production = await releaseProductionOf(db, release.projectId, release.repositoryId);
  const seen = release.seenInProductionAt ?? (production.services.some((s) => sameCommit(s.commitSha, release.mergeSha)) ? now : null);
  return releaseStatusOf({
    runs: repo.ciProvider === null ? [] : runs.map((r) => ({ name: r.name, status: r.status, startedAt: (r.startedAt ?? r.updatedAt).toISOString(), endedAt: r.endedAt?.toISOString() ?? null })),
    mergedAt: release.mergedAt.toISOString(),
    mergeSha: release.mergeSha,
    seenInProductionAt: seen?.toISOString() ?? null,
    now: now.toISOString(),
    pipeline: repo.ciProvider === null ? null : (repo.releasePipeline as ReleasePipeline),
    production: productionForStatus(production),
  });
}

async function rowOf(db: Db, viewer: Viewer, release: ReleaseRecord, now: Date): Promise<{ row: ReleaseRow; runs: (typeof releaseCiRuns.$inferSelect)[] }> {
  const [repo] = await db.select({ name: repositories.name, ciProvider: repositories.ciProvider, releasePipeline: repositories.releasePipeline }).from(repositories).where(eq(repositories.id, release.repositoryId));
  const runs = await db.select().from(releaseCiRuns).where(eq(releaseCiRuns.releaseId, release.id)).orderBy(releaseCiRuns.name);
  const status = await statusOf(db, release, repo ?? { ciProvider: null, releasePipeline: null }, runs, now);
  let fixTask: ReleaseRow["fixTask"] = null;
  if (release.fixTicketId) {
    const [tk] = await db.select({ id: tickets.id, number: tickets.number, projectId: tickets.projectId, code: projects.code }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, release.fixTicketId));
    if (tk && (await sees(db, viewer, tk.projectId))) fixTask = { id: tk.id, code: `${tk.code}-${tk.number}` };
  }
  return {
    runs,
    row: {
      id: release.id,
      code: release.code,
      projectId: release.projectId,
      repositoryId: release.repositoryId,
      repositoryName: repo?.name ?? "",
      prNumber: release.prNumber,
      prUrl: release.prUrl,
      title: release.title,
      mergeSha: release.mergeSha,
      mergedAt: release.mergedAt.toISOString(),
      mergedById: release.mergedBy,
      mergedGitName: release.mergedGitName,
      viaStubwise: release.viaStubwise,
      status,
      fixTask,
    },
  };
}

/** I rilasci di un progetto, dal più recente; 404 se chi guarda non lo vede. */
export async function listProjectReleases(db: Db, viewer: Viewer, projectId: string, now = new Date()): Promise<ReleaseRow[]> {
  if (!(await sees(db, viewer, projectId))) throw notFound();
  const records = await db.select().from(releases).where(eq(releases.projectId, projectId)).orderBy(desc(releases.mergedAt)).limit(100);
  const out: ReleaseRow[] = [];
  for (const r of records) out.push((await rowOf(db, viewer, r, now)).row);
  return out;
}

async function visibleRelease(db: Db, viewer: Viewer, code: string): Promise<ReleaseRecord> {
  const [r] = await db.select().from(releases).where(eq(releases.code, code.toUpperCase()));
  if (!r || !(await sees(db, viewer, r.projectId))) throw notFound();
  return r;
}

/** Un rilascio intero, per codice; 404 se non c'è o chi guarda non ne vede il progetto. */
export async function getRelease(db: Db, viewer: Viewer, code: string, now = new Date()): Promise<ReleaseDetail> {
  const r = await visibleRelease(db, viewer, code);
  const { row, runs } = await rowOf(db, viewer, r, now);
  const perms = await projectPermissionsFor(db, viewer, r.projectId);
  return {
    ...row,
    runs: runs.map((x) => ({ id: x.id, name: x.name, status: x.status, url: x.url, failedStep: x.failedStep, startedAt: x.startedAt?.toISOString() ?? null, endedAt: x.endedAt?.toISOString() ?? null })),
    releaseNotes: r.releaseNotes,
    seenInProductionAt: r.seenInProductionAt?.toISOString() ?? null,
    permissions: { fix: row.status.kind === "failed" && r.fixTicketId === null && perms?.has("tickets.create") === true },
  };
}

/**
 * «Fai sistemare a Claude» ([R 16]): una task `bug` NORMALE col rilascio
 * collegato e il passo fallito nella descrizione — da lì parte il lavoro di
 * sempre (piano, approvazione). Solo per un rilascio fallito, con
 * `tickets.create` nel progetto, e una sola per rilascio (sotto il lock del
 * rilascio: due click non fanno due task). Nessuna pipeline rilanciata.
 */
export async function fixRelease(db: Db, viewer: Viewer, code: string, now = new Date()): Promise<{ taskId: string; taskCode: string }> {
  const r0 = await visibleRelease(db, viewer, code);
  const perms = await projectPermissionsFor(db, viewer, r0.projectId);
  if (!perms?.has("tickets.create")) throw new ReleaseError(403, "forbidden", "You need tickets.create in this project");
  const { row, runs } = await rowOf(db, viewer, r0, now);
  if (row.status.kind !== "failed") throw new ReleaseError(409, "not_failed", "Only a failed release can be fixed");
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(releases).where(eq(releases.id, r0.id)).for("update");
    if (r!.fixTicketId) throw new ReleaseError(409, "already_fixing", "A fix task already exists for this release");
    const failed = runs.filter((x) => x.status === "failed");
    const lines = [
      `${r!.code}: ${r!.title}`,
      `PR: ${r!.prUrl}`,
      `Merge: ${r!.mergeSha}`,
      ...failed.map((x) => `- ${x.name}${x.failedStep ? `: ${x.failedStep}` : ""}${x.url ? ` (${x.url})` : ""}`),
    ];
    const ticket = await createTicket(tx, {
      projectId: r!.projectId,
      title: `Fix ${r!.code}: ${r!.title}`.slice(0, 250),
      body: lines.join("\n"),
      type: "bug",
      priority: "high",
      source: "manual",
      requestedByUserId: viewer.id,
    });
    await tx.update(releases).set({ fixTicketId: ticket.id }).where(eq(releases.id, r!.id));
    const [p] = await tx.select({ code: projects.code }).from(projects).where(eq(projects.id, r!.projectId));
    return { taskId: ticket.id, taskCode: `${p?.code ?? ""}-${ticket.number}` };
  });
}
