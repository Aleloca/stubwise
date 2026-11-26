import { z } from "zod";
import { personRefSchema } from "./person-ref.js";
import { CUSTOMER_STATUSES } from "../support/customer-status.js";
import { SUPPORT_STATE_ORDER } from "../support/state.js";
import { backlogItemStatusSchema } from "./backlog.js";

/**
 * Support: le conversazioni coi clienti nell'app (area 8, F3; forme concordate
 * con 94). La VISTA è quella del prototipo (`SupportConversationView`) più ciò
 * che il server sa e il prototipo no (il giudizio del controllo, l'esito-task,
 * la successiva di una chiusa). Lo stato e ciò che chi guarda PUÒ fare li
 * calcola il server; il client legge, non deduce. Ogni campo facoltativo nasce
 * con un default che non concede niente (un server più vecchio: nessuna
 * azione). La premessa (maintainer, 14 nov 2026): il team non scrive MAI al
 * cliente del widget; risponde solo al collaboratore del canale `mcp`.
 */

export const supportStateSchema = z.enum(SUPPORT_STATE_ORDER as [string, ...string[]]);
export const supportChannelSchema = z.enum(["widget", "mcp"]);
export const supportMessageFromSchema = z.enum(["customer", "triage", "team"]);
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES as [string, ...string[]]);

export const supportMessageSchema = z.object({
  id: z.uuid(),
  /** Il cliente, l'AI del widget (il triage) o una persona del team (solo canale `mcp`). */
  from: supportMessageFromSchema,
  /** Chi del team ha scritto (`team`), per chi vede il progetto; null per gli altri. */
  authorId: personRefSchema.nullable().default(null),
  body: z.string(),
  at: z.iso.datetime(),
});
export type SupportMessage = z.infer<typeof supportMessageSchema>;

export const supportConversationSchema = z.object({
  id: z.uuid(),
  /** `<PRJ>-S<n>`, per progetto, mai riusato. */
  code: z.string(),
  projectId: z.uuid(),
  projectCode: z.string(),
  channel: supportChannelSchema,
  widgetId: z.uuid().nullable().default(null),
  widgetName: z.string().nullable().default(null),
  /**
   * Area 8, «L'API per i siti» (additivo): il cliente è FIRMATO dal sito
   * (token d'identità valido all'apertura) e non solo dichiarato.
   */
  identityVerified: z.boolean().default(false),
  /** L'identità che il sito ha dichiarato; senza nome: «Anonymous visitor». */
  customer: z
    .object({ name: z.string().nullable().default(null), email: z.string().nullable().default(null) })
    .default({ name: null, email: null }),
  /** Pieni nel dettaglio; `[]` nell'elenco (c'è `lastMessage`). */
  messages: z.array(supportMessageSchema).default([]),
  lastMessage: supportMessageSchema.nullable().default(null),
  state: supportStateSchema,
  /** Del triage rifatto (fuori dalla F3): null dal server. */
  rewrittenWish: z.string().nullable().default(null),
  confirmedAt: z.iso.datetime().nullable().default(null),
  /** Il giudizio sul triage senza esito: `byUserId` null = il controllo del worker, altrimenti chi ha premuto «Non conclusa». */
  triage: z
    .object({
      outcome: z.enum(["concluded", "not_concluded"]),
      at: z.iso.datetime(),
      byUserId: personRefSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
  /** La richiesta nata dalla conversazione. */
  request: z
    .object({
      id: z.uuid(),
      code: z.string(),
      title: z.string(),
      description: z.string(),
      status: backlogItemStatusSchema,
      customerStatus: customerStatusSchema,
    })
    .nullable()
    .default(null),
  /** L'esito è un TICKET aperto dal widget (F3-1): il blocco mostra la task. */
  task: z
    .object({ id: z.uuid(), code: z.string(), title: z.string(), customerStatus: customerStatusSchema })
    .nullable()
    .default(null),
  /** «Apri la richiesta»: su una non conclusa, con `support.manage` e `backlog.create`. */
  canOpenRequest: z.boolean().default(false),
  /** «Non conclusa»: su una `answered`, con `support.manage` (decisione del maintainer). */
  canMarkNotConcluded: z.boolean().default(false),
  /** La risposta al collaboratore: SOLO sul canale `mcp`, con `support.manage`. */
  canReplyToCollaborator: z.boolean().default(false),
  /** Chiusa (un esito) e un messaggio dopo del cliente: la conversazione che l'ha seguita. */
  continuedIn: z.object({ code: z.string() }).nullable().default(null),
  /** La conversazione chiusa da cui questa è nata. */
  continuedFrom: z.object({ code: z.string() }).nullable().default(null),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
});
export type SupportConversation = z.infer<typeof supportConversationSchema>;

/**
 * ⌘K (rimandi, lotto 5): una conversazione trovata per codice (`ACQ-S2`) o
 * cliente, nei progetti che chi cerca vede — la forma del prototipo
 * (`SupportSearchResult` di `data/support/reads.ts`) con `projectCode` al
 * posto di `route`: il link lo fa il client (`supportHref(projectId, code)`).
 * Il «desiderio riscritto» non c'è sul server (`rewrittenWish` è sempre null),
 * quindi non si cerca.
 */
export const supportSearchResultSchema = z.object({
  kind: z.literal("support"),
  id: z.uuid(),
  code: z.string(),
  /** Il nome del cliente, o la sua email, o il codice. */
  label: z.string(),
  projectId: z.uuid(),
  projectCode: z.string(),
  state: supportStateSchema,
});
export type SupportSearchResult = z.infer<typeof supportSearchResultSchema>;

export const supportConversationListSchema = z.object({ items: z.array(supportConversationSchema) });

/** `GET …/by-code/:code/preview`: ESATTAMENTE ciò che vede il cliente. Mai un nome, una stima, un commento. */
export const supportCustomerPreviewSchema = z.object({
  status: customerStatusSchema,
  messages: z.array(z.object({ from: z.enum(["customer", "us"]), body: z.string(), at: z.iso.datetime() })),
});
export type SupportCustomerPreview = z.infer<typeof supportCustomerPreviewSchema>;

/** `POST …/by-code/:code/replies`: la risposta al collaboratore (solo canale `mcp`). `clientId` rende un doppio invio uno solo. */
export const supportReplyBodySchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  clientId: z.uuid().optional(),
});
export type SupportReplyBody = z.infer<typeof supportReplyBodySchema>;

/** `POST …/by-code/:code/request`: «Apri la richiesta» su una non conclusa. */
export const supportOpenRequestBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).default(""),
});
export type SupportOpenRequestBody = z.input<typeof supportOpenRequestBodySchema>;

export const supportOpenRequestResultSchema = z.object({
  conversation: supportConversationSchema,
  request: z.object({ id: z.uuid(), code: z.string() }),
});

/**
 * Area 8, «L'API per i siti» (`GET /widget/:slug/me/requests`): una richiesta
 * o un ticket del cliente FIRMATO dal sito, come lo vede lui. La forma è
 * CHIUSA (un test ne fissa le chiavi): mai nomi del team, stime, commenti,
 * titoli o codici interni. `label` sono le parole del cliente (il suo primo
 * messaggio, al più 140 caratteri), testo NON FIDATO per il sito; `code` è
 * quello della sua conversazione (`<PRJ>-S<n>`).
 */
export const siteRequestSchema = z.object({
  code: z.string(),
  kind: z.enum(["request", "ticket"]),
  label: z.string(),
  status: customerStatusSchema,
  statusLabel: z.string(),
  openedAt: z.iso.datetime(),
});
export type SiteRequest = z.infer<typeof siteRequestSchema>;

export const siteRequestListSchema = z.object({
  items: z.array(siteRequestSchema),
  total: z.number().int().default(0),
});
export type SiteRequestList = z.infer<typeof siteRequestListSchema>;

/** Il dettaglio: la riga e i messaggi della SUA conversazione col widget (cliente ↔ AI). */
export const siteRequestDetailSchema = siteRequestSchema.extend({
  messages: z.array(z.object({ from: z.enum(["customer", "assistant"]), body: z.string(), at: z.iso.datetime() })),
});
export type SiteRequestDetail = z.infer<typeof siteRequestDetailSchema>;
