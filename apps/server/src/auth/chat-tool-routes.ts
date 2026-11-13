// L'allowlist (lettura e la sola scrittura) sta in `@stubwise/shared`
// (`chat-tool-routes.ts`): una fonte per server e golden.
export { CHAT_TOOL_READ_ROUTES, CHAT_TOOL_WRITE_ROUTES } from "@stubwise/shared";

/**
 * Le rotte di lettura che consegnano a Claude contenuto NON fidato, scritto da
 * altri (area 5, fetta 3, decisione O): il testo di un file del Drive (anche
 * nello snippet di una ricerca) e le pagine Docs, intere o negli snippet della
 * ricerca (le manuali le scrive chiunque abbia `docs.edit`). Una lettura RIUSCITA del token del turno su una
 * di queste segna la conversazione (`claude_conversations.untrusted_read_at`),
 * e da lì ogni proposta è almeno B (`claude-actions/proposals.ts`). Chi
 * aggiunge un tool che legge testo scritto da altri aggiunge qui la sua rotta.
 */
export const CHAT_TOOL_UNTRUSTED_ROUTES: ReadonlySet<string> = new Set([
  "/api/projects/:projectId/drive/files",
  "/api/drive/files/by-code/:code/content",
  "/api/repositories/:repositoryId/docs/pages/:slug",
  // Gli snippet della ricerca nei Docs: righe delle stesse pagine (decisione (a), 11 nov 2026).
  "/api/projects/:projectId/docs/search",
  // Area 6, F5a: il riassunto di una riunione registrata nasce da un Doc che
  // scrive chi ha accesso alla riunione: NON fidato. Oggi nessun tool di Claude
  // lo legge (non sono in `CHAT_TOOL_READ_ROUTES`); se un tool lo leggerà, la
  // lettura segna già la conversazione.
  "/api/me/meetings/:noteId",
  "/api/me/calendar/events/:id/summary",
  // Area 8, F1 (M): un rilascio porta testo scritto FUORI dal team — il titolo
  // della PR (anche di un esterno), i nomi e i passi delle run del provider di
  // CI, le note di rilascio. NON fidato: la lettura segna la conversazione.
  "/api/releases/:code",
]);

/**
 * Le letture di task e richieste (review della F3, decisione del maintainer):
 * segnano la conversazione SOLO se fra ciò che restituiscono c'è un oggetto
 * nato da FUORI — una task arrivata dal widget, dall'SDK o da un webhook
 * (`EXTERNAL_TICKET_SOURCES`), una richiesta nata da un'email in entrata
 * (`backlog_items.external_origin`) o da una di quelle task, o una task
 * convertita da una richiesta così. Quelle scritte dai colleghi no.
 */
export const CHAT_TOOL_EXTERNAL_CONTENT_ROUTES: ReadonlySet<string> = new Set([
  "/api/tasks",
  "/api/tasks/:id",
  "/api/tasks/by-code/:code",
  "/api/requests/:id",
  "/api/requests/by-code/:code",
]);
/** Le origini di una task che vengono da fuori del team (dall'area 6, F2, anche `email`: una task nata da una proposta della posta). */
export const EXTERNAL_TICKET_SOURCES = ["widget", "sdk_error", "sdk_feedback", "webhook", "email"] as const;

