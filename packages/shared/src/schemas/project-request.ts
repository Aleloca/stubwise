import { z } from "zod";
import { backlogItemStatusSchema, backlogJobStatusSchema, backlogUrgencySchema } from "./backlog.js";
import { taskSizeSchema } from "./task-view.js";

/**
 * Una richiesta da trasformare in task (integrazione area 2, fetta 3): la
 * forma minima di `ProjectRequest` del prototipo che servono a «Da decidere»
 * e al blocco «Richieste nuove» della Home. La sezione Requests arriva con la
 * fetta 4: fino ad allora la voce si apre nel web vecchio (`webHref`).
 */
export const requestToConvertViewSchema = z.object({
  id: z.uuid(),
  /** `<PROGETTO>-R<n>`: il numero di catalogo della voce (contatore del progetto, mai riusato). */
  code: z.string(),
  projectId: z.uuid(),
  title: z.string(),
  status: backlogItemStatusSchema,
  /** La scala dei ticket (low/medium/high/urgent); null se non stimata. */
  urgency: backlogUrgencySchema.nullable(),
  requesterIds: z.array(z.uuid()).default([]),
  requestCount: z.number().int().default(1),
  createdAt: z.iso.datetime(),
  /** La voce nel web vecchio. */
  webHref: z.string(),
});
export type RequestToConvertView = z.infer<typeof requestToConvertViewSchema>;

/** Il livello del prototipo (urgenza, rischio): tre gradi. `urgent` del server si legge `high` + `urgent: true`. */
export const requestLevelSchema = z.enum(["low", "medium", "high"]);

/**
 * Una richiesta come la mostra l'app nuova (integrazione area 2, fetta 4): la
 * forma di `ProjectRequest` del prototipo sopra una voce di backlog. Il codice
 * è il numero di catalogo vero (`<PROGETTO>-R<n>`, 0121); `description` è il
 * testo della richiesta e `design` il design scritto dopo (quando il design ha
 * sostituito il corpo, il corpo originale è `description`).
 */
export const projectRequestViewSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  projectId: z.uuid(),
  title: z.string(),
  description: z.string(),
  requesterIds: z.array(z.uuid()).default([]),
  status: backlogItemStatusSchema,
  /** null: non stimata (il prototipo la mostra «medium»). */
  urgency: requestLevelSchema.nullable(),
  /** L'urgenza del server è `urgent` (la più alta, oltre `high`): l'app la segna senza perderla. */
  urgent: z.boolean().default(false),
  size: taskSizeSchema.nullable().default(null),
  risk: requestLevelSchema.nullable().default(null),
  riskNote: z.string().nullable().default(null),
  design: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  similarToId: z.uuid().nullable().default(null),
  mergedIntoId: z.uuid().nullable().default(null),
  mergedIntoCode: z.string().nullable().default(null),
  taskIds: z.array(z.uuid()).default([]),
  createdAt: z.iso.datetime(),
  /** Le proposte dell'intake ancora da decidere (testo dell'AI), o null. */
  suggestions: z
    .object({
      urgency: requestLevelSchema.optional(),
      size: taskSizeSchema.optional(),
      risk: requestLevelSchema.optional(),
      riskNote: z.string().optional(),
      reason: z.string().default(""),
    })
    .nullable()
    .default(null),
  webHref: z.string(),
});
export type ProjectRequestView = z.infer<typeof projectRequestViewSchema>;

/** Quanti caratteri della descrizione porta l'elenco. */
export const REQUEST_EXCERPT_LENGTH = 300;

/**
 * Una richiesta nell'ELENCO (`GET /api/requests`): la vista senza i testi
 * interi — descrizione, design e piano li porta solo il dettaglio. Al loro
 * posto i primi {@link REQUEST_EXCERPT_LENGTH} caratteri della descrizione e
 * se design e piano ci sono.
 */
export const projectRequestSummarySchema = projectRequestViewSchema
  .omit({ description: true, design: true, plan: true })
  .extend({
    excerpt: z.string().default(""),
    hasDesign: z.boolean().default(false),
    hasPlan: z.boolean().default(false),
  });
export type ProjectRequestSummary = z.infer<typeof projectRequestSummarySchema>;

/** Corpo di `POST /api/requests`: come oggi passa dall'intake, che può fonderla in una esistente. */
export const newRequestBodySchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).default(""),
});
export type NewRequestBody = z.infer<typeof newRequestBodySchema>;

/** L'esito dell'intake di una richiesta creata dall'app: nuova, o fusa in una esistente. */
export const requestJobViewSchema = z.object({
  /** Lo stato del job di intake: lo stesso enum dei job di backlog, non una copia. */
  status: backlogJobStatusSchema,
  /** null finché il job non è finito (o se è fallito). */
  outcome: z.enum(["created", "merged"]).nullable(),
  request: projectRequestViewSchema.nullable(),
});
export type RequestJobView = z.infer<typeof requestJobViewSchema>;

/** Corpo di `PATCH /api/requests/:id`: titolo, descrizione e metadati; gli assenti restano. */
export const requestPatchBodySchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  /** Il testo della richiesta (non il design). */
  description: z.string().max(100_000).optional(),
  urgency: requestLevelSchema.optional(),
  size: taskSizeSchema.nullable().optional(),
  risk: requestLevelSchema.nullable().optional(),
  riskNote: z.string().trim().max(2000).nullable().optional(),
});
export type RequestPatchBody = z.infer<typeof requestPatchBodySchema>;
