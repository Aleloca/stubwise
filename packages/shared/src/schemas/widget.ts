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

/**
 * Lo STESSO filtro come lo legge un client (area 8, F3, review): senza i
 * tetti della scrittura. I limiti sono una regola di chi SCRIVE (il body);
 * nella risposta `readerSchema` non sa attraversare un array coi tetti
 * (`array(checks)`), e un client non deve rifiutare una risposta perché il
 * server ha alzato un limite.
 */
const widgetRepositoryFilterViewSchema = z.object({
  paths: z.array(z.string()).default([]),
  slugs: z.array(z.string()).default([]),
  kinds: z.array(docPageKindSchema).default([]),
});
const widgetRepositoryFiltersViewSchema = z.record(z.uuid(), widgetRepositoryFilterViewSchema).default({});

/** Body di create/update di un widget (API interna). Estende la config con identità e cap. */
/**
 * Un sito ammesso (area 8, F3, S16): l'origine come la manda il browser
 * nell'header `Origin`, `https://host[:porta]` (`http` solo per `localhost` e
 * `127.0.0.1`), niente percorso, query, frammento o credenziali. Si
 * normalizza (host minuscolo, porta di default tolta, `/` finale tolta).
 * `null` se non è un'origine valida.
 */
export function normalizeWidgetOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

export const WIDGET_MAX_ORIGINS = 20;

/** L'elenco dei siti ammessi: normalizzato e senza doppioni; vuoto = qualunque sito. */
export const widgetOriginsSchema = z
  .array(z.string().max(300))
  .max(WIDGET_MAX_ORIGINS)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      const origin = normalizeWidgetOrigin(raw);
      if (origin === null) {
        ctx.addIssue({ code: "custom", message: `not an origin: ${raw}` });
        return z.NEVER;
      }
      if (!out.includes(origin)) out.push(origin);
    }
    return out;
  });

export const widgetUpsertBodySchema = widgetSettingsSchema.extend({
  name: z.string().min(1).max(80),
  dailyMessageCap: dailyCapSchema,
  dailyTicketCap: dailyCapSchema,
  repositoryFilters: widgetRepositoryFiltersSchema,
  /**
   * I siti ammessi (S16). FACOLTATIVO (un client più vecchio non lo manda):
   * assente nella modifica = l'elenco resta com'è; nella creazione = vuoto.
   */
  origins: widgetOriginsSchema.optional(),
  /**
   * Area 8, «L'API per i siti»: «Solo clienti verificati». FACOLTATIVO come
   * `origins`: assente nella modifica = resta com'è; nella creazione = spento.
   * Acceso senza un segreto d'identità: 422 `identity_secret_missing`.
   */
  identityRequired: z.boolean().optional(),
});
export type WidgetUpsertBody = z.infer<typeof widgetUpsertBodySchema>;
export type WidgetUpsertInput = z.input<typeof widgetUpsertBodySchema>;

/**
 * Un widget come lo vede l'amministrazione (`/api/projects/:projectId/widgets`,
 * la web e, dall'area 8 F3, l'app): i campi del corpo più chiave, data e il
 * numero di conversazioni. La chiave è pubblica (sta nello snippet del sito).
 */
export const widgetAdminSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  key: z.string(),
  enabled: z.boolean(),
  enabledRepositoryIds: z.array(z.uuid()),
  // Filtro FINE per-repo: chiavi ⊆ enabledRepositoryIds (garantito in scrittura).
  repositoryFilters: widgetRepositoryFiltersViewSchema,
  title: z.string(),
  welcomeMessage: z.string(),
  // Istruzioni per il system prompt: interne, mai sulla superficie pubblica del widget.
  instructions: z.string(),
  accentColor: z.string(),
  language: z.string(),
  dailyMessageCap: z.number().int().nullable(),
  dailyTicketCap: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  conversationCount: z.number().int(),
  /** I siti ammessi (area 8, F3, S16, additivo): vuoto = qualunque sito. */
  origins: z.array(z.string()).default([]),
  /**
   * Area 8, «L'API per i siti» (additivi): se il widget ha un segreto
   * d'identità (il segreto non esce MAI da una lettura), quando è stato
   * generato l'ultima volta, e «Solo clienti verificati».
   */
  identitySecretSet: z.boolean().default(false),
  identitySecretRotatedAt: z.iso.datetime().nullable().default(null),
  identityRequired: z.boolean().default(false),
});
export type WidgetAdmin = z.infer<typeof widgetAdminSchema>;

/**
 * L'elenco: lo legge chi vede il progetto (come la web); `canManage` (area 8,
 * F3, additivo) dice se chi guarda ha `widget.manage` — l'app nasconde la
 * sezione senza. Default `false` per un server più vecchio.
 */
export const widgetListSchema = z.object({ widgets: z.array(widgetAdminSchema), canManage: z.boolean().default(false) });
export const widgetResultSchema = z.object({ widget: widgetAdminSchema });

/**
 * `POST /api/projects/:projectId/widgets/:widgetId/identity-secret` (area 8,
 * «L'API per i siti»): il segreto NUOVO, mostrato questa volta sola. Il
 * vecchio smette subito (D-5).
 */
export const widgetIdentitySecretResultSchema = z.object({ secret: z.string(), rotatedAt: z.iso.datetime() });
export type WidgetIdentitySecretResult = z.infer<typeof widgetIdentitySecretResultSchema>;

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
