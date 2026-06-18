/**
 * Client minimale per le Web API di Slack basato su `fetch` (niente SDK): le
 * chiamate usate sono `views.open` (modal del flusso ticket), `users.info`
 * (email/profilo utente) e `users.list` (membri del workspace, per il flusso
 * di invito). Tutte usano lo scope `users:read`. Tutte le risposte Slack
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

/** Sottoinsieme dei campi `profile` di Slack che ci interessano. */
interface SlackUserProfile {
  email?: string | null;
  display_name?: string | null;
  real_name?: string | null;
  image_72?: string | null;
  image_192?: string | null;
  image_512?: string | null;
}

/** Sottoinsieme di un membro Slack (da `users.info`/`users.list`). */
interface SlackMember {
  id?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: SlackUserProfile;
}

interface UsersInfoResponse extends SlackResponse {
  user?: SlackMember;
}

interface UsersListResponse extends SlackResponse {
  members?: SlackMember[];
  response_metadata?: { next_cursor?: string };
}

/** Profilo Slack normalizzato e best-effort di un utente. */
export interface SlackUserProfileResult {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Membro del workspace normalizzato (incl. id) per il flusso di invito. */
export interface SlackWorkspaceUser extends SlackUserProfileResult {
  id: string;
}

/**
 * Numero massimo di pagine di `users.list` da scorrere: tetto prudente per
 * evitare loop su `next_cursor` mai vuoto e per limitare il numero di membri
 * caricati (~5 pagine × 200 = ~1000 membri).
 */
const MAX_USER_LIST_PAGES = 5;
/** Membri richiesti per pagina a `users.list`. */
const USER_LIST_PAGE_LIMIT = 200;

/** Display name dal profilo: `display_name`, fallback `real_name`, altrimenti null. */
function profileDisplayName(profile: SlackUserProfile | undefined): string | null {
  const display = profile?.display_name?.trim();
  if (display) return display;
  const real = profile?.real_name?.trim();
  return real ? real : null;
}

/** Avatar migliore disponibile: image_192 → image_512 → image_72, altrimenti null. */
function profileAvatarUrl(profile: SlackUserProfile | undefined): string | null {
  return profile?.image_192 ?? profile?.image_512 ?? profile?.image_72 ?? null;
}

/** Normalizza il `profile` di un membro Slack nel nostro formato. */
function toProfileResult(profile: SlackUserProfile | undefined): SlackUserProfileResult {
  return {
    email: profile?.email ?? null,
    displayName: profileDisplayName(profile),
    avatarUrl: profileAvatarUrl(profile),
  };
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
  /**
   * Profilo normalizzato (email, displayName, avatarUrl) di un utente Slack via
   * `users.info`. Ritorna `null` se la chiamata fallisce (`ok:false`):
   * best-effort, non lancia.
   */
  getUserProfile(userId: string): Promise<SlackUserProfileResult | null>;
  /**
   * Elenco dei membri reali del workspace via `users.list` (paginato). Esclude
   * bot, utenti cancellati e Slackbot.
   *
   * Comportamento d'errore: se la PRIMA pagina fallisce (`ok:false`) lancia un
   * errore, così l'endpoint a monte può rispondere "non disponibile" invece di
   * mostrare una lista vuota fuorviante. Errori sulle pagine SUCCESSIVE sono
   * tollerati: si ritornano i membri raccolti fino a quel punto.
   */
  listWorkspaceUsers(): Promise<SlackWorkspaceUser[]>;
}

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Encoding del body della richiesta verso Slack:
 * - `"json"`: `application/json`, body `JSON.stringify(payload)` (es. `views.open`);
 * - `"form"`: `application/x-www-form-urlencoded`, body `URLSearchParams`
 *   (richiesto da `users.info`/`users.list`, che NON leggono il body JSON).
 */
type SlackEncoding = "json" | "form";

/**
 * Esegue una chiamata POST a una Web API di Slack con il bot token come Bearer.
 * Il body viene serializzato secondo `encoding` (vedi {@link SlackEncoding}):
 * `views.open` accetta JSON, mentre `users.info`/`users.list` richiedono
 * `application/x-www-form-urlencoded` (con `form` il payload deve essere una
 * mappa di stringhe). Ritorna il JSON tipizzato, oppure `{ ok: false }` se la
 * rete o il parse falliscono. Non lancia mai: il chiamante decide come
 * degradare. Eventuali errori `{ ok: false, error }` vengono loggati SENZA il
 * token.
 */
async function slackApi<T extends SlackResponse>(
  botToken: string,
  method: string,
  payload: unknown,
  fetchImpl: FetchImpl,
  encoding: SlackEncoding,
): Promise<T> {
  const isForm = encoding === "form";
  const contentType = isForm
    ? "application/x-www-form-urlencoded; charset=utf-8"
    : "application/json; charset=utf-8";
  const body = isForm
    ? new URLSearchParams(payload as Record<string, string>)
    : JSON.stringify(payload);
  try {
    const res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": contentType,
      },
      body,
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
        "json",
      );
      return res.ok;
    },
    async getUserProfile(userId) {
      const res = await slackApi<UsersInfoResponse>(
        botToken,
        "users.info",
        { user: userId },
        fetchImpl,
        "form",
      );
      if (!res.ok) return null;
      return toProfileResult(res.user?.profile);
    },
    async getUserEmail(userId) {
      return (await this.getUserProfile(userId))?.email ?? null;
    },
    async listWorkspaceUsers() {
      const users: SlackWorkspaceUser[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_USER_LIST_PAGES; page += 1) {
        const res = await slackApi<UsersListResponse>(
          botToken,
          "users.list",
          { limit: String(USER_LIST_PAGE_LIMIT), ...(cursor ? { cursor } : {}) },
          fetchImpl,
          "form",
        );
        if (!res.ok) {
          // Prima pagina: propaga l'errore. Pagine successive: tollera e ritorna
          // quanto raccolto finora (vedi doc dell'interfaccia).
          if (page === 0) {
            throw new Error(`users.list fallita (error=${res.error ?? "unknown"})`);
          }
          break;
        }
        for (const member of res.members ?? []) {
          if (!member.id || member.is_bot || member.deleted || member.id === "USLACKBOT") {
            continue;
          }
          users.push({ id: member.id, ...toProfileResult(member.profile) });
        }
        cursor = res.response_metadata?.next_cursor?.trim() || undefined;
        if (!cursor) break;
      }
      return users;
    },
  };
}
