import { notifications, projects, repositories, type Db } from "@stubwise/db";
import { publishNotification } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";

/**
 * `pr.opened` (area 8, F2, S4): una PR aperta su un repository collegato,
 * dal webhook. UNA volta per PR: la card porta il link al pannello
 * (`?pr=<repositoryId>%23<n>`, univoco anche con più repository), e una
 * riconsegna o un `opened` ripetuto (anche contemporanei) che trovano già una
 * card di quella PR (repository e numero) non ne creano un'altra. Le PR di Stubwise (`stubwise/…`) le annuncia già
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
  // Una volta per PR anche con consegne contemporanee: il lock della PR, poi il
  // controllo e la scrittura nella stessa transazione. La chiave è la PR
  // (repository, numero), non il link: `PUBLIC_URL` può cambiare (review F2, 46).
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pr.opened:${input.repositoryId}#${input.prNumber}`}))`);
    const [already] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.kind, "pr.opened"),
          eq(notifications.projectId, repo.projectId),
          sql`${notifications.event}->>'repositoryId' = ${input.repositoryId}`,
          sql`${notifications.event}->>'prNumber' = ${String(input.prNumber)}`,
        ),
      )
      .limit(1);
    if (already) return;
    await publishNotification(
      tx,
      {
        kind: "pr.opened",
        projectId: repo.projectId,
        repositoryId: input.repositoryId,
        repositoryName: repo.name,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        title: input.title,
        url,
      },
      { projectId: repo.projectId },
    );
  });
}
