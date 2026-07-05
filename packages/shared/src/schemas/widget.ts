import { z } from "zod";

export const widgetTicketTypeSchema = z.enum(["bug", "feedback", "feature"]);
export type WidgetTicketType = z.infer<typeof widgetTicketTypeSchema>;

export const widgetLanguageSchema = z.enum(["it", "en"]);

export const widgetSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  enabledRepositoryIds: z.array(z.uuid()).default([]),
  title: z.string().min(1).max(80).default("Assistenza"),
  welcomeMessage: z.string().min(1).max(500).default("Ciao! Come posso aiutarti?"),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#22c55e"),
  language: widgetLanguageSchema.default("it"),
});
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

export const widgetConversationCreateBodySchema = z.object({
  user: z.object({
    id: z.string().min(1).max(200),
    email: z.email().max(320).optional(),
    name: z.string().min(1).max(200).optional(),
  }),
});

export const widgetChatMessageBodySchema = z.object({
  content: z.string().min(1).max(2000),
});

export const widgetTicketConfirmBodySchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20_000),
  type: widgetTicketTypeSchema,
});
