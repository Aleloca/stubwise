import { z } from "zod";
import { CUSTOMER_STATUSES } from "../support/customer-status.js";
import { SUPPORT_STATE_ORDER } from "../support/state.js";
import { backlogItemStatusSchema } from "./backlog.js";

/**
 * Support: le conversazioni coi clienti nell'app (area 8, F3; forme concordate
 * con 94). La VISTA è quella del prototipo (`SupportConversationView`) più ciò
 * che il server sa e il prototipo no (il giudizio del controllo, l'esito-task,
 * la bozza in arrivo). Lo stato e ciò che chi guarda PUÒ fare li calcola il
 * server; il client legge, non deduce. Ogni campo facoltativo nasce con un
 * default che non concede niente (un server più vecchio: nessuna azione).
 */

export const supportStateSchema = z.enum(SUPPORT_STATE_ORDER as [string, ...string[]]);
export const supportChannelSchema = z.enum(["widget", "mcp"]);
export const supportMessageFromSchema = z.enum(["customer", "triage", "team"]);
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES as [string, ...string[]]);

export const supportMessageSchema = z.object({
  id: z.uuid(),
  /** Il cliente, l'AI del widget (il triage) o una persona del team. */
  from: supportMessageFromSchema,
  /** Chi del team ha scritto (`team`), per chi vede il progetto; null per gli altri. */
  authorId: z.uuid().nullable().default(null),
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
  /** L'identità che il sito ha dichiarato; senza nome: «Anonymous visitor». */
  customer: z
    .object({ name: z.string().nullable().default(null), email: z.string().nullable().default(null) })
    .default({ name: null, email: null }),
  /** Pieni nel dettaglio; `[]` nell'elenco e in «Clienti in attesa» (c'è `lastMessage`). */
  messages: z.array(supportMessageSchema).default([]),
  lastMessage: supportMessageSchema.nullable().default(null),
  state: supportStateSchema,
  /** Il primo messaggio del cliente rimasto senza risposta, se aspetta noi. */
  waitingSince: z.iso.datetime().nullable().default(null),
  /** Del triage rifatto (fuori dalla F3): null dal server. */
  rewrittenWish: z.string().nullable().default(null),
  confirmedAt: z.iso.datetime().nullable().default(null),
  /** Il giudizio sul triage senza esito: `byUserId` null = il controllo del worker, altrimenti chi ha premuto «Non conclusa». */
  triage: z
    .object({
      outcome: z.enum(["concluded", "not_concluded"]),
      at: z.iso.datetime(),
      byUserId: z.uuid().nullable().default(null),
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
  /** La bozza di Claude della conversazione: solo per chi ha `support.reply`, mai inviata da sola. */
  claudeDraft: z.string().nullable().default(null),
  claudeDraftAt: z.iso.datetime().nullable().default(null),
  /** Una bozza è in arrivo (una raffica del cliente, o «Ask Claude» accodato). */
  claudeDraftPending: z.boolean().default(false),
  following: z.boolean().default(false),
  canReply: z.boolean().default(false),
  /** La casella è chiusa anche a chi può rispondere: durante il triage risponde l'AI del widget (R-K15). */
  replyClosed: z.enum(["triage"]).nullable().default(null),
  /** «Apri la richiesta»: su una non conclusa, con `backlog.create`. */
  canOpenRequest: z.boolean().default(false),
  /** «Non conclusa»: su una `answered`, con `support.reply` (decisione del maintainer). */
  canMarkNotConcluded: z.boolean().default(false),
  /** «Scrivigli anche per email»: null se si può, altrimenti perché no. */
  emailBlocked: z.enum(["no_permission", "triage", "no_email", "no_mailbox"]).nullable().default(null),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
});
export type SupportConversation = z.infer<typeof supportConversationSchema>;

export const supportConversationListSchema = z.object({ items: z.array(supportConversationSchema) });

/** `GET …/by-code/:code/preview`: ESATTAMENTE ciò che vede il cliente. Mai un nome, una bozza, una stima, un commento. */
export const supportCustomerPreviewSchema = z.object({
  status: customerStatusSchema,
  messages: z.array(z.object({ from: z.enum(["customer", "us"]), body: z.string(), at: z.iso.datetime() })),
});
export type SupportCustomerPreview = z.infer<typeof supportCustomerPreviewSchema>;

/** `POST …/by-code/:code/replies`: «Send to customer». `clientId` rende un doppio invio uno solo. */
export const supportReplyBodySchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  clientId: z.uuid().optional(),
});
export type SupportReplyBody = z.infer<typeof supportReplyBodySchema>;

/** `PUT …/by-code/:code/follow`. */
export const supportFollowBodySchema = z.object({ on: z.boolean() });

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

/** `GET …/by-code/:code/email-draft`: i campi da aprire nella Posta. Il server non salva né invia. */
export const supportEmailDraftSchema = z.object({
  slot: z.string(),
  to: z.object({ name: z.string().nullable().default(null), email: z.string() }),
  subject: z.string(),
  body: z.string(),
});
export type SupportEmailDraft = z.infer<typeof supportEmailDraftSchema>;
