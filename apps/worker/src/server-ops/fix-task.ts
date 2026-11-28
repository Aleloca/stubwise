import { appUrl } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { aiJobs, environmentServers, projectEnvironments, projects, serverAnalyses, serverFixes, servers, tickets, type Db } from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { attributionContext, publishNotification, userIdsWithPermission, type NotificationEvent } from "@stubwise/notifications";
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
  /**
   * Chi ha chiesto l'analisi a mano (decisione del maintainer, 15 nov 2026):
   * riceve la diagnosi da OBBLIGATORIO (`analysis_requester`) se vede il
   * progetto attribuito; una card sola anche se è già iscritto.
   */
  requesterId?: string | null;
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
    // `?task=` e non `/tasks/<codice>`, che il router della nuova app non conosce.
    url: appUrl(input.publicUrl, { to: "task", projectCode: created.projectCode, taskCode: created.taskCode }),
  };
  try {
    await publish(db, event, {
      projectId: input.projectId,
      ticketId: created.ticketId,
      ...(input.requesterId ? { mandatory: [{ userId: input.requesterId, reason: "analysis_requester" as const }] } : {}),
    });
  } catch (error) {
    log(`[server-ops] avviso della diagnosi ${input.analysisId} non pubblicato: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ticketId: created.ticketId, taskCode: created.taskCode };
}

/**
 * L'esito di un'analisi A MANO per chi l'ha chiesta, quando non arriva già
 * con la diagnosi del progetto attribuito (non determinata, fallita, bloccata,
 * o attribuita a un progetto che lui non vede). La card è nel primo progetto
 * del server in cui ha `servers.operate` (lo stesso criterio con cui ha potuto
 * avviarla) e va SOLO a lui (`mandatoryOnly`): gli iscritti di quel progetto
 * non ricevono l'esito di un'analisi che non hanno chiesto.
 */
export async function notifyAnalysisRequester(
  db: Db,
  input: {
    serverId: string;
    requesterId: string;
    outcome: "attributed" | "undetermined" | "failed" | "blocked";
    language: Language;
    publicUrl: string;
  },
  publish: typeof publishNotification = publishNotification,
  log: (m: string) => void = console.warn,
): Promise<string | null> {
  const [server] = await db.select().from(servers).where(eq(servers.id, input.serverId));
  if (!server) return null;
  const target = await requesterProjectOf(db, input.serverId, input.requesterId);
  if (target === null) return null;
  const { projectId, projectCode } = target;
  const code = `SRV-${server.number}`;
  const event: NotificationEvent = {
    kind: "server.diagnosis_ready",
    projectId,
    serverName: server.name,
    serverId: server.id,
    taskCode: null,
    title: t(input.language, "server.taskTitleManual", { code, name: server.name }),
    url: appUrl(input.publicUrl, { to: "server", projectCode, serverCode: code }),
    outcome: input.outcome,
  };
  try {
    await publish(db, event, { projectId, mandatory: [{ userId: input.requesterId, reason: "analysis_requester" }], mandatoryOnly: true });
  } catch (error) {
    log(`[server-ops] esito dell'analisi per chi l'ha chiesta non pubblicato: ${error instanceof Error ? error.message : String(error)}`);
  }
  return projectId;
}

/**
 * Decisione del maintainer (15 nov 2026, risposta c): l'esito «non
 * determinata» — e, come per una fallita, «fallita» — va anche agli ISCRITTI
 * delle PRODUZIONI del server (i progetti con un ambiente `production` che lo
 * usa), oltre a chi l'ha chiesta. Una card per produzione; chi l'ha chiesta,
 * se il suo progetto è una di quelle produzioni, sta fra gli obbligatori di
 * QUELLA card (una sola); altrimenti la sua card a sé (`notifyAnalysisRequester`).
 */
export async function notifyAnalysisOutcome(
  db: Db,
  input: {
    serverId: string;
    requesterId: string | null;
    outcome: "undetermined" | "failed";
    manual: boolean;
    language: Language;
    publicUrl: string;
  },
  publish: typeof publishNotification = publishNotification,
  log: (m: string) => void = console.warn,
): Promise<void> {
  const [server] = await db.select().from(servers).where(eq(servers.id, input.serverId));
  if (!server) return;
  const productions = await db
    .selectDistinct({ projectId: projects.id, code: projects.code })
    .from(environmentServers)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .where(and(eq(environmentServers.serverId, input.serverId), eq(projectEnvironments.kind, "production")));
  const requesterProject = input.requesterId ? await requesterProjectOf(db, input.serverId, input.requesterId) : null;
  const code = `SRV-${server.number}`;
  const title = t(input.language, input.manual ? "server.taskTitleManual" : "server.taskTitle", { code, name: server.name });
  let requesterServed = false;
  for (const p of productions) {
    const withRequester = input.requesterId !== null && requesterProject?.projectId === p.projectId;
    if (withRequester) requesterServed = true;
    const event: NotificationEvent = {
      kind: "server.diagnosis_ready",
      projectId: p.projectId,
      serverName: server.name,
      serverId: server.id,
      taskCode: null,
      title,
      url: appUrl(input.publicUrl, { to: "server", projectCode: p.code, serverCode: code }),
      outcome: input.outcome,
    };
    try {
      await publish(db, event, {
        projectId: p.projectId,
        ...(withRequester ? { mandatory: [{ userId: input.requesterId!, reason: "analysis_requester" as const }] } : {}),
      });
    } catch (error) {
      log(`[server-ops] esito dell'analisi per la produzione ${p.code} non pubblicato: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (input.requesterId && !requesterServed) {
    await notifyAnalysisRequester(
      db,
      { serverId: input.serverId, requesterId: input.requesterId, outcome: input.outcome, language: input.language, publicUrl: input.publicUrl },
      publish,
      log,
    );
  }
}

/** Il primo progetto del server in cui chi ha chiesto l'analisi ha `servers.operate`. */
async function requesterProjectOf(db: Db, serverId: string, requesterId: string): Promise<{ projectId: string; projectCode: string } | null> {
  for (const p of (await attributionContext(db, serverId)).serverProjects) {
    if ((await userIdsWithPermission(db, "servers.operate", p.projectId)).includes(requesterId)) return { projectId: p.projectId, projectCode: p.projectCode };
  }
  return null;
}
