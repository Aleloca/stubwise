import { z } from "zod";

/**
 * SCRIVERE (area 6, fetta 3): le bozze (di Gmail, D7 = b) e il loro
 * salvataggio. Forme di `/api/me/mail/drafts`. Ogni campo oltre l'identità ha
 * un default: un server di prima non ha queste rotte, uno più nuovo può
 * aggiungere campi.
 */

export const mailComposeModeSchema = z.enum(["new", "reply", "replyAll", "forward"]);
export type MailComposeMode = z.infer<typeof mailComposeModeSchema>;

export const mailComposeAddressSchema = z.object({
  email: z.string(),
  name: z.string().nullable().default(null),
});
export type MailComposeAddress = z.infer<typeof mailComposeAddressSchema>;

export const mailDraftAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sizeBytes: z.number().int(),
  driveFileId: z.uuid().nullable().default(null),
  as: z.enum(["copy", "link"]).default("copy"),
});

export const mailDraftSchema = z.object({
  /** Null = non ancora salvata (la «bozza di» una conversazione, già indirizzata). */
  id: z.uuid().nullable(),
  accountId: z.uuid(),
  /** Il thread Gmail; null = un'email nuova. */
  threadId: z.string().nullable().default(null),
  mode: mailComposeModeSchema,
  /** `email_messages.id` del messaggio a cui si risponde (o che si inoltra). */
  replyToMessageId: z.uuid().nullable().default(null),
  to: z.array(mailComposeAddressSchema).default([]),
  cc: z.array(mailComposeAddressSchema).default([]),
  subject: z.string().default(""),
  body: z.string().default(""),
  attachments: z.array(mailDraftAttachmentSchema).default([]),
  /** Rispondi cita il messaggio sotto (default sì); Inoltra sempre. */
  quote: z.boolean().default(true),
  updatedAt: z.string().nullable().default(null),
});
export type MailDraft = z.infer<typeof mailDraftSchema>;

export const mailDraftListSchema = z.object({ items: z.array(mailDraftSchema) });
export type MailDraftList = z.infer<typeof mailDraftListSchema>;

/** Il corpo di un salvataggio: crea o sostituisce la bozza dello slot. */
export const mailDraftSaveSchema = z.object({
  accountId: z.uuid(),
  threadId: z.string().max(200).nullable().default(null),
  mode: mailComposeModeSchema,
  replyToMessageId: z.uuid().nullable().default(null),
  to: z.array(z.object({ email: z.string().max(320), name: z.string().max(200).nullable().default(null) })).max(100).default([]),
  cc: z.array(z.object({ email: z.string().max(320), name: z.string().max(200).nullable().default(null) })).max(100).default([]),
  subject: z.string().max(1000).default(""),
  body: z.string().max(200_000).default(""),
  quote: z.boolean().default(true),
  /**
   * «Tieni la mia» dopo un `draft_changed`: scrive sopra la versione cambiata
   * da Gmail. Un gesto esplicito, mai il default (la bozza di Gmail non si
   * sovrascrive in silenzio).
   */
  overwrite: z.boolean().default(false),
});
export type MailDraftSave = z.input<typeof mailDraftSaveSchema>;

/** Il canale con cui il server sveglia il worker per un invio (D6). */
export const MAIL_OUTGOING_CHANNEL = "mail_outgoing";

/** Un invio (D6: il server lo trattiene 10 s). `messageId` è l'id dell'invio. */
export const mailOutgoingSchema = z.object({
  messageId: z.uuid(),
  threadId: z.string().nullable().default(null),
  state: z.enum(["queued", "sending", "sent", "failed", "cancelled"]),
  /** Fin quando si può annullare. */
  undoUntil: z.string(),
  /** Un fallimento, in un codice che si può dire: `address_not_found`, `quota`, `token_expired`, `other`. */
  error: z.string().nullable().default(null),
  sentAt: z.string().nullable().default(null),
});
export type MailOutgoing = z.infer<typeof mailOutgoingSchema>;

/** L'esito di Annulla e di Elimina un invio fallito: la bozza che torna. */
export const mailDraftRestoreSchema = z.object({
  draft: mailDraftSchema.nullable().default(null),
  /** Gli allegati che non sono tornati (oltre i limiti dopo un'unione). */
  droppedAttachments: z.array(z.string()).default([]),
});
export type MailDraftRestore = z.infer<typeof mailDraftRestoreSchema>;

/**
 * Un destinatario suggerito mentre si scrive un indirizzo (area 6, F3): prima
 * le persone del team che chi scrive vede (`team`, con `personId`), poi gli
 * indirizzi visti nelle SUE caselle (`mail`).
 */
export const mailRecipientSuggestionSchema = z.object({
  name: z.string().nullable().default(null),
  email: z.string(),
  personId: z.uuid().nullable().default(null),
  group: z.enum(["team", "mail"]),
});
export type MailRecipientSuggestion = z.infer<typeof mailRecipientSuggestionSchema>;
export const mailRecipientSuggestionListSchema = z.object({ items: z.array(mailRecipientSuggestionSchema).default([]) });
export type MailRecipientSuggestionList = z.infer<typeof mailRecipientSuggestionListSchema>;
