import { gitAccounts, repositories, type Db } from "@stubwise/db";
import { inArray } from "drizzle-orm";
import { changedFields, recordChange, type ChangeInput } from "./change-log.js";

/**
 * Area 9, F5, Task 6: le voci di repository, ambienti e widget, con le forme
 * del prototipo (`projectSettings/repositories.ts`, `releases/writes.ts`,
 * `support/writes.ts`, i valori in `changelog/settingValues.ts`).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Actor = ChangeInput["actor"];
type RepositoryRow = typeof repositories.$inferSelect;

export const repositoryObject = (r: { id: string; name: string }) => ({ type: "repository", id: r.id, label: r.name });
export const environmentObject = (e: { id: string; name: string }) => ({ type: "environment", id: e.id, label: e.name });
export const widgetObject = (w: { id: string; name: string }) => ({ type: "widget", id: w.id, label: w.name });

const pipelineValue = (p: RepositoryRow["releasePipeline"]) => (p.mode === "named" ? `named:${p.names.join(",")}` : "auto");

/**
 * Le voci del PATCH di un repository. `repository.updated` una per campo
 * (`params.field`), come il prototipo: gli account col NOME (`null` = il
 * revisore predefinito). Il ramo di default è un campo del server che il
 * prototipo non modifica: entra con la sua chiave. Le PR dei colleghi e la
 * pipeline (col ramo di rilascio) hanno i loro tipi. Il CI provider non ha un
 * tipo nella 9c: niente voce.
 */
export async function recordRepositoryChanges(tx: Tx, actor: Actor, before: RepositoryRow, after: RepositoryRow): Promise<void> {
  const ids = [before.gitAccountId, after.gitAccountId, before.reviewGitAccountId, after.reviewGitAccountId].filter((id): id is string => id !== null);
  const names = new Map((await tx.select({ id: gitAccounts.id, name: gitAccounts.name }).from(gitAccounts).where(inArray(gitAccounts.id, ids))).map((a) => [a.id, a.name]));
  const nameOf = (id: string | null) => (id === null ? null : (names.get(id) ?? null));
  const values = (r: RepositoryRow) => ({
    name: r.name,
    url: r.repoUrl,
    defaultBranch: r.defaultBranch,
    gitAccount: nameOf(r.gitAccountId),
    reviewGitAccount: nameOf(r.reviewGitAccountId),
    installCommand: r.installCommand,
    testCommand: r.testCommand,
    graphEnabled: r.graphEnabled,
    protectedBranches: r.protectedBranches,
  });
  const b = values(before);
  const a = values(after);
  const object = repositoryObject(after);
  for (const field of Object.keys(a) as (keyof typeof a)[]) {
    const diff = changedFields({ [field]: b[field] }, { [field]: a[field] });
    if (diff) await recordChange(tx, { type: "repository.updated", actor, projectId: after.projectId, data: { object, ...diff, params: { field } } });
  }
  const pr = changedFields({ prMode: before.colleaguePrs }, { prMode: after.colleaguePrs });
  if (pr) await recordChange(tx, { type: "repository.pr_mode_changed", actor, projectId: after.projectId, data: { object, ...pr } });
  // Il ramo di rilascio assente vale quello di default (com'è letto dai rilasci).
  const release = changedFields(
    { pipeline: pipelineValue(before.releasePipeline), branch: before.releaseBranch ?? before.defaultBranch },
    { pipeline: pipelineValue(after.releasePipeline), branch: after.releaseBranch ?? after.defaultBranch },
  );
  if (release) await recordChange(tx, { type: "repository.release_pipeline_changed", actor, projectId: after.projectId, data: { object, ...release } });
}
