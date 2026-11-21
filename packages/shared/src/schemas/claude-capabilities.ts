import { z } from "zod";

/**
 * Area 10, F7 (S0, D-1 = a): ciò che Claude sa fare, come id del prototipo
 * (`domain/claude/intents/general.ts`, `CAPABILITIES`). Le frasi restano del
 * renderer. F7-1 = a (maintainer): SOLO le capacità che il server sa fare; le
 * `product*` della doc di prodotto arrivano con l'area 11, e un renderer salta
 * gli id che non riceve (o che non conosce: `readerSchema` li legge
 * `UNKNOWN`).
 */
export const CLAUDE_CAPABILITY_IDS = [
  "automation",
  "stalled",
  "spend",
  "archive",
  "addMember",
  "releaseNotes",
  "mailBody",
  "taskDescription",
  // Area 11, F6: la doc di prodotto. Le prime tre con `docs.edit` in almeno un
  // progetto, `productBacklog` con `backlog.create`, `productChanges` con `docs.view`.
  "productFirstVersion",
  "productUpdate",
  "productBacklog",
  "productWireframe",
  "productChanges",
] as const;
export const claudeCapabilityIdSchema = z.enum(CLAUDE_CAPABILITY_IDS);
export type ClaudeCapabilityId = z.infer<typeof claudeCapabilityIdSchema>;

/**
 * `GET /api/claude/capabilities` e il `data` dell'evento `capabilities`: le
 * capacità di CHI CHIEDE, dai permessi veri (una c'è solo se la sua azione
 * passerebbe), nell'ordine del prototipo.
 */
export const claudeCapabilitiesSchema = z.object({ items: z.array(claudeCapabilityIdSchema) });
export type ClaudeCapabilities = z.infer<typeof claudeCapabilitiesSchema>;

/**
 * Area 10, F7 (D-5 = a): le righe «Claude can help you…». Le pagine sono
 * quattro (la conversazione di supporto è fuori: premessa del maintainer del
 * 14 nov 2026). `objectId`: `<repositoryId>:<prNumber>` per la PR, l'id del
 * progetto per Automations e Overview, nessuno per Usage.
 */
export const CLAUDE_SUGGESTION_PAGES = ["pr", "automations", "overview", "usage"] as const;
export const claudeSuggestionPageSchema = z.enum(CLAUDE_SUGGESTION_PAGES);
export type ClaudeSuggestionPage = z.infer<typeof claudeSuggestionPageSchema>;

export const CLAUDE_SUGGESTION_KINDS = ["releaseNotes", "buildAutomation", "whyStalled", "monthSpend"] as const;
export const claudeSuggestionKindSchema = z.enum(CLAUDE_SUGGESTION_KINDS);
export type ClaudeSuggestionKind = z.infer<typeof claudeSuggestionKindSchema>;

export const claudeSuggestionQuerySchema = z.object({
  page: claudeSuggestionPageSchema,
  objectId: z.string().trim().min(1).max(200).optional(),
});

/**
 * La riga per chi guarda, o `null`: nessuna riga (anche per un oggetto che non
 * vede: mai 404, la riga non è un oracolo). `params`: il solo codice
 * dell'oggetto (`{ code }`), per la frase del renderer. `suggestionId`: la
 * chiave del «Not now» (`<kind>:<objectId>`).
 */
export const claudeSuggestionSchema = z
  .object({
    suggestionId: z.string(),
    kind: claudeSuggestionKindSchema,
    page: claudeSuggestionPageSchema,
    objectId: z.string(),
    params: z.record(z.string(), z.string()).default({}),
  })
  .nullable();
export type ClaudeSuggestion = z.infer<typeof claudeSuggestionSchema>;

/** `POST /api/claude/suggestions/dismiss`: «Not now», per chi guarda, su quell'oggetto. */
export const dismissClaudeSuggestionSchema = z.object({
  kind: claudeSuggestionKindSchema,
  objectId: z.string().trim().max(200).default(""),
});
