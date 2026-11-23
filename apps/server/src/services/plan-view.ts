import { aiJobs, planDigest, projectDecisions, tickets, type Db } from "@stubwise/db";
import type { TaskWorkView } from "@stubwise/shared";
import { and, eq, like, sql } from "drizzle-orm";

/**
 * Il piano di un job e il suo stato (rimandi, lotto 4, §7.2): UNA regola per
 * `/work` (`task-work.ts`) e per il dettaglio della sessione
 * (`agent-sessions.ts`). Un modulo a sé, con le sole letture: il dettaglio
 * della sessione è raggiungibile dal catalogo delle azioni di Claude, che non
 * deve arrivare a moduli che fanno uscire effetti (`claude-actions-effects.test.ts`).
 */
type PlanStatus = NonNullable<TaskWorkView["runs"][number]["plan"]>["status"];

/**
 * Lo stato del piano di un job (la regola di `/work`, rimandi lotto 4 §7.2:
 * la usa anche il dettaglio della sessione, così le due letture non
 * divergono). SOLO da un esito verificabile: in attesa sul gate → `pending`;
 * una decisione approvata per quel job nel registro, o un job che ha ESEGUITO
 * → `approved`; il digest della pre-approvazione uguale a quello del piano →
 * `pre_approved`; altrimenti `undecided`.
 */
export function planStatusOf(j: { id: string; status: string; planText: string | null }, approvedJobs: ReadonlySet<string>, planApprovedDigest: string | null): PlanStatus {
  if (j.status === "awaiting_plan_approval") return "pending";
  if (approvedJobs.has(j.id)) return "approved";
  if (j.status === "fixing" || j.status === "pr_opened" || j.status === "pr_merged" || j.status === "pr_closed") return "approved";
  if (j.planText && planApprovedDigest && planApprovedDigest === planDigest(j.planText)) return "pre_approved";
  return "undecided";
}

/**
 * Il piano di UN job, come `/work` lo mette sul suo run (rimandi lotto 4,
 * §7.2: il dettaglio della sessione). null senza `plan_text` (anche dopo un
 * rifiuto, che lo azzera).
 */
export async function jobPlanView(db: Db, jobId: string): Promise<{ jobId: string; text: string; summary: string; status: PlanStatus; at: string; digest: string } | null> {
  const [job] = await db
    .select({ id: aiJobs.id, status: aiJobs.status, planText: aiJobs.planText, planSummary: aiJobs.planSummary, startedAt: aiJobs.startedAt, createdAt: aiJobs.createdAt, ticketId: aiJobs.ticketId })
    .from(aiJobs)
    .where(eq(aiJobs.id, jobId));
  if (!job?.planText) return null;
  const [ticket] = await db.select({ planApprovedDigest: tickets.planApprovedDigest }).from(tickets).where(eq(tickets.id, job.ticketId));
  const approved = await db
    .select({ id: projectDecisions.id })
    .from(projectDecisions)
    .where(
      and(
        eq(projectDecisions.ticketId, job.ticketId),
        eq(projectDecisions.source, "plan_review"),
        like(projectDecisions.sourceKey, "plan_review:%"),
        sql`${projectDecisions.sourceRef}->>'jobId' = ${job.id}`,
        sql`${projectDecisions.sourceRef}->>'mode' = 'execute'`,
      ),
    )
    .limit(1);
  return {
    jobId: job.id,
    text: job.planText,
    summary: job.planSummary ?? "",
    status: planStatusOf(job, new Set(approved.length > 0 ? [job.id] : []), ticket?.planApprovedDigest ?? null),
    at: (job.startedAt ?? job.createdAt).toISOString(),
    digest: planDigest(job.planText),
  };
}
