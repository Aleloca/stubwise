/**
 * Client minimale per le Web API di Slack basato su `fetch` (niente SDK).
 *
 * Vive in `@stubwise/notifications` — e non più in `apps/server/src/slack/api.ts`,
 * che lo RI-ESPORTA per non toccare le rotte esistenti — perché ha due
 * consumatori: il server (flusso ticket, identità) e il WORKER, che manda i DM
 * dell'inbox dal poller delle consegne e non può importare da `apps/server`.
 *
 * Due famiglie di metodi, con contratti d'errore DIVERSI e deliberati:
 *  - LETTURA/UI (`views.open`, `users.info`, `users.list`): best-effort, gli
 *    errori vengono loggati e assorbiti (mai un 500 verso Slack);
 *  - MESSAGGISTICA (`chat.postMessage`, `chat.update`): LANCIA. Chi manda un DM
 *    è una coda con ritentativi, e per decidere "ritenta" o "arrenditi" le
 *    serve il codice d'errore di Slack — vedi {@link SlackApiError} e
 *    {@link isFatalSlackError}.
 *
 * `fetch` è iniettabile (opzione `fetchImpl`) così i test non colpiscono la
 * rete: si passa un fake che ritorna una Response sintetica.
 */
import { decrypt, instanceSettings } from "@stubwise/db";
import type { DbOrTx } from "./dispatch.js";

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

/** Risposta di `chat.postMessage`/`chat.update`. */
interface ChatMessageResponse extends SlackResponse {
  ts?: string;
  channel?: string;
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

/** Argomenti di `chat.postMessage`. `channel` accetta anche uno `<slackUserId>`: Slack apre da sé il DM (scope `chat:write` + `im:write`). */
export interface PostMessageInput {
  channel: string;
  /** Testo mrkdwn: fallback delle notifiche push e dei client che non rendono i blocchi. */
  text: string;
  /** Blocchi Block Kit (opzionali): vedi `./slack-blocks.ts`. */
  blocks?: unknown[];
}

/** Argomenti di `chat.update`: identifica il messaggio con (canale, ts). */
export interface UpdateMessageInput extends PostMessageInput {
  ts: string;
}

/** Riferimento del messaggio postato: è ciò che finisce in `notification_deliveries.external_ref`. */
export interface PostedMessage {
  /** Timestamp Slack del messaggio (la sua chiave). */
  ts: string;
  /** Canale RISOLTO da Slack: postando su uno user id è il DM (`D…`), non lo user id. */
  channel: string;
}

/**
 * Sotto-interfaccia di sola MESSAGGISTICA: è tutto ciò che serve al poller
 * delle consegne, e permette ai suoi test di fingere due metodi invece di sei.
 */
export interface SlackMessenger {
  /**
   * Posta un messaggio (`chat.postMessage`). LANCIA {@link SlackApiError} se
   * Slack risponde `ok:false`, un Error generico su errore di rete/parse.
   */
  postMessage(input: PostMessageInput): Promise<PostedMessage>;
  /**
   * Riscrive un messaggio esistente (`chat.update`). Stesso contratto d'errore
   * di {@link postMessage}. Passare `blocks: []` RIMUOVE i blocchi (è così che
   * spariscono i bottoni di una notifica ormai gestita).
   */
  updateMessage(input: UpdateMessageInput): Promise<PostedMessage>;
}

/**
 * Client Slack iniettabile: incapsula il bot token e l'implementazione di
 * fetch. In produzione si costruisce con {@link createSlackClient} dal bot
 * token decifrato; nei test si passa un fake che implementa la stessa
 * interfaccia, evitando del tutto la rete.
 */
export interface SlackClient extends SlackMessenger {
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
 * Errore TIPIZZATO di una Web API di Slack: `ok:false` con il suo `error`.
 * `code` è il codice grezzo di Slack (`channel_not_found`, `ratelimited`, …):
 * è su quello che il chiamante decide se ritentare. Il messaggio non contiene
 * mai il token (viene persistito nella colonna `error` della consegna).
 */
export class SlackApiError extends Error {
  readonly code: string;
  constructor(method: string, code: string) {
    super(`Slack ${method} ha risposto ok=false (error=${code})`);
    this.name = "SlackApiError";
    this.code = code;
  }
}

/**
 * Errori di Slack che NON hanno senso ritentare: token non valido o revocato,
 * scope mancante, destinatario/messaggio inesistente. Ritentarli brucerebbe
 * cinque tentativi su un esito che non può cambiare da solo.
 *
 * Tutto il resto — `ratelimited`, gli errori interni di Slack, gli errori di
 * rete (che NON sono SlackApiError) — è transitorio: si ritenta col backoff.
 */
const FATAL_SLACK_ERRORS = new Set([
  // Configurazione dell'app: il token non funziona finché non lo si rifà.
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_authed",
  "missing_scope",
  "no_permission",
  "org_login_required",
  // Destinatario o messaggio: non esiste, o non è raggiungibile dal bot.
  "channel_not_found",
  "user_not_found",
  "user_is_bot",
  "users_not_found",
  "is_archived",
  "cannot_dm_bot",
  // Solo per chat.update: il messaggio da riscrivere non c'è (più).
  "message_not_found",
  "cant_update_message",
  "edit_window_closed",
]);

/** True se l'errore è definitivo: la consegna va chiusa `failed` senza ritentare. */
export function isFatalSlackError(error: unknown): boolean {
  return error instanceof SlackApiError && FATAL_SLACK_ERRORS.has(error.code);
}

/**
 * Come {@link slackApi} ma LANCIA invece di degradare: `ok:false` diventa
 * {@link SlackApiError}, un errore di rete/parse si propaga com'è (così il
 * chiamante distingue "Slack ha detto no" da "non ho parlato con Slack").
 */
async function slackApiOrThrow<T extends SlackResponse>(
  botToken: string,
  method: string,
  payload: unknown,
  fetchImpl: FetchImpl,
): Promise<T> {
  const res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as T;
  if (!json.ok) throw new SlackApiError(method, json.error ?? "unknown");
  return json;
}

/**
 * Costruisce un {@link SlackClient} reale a partire dal bot token (decifrato).
 * `fetchImpl` di default è il fetch globale; i test ne iniettano uno fake.
 */
export function createSlackClient(botToken: string, fetchImpl: FetchImpl = fetch): SlackClient {
  return {
    async postMessage({ channel, text, blocks }) {
      const res = await slackApiOrThrow<ChatMessageResponse>(
        botToken,
        "chat.postMessage",
        { channel, text, ...(blocks ? { blocks } : {}) },
        fetchImpl,
      );
      return toPostedMessage("chat.postMessage", res, channel);
    },
    async updateMessage({ channel, ts, text, blocks }) {
      const res = await slackApiOrThrow<ChatMessageResponse>(
        botToken,
        "chat.update",
        { channel, ts, text, ...(blocks ? { blocks } : {}) },
        fetchImpl,
      );
      return toPostedMessage("chat.update", res, channel);
    },
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

/**
 * Normalizza la risposta di `chat.*` nel riferimento del messaggio. Un `ok:true`
 * SENZA `ts` non è utilizzabile (l'`external_ref` servirà a riscrivere quel
 * messaggio): meglio un errore esplicito che una consegna `sent` senza
 * riferimento. Il `channel` risolto da Slack (`D…` per un DM aperto su uno user
 * id) vince su quello richiesto, perché è quello che `chat.update` vuole.
 */
function toPostedMessage(
  method: string,
  res: ChatMessageResponse,
  requestedChannel: string,
): PostedMessage {
  if (!res.ts) throw new Error(`Slack ${method} ha risposto ok=true ma senza ts`);
  return { ts: res.ts, channel: res.channel ?? requestedChannel };
}

/** Credenziali Slack decifrate, o null se l'integrazione non è configurata. */
export interface SlackCreds {
  signingSecret: string;
  botToken: string;
}

/**
 * Fabbrica del client Slack iniettabile: in produzione costruisce il client
 * reale dal bot token (con fetch globale); nei test si passa un fake che non
 * tocca la rete.
 */
export type SlackClientFactory = (botToken: string) => SlackClient;

/**
 * Carica e decifra signing secret + bot token dalle instance settings
 * (singleton id=1). Ritorna null se uno dei due manca (integrazione non
 * completa) o se la decifratura fallisce (blob corrotto/chiave errata): in
 * entrambi i casi il flusso Slack è trattato come "non abilitato". I segreti
 * non vengono mai loggati.
 */
export async function loadSlackCreds(
  db: DbOrTx,
  encryptionKey: Buffer,
): Promise<SlackCreds | null> {
  const [row] = await db
    .select({
      signing: instanceSettings.slackSigningSecretEncrypted,
      bot: instanceSettings.slackBotTokenEncrypted,
    })
    .from(instanceSettings)
    .limit(1);
  if (!row?.signing || !row.bot) return null;
  try {
    return {
      signingSecret: decrypt(row.signing, encryptionKey),
      botToken: decrypt(row.bot, encryptionKey),
    };
  } catch {
    return null;
  }
}

/**
 * Solo il BOT TOKEN decifrato, o null se assente/indecifrabile.
 *
 * Distinta da {@link loadSlackCreds} perché chi manda un DM non ha bisogno del
 * signing secret (che serve a VERIFICARE le richieste in arrivo da Slack):
 * pretenderlo renderebbe muto il canale su un'istanza che, per qualunque
 * ragione, ha solo il token.
 */
export async function loadSlackBotToken(
  db: DbOrTx,
  encryptionKey: Buffer,
): Promise<string | null> {
  const [row] = await db
    .select({ bot: instanceSettings.slackBotTokenEncrypted })
    .from(instanceSettings)
    .limit(1);
  if (!row?.bot) return null;
  try {
    return decrypt(row.bot, encryptionKey);
  } catch {
    return null;
  }
}
