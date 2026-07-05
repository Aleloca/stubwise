/**
 * Client HTTP minimale verso la superficie pubblica del widget
 * (`<origin>/widget/<slug>/...`, vedi `apps/server/src/routes/widget.ts`).
 *
 * Ogni richiesta porta l'header `X-Stubwise-Key` (autentica il PROGETTO, non
 * l'utente: la chiave è pubblica nel sorgente della pagina ospite, come l'SDK di
 * ingestion). Le shape di risposta sono allineate ai contratti Zod del server.
 */
import type { WidgetDsn } from "./dsn.js";

/** Base di chiamata: coordinate del backend risolte dal DSN. */
export type WidgetApiBase = WidgetDsn;

/** Config pubblica del widget: spento, oppure attivo coi campi di rendering. */
export type WidgetConfig =
  | { enabled: false }
  | {
      enabled: true;
      title: string;
      welcomeMessage: string;
      accentColor: string;
      language: "it" | "en";
      chatEnabled: boolean;
    };

/** Identità DICHIARATA dal sito ospite (non autenticata). */
export interface WidgetUser {
  id: string;
  email?: string;
  name?: string;
}

/** Messaggio dello storico conversazione (GET messages). */
export interface WidgetMessage {
  id: string;
  role: string;
  content: string;
  /** Riferimenti Docs della risposta RAG: forma libera (jsonb), può essere null. */
  citations: unknown;
  ticketId: string | null;
  createdAt: string;
}

/** Corpo di conferma di un ticket dal widget (proposta + utente). */
export interface WidgetTicketConfirm {
  title: string;
  body: string;
  type: "bug" | "feedback" | "feature";
  userId: string;
}

/**
 * Errore di un endpoint widget con status e codice applicativo del server
 * (es. `widget_chat_cap_reached`, `widget_ticket_cap_reached`, `widget_disabled`,
 * `conversation_not_found`, `chat_unavailable`, `invalid_ingestion_key`). Il
 * chiamante mappa `status`/`code` su messaggi utente attuabili.
 */
export class WidgetApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code?: string, message?: string) {
    super(message ?? code ?? `HTTP ${status}`);
    this.name = "WidgetApiError";
    this.status = status;
    this.code = code;
  }
}

/** URL di una route pubblica del widget a partire dalla base. */
function url(base: WidgetApiBase, path: string): string {
  return `${base.origin}/widget/${base.slug}${path}`;
}

/** Header comuni: chiave del progetto + (per i POST con body) content-type JSON. */
function headers(base: WidgetApiBase, json: boolean): HeadersInit {
  const h: Record<string, string> = { "X-Stubwise-Key": base.key };
  if (json) h["content-type"] = "application/json";
  return h;
}

/**
 * Legge il codice d'errore applicativo dal body (best effort) e lancia un
 * {@link WidgetApiError}. Il body d'errore del server è `{ code, message }`
 * (vedi `apps/server/src/errors.ts#apiError`); gli errori di validazione Zod
 * (422) non hanno `code`.
 */
async function throwApiError(response: Response): Promise<never> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const data = (await response.json()) as { code?: string; message?: string };
    code = data.code;
    message = data.message;
  } catch {
    // body non-JSON o vuoto: si lancia comunque con lo status
  }
  throw new WidgetApiError(response.status, code, message);
}

/** GET /widget/:slug/config → config pubblica (spento o attivo). */
export async function fetchConfig(base: WidgetApiBase): Promise<WidgetConfig> {
  const response = await fetch(url(base, "/config"), {
    method: "GET",
    headers: headers(base, false),
  });
  if (!response.ok) await throwApiError(response);
  return (await response.json()) as WidgetConfig;
}

/** POST /widget/:slug/conversations → apre/riprende una conversazione. */
export async function createConversation(
  base: WidgetApiBase,
  user: WidgetUser,
): Promise<{ conversationId: string }> {
  const response = await fetch(url(base, "/conversations"), {
    method: "POST",
    headers: headers(base, true),
    body: JSON.stringify({ user }),
  });
  if (!response.ok) await throwApiError(response);
  return (await response.json()) as { conversationId: string };
}

/** GET /widget/:slug/conversations/:id/messages?userId= → storico cronologico. */
export async function fetchMessages(
  base: WidgetApiBase,
  conversationId: string,
  userId: string,
): Promise<{ messages: WidgetMessage[] }> {
  const query = new URLSearchParams({ userId });
  const response = await fetch(
    url(base, `/conversations/${conversationId}/messages?${query.toString()}`),
    { method: "GET", headers: headers(base, false) },
  );
  if (!response.ok) await throwApiError(response);
  return (await response.json()) as { messages: WidgetMessage[] };
}

/**
 * POST /widget/:slug/conversations/:id/messages → invia un messaggio utente.
 * Ritorna la Response GREZZA per il consumo dello stream SSE (vedi
 * {@link ./sse.ts#parseSseStream}); lancia {@link WidgetApiError} sugli errori
 * PRIMA dello stream (401/404/429/503).
 */
export async function sendMessage(
  base: WidgetApiBase,
  conversationId: string,
  input: { content: string; userId: string },
): Promise<Response> {
  const response = await fetch(url(base, `/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: headers(base, true),
    body: JSON.stringify(input),
  });
  if (!response.ok) await throwApiError(response);
  return response;
}

/** POST /widget/:slug/conversations/:id/tickets → conferma un ticket. */
export async function confirmTicket(
  base: WidgetApiBase,
  conversationId: string,
  body: WidgetTicketConfirm,
): Promise<{ ticketId: string; number: number }> {
  const response = await fetch(url(base, `/conversations/${conversationId}/tickets`), {
    method: "POST",
    headers: headers(base, true),
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwApiError(response);
  return (await response.json()) as { ticketId: string; number: number };
}
