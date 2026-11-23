import { registerPersonMask } from "../services/people-known.js";
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
  claudeVisibilityConfirmationSchema,
  continueClaudeConversationSchema,
  createClaudeConversationSchema,
  patchClaudeConversationSchema,
  setClaudeConversationVisibilitySchema,
  answerClaudeQuestionSchema,
  claudeConversationQuestionSchema,
} from "@stubwise/shared";
import { answerConversationQuestion, listConversationQuestions } from "../services/claude-conversation-questions.js";
import { apiError } from "../errors.js";
import {
  createClaudeConversation,
  deleteClaudeConversation,
  getClaudeConversation,
  continueClaudeConversation,
  listClaudeConversations,
  patchClaudeConversation,
  setClaudeConversationVisibility,
} from "../services/claude-conversations.js";
import { monthlyBudgetExhausted } from "../services/agent-sessions.js";
import { createProposal, listGroups, listProposals, ownLiveConversation } from "../claude-actions/proposals.js";
import { actionEffects } from "./claude-actions.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// Le conversazioni libere con Claude (chat, fetta 1), sotto `/api/claude/conversations`.
// Le vede e le tocca SOLO l'autore: il filtro sta nel servizio, nella WHERE, e
// una conversazione di un altro risponde 404 come una che non esiste. Messaggi,
// eventi e stream sono quelli delle sessioni (`/api/agent-sessions/:id/…`).

const idParams = z.object({ id: z.uuid() });
const ACCESS = { kind: "user" } as const;

export async function claudeConversationRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Registro, A11 r.1414: chi guarda non riceve l'id di chi non conosce.
  registerPersonMask(app, new Set<string>(), new Set(["author", "publishedBy", "by"]));

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
        scope: request.query.scope,
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
   * «Continua» (fetta 5, F5.3): una pubblica di un altro diventa una
   * conversazione NUOVA, privata, di chi continua. 404 se non la vede, 409 se
   * è sua, privata o archiviata.
   */
  app.post(
    "/:id/continue",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        body: continueClaudeConversationSchema,
        response: { 201: claudeConversationSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await continueClaudeConversation(app.db, request.user!, request.params.id, request.body);
      if (result.ok) return reply.code(201).send(result.conversation);
      if (result.error === "not_found") return apiError(reply, 404, "not_found", "Conversation not found");
      if (result.error === "not_public") return apiError(reply, 409, "not_public", "Only someone else's public conversation can be continued");
      return apiError(reply, 409, "budget_exhausted", "The monthly AI budget is used up");
    },
  );

  /**
   * «Make public» / «Make private» e la riconferma del seguito privato (fetta
   * 5): solo l'autore. Pubblicare vuole i progetti letti o toccati confermati
   * (409 `needs_confirmation` con l'elenco e `includesToolReads`). Il token
   * del turno non ci arriva (non è nell'allowlist).
   */
  app.post(
    "/:id/visibility",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        body: setClaudeConversationVisibilitySchema,
        response: {
          200: claudeConversationSchema,
          404: errorSchema,
          409: z.union([claudeVisibilityConfirmationSchema, errorSchema]),
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await setClaudeConversationVisibility(app.db, request.user!, request.params.id, request.body);
      if (result.ok) return result.conversation;
      if (result.error === "needs_confirmation") return reply.code(409).send(result.confirmation);
      if (result.error === "not_found") return apiError(reply, 404, "not_found", "Conversation not found");
      if (result.error === "private_content") {
        return apiError(reply, 409, "private_content", "Claude read your mail, your calendar or a private channel here: this conversation can't be made public");
      }
      return apiError(reply, 409, "conversation_archived", "An archived conversation can't be made public");
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
        actionEffects(app, request),
      );
    },
  );

  /**
   * Area 10, F2: le domande a scelta di Claude nella conversazione libera. Chi
   * legge una pubblica vede solo quelle prima del seguito privato, come le
   * proposte; risponde solo l'autore. La risposta entra come un suo messaggio
   * (202, come `POST /api/agent-sessions/:id/messages`).
   */
  app.get(
    "/:id/questions",
    {
      config: { access: ACCESS },
      schema: { params: idParams, response: { 200: z.array(claudeConversationQuestionSchema), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      if (!(await getClaudeConversation(app.db, request.user!, request.params.id))) {
        return apiError(reply, 404, "not_found", "Conversation not found");
      }
      return listConversationQuestions(app.db, request.user!, request.params.id);
    },
  );

  app.post(
    "/:id/questions/:questionId/answer",
    {
      config: { access: ACCESS },
      schema: {
        params: z.object({ id: z.uuid(), questionId: z.uuid() }),
        body: answerClaudeQuestionSchema,
        response: {
          202: z.object({ inputId: z.uuid(), status: z.literal("pending") }),
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      if (!(await getClaudeConversation(app.db, request.user!, request.params.id))) {
        return apiError(reply, 404, "not_found", "Conversation not found");
      }
      const result = await answerConversationQuestion(app.db, request.user!, request.params.id, request.params.questionId, request.body);
      if (result.ok) return reply.code(202).send({ inputId: result.inputId, status: "pending" as const });
      switch (result.error) {
        case "not_found":
          return apiError(reply, 404, "not_found", "Question not found");
        case "forbidden":
          return apiError(reply, 403, "forbidden", "Only the author answers Claude's questions");
        case "answered":
          return apiError(reply, 409, "answered", "This question is already answered");
        case "stale":
          return apiError(reply, 409, "stale", "The conversation went on after this question");
        case "invalid_option":
          return apiError(reply, 422, "invalid_option", "There is no such option");
        case "conversation_archived":
          return apiError(reply, 409, "conversation_archived", "The conversation is archived");
        case "budget_exhausted":
          return apiError(reply, 409, "budget_exhausted", "The monthly AI budget is used up");
        default:
          return apiError(reply, 409, result.error, "The answer could not be sent");
      }
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
