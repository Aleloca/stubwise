// L'allowlist (lettura e la sola scrittura) sta in `@stubwise/shared`
// (`chat-tool-routes.ts`): una fonte per server e golden.
import { agentSessions, chatChannels, claudeConversations, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
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
  // Area 10, F1 (review M6): un server porta l'hostname e i nomi dei servizi
  // che riporta l'agente dall'host: testo scritto fuori dal team.
  "/api/servers/by-code/:code",
  // Area 10, F1: una conversazione di supporto (la scrive il cliente) e i
  // messaggi di un canale (li scrive chiunque ne sia membro, anche un ospite).
  // Il dettaglio del canale (nome, descrizione) lo segna anch'esso: lo scrive
  // chi l'ha creato, e la lettura va sempre insieme ai messaggi.
  "/api/support/conversations/by-code/:code",
  "/api/chat/channels/:id",
  "/api/chat/channels/:id/messages",
  // Area 10, F1: una conversazione della posta e un appuntamento (li scrivono
  // mittenti e organizzatori, anche di fuori).
  "/api/me/mail/threads/:threadId",
  "/api/me/calendar/events/:id",
  // Area 10, F6: le note di una PR. La bozza viene dai commit (li scrive chi
  // ha accesso al repository, anche di fuori) e dai titoli delle task.
  "/api/repositories/:repositoryId/pulls/:prNumber/release-notes",
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


/**
 * Area 10, F1 (review I2 e I3): le letture di contenuto PERSONALE di chi
 * chiede — la sua posta, il suo calendario, un canale privato o un DM, una
 * automazione generale (la vede solo chi ha il permesso d'istanza). Valgono
 * SOLO in una conversazione libera PRIVATA: in una pubblica le leggerebbe
 * chiunque abbia `claude.public.view`, e in un turno di @Claude nella Chat la
 * risposta sta in un canale (ospiti compresi). `mailbox_owner` non include MAI
 * gli admin, e la posta non va mai in un canale condiviso (`mail-calendar.md`).
 * Una lettura riuscita segna la conversazione (`private_read_at`), che da lì
 * non si pubblica.
 */
export const CHAT_TOOL_PRIVATE_ROUTES: ReadonlySet<string> = new Set([
  "/api/me/mail/threads/:threadId",
  "/api/me/calendar/events/:id",
  // Area 10, review di F3–F8 (I1): la spesa del mese (totale e per progetto)
  // coi permessi di chi chiede — in una pubblica o in un canale la leggerebbe
  // chi non ha quei permessi.
  "/api/ai-usage/summary",
]);
const CHANNEL_ROUTES = new Set(["/api/chat/channels/:id", "/api/chat/channels/:id/messages"]);

/** La lettura è di contenuto personale? (Per un canale e un'automazione dipende dall'oggetto.) */
export async function isPrivateChatToolRead(db: Db, route: string, params: Record<string, unknown>): Promise<boolean> {
  if (CHAT_TOOL_PRIVATE_ROUTES.has(route)) return true;
  if (route === "/api/automations/:code") return /^AUT-/i.test(String(params["code"] ?? ""));
  if (CHANNEL_ROUTES.has(route)) {
    const id = String(params["id"] ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const [c] = await db.select({ kind: chatChannels.kind, visibility: chatChannels.visibility }).from(chatChannels).where(eq(chatChannels.id, id));
    return c !== undefined && (c.kind === "dm" || c.visibility === "private");
  }
  return false;
}

/**
 * Il turno è di una conversazione libera PRIVATA? Non basta la visibilità:
 * anche un turno di @Claude nella Chat ha la sua riga in `claude_conversations`,
 * privata di default, ma la sua risposta sta in un canale. Conta il tipo della
 * sessione (`free`).
 */
export async function isPrivateConversation(db: Db, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ visibility: claudeConversations.visibility, kind: agentSessions.kind })
    .from(claudeConversations)
    .innerJoin(agentSessions, eq(agentSessions.id, claudeConversations.sessionId))
    .where(eq(claudeConversations.sessionId, sessionId));
  return row?.kind === "free" && row.visibility === "private";
}
