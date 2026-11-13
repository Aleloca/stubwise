import { prReleaseNotes, projects, releaseCodeSeqs, releases, repositories, type Db } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";

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
