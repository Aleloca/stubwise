import { z } from "zod";
import { docPageKindSchema } from "./docs.js";

export const widgetTicketTypeSchema = z.enum(["bug", "feedback", "feature"]);
export type WidgetTicketType = z.infer<typeof widgetTicketTypeSchema>;

export const widgetLanguageSchema = z.enum(["it", "en"]);
export type WidgetLanguage = z.infer<typeof widgetLanguageSchema>;

export const widgetSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  enabledRepositoryIds: z.array(z.uuid()).max(200).default([]),
  title: z.string().min(1).max(80).default("Assistenza"),
  welcomeMessage: z.string().min(1).max(500).default("Ciao! Come posso aiutarti?"),
  // Istruzioni aggiuntive (testo libero, opzionale) iniettate nel system prompt
  // della chat per indirizzare le risposte; stringa vuota = nessuna istruzione.
  instructions: z.string().max(4000).default(""),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#22c55e"),
  language: widgetLanguageSchema.default("it"),
});
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

/** Cap giornaliero per-widget: null = usa il default d'istanza (env). */
const dailyCapSchema = z.number().int().min(1).max(100_000).nullable().default(null);

/**
 * Percorso relativo normalizzato dentro il repo: niente slash iniziale/finale,
 * niente `..` (fail-closed: un path malformato è un errore, non un filtro vuoto).
 */
const repoPathSchema = z
  .string()
  .min(1)
  .max(500)
  // Un segmento vuoto copre anche slash iniziale/finale e doppio slash (a//b).
  .refine((p) => {
    const segments = p.split("/");
    return segments.every((s) => s !== "" && s !== "." && s !== "..");
  }, "path non normalizzato o traversal");

/**
 * Filtro per-repo: prefissi di sourcePath, slug espliciti (pagine senza
 * percorso) e/o GRUPPI interi per `kind` (technical/functional/manual/releases).
 *
 * I `kinds` hanno semantica VIVA: selezionano un intero gruppo di pagine di
 * quel kind, incluse quelle FUTURE prodotte dalle rigenerazioni (a differenza di
 * `paths`/`slugs`, che sono liste esplicite congelate al momento della scelta).
 * Il match delle tre gambe è in OR (vedi retrieval): una pagina passa se combacia
 * con un prefisso path OPPURE è tra gli slug OPPURE è di uno dei kind selezionati.
 *
 * ⚠️ RETROCOMPATIBILITÀ: le entry jsonb già salvate NON hanno `kinds`. Il
 * `.default([])` copre il parse in lettura; il codice di retrieval usa comunque
 * `filter.kinds ?? []` per non assumerne la presenza sulle righe grezze.
 */
export const widgetRepositoryFilterSchema = z.object({
  paths: z.array(repoPathSchema).max(50).default([]),
  slugs: z.array(z.string().min(1).max(300)).max(100).default([]),
  kinds: z.array(docPageKindSchema).max(4).default([]),
});
export type WidgetRepositoryFilter = z.infer<typeof widgetRepositoryFilterSchema>;

/**
 * Mappa repositoryId → filtro. ⚠️ Il default `{}` = "nessun filtro, repo interi":
 * un PUT che OMETTE il campo azzera i filtri salvati (full-replacement, unica
 * direzione fail-open della feature). I client devono sempre inviare il campo
 * completo — la SPA lo fa (test anti-wipe in widgets-section.test.tsx).
 */
export const widgetRepositoryFiltersSchema = z
  .record(z.uuid(), widgetRepositoryFilterSchema)
  .default({});
export type WidgetRepositoryFilters = z.infer<typeof widgetRepositoryFiltersSchema>;

/** Body di create/update di un widget (API interna). Estende la config con identità e cap. */
export const widgetUpsertBodySchema = widgetSettingsSchema.extend({
  name: z.string().min(1).max(80),
  dailyMessageCap: dailyCapSchema,
  dailyTicketCap: dailyCapSchema,
  repositoryFilters: widgetRepositoryFiltersSchema,
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
