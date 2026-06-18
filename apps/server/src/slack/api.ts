/**
 * Client minimale per le Web API di Slack basato su `fetch` (niente SDK): le
 * sole due chiamate che servono al flusso "slash command + message action →
 * modal → ticket" sono `views.open` e `users.info`. Tutte le risposte Slack
 * hanno forma `{ ok: boolean, error?: string, ... }`: gli errori vengono
 * loggati e assorbiti (best-effort), mai propagati come 500 verso Slack.
 *
 * `fetch` è iniettabile (opzione `fetchImpl`) così i test non colpiscono la
 * rete: si passa un fake che ritorna una Response sintetica.
 */

/** Implementazione di fetch iniettabile (default: il fetch globale di Node 22). */
export type FetchImpl = typeof fetch;

/** Forma comune delle risposte delle Web API di Slack. */
interface SlackResponse {
  ok: boolean;
  error?: string;
}

interface UsersInfoResponse extends SlackResponse {
  user?: { profile?: { email?: string | null } };
}

/**
 * Client Slack iniettabile: incapsula il bot token e l'implementazione di
 * fetch. In produzione si costruisce con {@link createSlackClient} dal bot
 * token decifrato; nei test si passa un fake che implementa la stessa
 * interfaccia, evitando del tutto la rete.
 */
export interface SlackClient {
  /** Apre una view modale a partire da un `trigger_id`. Ritorna `ok`. */
  openView(triggerId: string, view: unknown): Promise<boolean>;
  /**
   * Email dell'utente Slack (da `users.info` → `user.profile.email`), o `null`
   * se la chiamata fallisce o l'email non è disponibile. Best-effort.
   */
  getUserEmail(userId: string): Promise<string | null>;
}

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Esegue una chiamata POST a una Web API di Slack con il bot token come Bearer
 * e payload JSON. Ritorna il JSON tipizzato, oppure `{ ok: false }` se la rete
 * o il parse falliscono. Non lancia mai: il chiamante decide come degradare.
 * Eventuali errori `{ ok: false, error }` vengono loggati SENZA il token.
 */
async function slackApi<T extends SlackResponse>(
  botToken: string,
  method: string,
  payload: unknown,
  fetchImpl: FetchImpl,
): Promise<T> {
  try {
    const res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as T;
    if (!json.ok) {
      // Mai loggare il token: solo il metodo e il codice d'errore di Slack.
      console.warn(`[slack] ${method} ha risposto ok=false (error=${json.error ?? "unknown"})`);
    }
    return json;
  } catch (error) {
    console.warn(`[slack] chiamata ${method} fallita (rete/parse):`, error);
    return { ok: false } as T;
  }
}

/**
 * Costruisce un {@link SlackClient} reale a partire dal bot token (decifrato).
 * `fetchImpl` di default è il fetch globale; i test ne iniettano uno fake.
 */
export function createSlackClient(botToken: string, fetchImpl: FetchImpl = fetch): SlackClient {
  return {
    async openView(triggerId, view) {
      const res = await slackApi<SlackResponse>(
        botToken,
        "views.open",
        { trigger_id: triggerId, view },
        fetchImpl,
      );
      return res.ok;
    },
    async getUserEmail(userId) {
      const res = await slackApi<UsersInfoResponse>(
        botToken,
        "users.info",
        { user: userId },
        fetchImpl,
      );
      return res.ok ? (res.user?.profile?.email ?? null) : null;
    },
  };
}
