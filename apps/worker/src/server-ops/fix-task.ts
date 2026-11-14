import { eq, sql } from "drizzle-orm";
import { aiJobs, projects, serverAnalyses, serverFixes, servers, tickets, type Db } from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { publishNotification, type NotificationEvent } from "@stubwise/notifications";
import { validateServerPlan, type AttributionInput, type ServerDiagnosisReport } from "@stubwise/shared";

/**
 * La TASK di un'analisi attribuita (area 8, F4b, S6;
 * docs/invariants/server-operations.md).
 * - Nasce NEL PROGETTO ATTRIBUITO, `bug` di sorgente `server`, e passa dal
 *   triage/auto-fix come ogni bug (F4b-6 = b): un `ai_jobs` come l'ingest.
 * - Titolo e testo d'apertura sono TEMPLATE; la diagnosi del modello entra
 *   come contenuto delimitato (un blocco recintato), mai fra le istruzioni.
 *   Il prompt del fix la mette comunque dentro `<ticket_content>` (non fidato).
 * - Il piano proposto si VALIDA (`validateServerPlan`): valido e con le
 *   operazioni dell'agente accese → `server_fixes` in attesa d'approvazione;
 *   altrimenti la correzione resta senza piano e il testo dice perché. Il piano
 *   sta in `server_fixes`, MAI nel piano del ticket (F4b-7).
 * - `server.diagnosis_ready` agli iscritti del progetto, best-effort.
 */

export interface ServerTaskInput {
  analysisId: string;
  serverId: string;
  projectId: string;
  manual: boolean;
  report: ServerDiagnosisReport;
  context: Omit<AttributionInput, "cause">;
  language: Language;
  publicUrl: string;
  severity: "trouble" | "down" | null;
}

const FENCE = "~~~";
/** Un blocco recintato che il contenuto non può chiudere. */
const fenced = (text: string) => `${FENCE}text\n${text.replaceAll(FENCE, "~ ~ ~")}\n${FENCE}`;

export async function openServerTask(
  db: Db,
  input: ServerTaskInput,
  publish: typeof publishNotification = publishNotification,
  log: (m: string) => void = console.warn,
): Promise<{ ticketId: string; taskCode: string } | null> {
  const [server] = await db.select().from(servers).where(eq(servers.id, input.serverId));
  if (!server) return null;
  const code = `SRV-${server.number}`;
  const lang = input.language;

  // Un `fix` senza passi è «nessun piano», non un piano non valido (golden F4b).
  const validation = input.report.fix && input.report.fix.steps.length > 0
    ? validateServerPlan({ plan: input.report.fix, projectId: input.projectId, serverProjects: input.context.serverProjects, seenContainers: input.context.seenContainers })
    : null;
  const operationsOn = server.agentCapabilities.operations === true;
  const planNote =
    validation === null
      ? null
      : !validation.ok
        ? t(lang, "server.taskPlanInvalid", { reason: validation.reason })
        : !operationsOn
          ? t(lang, "server.taskPlanOperationsOff")
          : t(lang, "server.taskPlanProposed", { count: validation.plan.steps.length });

  const title = t(lang, input.manual ? "server.taskTitleManual" : "server.taskTitle", { code, name: server.name });
  const body = [
    t(lang, "server.taskBody", { code, name: server.name }),
    `**${t(lang, "server.taskDiagnosis")}**`,
    fenced(input.report.summary),
    ...(input.report.cause.why ? [`**${t(lang, "server.taskWhy")}**`, fenced(input.report.cause.why)] : []),
    ...(planNote ? [planNote] : []),
  ].join("\n\n");

  const created = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(projects)
      .set({ nextTicketNumber: sql`${projects.nextTicketNumber} + 1` })
      .where(eq(projects.id, input.projectId))
      .returning({ next: projects.nextTicketNumber, code: projects.code });
    if (!claimed) return null;
    const [ticket] = await tx
      .insert(tickets)
      .values({
        projectId: input.projectId,
        number: claimed.next - 1,
        title,
        body,
        type: "bug",
        priority: input.severity === "down" ? "high" : "medium",
        source: "server",
      })
      .returning({ id: tickets.id, number: tickets.number });
    // F4b-6 = b: il triage/auto-fix come ogni bug (apre al più una PR, non la mergia).
    await tx.insert(aiJobs).values({ ticketId: ticket!.id });
    const plan = validation?.ok && operationsOn ? validation.plan.steps : null;
    await tx.insert(serverFixes).values({
      taskId: ticket!.id,
      serverId: input.serverId,
      projectId: input.projectId,
      analysisId: input.analysisId,
      status: plan ? "awaiting_approval" : "none",
      steps: plan ?? [],
      planError: validation === null ? null : !validation.ok ? validation.reason : !operationsOn ? "operations_off" : null,
    });
    await tx.update(serverAnalyses).set({ taskId: ticket!.id }).where(eq(serverAnalyses.id, input.analysisId));
    return { ticketId: ticket!.id, taskCode: `${claimed.code}-${ticket!.number}`, projectCode: claimed.code };
  });
  if (!created) return null;

  const event: NotificationEvent = {
    kind: "server.diagnosis_ready",
    projectId: input.projectId,
    serverName: server.name,
    serverId: server.id,
    taskCode: created.taskCode,
    title,
    url: `${input.publicUrl.replace(/\/+$/, "")}/app/#/p/${created.projectCode}/tasks/${created.taskCode}`,
  };
  try {
    await publish(db, event, { projectId: input.projectId, ticketId: created.ticketId });
  } catch (error) {
    log(`[server-ops] avviso della diagnosi ${input.analysisId} non pubblicato: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ticketId: created.ticketId, taskCode: created.taskCode };
}
