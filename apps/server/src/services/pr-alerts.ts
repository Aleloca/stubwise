import { notifications, projects, repositories, type Db } from "@stubwise/db";
import { publishNotification } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";

/**
 * `pr.opened` (area 8, F2, S4): una PR aperta su un repository collegato,
 * dal webhook. UNA volta per PR: la card porta il link al pannello
 * (`?pr=<repositoryId>%23<n>`, univoco anche con più repository), e una
 * riconsegna o un `opened` ripetuto che trovano già una card con quel link non
 * ne creano un'altra. Le PR di Stubwise (`stubwise/…`) le annuncia già
 * `job.pr_opened`. Una riapertura non è un'apertura. Best-effort: non lancia.
 */
export async function publishPrOpened(
  db: Db,
  publicUrl: string | null | undefined,
  input: { repositoryId: string; prNumber: number; prUrl: string; title: string; sourceBranch: string; reopened?: boolean },
): Promise<void> {
  if (input.reopened === true || input.sourceBranch.startsWith("stubwise/")) return;
  const [repo] = await db
    .select({ projectId: repositories.projectId, name: repositories.name, projectCode: projects.code })
    .from(repositories)
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(repositories.id, input.repositoryId));
  if (!repo) return;
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  const url = `${base}/app/#/p/${repo.projectCode}/releases?pr=${input.repositoryId}%23${input.prNumber}`;
  const [already] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.kind, "pr.opened"), eq(notifications.projectId, repo.projectId), sql`${notifications.event}->>'url' = ${url}`))
    .limit(1);
  if (already) return;
  await publishNotification(
    db,
    { kind: "pr.opened", projectId: repo.projectId, repositoryName: repo.name, prNumber: input.prNumber, prUrl: input.prUrl, title: input.title, url },
    { projectId: repo.projectId },
  );
}
