import {
  agentQuestions,
  aiJobs,
  automations,
  claudeSuggestionDismissals,
  notifications,
  prReleaseNotes,
  projects,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { taskListQuerySchema, type ClaudeSuggestion, type ClaudeSuggestionKind, type ClaudeSuggestionPage } from "@stubwise/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import { isAllProjects, projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { monthlyBudgetExhausted } from "./agent-sessions.js";
import { releaseNotesWriteAccess } from "./pr-release-notes.js";
import { loadTaskViews, serverToday, stallsOf, taskFilterConditions } from "./task-view.js";
import { usageScope } from "./usage-summary.js";

/**
 * Area 10, F7 (D-5 = a): la riga «Claude can help you…» di una pagina, per chi
 * guarda, o `null`. Le regole, in ordine (`claude-suggestions.md` del
 * prototipo):
 * 1. il budget del mese esaurito → niente riga (Claude non partirebbe);
 * 2. «Not now» salvato da chi guarda per QUEL tipo e QUELL'oggetto → niente;
 * 3. per pagina, solo se l'azione suggerita passerebbe per chi guarda:
 *    - `pr` (`<repositoryId>:<prNumber>`): la PR aperta, chi guarda può
 *      scrivere le note (la regola di `putPrReleaseNotes`), le note sono
 *      vuote, e la task della PR non aspetta nessuno (un piano da approvare,
 *      una domanda dell'agente aperta) → `releaseNotes`;
 *    - `automations` (un progetto): lo vede, ha `automations.manage`, e il
 *      progetto non ha automazioni → `buildAutomation`;
 *    - `overview` (un progetto): lo vede, nessuna proposta del polso aperta
 *      per lui, almeno una task ferma (`stallsOf`, la regola di
 *      `read_stalled_work`: la riga non porta mai a «niente di fermo») →
 *      `whyStalled`;
 *    - `usage`: la regola di `/api/ai-usage/summary` → `monthSpend`.
 * Un oggetto che chi guarda non vede dà `null`, mai 404: la riga non è un
 * oracolo. `params` porta il solo codice dell'oggetto.
 */
const KIND_OF_PAGE: Record<ClaudeSuggestionPage, ClaudeSuggestionKind> = {
  pr: "releaseNotes",
  automations: "buildAutomation",
  overview: "whyStalled",
  usage: "monthSpend",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export async function claudeSuggestionFor(
  db: Db,
  viewer: SessionUser,
  input: { page: ClaudeSuggestionPage; objectId?: string },
): Promise<ClaudeSuggestion> {
  const kind = KIND_OF_PAGE[input.page];
  const objectId = input.page === "usage" ? "" : (input.objectId ?? "");
  if (input.page !== "usage" && objectId === "") return null;
  if (await monthlyBudgetExhausted(db)) return null;
  const [dismissed] = await db
    .select({ kind: claudeSuggestionDismissals.kind })
    .from(claudeSuggestionDismissals)
    .where(and(eq(claudeSuggestionDismissals.userId, viewer.id), eq(claudeSuggestionDismissals.kind, kind), eq(claudeSuggestionDismissals.objectId, objectId)));
  if (dismissed) return null;
  const params = await paramsFor(db, viewer, input.page, objectId);
  return params === null ? null : { suggestionId: `${kind}:${objectId}`, kind, page: input.page, objectId, params };
}

async function paramsFor(db: Db, viewer: SessionUser, page: ClaudeSuggestionPage, objectId: string): Promise<Record<string, string> | null> {
  switch (page) {
    case "usage": {
      const scope = await usageScope(db, viewer);
      return isAllProjects(scope) || scope.length > 0 ? {} : null;
    }
    case "pr":
      return prParams(db, viewer, objectId);
    case "automations":
    case "overview": {
      if (!UUID.test(objectId)) return null;
      const perms = await projectPermissionsFor(db, viewer, objectId);
      if (!perms) return null;
      const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, objectId));
      if (!project) return null;
      if (page === "automations") {
        if (!perms.has("automations.manage")) return null;
        const [any] = await db.select({ id: automations.id }).from(automations).where(eq(automations.projectId, objectId)).limit(1);
        return any ? null : { code: project.code };
      }
      // Una proposta del polso aperta per chi guarda su quel progetto: la riga tace.
      const [pulse] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, viewer.id), eq(notifications.projectId, objectId), eq(notifications.kind, "project.pulse"), ne(notifications.status, "handled")))
        .limit(1);
      if (pulse) return null;
      return (await hasStalled(db, viewer, objectId)) ? { code: project.code } : null;
    }
  }
}

/** La regola di `read_stalled_work` (`GET /api/tasks/stalled`) su un progetto. */
async function hasStalled(db: Db, viewer: SessionUser, projectId: string): Promise<boolean> {
  const today = serverToday();
  const query = taskListQuerySchema.parse({ projectIds: projectId });
  const loaded = await loadTaskViews(db, viewer, taskFilterConditions(query, today, viewer.id));
  return (await stallsOf(db, viewer, loaded, today)).size > 0;
}

async function prParams(db: Db, viewer: Viewer, objectId: string): Promise<Record<string, string> | null> {
  const m = /^([0-9a-f-]{36}):([1-9][0-9]{0,9})$/i.exec(objectId);
  if (!m || !UUID.test(m[1]!)) return null;
  const repositoryId = m[1]!;
  const prNumber = Number(m[2]);
  // Chi guarda può scrivere le note (e vede il progetto, e Stubwise conosce la PR).
  if (!(await releaseNotesWriteAccess(db, viewer, repositoryId, prNumber)).ok) return null;
  const [pr] = await db
    .select({ ticketId: tickets.id, number: tickets.number, code: projects.code })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(eq(ticketRepositories.repositoryId, repositoryId), eq(ticketRepositories.prNumber, prNumber), eq(ticketRepositories.prState, "open"), ne(tickets.type, "review")))
    .limit(1);
  if (!pr) return null;
  const [notes] = await db
    .select({ body: prReleaseNotes.body })
    .from(prReleaseNotes)
    .where(and(eq(prReleaseNotes.repositoryId, repositoryId), eq(prReleaseNotes.prNumber, prNumber)));
  if (notes && notes.body.trim() !== "") return null;
  // La task della PR aspetta qualcuno: un piano da approvare, una domanda aperta.
  const [waiting] = await db.execute<{ one: number }>(sql`
    select 1 as one where exists (select 1 from ${aiJobs} where ${aiJobs.ticketId} = ${pr.ticketId} and ${aiJobs.status} = 'awaiting_plan_approval')
      or exists (select 1 from ${agentQuestions} where ${agentQuestions.ticketId} = ${pr.ticketId} and ${agentQuestions.answeredAt} is null and ${agentQuestions.cancelledAt} is null)`);
  if (waiting) return null;
  return { code: `${pr.code}-${pr.number}` };
}

/** «Not now»: per chi guarda, su quel tipo e quell'oggetto. Ripetuto non fa niente. */
export async function dismissClaudeSuggestion(db: Db, viewer: Viewer, input: { kind: ClaudeSuggestionKind; objectId: string }): Promise<void> {
  await db
    .insert(claudeSuggestionDismissals)
    .values({ userId: viewer.id, kind: input.kind, objectId: input.objectId })
    .onConflictDoNothing();
}
