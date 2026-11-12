import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { claudeActionFailureSchema, claudeProposalViewSchema } from "@stubwise/shared";
import { apiError } from "../errors.js";
import type { ActionEffects } from "../claude-actions/effects.js";
import { cancelProposal, confirmProposal, requestUndo } from "../claude-actions/proposals.js";
import { publicUrlOrUndefined } from "../ingest/shared.js";
import { fillDraftBody } from "../services/mail-drafts.js";
import { claudeActions } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { authErrorResponses, errorSchema } from "./shared.js";

// Le decisioni della PERSONA sulle azioni di Claude (chat, fetta 3), sotto
// `/api/claude`: confermare o annullare una scheda, «Annulla» un gruppo
// eseguito. Solo l'autore della conversazione (le altre rispondono 404), con
// la sessione o un PAT; MAI col token del turno, che qui risponde 403
// (`chat_tool_forbidden`, l'allowlist). Ogni decisione riverifica scadenza,
// classe e permessi ADESSO (`claude-actions/proposals.ts`).

/**
 * Ciò che l'esecutore usa fuori dalla transazione (solo dopo il commit, mai a
 * secco): lo storage per gli allegati, il link pubblico delle notifiche (il
 * piano da approvare di un lavoro avviato), il log della richiesta.
 */
export function actionEffects(app: FastifyInstance, request: { log: FastifyBaseLogger }): ActionEffects {
  const publicUrl = publicUrlOrUndefined(app);
  return {
    storage: () => app.storage(),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    log: (message, error) => request.log.warn({ err: error }, message),
    markEffectFailure: async (actionId, code) => {
      await app.db.update(claudeActions).set({ effectFailure: code }).where(eq(claudeActions.id, actionId));
    },
    // `fillMailBody`: la bozza Gmail di chi ha confermato, dopo il commit.
    mailBody: async (userId, args) => {
      const out = await fillDraftBody(app.db, app.encryptionKey, app.mailComposeClient, await app.storage(), userId, args);
      if ("error" in out) throw new Error(`fillMailBody: ${out.error}`);
    },
  };
}

const idParams = z.object({ id: z.uuid() });
const ACCESS = { kind: "user" } as const;
const refusedSchema = z.object({
  code: z.literal("refused"),
  message: z.string(),
  proposal: claudeProposalViewSchema.optional(),
  failure: claudeActionFailureSchema.optional(),
});

export async function claudeActionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/proposals/:id/confirm",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        body: z
          .object({
            selected: z.array(z.number().int().min(0)).max(20).optional(),
            edited: z.array(z.object({ index: z.number().int().min(0), args: z.record(z.string(), z.unknown()) })).max(20).optional(),
          })
          .default({}),
        response: {
          200: claudeProposalViewSchema,
          400: errorSchema,
          404: errorSchema,
          409: z.union([refusedSchema, errorSchema]),
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await confirmProposal(
        app.db,
        request.user!,
        request.params.id,
        {
          ...(request.body.selected ? { selected: request.body.selected } : {}),
          ...(request.body.edited ? { edited: request.body.edited } : {}),
        },
        actionEffects(app, request),
      );
      if (result.ok) return result.proposal;
      if (result.error === "not_found") return apiError(reply, 404, "not_found", "Proposal not found");
      if (result.error === "invalid") return apiError(reply, 400, "invalid", "Select at least one action");
      if (result.error === "refused") {
        return reply.code(409).send({ code: "refused", message: "The action was refused", proposal: result.proposal });
      }
      return apiError(reply, 409, result.error, result.error);
    },
  );

  app.post(
    "/proposals/:id/cancel",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        response: { 200: claudeProposalViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await cancelProposal(app.db, request.user!, request.params.id);
      if (result.ok) return result.proposal;
      if (result.error === "not_found") return apiError(reply, 404, "not_found", "Proposal not found");
      return apiError(reply, 409, result.error, result.error);
    },
  );

  app.post(
    "/groups/:id/undo",
    {
      config: { access: ACCESS },
      schema: {
        params: idParams,
        response: {
          200: z.object({ kind: z.enum(["undone", "needs_confirmation"]), proposal: claudeProposalViewSchema.optional() }),
          404: errorSchema,
          409: z.union([refusedSchema, errorSchema]),
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await requestUndo(app.db, request.user!, request.params.id, actionEffects(app, request));
      if (result.ok) return result.kind === "undone" ? { kind: "undone" as const } : { kind: "needs_confirmation" as const, proposal: result.proposal };
      if (result.error === "not_found" || result.error === "not_yours") return apiError(reply, 404, "not_found", "Not found");
      if (result.error === "refused") {
        return reply.code(409).send({ code: "refused", message: "The undo was refused", ...(result.failure ? { failure: result.failure } : {}) });
      }
      return apiError(reply, 409, result.error, result.error);
    },
  );
}
