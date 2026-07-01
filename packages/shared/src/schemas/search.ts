import { z } from "zod";
import { docPageKindSchema } from "./docs.js";
import { ticketStatusSchema } from "./ticket.js";

/**
 * Tipo di entità cercabile dalla ricerca globale (spotlight Cmd/K): ticket,
 * progetto, repository o pagina di documentazione. Fonte di verità condivisa
 * tra db (enum `search_entity`), server (validazione) e web (icone/gruppi).
 */
export const searchEntityTypeSchema = z.enum(["ticket", "project", "repository", "doc"]);
export type SearchEntityType = z.infer<typeof searchEntityTypeSchema>;

/**
 * Un ticket trovato dalla corsia full-text: il numero (per-progetto), lo stato,
 * lo snippet evidenziato (`ts_headline`) e il nome del progetto per il contesto.
 * `id` per navigare a `/tickets/:id`.
 */
export const searchTicketHitSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  status: ticketStatusSchema,
  snippet: z.string(),
  projectId: z.string(),
  projectName: z.string(),
});
export type SearchTicketHit = z.infer<typeof searchTicketHitSchema>;

/**
 * Un progetto trovato (match su nome/slug/descrizione): id/slug per la route e
 * uno snippet dalla descrizione (nullable se il progetto non ne ha).
 */
export const searchProjectHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  snippet: z.string().nullable(),
});
export type SearchProjectHit = z.infer<typeof searchProjectHitSchema>;

/**
 * Un repository trovato (match su nome/slug/repoUrl): id/slug per la route,
 * `projectId` per il contesto e l'URL del repo come snippet.
 */
export const searchRepositoryHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  projectId: z.string(),
  repoUrl: z.string(),
});
export type SearchRepositoryHit = z.infer<typeof searchRepositoryHitSchema>;

/**
 * Una pagina di documentazione trovata dal full-text: slug/kind per la route,
 * snippet evidenziato (`ts_headline`) e il repository di appartenenza (per
 * mostrare da quale spazio Docs proviene, in scope globale).
 */
export const searchDocHitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  snippet: z.string(),
  repositoryId: z.string(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});
export type SearchDocHit = z.infer<typeof searchDocHitSchema>;

/**
 * Un gruppo di risultati (per tipo): i primi N item e `hasMore` se il full-text
 * ne ha trovati altri oltre la finestra restituita.
 */
function group<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), hasMore: z.boolean() });
}

/**
 * Risposta della corsia full-text federata (`GET /api/search`): i 4 gruppi,
 * ognuno con i suoi item e `hasMore`. In scope Docs solo `docs` è ristretto al
 * repository; gli altri gruppi restano globali.
 */
export const searchResultsSchema = z.object({
  tickets: group(searchTicketHitSchema),
  projects: group(searchProjectHitSchema),
  repositories: group(searchRepositoryHitSchema),
  docs: group(searchDocHitSchema),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;

/**
 * Una voce della cronologia unificata dei risultati cliccati: denormalizzata
 * (title/subtitle/route) per il render diretto senza join. `clickedAt` è una
 * ISO string. `repositoryId` valorizzato per le voci Docs (filtro in scope).
 */
export const searchHistoryItemSchema = z.object({
  type: searchEntityTypeSchema,
  entityId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  route: z.string(),
  repositoryId: z.string().nullable(),
  clickedAt: z.string(),
});
export type SearchHistoryItem = z.infer<typeof searchHistoryItemSchema>;

/**
 * Body per registrare (upsert) un risultato cliccato nella cronologia. `route`
 * e `title` non vuoti; `subtitle`/`repositoryId` opzionali.
 */
export const recordSearchHistoryBodySchema = z.object({
  type: searchEntityTypeSchema,
  entityId: z.string().min(1).max(300),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).nullable().optional(),
  route: z.string().min(1).max(500),
  repositoryId: z.uuid().nullable().optional(),
});
export type RecordSearchHistoryBody = z.infer<typeof recordSearchHistoryBodySchema>;
