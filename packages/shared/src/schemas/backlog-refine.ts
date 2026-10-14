import { z } from "zod";
import { updateBacklogItemSchema } from "./backlog.js";

/**
 * Sessioni di refinement del backlog (design 2026-10-14): body delle rotte di
 * avvio e input dei tre tool con cui l'agente scrive sulla voce. I validatori
 * dei metadati sono QUELLI del `PATCH /api/backlog/:id`: mai due copie.
 */

/** Body di `POST /api/backlog/:id/refine-session`: il primo messaggio è facoltativo. */
export const startRefineSessionInputSchema = z.object({
  message: z.string().trim().min(1).max(4000).optional(),
});
export type StartRefineSessionInput = z.infer<typeof startRefineSessionInputSchema>;

export const startRefineSessionResultSchema = z.object({
  agentSessionId: z.uuid(),
  inputId: z.uuid().nullable(),
});
export type StartRefineSessionResult = z.infer<typeof startRefineSessionResultSchema>;

/** Tetto di design e piano: lo stesso di `setContentSchema`. */
export const REFINE_DOC_MAX_CHARS = 200_000;
export const refineSetDocInputSchema = z.object({
  markdown: z.string().min(1).max(REFINE_DOC_MAX_CHARS),
});

/** I metadati scrivibili dall'agente: il PATCH senza `status`, almeno un campo. */
export const refineUpdateItemInputSchema = updateBacklogItemSchema
  .omit({ status: true })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "at least one field is required",
  });
export type RefineUpdateItemInput = z.infer<typeof refineUpdateItemInputSchema>;

export const REFINE_MCP_SERVER_NAME = "stubwise_refine";
export const REFINE_TOOLS = ["set_design", "set_plan", "update_item"] as const;
export type RefineToolName = (typeof REFINE_TOOLS)[number];
/** I nomi da mettere in `allowedTools`: il CLI li chiama `mcp__<server>__<tool>`. */
export const REFINE_TOOL_NAMES: readonly string[] = REFINE_TOOLS.map(
  (tool) => `mcp__${REFINE_MCP_SERVER_NAME}__${tool}`,
);
