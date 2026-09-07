import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decrypt,
  encrypt,
  googleAccounts,
  googleWorkspaces,
  oauthStates,
  type Db,
} from "@stubwise/db";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  GOOGLE_SCOPES,
  type FetchImpl,
} from "@stubwise/google";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

/**
 * FLUSSO OAUTH delle caselle Google (Fase 6, Task 5): la logica, fuori dalle
 * rotte.
 *
 * Le rotte (`routes/me-google.ts`) fanno tre cose — autenticare, chiamare qui,
 * tradurre l'esito in uno status o in un redirect — e tutto il resto sta in
 * questo modulo, che si può esercitare senza `app.inject`.
 *
 * ⚠️ IL PUNTO DELICATO È LO `state`, e vale la pena dirlo prima del codice.
 * Il callback di Google è una rotta **senza autenticazione**: ci arriva un
 * browser che torna da `accounts.google.com` senza cookie garantiti (design §3,
 * «Nessun cookie richiesto»). L'unica cosa che dice «questo callback appartiene
 * davvero all'utente X che ha appena premuto Collega» è lo `state`, e per
 * reggere quel peso gli servono DUE difese distinte, nessuna delle quali basta
 * da sola:
 *
 * 1. **La FIRMA** (HMAC-SHA256 sulla chiave d'istanza) impedisce di
 *    FABBRICARNE uno: senza la chiave non si può dire «sono l'utente X».
 * 2. **Il NONCE monouso** in `oauth_states` impedisce di RIUSARNE uno vero:
 *    una firma valida resta valida per sempre, quindi uno `state` intercettato
 *    (dai log del proxy, dalla cronologia, da un Referer) potrebbe essere
 *    rigiocato da chiunque per attaccare una casella a un altro utente. Il
 *    nonce si consuma alla prima verifica, con un UPDATE guardato: il secondo
 *    callback non trova più nulla da consumare.
 *
 * Chi un domani semplificasse togliendo la tabella «tanto lo state è firmato»
 * riaprirebbe esattamente il replay. E chi togliesse la firma tenendo solo il
 * nonce permetterebbe di indovinare/enumerare i nonce altrui.
 */

/**
 * Finestra di validità dello `state`: 10 minuti (design §3). È il tempo per
 * scegliere l'account e accettare il consenso, non per lasciare la scheda
 * aperta un giorno.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Gli scope SENZA i quali la casella è inutile: leggere la posta e leggere il
 * calendario. `openid`/`email` non sono qui perché senza di essi non avremmo
 * nemmeno l'identità — la `userinfo` fallirebbe prima.
 */
export const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/** Il contenuto firmato dello `state`. */
export interface OauthStatePayload {
  userId: string;
  workspaceId: string;
  /** Chiave della riga monouso in `oauth_states`. */
  nonce: string;
  /** Scadenza in ms epoch. Ridondante con `expires_at`, e non per sbaglio: vedi sotto. */
  exp: number;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signature(body: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(body).digest();
}

/**
 * Firma il payload: `<base64url(json)>.<base64url(hmac)>`.
 *
 * La chiave è la **chiave di cifratura d'istanza** (`ENCRYPTION_KEY`, 32 byte),
 * la stessa che protegge i segreti at rest: non è il session secret perché
 * questo `state` non è una sessione — non identifica un browser, identifica una
 * richiesta di collegamento — e non è una chiave nuova perché aggiungerne una
 * significherebbe un'altra variabile d'ambiente obbligatoria da ruotare, per
 * una firma che vive 10 minuti. HMAC-SHA256 con una chiave usata anche per
 * AES-GCM è un riuso di chiave fra primitive diverse: accettabile qui perché i
 * due usi non producono mai output confrontabili, e l'alternativa (derivarne
 * una con HKDF) aggiungerebbe una dipendenza concettuale senza cambiare il
 * modello di minaccia — chi ha la chiave ha già i refresh token.
 */
export function signState(payload: OauthStatePayload, key: Buffer): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(signature(body, key))}`;
}

/**
 * Verifica firma e forma dello `state`, o `null`.
 *
 * `timingSafeEqual` e non `===`: il confronto di una firma è il caso da manuale
 * dell'oracolo temporale, e costa una riga.
 *
 * ⚠️ Questa funzione NON dice che lo state è spendibile: dice solo che l'abbiamo
 * emesso noi e che non è scaduto. La scadenza è controllata **due volte**, qui
 * sull'`exp` firmato e nel DB su `expires_at`, e la ridondanza è voluta: il
 * campo firmato è quello che un attaccante non può allungare, la colonna è
 * quella su cui l'UPDATE guardato è atomico. Il consumo del nonce —
 * l'unica cosa che rende lo state MONOUSO — sta in {@link completeCallback}.
 */
export function verifyState(raw: string, key: Buffer, nowMs: number = Date.now()): OauthStatePayload | null {
  const [body, provided, ...rest] = raw.split(".");
  if (!body || !provided || rest.length > 0) return null;

  const expected = signature(body, key);
  let given: Buffer;
  try {
    given = Buffer.from(provided, "base64url");
  } catch {
    return null;
  }
  // timingSafeEqual lancia se le lunghezze differiscono: il controllo prima.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { userId, workspaceId, nonce, exp } = parsed as Record<string, unknown>;
  if (typeof userId !== "string" || typeof workspaceId !== "string") return null;
  if (typeof nonce !== "string" || typeof exp !== "number") return null;
  if (exp <= nowMs) return null;
  return { userId, workspaceId, nonce, exp };
}

/** Dipendenze del flusso: tutto iniettabile, `fetchImpl` compreso (test). */
export interface GoogleOauthDeps {
  db: Db;
  /** 32 byte: cifra i segreti at rest e firma lo `state`. */
  encryptionKey: Buffer;
  /** URI di redirect registrato in Google Cloud Console, identico ai due lati. */
  redirectUri: string;
  /** `fetch` verso Google. Assente = quello globale (produzione). */
  fetchImpl?: FetchImpl;
  /** Sorgente del tempo, per i test dello scadere dello `state`. */
  now?: () => number;
}

/** Esito di {@link beginConnect}. */
export type BeginConnectResult =
  | { status: "ok"; authorizeUrl: string }
  | { status: "workspace_not_found" }
  | { status: "workspace_secret_missing" };

/**
 * Avvia il collegamento: emette il nonce, scrive la riga monouso e compone la
 * URL di consenso.
 *
 * Il controllo sul segreto mancante è **qui e non nel callback** di proposito:
 * un Workspace con `client_secret_encrypted = ""` (la sentinella di
 * azzeramento del registro, vedi `routes/google-workspaces.ts`) porterebbe
 * l'utente fino alla schermata di Google per poi fallire allo scambio del
 * code, con un `error` generico e nessun modo di capire che il problema è di
 * configurazione. Meglio un 409 prima di partire.
 */
export async function beginConnect(
  deps: GoogleOauthDeps,
  input: { userId: string; workspaceId: string },
): Promise<BeginConnectResult> {
  const nowMs = (deps.now ?? Date.now)();
  const [workspace] = await deps.db
    .select()
    .from(googleWorkspaces)
    .where(eq(googleWorkspaces.id, input.workspaceId));
  if (!workspace) return { status: "workspace_not_found" };
  if (workspace.clientSecretEncrypted === "") return { status: "workspace_secret_missing" };

  // Potatura opportunistica: gli state scaduti da oltre un giorno non servono
  // più a nessuno. La finestra larga è deliberata — cancellare a `expires_at`
  // esatto trasformerebbe un replay tardivo (che vogliamo rifiutare
  // esplicitamente) in un "nonce mai esistito", indistinguibile da uno
  // fabbricato.
  await deps.db
    .delete(oauthStates)
    .where(lt(oauthStates.expiresAt, new Date(nowMs - 24 * 60 * 60 * 1000)));

  // 32 byte di entropia: il nonce non deve essere indovinabile nemmeno
  // conoscendo quelli precedenti.
  const nonce = randomBytes(32).toString("base64url");
  const exp = nowMs + OAUTH_STATE_TTL_MS;
  await deps.db.insert(oauthStates).values({
    nonce,
    userId: input.userId,
    workspaceId: workspace.id,
    expiresAt: new Date(exp),
  });

  const state = signState(
    { userId: input.userId, workspaceId: workspace.id, nonce, exp },
    deps.encryptionKey,
  );
  return {
    status: "ok",
    authorizeUrl: buildAuthorizeUrl({
      clientId: workspace.clientId,
      redirectUri: deps.redirectUri,
      state,
      scopes: GOOGLE_SCOPES,
      // Precompila il selettore d'account con il dominio del Workspace: non è
      // una difesa (Google non la garantisce), il `domain_mismatch` sì.
      hd: workspace.domains[0] ?? null,
    }),
  };
}

/**
 * Esito del callback.
 *
 * `invalid_state` è tenuto SEPARATO dagli esiti di prodotto perché la rotta lo
 * tratta in modo diverso: gli altri sono un redirect alla pagina Account (li
 * legge un browser che torna da Google), questo è un 400 secco — un callback
 * con uno state non nostro, riusato o scaduto non è un flusso da concludere con
 * un messaggio gentile, è una richiesta che non riconosciamo.
 */
export type CallbackStatus =
  | "invalid_state"
  | "ok"
  | "domain_mismatch"
  | "no_refresh_token"
  | "insufficient_scope"
  | "email_not_verified"
  | "mailbox_owned_by_other"
  | "error";

export interface CallbackResult {
  status: CallbackStatus;
  /** Presente solo su `ok`: la riga scritta (utile ai test e ai log). */
  accountId?: string;
  /** Dettaglio per il log del server, mai per l'utente. */
  detail?: string;
}

/** Il dominio di un'email, lowercase, o null se l'indirizzo è malformato. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Conclude il collegamento: verifica lo state, lo consuma, scambia il code,
 * controlla i requisiti e fa l'upsert.
 *
 * ⚠️ ORDINE DEI CONTROLLI, che è un contratto e non un dettaglio: state →
 * scambio → identità (**email verificata**) → **dominio** → refresh token →
 * scope → **titolarità della casella** → scrittura. L'email verificata viene
 * SUBITO dopo lo scambio perché tutto ciò che segue (dominio, titolarità)
 * ragiona su `userinfo.email` come se fosse garantita: un'email non
 * verificata da Google non è un'identità su cui prendere nessuna delle
 * decisioni successive. Il dominio viene PRIMA di tutto ciò che riguarda i
 * token perché è l'unico rifiuto che dipende da CHI è la casella: su
 * `domain_mismatch` non deve restare traccia di quell'indirizzo nel database
 * (design §3), e l'unico modo di garantirlo è non arrivare mai alla
 * scrittura. La titolarità (un'altra riga, di un ALTRO utente, già su
 * quell'email) viene per ultima, appena prima della scrittura vera: è
 * l'ultimo cancello prima dell'unico punto che tocca il DB in scrittura, e
 * un rifiuto qui — come gli altri — non lascia tracce nuove né tocca la riga
 * esistente.
 */
export async function completeCallback(
  deps: GoogleOauthDeps,
  input: { code: string; state: string },
): Promise<CallbackResult> {
  const now = deps.now ?? Date.now;
  const payload = verifyState(input.state, deps.encryptionKey, now());
  if (!payload) return { status: "invalid_state", detail: "firma non valida o state scaduto" };

  // IL CONSUMO DEL NONCE, in un UPDATE guardato: `consumed_at is null` e
  // `expires_at > now()` sono nella WHERE, quindi due callback concorrenti con
  // lo stesso state vedono uno solo la riga (l'altro non ha nulla da
  // aggiornare). Un SELECT seguito da un UPDATE avrebbe una finestra fra i due.
  const [consumed] = await deps.db
    .update(oauthStates)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(oauthStates.nonce, payload.nonce),
        isNull(oauthStates.consumedAt),
        sql`${oauthStates.expiresAt} > now()`,
      ),
    )
    .returning();
  if (!consumed) return { status: "invalid_state", detail: "nonce assente, già usato o scaduto" };
  // Lo state è firmato, quindi userId/workspaceId non possono essere stati
  // alterati; il confronto con la riga difende dal caso in cui la riga sia
  // stata riscritta o il payload appartenga a un altro flusso.
  if (consumed.userId !== payload.userId || consumed.workspaceId !== payload.workspaceId) {
    return { status: "invalid_state", detail: "state non corrisponde alla riga oauth_states" };
  }

  const [workspace] = await deps.db
    .select()
    .from(googleWorkspaces)
    .where(eq(googleWorkspaces.id, payload.workspaceId));
  if (!workspace) return { status: "error", detail: "workspace rimosso durante il consenso" };
  if (workspace.clientSecretEncrypted === "") {
    return { status: "error", detail: "workspace senza client secret" };
  }

  let clientSecret: string;
  try {
    clientSecret = decrypt(workspace.clientSecretEncrypted, deps.encryptionKey);
  } catch {
    return { status: "error", detail: "client secret non decifrabile" };
  }

  const options = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  let tokens;
  let userinfo;
  try {
    tokens = await exchangeCode(
      {
        clientId: workspace.clientId,
        clientSecret,
        code: input.code,
        redirectUri: deps.redirectUri,
      },
      options,
    );
    userinfo = await fetchUserinfo({ accessToken: tokens.accessToken }, options);
  } catch (error) {
    // Qualunque cosa Google dica di storto (code già speso, credenziale
    // sbagliata, rete) è un `error` generico verso l'utente: il dettaglio va
    // nel log del chiamante, non nella barra degli indirizzi.
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }

  // `emailVerified` PRIMA del dominio: se Google stesso non garantisce che
  // l'indirizzo appartenga davvero al titolare del token, non ha senso
  // ragionare sul suo dominio (design §3, Task 5 di review). Nessuna riga
  // scritta, come `domain_mismatch`.
  if (!userinfo.emailVerified) {
    return { status: "email_not_verified", detail: `email ${userinfo.email} non verificata da Google` };
  }

  const domain = domainOf(userinfo.email);
  if (!domain || !workspace.domains.includes(domain)) {
    return { status: "domain_mismatch", detail: `dominio ${domain ?? "assente"} fuori dal Workspace` };
  }

  if (!tokens.refreshToken) {
    // Succede quando l'utente aveva GIÀ autorizzato l'app e non ha revocato:
    // Google manda il refresh token solo al primo consenso, e `prompt=consent`
    // di solito lo rimanda ma non lo garantisce. Senza, la casella sarebbe
    // sincronizzabile per un'ora e poi morta: meglio non crearla affatto.
    return { status: "no_refresh_token" };
  }

  const granted = new Set(tokens.scopes);
  if (!REQUIRED_GOOGLE_SCOPES.every((scope) => granted.has(scope))) {
    return { status: "insufficient_scope", detail: `concessi: ${tokens.scopes.join(" ")}` };
  }

  // TITOLARITÀ: se quell'email è GIÀ una riga di un ALTRO utente, non si
  // scrive nulla. Senza questo controllo l'upsert sotto trasferirebbe la
  // casella (e con essa la storia già ingerita di `email_messages` e
  // `calendar_events`) all'utente che sta completando QUESTO callback, in
  // silenzio: l'unica prova che questo flusso raccoglie è che chi ha appena
  // dato il consenso su Google controlla l'indirizzo ORA, non che sia la
  // stessa persona che l'aveva collegato la prima volta con un account
  // Stubwise diverso. Un ricollegamento dello STESSO utente (userId
  // coincide) non entra in questo ramo e prosegue come riattivazione.
  const [existingByEmail] = await deps.db
    .select({ userId: googleAccounts.userId })
    .from(googleAccounts)
    .where(eq(googleAccounts.email, userinfo.email));
  if (existingByEmail && existingByEmail.userId !== payload.userId) {
    return { status: "mailbox_owned_by_other", detail: `casella ${userinfo.email} già collegata da un altro utente` };
  }

  // UPSERT SULL'EMAIL, che è unique GLOBALE.
  //
  // Il ramo di conflitto è la RIATTIVAZIONE del design §3 («ricollegare
  // riattiva»): azzera `disabled_at`/`disabled_reason` e `sync_attempts`, e
  // rimette `next_sync_at` a ora — senza, una casella disabilitata da
  // `invalid_grant` resterebbe muta per sempre anche dopo un ricollegamento
  // riuscito, e in silenzio. È la stessa lezione dell'upsert dei device token
  // (`routes/me-prefs.ts`).
  //
  // `user_id` è nel SET ma, grazie al controllo qui sopra, non trasferisce
  // MAI la casella a un altro utente: quando questo ramo scatta, la riga
  // esistente (se c'è) è già dello STESSO `payload.userId`, quindi il SET è
  // un no-op sul proprietario. È la stessa persona reale, e il consenso
  // appena dato su Google è la prova che quella persona controlla quella
  // casella ORA.
  //
  // NON si toccano `proposals_enabled` (è la preferenza dell'utente: un
  // ricollegamento non è il momento di riaccendergliela) né i cursori
  // `gmail_history_id`/`calendar_sync_token` (restano validi: azzerarli
  // significherebbe rifare l'ingestione da capo).
  const values = {
    userId: payload.userId,
    workspaceId: workspace.id,
    email: userinfo.email,
    googleSub: userinfo.sub,
    refreshTokenEncrypted: encrypt(tokens.refreshToken, deps.encryptionKey),
    scopes: tokens.scopes,
  };
  const [account] = await deps.db
    .insert(googleAccounts)
    .values({ ...values, connectedAt: sql`now()`, nextSyncAt: sql`now()` })
    .onConflictDoUpdate({
      target: googleAccounts.email,
      set: {
        ...values,
        connectedAt: sql`now()`,
        nextSyncAt: sql`now()`,
        syncAttempts: 0,
        disabledAt: null,
        disabledReason: null,
      },
    })
    .returning({ id: googleAccounts.id });
  if (!account) throw new Error("upsert della casella Google non ha restituito la riga");
  return { status: "ok", accountId: account.id };
}
