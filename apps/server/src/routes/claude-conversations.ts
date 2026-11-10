import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  claudeActionGroupViewSchema,
  claudeChatStatusSchema,
  claudeProposalOutcomeSchema,
  claudeProposalViewSchema,
  createClaudeProposalSchema,
  claudeConversationDetailSchema,
  claudeConversationListQuerySchema,
  claudeConversationListSchema,
  claudeConversationSchema,
  createClaudeConversationSchema,
  patchClaudeConversationSchema,
} from "@stubwise/shared";
import { apiError } from "../errors.js";
import {
  createClaudeConversation,
  deleteClaudeConversation,
  getClaudeConversation,
  listClaudeConversations,
  patchClaudeConversation,
} from "../services/claude-conversations.js";
import { monthlyBudgetExhausted } from "../services/agent-sessions.js";
import { createProposal, listGroups, listProposals, ownLiveConversation } from "../claude-actions/proposals.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// Le conversazioni libere con Claude (chat, fetta 1), sotto `/api/claude/conversations`.
// Le vede e le tocca SOLO l'autore: il filtro sta nel servizio, nella WHERE, e
// una conversazione di un altro risponde 404 come una che non esiste. Messaggi,
// eventi e stream sono quelli delle sessioni (`/api/agent-sessions/:id/…`).

const idParams = z.object({ id: z.uuid() });
const ACCESS = { kind: "user" } as const;

export async function claudeConversationRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Letterale PRIMA di `/:id` (la trappola di routing del repo).
  app.get(
    "/status",
    {
      config: { access: ACCESS },
      schema: { response: { 200: claudeChatStatusSchema, ...authErrorResponses } },
    },
    async () => ({ budgetExhausted: await monthlyBudgetExhausted(app.db) }),
  );

  app.get(
    "/",
    {
      config: { access: ACCESS },
      schema: { querystring: claudeConversationListQuerySchema, response: { 200: claudeConversationListSchema, ...authErrorResponses } },
    },
    async (request) =>
      listClaudeConversations(app.db, request.user!, {
        archived: request.query.archived === "true",
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
        ...(request.query.before !== undefined ? { before: request.query.before } : {}),
      }),
  );

  app.post(
    "/",
    {
      config: { access: ACCESS },
      schema: {
        body: createClaudeConversationSchema,
        response: { 201: claudeConversationSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await createClaudeConversation(app.db, request.user!, request.body);
      if (!result.ok) return apiError(reply, 409, "budget_exhausted", "The monthly AI budget is used up");
      return reply.code(201).send(result.conversation);
    },
  );

  app.get(
    "/:id",
    {
      config: { access: ACCESS },
      schema: { params: idParams, response: { 200: claudeConversationDetailSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const detail = await getClaudeConversation(app.db, request.user!, request.params.id);
      if (!detail) return apiError(reply, 404, "not_found", "Conversation not found");
      return detail;
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        body: patchClaudeConversationSchema,
        response: { 200: claudeConversationSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const updated = await patchClaudeConversation(app.db, request.user!, request.params.id, request.body);
      if (!updated) return apiError(reply, 404, "not_found", "Conversation not found");
      return updated;
    },
  );

  /**
   * La proposta di Claude (tool `propose_action`, chat fetta 3): la SOLA rotta
   * di scrittura del token del turno (`CHAT_TOOL_WRITE_ROUTES`), e solo per la
   * conversazione del suo turno. Una persona non la chiama: 403. Crea la
   * proposta; la classe e, per una A, l'esecuzione le fa il server.
   */
  app.post(
    "/:id/proposals",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        body: createClaudeProposalSchema,
        response: { 200: claudeProposalOutcomeSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (user.chatToolSessionId === undefined) {
        return apiError(reply, 403, "claude_only", "Only Claude's turn can propose actions");
      }
      if (user.chatToolSessionId !== request.params.id || !(await ownLiveConversation(app.db, user.id, request.params.id))) {
        return apiError(reply, 404, "not_found", "Conversation not found");
      }
      return createProposal(
        app.db,
        user,
        request.params.id,
        { toolUseId: request.body.toolUseId, actions: request.body.actions, summary: request.body.summary },
        { storage: () => app.storage(), log: (message, error) => request.log.warn({ err: error }, message) },
      );
    },
  );

  app.get(
    "/:id/proposals",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        response: { 200: z.array(claudeProposalViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      if (!(await getClaudeConversation(app.db, request.user!, request.params.id))) {
        return apiError(reply, 404, "not_found", "Conversation not found");
      }
      return listProposals(app.db, request.user!, request.params.id);
    },
  );

  app.get(
    "/:id/groups",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        response: { 200: z.array(claudeActionGroupViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      if (!(await getClaudeConversation(app.db, request.user!, request.params.id))) {
        return apiError(reply, 404, "not_found", "Conversation not found");
      }
      return listGroups(app.db, request.user!, request.params.id);
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: ACCESS },
      schema: { params: idParams, response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const ok = await deleteClaudeConversation(app.db, request.user!, request.params.id);
      if (!ok) return apiError(reply, 404, "not_found", "Conversation not found");
      return reply.code(204).send(null);
    },
  );
}
