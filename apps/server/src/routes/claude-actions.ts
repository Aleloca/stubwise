import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { chatCitationSchema, claudeActionFailureSchema, claudeActionGroupViewSchema, claudePageOutcomeSchema, claudePageOutcomeStatusSchema, claudeProposalViewSchema } from "@stubwise/shared";
import { citeablesFor } from "../chat/citations.js";
import { requireReauth } from "../auth/access.js";
import { apiError } from "../errors.js";
import type { ActionEffects } from "../claude-actions/effects.js";
import { cancelProposal, confirmProposal, requestUndo, settlePageOutcome } from "../claude-actions/proposals.js";
import { retryActionEffect } from "../claude-actions/retry-effect.js";
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
/** La chiave d'istanza, o undefined se `buildApp` non l'ha (il getter lancia). */
function keyOrUndefined(app: FastifyInstance): Buffer | undefined {
  try {
    return app.encryptionKey;
  } catch {
    return undefined;
  }
}

export function actionEffects(app: FastifyInstance, request: { log: FastifyBaseLogger }): ActionEffects {
  const publicUrl = publicUrlOrUndefined(app);
  return {
    storage: () => app.storage(),
    // Lotto 6: il preflight (solo lettura, solo al run vero) decifra le credenziali di un account git.
    // Letta senza lanciare: un'istanza senza chiave fa ogni altra proposta, e il
    // preflight (fail-closed) risponde `preflight_unavailable` (lotto 7: la
    // lettura diretta del getter faceva 500 su OGNI proposta senza chiave).
    ...(keyOrUndefined(app) ? { encryptionKey: keyOrUndefined(app)! } : {}),
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
      // Area 9, F7 (M-2 = a): la riconferma solo se il gruppo ha una C, con la
      // finestra di chi conferma (`requireReauth`, la regola delle altre rotte).
      config: { access: ACCESS, mcp: { action: "claude.confirmProposal", summary: "Conferma una proposta di Claude: il server la esegue coi tuoi permessi.", effect: "write", note: "Solo con le parole dell'utente. Una proposta che tocca segreti o membri chiede la riconferma: col PAT risponde `session_required`, va fatta dall'app." }, partialReauth: true },
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
          reauth: () => requireReauth(request, reply),
        },
        actionEffects(app, request),
      );
      if (result.ok) return result.proposal;
      // `requireReauth` ha già risposto (403 `reauth_required` / `second_factor_setup_required`).
      if (result.error === "reauth_required") return reply;
      if (result.error === "not_found") return apiError(reply, 404, "not_found", "Proposal not found");
      if (result.error === "invalid") return apiError(reply, 400, "invalid", "Select at least one action");
      if (result.error === "refused") {
        return reply.code(409).send({ code: "refused", message: "The action was refused", proposal: result.proposal });
      }
      return apiError(reply, 409, result.error, result.error);
    },
  );

  // Lotto 9, voce 1: le citazioni di un turno (`turn_end.citations`) come le
  // legge chi guarda: solo ciò che vede (un riferimento invisibile non torna).
  app.post(
    "/citations/resolve",
    {
      config: { access: ACCESS, mcp: { action: "claude.resolveCitations", summary: "Risolve le citazioni di un turno di Claude in ciò che vedi (un riferimento invisibile non torna).", effect: "write" } },
      schema: {
        body: z.object({ refs: z.array(z.object({ kind: z.enum(["task", "request", "project", "doc", "drive"]), id: z.uuid() })).max(100) }),
        response: { 200: z.object({ items: z.array(chatCitationSchema) }), ...authErrorResponses },
      },
    },
    async (request) => {
      const seen = await citeablesFor(app.db, request.user!, request.body.refs);
      return {
        items: [...seen.values()].map((c) => ({ kind: c.kind, id: c.id, label: c.label, projectId: c.projectId, code: c.code ?? null, doc: c.doc ?? null, drive: c.drive ?? null, product: c.product ?? null })),
      };
    },
  );

  app.post(
    "/proposals/:id/cancel",
    {
      config: { access: ACCESS, mcp: { action: "claude.cancelProposal", summary: "Rifiuta una proposta di Claude.", effect: "write" } },
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

  // Lotto 7, voce 1: l'esito di un'azione del renderer (pagina o bozza), per indice.
  app.post(
    "/proposals/:id/actions/:index/outcome",
    {
      config: { access: ACCESS, mcp: { action: "claude.actionOutcome", summary: "Registra l'esito di un'azione di una proposta che si fa sulla pagina (una pagina o una bozza scritte da chi guarda).", effect: "write" } },
      schema: {
        params: z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(1000) }),
        body: z.object({ status: claudePageOutcomeStatusSchema }),
        response: {
          200: claudePageOutcomeSchema,
          404: errorSchema,
          409: errorSchema.extend({ current: z.string() }),
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await settlePageOutcome(app.db, request.user!, request.params.id, request.params.index, request.body.status);
      if (result.ok) return result.outcome;
      if (result.error === "invalid_move") return reply.code(409).send({ code: "invalid_move", message: "Move not allowed", current: result.current });
      if (result.error === "not_found") return apiError(reply, 404, "not_found", "Proposal not found");
      return apiError(reply, 422, "not_a_page_action", "Not a page action");
    },
  );

  // Rimandi, lotto 4 (§5): «Riprova» del seguito di un `fillMailBody` non
  // salvato. Per indice nel gruppo (D-5.3 = a); il testo è quello salvato.
  app.post(
    "/groups/:id/actions/:index/retry",
    {
      config: { access: ACCESS, mcp: { action: "claude.retryEffect", summary: "Riprova il seguito non riuscito di un'azione di Claude (es. il salvataggio di una bozza su Gmail).", effect: "write" } },
      schema: {
        params: z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(1000) }),
        response: {
          200: claudeActionGroupViewSchema,
          404: errorSchema,
          409: errorSchema.extend({ reason: z.string().optional() }),
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const out = await retryActionEffect(app.db, request.user!, request.params.id, request.params.index, async (userId, args) => {
        const saved = await fillDraftBody(app.db, app.encryptionKey, app.mailComposeClient, await app.storage(), userId, args);
        return "error" in saved ? { error: saved.error } : {};
      });
      if (out.ok) return out.group;
      return reply.code(out.status).send({ code: out.code, message: out.code, ...(out.reason ? { reason: out.reason } : {}) });
    },
  );

  app.post(
    "/groups/:id/undo",
    {
      config: { access: ACCESS, mcp: { action: "claude.undo", summary: "Annulla un gruppo di azioni eseguite da Claude.", effect: "write" } },
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
