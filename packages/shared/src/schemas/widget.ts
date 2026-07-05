import { z } from "zod";

export const widgetTicketTypeSchema = z.enum(["bug", "feedback", "feature"]);
export type WidgetTicketType = z.infer<typeof widgetTicketTypeSchema>;

export const widgetLanguageSchema = z.enum(["it", "en"]);
export type WidgetLanguage = z.infer<typeof widgetLanguageSchema>;

export const widgetSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  enabledRepositoryIds: z.array(z.uuid()).max(200).default([]),
  title: z.string().min(1).max(80).default("Assistenza"),
  welcomeMessage: z.string().min(1).max(500).default("Ciao! Come posso aiutarti?"),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#22c55e"),
  language: widgetLanguageSchema.default("it"),
});
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

/** Cap giornaliero per-widget: null = usa il default d'istanza (env). */
const dailyCapSchema = z.number().int().min(1).max(100_000).nullable().default(null);

/** Body di create/update di un widget (API interna). Estende la config con identità e cap. */
export const widgetUpsertBodySchema = widgetSettingsSchema.extend({
  name: z.string().min(1).max(80),
  dailyMessageCap: dailyCapSchema,
  dailyTicketCap: dailyCapSchema,
});
export type WidgetUpsertBody = z.infer<typeof widgetUpsertBodySchema>;

export const widgetConversationCreateBodySchema = z.object({
  user: z.object({
    id: z.string().min(1).max(200),
    email: z.email().max(320).optional(),
    name: z.string().min(1).max(200).optional(),
  }),
});

export const widgetChatMessageBodySchema = z.object({
  content: z.string().min(1).max(2000),
  // Identità DICHIARATA dal sito ospite (non autenticata): serve a verificare
  // che la conversazione appartenga a questo utente, come per il GET storico.
  userId: z.string().min(1).max(200),
});

// PROPOSTA di ticket emessa dall'LLM nel sentinel della chat widget: solo il
// contenuto del ticket (title/body/type), SENZA identità utente.
export const widgetTicketProposalSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20_000),
  type: widgetTicketTypeSchema,
});
export type WidgetTicketProposal = z.infer<typeof widgetTicketProposalSchema>;

// CONFERMA del ticket dall'endpoint: la proposta + l'identità DICHIARATA dal
// sito ospite (non autenticata), per verificare che la conversazione appartenga
// a questo utente, come per chat e storico.
export const widgetTicketConfirmBodySchema = widgetTicketProposalSchema.extend({
  userId: z.string().min(1).max(200),
});
export type WidgetTicketConfirmBody = z.infer<typeof widgetTicketConfirmBodySchema>;
