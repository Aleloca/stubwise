import type { ZodType } from "zod";
import { ApiError, errorFromResponse } from "./errors.js";
import { createAuthEndpoints } from "./endpoints/auth.js";
import { createBacklogEndpoints } from "./endpoints/backlog.js";
import { createDocsEndpoints } from "./endpoints/docs.js";
import { createInboxEndpoints } from "./endpoints/inbox.js";
import { createMeEndpoints } from "./endpoints/me.js";
import { createProjectsEndpoints } from "./endpoints/projects.js";
import { createSearchEndpoints } from "./endpoints/search.js";
import { createTicketsEndpoints } from "./endpoints/tickets.js";

/**
 * L'init di `fetch` DERIVATO dal `fetch` dell'ambiente, invece di nominare
 * `RequestInit`: quel nome esiste nella `lib.dom` del browser e nei tipi di
 * Node, ma non è garantito ovunque questo pacchetto venga compilato — React
 * Native su tutte. Derivandolo, il tipo è sempre quello del `fetch` che il
 * client userà davvero.
 */
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Firma del trasporto: un solo punto in cui passano metodo, path, corpo e — se
 * c'è — lo schema di risposta. Gli endpoint la ricevono e non conoscono altro
 * del client (né `fetch`, né la baseUrl, né come si ottiene il token).
 *
 * `schema` è OPZIONALE, ed è la scelta centrale del pacchetto:
 * - passato → `schema.parse` sulla risposta, cioè fail-fast. Si passa solo dove
 *   il server dichiara lo STESSO schema come risposta della rotta: il
 *   serializzatore Zod di Fastify ci fa passare ogni payload prima di
 *   spedirlo, quindi la forma sul filo È quella dello schema per costruzione e
 *   una `parse` lato client non può fallire su una risposta legittima;
 * - omesso → il JSON grezzo con un cast, esattamente ciò che la SPA fa oggi.
 *   È la corsia che `apps/web` usa per le ~40 rotte che qui non sono mappate:
 *   adottare il client non deve poter cambiare cosa vede un utente del web.
 */
export interface ApiRequest {
  <T>(method: HttpMethod, path: string, body?: unknown, schema?: ZodType<T>): Promise<T>;
}

export interface StubwiseClientOptions {
  /**
   * Radice dell'istanza, SENZA il prefisso `/api` (che è nei path degli
   * endpoint). Stringa vuota per un client same-origin come la SPA; un'origine
   * completa (`https://stubwise.example`) per l'app mobile.
   */
  baseUrl: string;
  /**
   * Valore dell'header `authorization`, o `null` per non mandarlo. È una
   * funzione (anche asincrona) e non una stringa perché il token dell'app
   * mobile vive nel keychain e può cambiare fra due richieste; la SPA, che si
   * autentica col cookie di sessione, ritorna `null`.
   */
  getAuthHeader: () => string | null | undefined | Promise<string | null | undefined>;
  /** Iniettabile per i test e per gli ambienti senza `fetch` globale. */
  fetch?: typeof globalThis.fetch;
  /**
   * Passato a `fetch` solo se definito: la SPA usa `"include"` per il cookie
   * httpOnly, l'app mobile non ha cookie e non deve mandare l'opzione affatto.
   */
  credentials?: "omit" | "same-origin" | "include";
}

export interface StubwiseClient {
  /** Trasporto grezzo, per le rotte che questo pacchetto non mappa. */
  request: ApiRequest;
  auth: ReturnType<typeof createAuthEndpoints>;
  inbox: ReturnType<typeof createInboxEndpoints>;
  me: ReturnType<typeof createMeEndpoints>;
  projects: ReturnType<typeof createProjectsEndpoints>;
  tickets: ReturnType<typeof createTicketsEndpoints>;
  backlog: ReturnType<typeof createBacklogEndpoints>;
  docs: ReturnType<typeof createDocsEndpoints>;
  search: ReturnType<typeof createSearchEndpoints>;
}

/**
 * Client HTTP dell'API di Stubwise, condiviso da SPA e app mobile.
 *
 * Framework-free di proposito: nessun React, nessun store, nessuna cache. Chi
 * lo usa ci mette sopra il proprio livello (TanStack Query sul web, lo stesso
 * sull'app) — qui vivono solo path, verbi, header, errori e forme di risposta,
 * che sono le quattro cose che altrimenti verrebbero riscritte due volte.
 */
export function createStubwiseClient(options: StubwiseClientOptions): StubwiseClient {
  const { getAuthHeader, credentials } = options;
  // Il `fetch` globale si risolve a OGNI chiamata, non alla costruzione del
  // client: catturarlo qui congelerebbe il riferimento vivo al momento in cui il
  // modulo viene importato, e chi lo sostituisce dopo (i test della SPA con
  // `vi.stubGlobal`, un polyfill caricato tardi) parlerebbe nel vuoto — con le
  // richieste che partono davvero verso la rete.
  const fetchImpl: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // Lo slash finale della baseUrl lo toglie il client, non il chiamante: i path
  // degli endpoint iniziano tutti con "/" e "https://host//api/…" è un 404.
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const request: ApiRequest = async <T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    schema?: ZodType<T>,
  ): Promise<T> => {
    const headers: Record<string, string> = {};
    let authHeader: string | null | undefined;
    try {
      authHeader = await getAuthHeader();
    } catch (error) {
      // Sull'app mobile il token viene dal keychain, che può non essere
      // disponibile (dispositivo bloccato, portachiavi in errore). Era l'unico
      // punto del trasporto da cui usciva un errore NON normalizzato: status 0
      // come gli errori di rete, perché anche qui la richiesta non è partita.
      throw new ApiError(0, "Unable to read the stored credentials", "auth_unavailable", {
        cause: error,
      });
    }
    if (authHeader) headers.authorization = authHeader;

    const init: FetchInit = { method, headers };
    if (credentials !== undefined) init.credentials = credentials;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      // fetch rifiuta con TypeError sugli errori di rete (server giù, DNS,
      // CORS): normalizzato in ApiError così i chiamanti hanno un solo tipo di
      // errore da gestire. Tutto il resto (es. AbortError) riemerge as-is.
      if (error instanceof TypeError) {
        // `network_error` è un code stabile (non c'è un body server da cui
        // leggerlo): le UI lo localizzano. Il message inglese è il fallback.
        throw new ApiError(0, "Unable to reach the server", "network_error", { cause: error });
      }
      throw error;
    }

    if (!response.ok) throw await errorFromResponse(response);

    if (response.status === 204) return undefined as T;
    const data: unknown = await response.json();
    if (!schema) return data as T;
    try {
      return schema.parse(data);
    } catch (error) {
      // Una forma inattesa resta un BUG (vedi il commento su `ApiRequest`), ma
      // non deve uscire come `ZodError` nuda: i chiamanti hanno un solo tipo di
      // errore da gestire, e il messaggio di Zod ("Invalid input: expected
      // number, received string") non è una frase da mostrare a un utente. Lo
      // status è quello vero della risposta — 200, non 0: il server HA
      // risposto. Il dettaglio resta in `cause` (la ZodError) e in `details`
      // (il body grezzo) per chi fa diagnosi.
      throw new ApiError(response.status, "Unexpected response shape", "invalid_response", {
        cause: error,
        details: data,
      });
    }
  };

  return {
    request,
    auth: createAuthEndpoints(request),
    inbox: createInboxEndpoints(request),
    me: createMeEndpoints(request),
    projects: createProjectsEndpoints(request),
    tickets: createTicketsEndpoints(request),
    backlog: createBacklogEndpoints(request),
    docs: createDocsEndpoints(request),
    search: createSearchEndpoints(request),
  };
}
