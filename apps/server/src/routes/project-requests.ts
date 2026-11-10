import { backlogItems, backlogJobs, projects } from "@stubwise/db";
import {
  acceptBacklogItemSuggested,
  dismissBacklogItemSuggested,
  updateRequestFields,
} from "@stubwise/notifications";
import {
  effortFromSize,
  newRequestBodySchema,
  projectRequestSummarySchema,
  projectRequestViewSchema,
  requestJobViewSchema,
  requestPatchBodySchema,
  type ProjectRequestView,
} from "@stubwise/shared";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { routePermissions, visibleProjectIds, inProjects } from "../auth/access.js";
import { backlogItemAccess, fromBacklogJob, fromBody, fromQuery } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { applyBacklogMerge, MergeAiError, MergeChangedError, mergedDocumentOf, readMergeSnapshot } from "../services/backlog-merge.js";
import { enqueueBacklogIntake } from "../services/backlog-intake.js";
import { closeRefineSessionForItem } from "../services/backlog-refine.js";
import { loadRequestSummaries, loadRequestViews, requestView, requestVisibility } from "../services/project-requests.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Le richieste dell'app nuova (integrazione area 2, fetta 4): la sezione
 * Requests (il Backlog del web vecchio) nella forma `ProjectRequest` del
 * prototipo. Le regole sono quelle del prototipo (`data/api-mutations.ts`),
 * tranne due decisioni del maintainer che non vanno «corrette»:
 * - la creazione passa dall'INTAKE come oggi (asincrona: 202 e un job), che
 *   può fondere la richiesta in una esistente; l'esito lo dice
 *   `GET /api/requests/jobs/:jobId` (nuova o fusa, e in quale);
 * - «Fondi in…» riscrive la destinazione col modello; se il modello non
 *   risponde, nessuna delle due voci cambia (502 `merge_failed`).
 * Trasformare in task è `POST /api/tasks` con `requestId` (fetta 1).
 * Le rotte del backlog del web vecchio restano com'erano.
 */

const OPEN = ["new", "refining", "ready"] as const;
const idParams = z.object({ id: z.uuid() });
const viewOr404 = { 200: projectRequestViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses };

export async function projectRequestRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/requests",
    {
      config: { access: { kind: "project", permission: "member", project: fromQuery("projectId") } },
      schema: {
        querystring: z.object({ projectId: z.uuid() }),
        response: { 200: z.array(projectRequestSummarySchema), ...authErrorResponses },
      },
    },
    // Leggero: un estratto al posto di descrizione, design e piano (il dettaglio li porta interi).
    async (request) =>
      loadRequestSummaries(app.db, [
        eq(backlogItems.projectId, request.query.projectId),
        await requestVisibility(app.db, request.user!),
      ]),
  );

  // Letterali PRIMA di `/requests/:id` (trappola di routing).
  app.get(
    "/requests/by-code/:code",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ code: z.string().max(40) }), response: { 200: projectRequestViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const match = /^([A-Za-z][A-Za-z0-9]{1,5})-R(\d{1,9})$/.exec(request.params.code);
      if (!match) return apiError(reply, 404, "not_found", "Request not found");
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.code, match[1]!.toUpperCase()), inProjects(projects.id, await visibleProjectIds(app.db, request.user!))));
      if (!project) return apiError(reply, 404, "not_found", "Request not found");
      const [view] = await loadRequestViews(app.db, [
        eq(backlogItems.projectId, project.id),
        eq(backlogItems.number, Number(match[2])),
        await requestVisibility(app.db, request.user!),
      ]);
      return view ?? apiError(reply, 404, "not_found", "Request not found");
    },
  );

  /**
   * L'esito dell'intake di una richiesta creata dall'app: `merged` se la voce
   * prodotta esisteva già prima del job (l'intake ha fuso la richiesta in
   * lei), `created` se è nata col job. Chi non vede la voce prodotta né ha
   * accodato il job riceve 404, come per un job che non esiste.
   */
  app.get(
    "/requests/jobs/:jobId",
    {
      config: { access: { kind: "project", permission: "member", project: fromBacklogJob("jobId") } },
      schema: { params: z.object({ jobId: z.uuid() }), response: { 200: requestJobViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const [job] = await app.db
        .select({
          status: backlogJobs.status,
          resultItemId: backlogJobs.resultItemId,
          payload: backlogJobs.payload,
          createdAt: backlogJobs.createdAt,
        })
        .from(backlogJobs)
        .where(eq(backlogJobs.id, request.params.jobId));
      if (!job) return apiError(reply, 404, "job_not_found", "Job not found");
      const view = job.resultItemId ? await requestView(app.db, request.user!, job.resultItemId) : null;
      const requester = "requestedByUserId" in job.payload ? job.payload.requestedByUserId : undefined;
      if (!routePermissions(request).has("backlog.view_all") && requester !== request.user!.id && !view) {
        return apiError(reply, 404, "job_not_found", "Job not found");
      }
      if (job.status !== "done" || !job.resultItemId) return { status: job.status, outcome: null, request: null };
      const [item] = await app.db
        .select({ createdAt: backlogItems.createdAt })
        .from(backlogItems)
        .where(eq(backlogItems.id, job.resultItemId));
      const outcome: "merged" | "created" = item && item.createdAt.getTime() < job.createdAt.getTime() ? "merged" : "created";
      return { status: job.status, outcome, request: view };
    },
  );

  app.post(
    "/requests",
    {
      config: { access: { kind: "project", permission: "backlog.create", project: fromBody("projectId") } },
      schema: {
        body: newRequestBodySchema,
        response: { 202: z.object({ jobId: z.uuid() }), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, title, description } = request.body;
      const result = await enqueueBacklogIntake(app.db, {
        projectId,
        title,
        body: description,
        requestedByUserId: request.user!.id,
      });
      if (!result.ok) return apiError(reply, 404, "project_not_found", "Project not found");
      return reply.code(202).send({ jobId: result.jobId });
    },
  );

  app.get(
    "/requests/:id",
    {
      config: { access: backlogItemAccess("id", "member") },
      schema: { params: idParams, response: { 200: projectRequestViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) =>
      (await requestView(app.db, request.user!, request.params.id)) ?? apiError(reply, 404, "not_found", "Request not found"),
  );

  /** Titolo, descrizione e metadati (`backlog.edit`). Trasformata o archiviata, la richiesta è in sola lettura (il titolo no). */
  app.patch(
    "/requests/:id",
    {
      config: { access: backlogItemAccess("id", "backlog.edit") },
      schema: { params: idParams, body: requestPatchBodySchema, response: viewOr404 },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { title, description, urgency, size, risk, riskNote } = request.body;
      // Una scrittura sola, sotto il lock della voce: lo stato si ricontrolla lì.
      const res = await updateRequestFields(
        app.db,
        id,
        {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(urgency !== undefined ? { urgency } : {}),
          ...(size !== undefined ? { effort: effortFromSize(size) } : {}),
          ...(risk !== undefined ? { risk } : {}),
          ...(riskNote !== undefined ? { riskNote: riskNote ? riskNote : null } : {}),
        },
        { readOnlyClosed: true },
      );
      if (res === "not_found") return apiError(reply, 404, "not_found", "Request not found");
      if (res === "read_only") {
        return apiError(reply, 409, "request_read_only", "A converted or archived request cannot change its metadata");
      }
      return (await requestView(app.db, request.user!, id)) ?? apiError(reply, 404, "not_found", "Request not found");
    },
  );

  // Le proposte dell'intake: accettate diventano i metadati, scartate spariscono.
  // Gli scrittori sono quelli di `backlog-item-writes.ts` (voce in lock), gli
  // stessi delle rotte del backlog; qui una trasformata o archiviata è in sola lettura.
  for (const [action, write] of [
    ["accept", acceptBacklogItemSuggested],
    ["dismiss", dismissBacklogItemSuggested],
  ] as const) {
    app.post(
      `/requests/:id/suggestions/${action}`,
      { config: { access: backlogItemAccess("id", "backlog.edit") }, schema: { params: idParams, response: viewOr404 } },
      async (request, reply) => {
        const { id } = request.params;
        const res = await write(app.db, id, { readOnlyClosed: true });
        if (res === "not_found") return apiError(reply, 404, "not_found", "Request not found");
        if (res === "read_only") {
          return apiError(reply, 409, "request_read_only", "A converted or archived request cannot change its metadata");
        }
        if (res === "no_suggested") return apiError(reply, 409, "no_suggested", "There are no suggestions to " + action);
        return (await requestView(app.db, request.user!, id))!;
      },
    );
  }

  /** Archivia una richiesta aperta; la sua sessione di refinement si chiude. */
  app.post(
    "/requests/:id/archive",
    { config: { access: backlogItemAccess("id", "backlog.edit") }, schema: { params: idParams, response: viewOr404 } },
    async (request, reply) => {
      const { id } = request.params;
      const changed = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(backlogItems)
          .set({ status: "archived" })
          .where(and(eq(backlogItems.id, id), inArray(backlogItems.status, [...OPEN])))
          .returning({ id: backlogItems.id });
        if (row) await closeRefineSessionForItem(tx, id);
        return row !== undefined;
      });
      if (!changed) return apiError(reply, 409, "invalid_status", "Only an open request can be archived");
      return (await requestView(app.db, request.user!, id))!;
    },
  );

  /** Riapre un'archiviata (anche fusa): torna «nuova», e non è più fusa in niente. */
  app.post(
    "/requests/:id/reopen",
    { config: { access: backlogItemAccess("id", "backlog.edit") }, schema: { params: idParams, response: viewOr404 } },
    async (request, reply) => {
      const { id } = request.params;
      const [row] = await app.db
        .update(backlogItems)
        .set({ status: "new", mergedIntoId: null })
        .where(and(eq(backlogItems.id, id), eq(backlogItems.status, "archived")))
        .returning({ id: backlogItems.id });
      if (!row) return apiError(reply, 409, "invalid_status", "Only an archived request can be reopened");
      return (await requestView(app.db, request.user!, id))!;
    },
  );

  /**
   * L'«Annulla» di un'archiviazione a mano: torna allo stato aperto di prima,
   * che lo decide il SERVER (`archived_from`, scritto dal trigger della 0122).
   * Il `status` del body resta accettato per i client di prima, ma non conta.
   * Un'archiviata di prima della 0122 (stato precedente ignoto) torna «nuova».
   * Una fusa si riapre, non si ripristina.
   */
  app.post(
    "/requests/:id/restore",
    {
      config: { access: backlogItemAccess("id", "backlog.edit") },
      schema: { params: idParams, body: z.object({ status: z.enum(OPEN).optional() }).nullish(), response: viewOr404 },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [row] = await app.db
        .update(backlogItems)
        .set({ status: sql`coalesce(${backlogItems.archivedFrom}, 'new'::backlog_item_status)` })
        .where(
          and(
            eq(backlogItems.id, id),
            eq(backlogItems.status, "archived"),
            isNull(backlogItems.mergedIntoId),
            or(isNull(backlogItems.archivedFrom), inArray(backlogItems.archivedFrom, [...OPEN])),
          ),
        )
        .returning({ id: backlogItems.id });
      if (!row) return apiError(reply, 409, "invalid_status", "Only a request archived by hand can be restored");
      return (await requestView(app.db, request.user!, id))!;
    },
  );

  /**
   * «Fondi in…»: questa richiesta (aperta) si fonde in `intoId` (stesso
   * progetto, non archiviata né trasformata). La destinazione la riscrive il
   * modello, FUORI transazione; se non risponde, 502 `merge_failed` e niente
   * cambia, così l'app offre «Riprova». Se nel frattempo una delle due è
   * cambiata, 409 `request_changed` e niente cambia.
   */
  app.post(
    "/requests/:id/merge",
    {
      config: { access: backlogItemAccess("id", "backlog.edit") },
      schema: {
        params: idParams,
        body: z.object({ intoId: z.uuid() }),
        response: { ...viewOr404, 400: errorSchema, 502: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { intoId } = request.body;
      const source = await requestView(app.db, request.user!, id);
      const target = id === intoId ? null : await requestView(app.db, request.user!, intoId);
      if (!source) return apiError(reply, 404, "not_found", "Request not found");
      if (!target || target.projectId !== source.projectId) {
        return apiError(reply, 400, "invalid_target", "Merge into another request of the same project");
      }
      if (!(OPEN as readonly string[]).includes(source.status) || target.status === "archived" || target.status === "converted") {
        return apiError(reply, 409, "invalid_status", "These requests cannot be merged");
      }
      if (app.chatLlm.isAvailable) {
        const availability = await app.chatLlm.isAvailable();
        if (!availability.available) return apiError(reply, 503, "chat_unavailable", "Merging needs an API-key AI provider");
      }
      const before = await readMergeSnapshot(app.db, id, intoId);
      if (!before) return apiError(reply, 409, "request_changed", "One of the two requests changed; nothing was merged");
      let merged: string;
      try {
        merged = await mergedDocumentOf(app.chatLlm, before.target, before.absorbed, target.projectId);
        await applyBacklogMerge(app.db, before, merged);
      } catch (error) {
        if (error instanceof MergeAiError) {
          return apiError(reply, 502, "merge_failed", "The AI could not merge the two requests; nothing was changed");
        }
        if (error instanceof MergeChangedError) {
          return apiError(reply, 409, "request_changed", "One of the two requests changed while merging; nothing was merged");
        }
        throw error;
      }
      return (await requestView(app.db, request.user!, intoId)) as ProjectRequestView;
    },
  );
}
