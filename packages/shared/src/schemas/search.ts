import { z } from "zod";
import { docPageKindSchema } from "./docs.js";
import { ticketStatusSchema } from "./ticket.js";

/**
 * Tipo di entità cercabile dalla ricerca globale (spotlight Cmd/K): ticket,
 * progetto, repository o pagina di documentazione. Fonte di verità condivisa
 * tra db (enum `search_entity`), server (validazione) e web (icone/gruppi).
 *
 * ⚠️ **La POSTA non è qui, ed è una scelta** (15 set 2026). Questo enum non è
 * «cosa si può cercare»: è cosa finisce nella CRONOLOGIA dei risultati
 * cliccati (`search_history`, che lo usa come colonna). Le conversazioni si
 * cercano — {@link searchMailHitSchema} — ma **non si registrano fra i
 * recenti**, per due motivi che valgono più della comodità:
 *
 *  1. una voce di cronologia porta con sé `title`/`subtitle`
 *     DENORMALIZZATI: registrare una conversazione significherebbe copiare
 *     l'oggetto di un'email in una SECONDA tabella, fuori da
 *     `email_messages` — e quindi fuori dalla potatura di `pruneOldEmails`.
 *     Un messaggio cancellato da Gmail e potato da noi lascerebbe il suo
 *     oggetto nei «recenti» per sempre;
 *  2. aggiungere un valore a questo enum significa un `ALTER TYPE` sul
 *     `search_entity` del database, cioè la trappola documentata in
 *     CLAUDE.md — e un binario più vecchio che rileggesse una riga
 *     `type='mail'` farebbe fallire la serializzazione di
 *     `/api/search/history`.
 *
 * Chi un domani volesse i recenti anche per la posta affronti il punto 1
 * PRIMA del punto 2: il problema vero è la copia che sopravvive alla
 * retention, non la migrazione.
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
 * Un risultato Docs della corsia SEMANTICA (lenta) — `GET /api/search/docs-semantic`.
 * Stesso shape del gruppo `docs` della corsia full-text ({@link searchDocHitSchema})
 * più uno `score` di rilevanza in [0, 1]: il client fonde questi risultati nel
 * gruppo Docs, usando lo `score` per ordinarli/deduplicarli con quelli full-text.
 */
export const searchDocSemanticHitSchema = searchDocHitSchema.extend({
  score: z.number(),
});
export type SearchDocSemanticHit = z.infer<typeof searchDocSemanticHitSchema>;

/**
 * Risposta della corsia semantica Docs (`GET /api/search/docs-semantic`): una
 * lista piatta di hit Docs con `score`. Best-effort: se l'embedding non è
 * disponibile o non ci sono Docs, è una lista vuota (mai un errore).
 */
export const searchDocsSemanticResultsSchema = z.array(searchDocSemanticHitSchema);
export type SearchDocsSemanticResults = z.infer<typeof searchDocsSemanticResultsSchema>;

/**
 * UNA CONVERSAZIONE di posta trovata (15 set 2026, design §3).
 *
 * ⚠️ **Si cercano CONVERSAZIONI, non messaggi.** La posta in Stubwise si legge
 * per conversazione dal 14 settembre: una ricerca che restituisse messaggi
 * sciolti riporterebbe indietro il modello che abbiamo appena tolto, e tre
 * righe per tre risposte dello stesso scambio. Un risultato porta alla
 * conversazione, e `matchedMessageId` dice QUALE messaggio ha combaciato, così
 * chi arriva non deve rileggere il thread per capire perché è comparso.
 *
 * ⚠️ **Questo gruppo è PRIVATO del proprietario della casella.** Il server lo
 * filtra su `google_accounts.user_id`, e nessun ruolo scavalca — nemmeno un
 * admin (audience `mailbox_owner`, fase 6). Non è un requisito di questa
 * fase: è un'invariante esistente che la ricerca non deve poter incrinare.
 *
 * `subject`/`from` sono testo NON FIDATO (li scrive chi manda l'email);
 * `snippet` viene da `ts_headline`, quindi contiene il markup `<mark>` di
 * Postgres e va reso con le stesse cautele degli altri snippet di questo file.
 */
export const searchMailHitSchema = z.object({
  threadId: z.string(),
  accountId: z.string(),
  accountEmail: z.string(),
  /** Oggetto del messaggio che ha combaciato. NON FIDATO. */
  subject: z.string().nullable(),
  /** Mittente del messaggio che ha combaciato. NON FIDATO. */
  from: z.string(),
  snippet: z.string(),
  /** Il messaggio che ha combaciato: serve a evidenziarlo dentro la conversazione. */
  matchedMessageId: z.string(),
  receivedAt: z.string(),
});
export type SearchMailHit = z.infer<typeof searchMailHitSchema>;

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
  /**
   * La POSTA (15 set 2026, design §3) — conversazioni, non messaggi, e solo
   * quelle delle caselle di CHI CHIEDE.
   *
   * `.default(...)` e non obbligatorio, come ogni campo nuovo in una risposta
   * che un client può leggere da un server più vecchio (CLAUDE.md, «solo
   * cambi additivi»). ⚠️ Sul WEB quel default non gira mai — `lib/api.ts` fa
   * un cast, non un `parse` — quindi il gruppo va difeso anche nel PUNTO DI
   * LETTURA con `?? []`, e la fixture del test che lo copre va lasciata senza
   * il campo apposta.
   */
  mail: group(searchMailHitSchema).default({ items: [], hasMore: false }),
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
