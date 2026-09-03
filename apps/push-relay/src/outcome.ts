/**
 * VOCABOLARIO CONDIVISO DEI DUE CLIENT DI PUSH, e le due regole che li rendono
 * sicuri. Chi aggiunge un codice d'errore ad `apns.ts` o `fcm.ts` legga QUESTO
 * file prima: sono le uniche due cose che non si possono sbagliare.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REGOLA 1 — `invalid_token` SPEGNE TELEFONI VERI.
 *
 * Il poller delle consegne (`applyPushOutcome` in
 * `apps/worker/src/notify/deliveries-poller.ts`) si fida di noi: a un esito
 * `invalid_token` risponde disabilitando la riga di `device_tokens`
 * (`disabledReason: "invalid_token"`). È l'UNICO esito distruttivo di tutto il
 * sistema, ed è irreversibile senza un'azione dell'utente — chi lo subisce per
 * sbaglio smette di ricevere push e non se ne accorge nessuno: il rimedio è un
 * re-login su ogni telefono.
 *
 * Perciò `invalid_token` si usa SOLO davanti a un identificatore che dichiara
 * la registrazione finita — `Unregistered` per APNs, `UNREGISTERED` per FCM — e
 * MAI davanti a un codice generico, a uno status HTTP nudo o a un codice che
 * non conosciamo. In particolare **non** basta il codice HTTP: APNs usa `400
 * BadDeviceToken` sia per un token inventato sia per un token giusto mandato
 * all'ambiente sbagliato, e FCM usa `404` sia per un token sparito sia per un
 * `project_id` sbagliato. In entrambi i casi la causa più probabile è una
 * NOSTRA misconfigurazione, che riguarda tutti i device insieme: mapparli su
 * `invalid_token` cancellerebbe l'intera base installata, in silenzio, un
 * device alla volta.
 *
 * **Nel dubbio si sceglie `failed`.** `failed` significa «permanente, ma il
 * token resta valido»: la notifica non arriva e qualcuno lo legge nel `reason`,
 * ma nessun telefono si spegne. Il costo è che un token davvero morto continua
 * a consumare un `failed` per notifica invece di essere potato — accettabile,
 * perché la potatura vera arriva comunque dal codice esplicito, che è quello
 * che i due servizi mandano quando l'app viene disinstallata (il caso comune).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REGOLA 2 — `reason` NON PUÒ CONTENERE IL TOKEN.
 *
 * `reason` è l'unico campo che il relay riempie liberamente e che il poller
 * scrive senza poterlo verificare: finisce in `notification_deliveries.error` e
 * nei log del worker. Da un token in un log ci si può intestare il device di
 * qualcun altro, ed è il motivo per cui tutta la catena a monte lo tiene fuori
 * da colonne e log (token fuori dal path del DELETE, esiti salvati per id del
 * device, messaggi coi soli conteggi). Un `reason` che eco il token vanifica da
 * solo tutto il resto.
 *
 * La garanzia NON è «stiamo attenti a cosa copiamo»: è {@link reasonCode}, che
 * lascia passare solo un IDENTIFICATORE corto e ben formato. I corpi d'errore
 * dei due servizi il token ce lo mettono davvero — FCM scrive «The registration
 * token <token> is not a valid FCM registration token» — quindi il testo libero
 * di una risposta non entra MAI in `reason`, nemmeno troncato.
 */
import type { PushPayload, PushRelayResultStatus } from "@stubwise/shared";

/** L'esito di un singolo invio, nella forma che il contratto pubblica. */
export interface PushSendResult {
  status: PushRelayResultStatus;
  reason?: string;
}

/** Ciò che il server chiede a un client di push, APNs o FCM che sia. */
export interface PushClient {
  send(token: string, payload: PushPayload): Promise<PushSendResult>;
}

/**
 * Tetto di un codice d'errore, in caratteri.
 *
 * 40 non è un numero tondo a caso: il codice più lungo che i due servizi
 * mandano è `TooManyProviderTokenUpdates` (27), e i token veri sono molto più
 * lunghi — 64 caratteri esadecimali per APNs, 140+ con `:` e `-` per FCM.
 * Il tetto è quindi già da solo una barriera contro il caso che ci preoccupa,
 * PRIMA del confronto esplicito col token qui sotto. Alzarlo lo riaprirebbe:
 * un token esadecimale che comincia per lettera ha la stessa forma di un
 * identificatore, e sarebbe indistinguibile per sola forma.
 */
const REASON_CODE_MAX_CHARS = 40;

/**
 * La forma di un codice d'errore di APNs (`CamelCase`) o di FCM
 * (`UPPER_SNAKE`). Ancorata agli estremi: un codice con dentro uno spazio, due
 * punti o un trattino non è un codice, è testo libero — e il testo libero non
 * passa.
 */
const REASON_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Quanti caratteri consecutivi in comune col token bastano a considerare un
 * codice compromesso.
 *
 * ⚠️ Sei, e la soglia è bassa DI PROPOSITO. La versione precedente confrontava
 * per contenenza TOTALE (`code.includes(token) || token.includes(code)`) e
 * lasciava passare la sovrapposizione a un bordo, che è il caso realmente
 * ostile: con `token = "abcdefghijklmnopqrst"`, il codice
 * `"klmnopqrstUnregistered"` non contiene il token e non è contenuto in esso,
 * ma si porta via dieci dei suoi caratteri — e con un `code` fino a 40
 * caratteri il frammento poteva arrivare a 39. Un filtro che dichiara di
 * reggere «un corpo ostile» non può fermarsi alla contenenza totale.
 *
 * Sui falsi positivi il conto torna: perché scattasse per caso servirebbero sei
 * caratteri consecutivi di un codice dentro un token. I token APNs sono esadecimali
 * (`[0-9a-f]`) e nessuna finestra da sei dei codici veri è tutta esadecimale
 * (`baddevicetoken` → `baddev`, `addevi`, … tutte con lettere fuori range); per un
 * token FCM in base64url la probabilità è dell'ordine di 10⁻⁸. E quando scatta,
 * il degrado è benigno: `reason` diventa `unknown … status N`, cioè si perde
 * una diagnostica, non si spegne un telefono.
 */
const SHARED_RUN_MIN_CHARS = 6;

/**
 * Il codice e il token condividono una sequenza abbastanza lunga?
 *
 * La soglia è `min(SHARED_RUN_MIN_CHARS, len(code), len(token))`, così l'unico
 * controllo copre anche i due estremi senza casi speciali: se il TOKEN è più
 * corto della soglia si finisce a cercare il token intero dentro il codice, e
 * se è il CODICE a essere più corto si cerca il codice intero dentro il token —
 * cioè esattamente la vecchia contenenza totale, che resta inclusa.
 *
 * Scansione a finestra scorrevole: `code` è ≤ 40 caratteri e `token` ≤ 1024
 * byte, quindi qualche centinaio di confronti nel caso peggiore. Non serve di
 * meglio, e un algoritmo più furbo qui sarebbe solo più facile da sbagliare.
 */
function sharesRunWithToken(code: string, token: string): boolean {
  const needle = code.toLowerCase();
  const haystack = token.toLowerCase();
  const threshold = Math.min(SHARED_RUN_MIN_CHARS, needle.length, haystack.length);
  if (threshold === 0) return false;
  for (let start = 0; start + threshold <= needle.length; start += 1) {
    if (haystack.includes(needle.slice(start, start + threshold))) return true;
  }
  return false;
}

/**
 * Estrae un codice d'errore riportabile, o `null` se ciò che è arrivato non lo
 * è. È l'unico varco fra un corpo di risposta e il campo `reason`.
 *
 * `token` non serve a costruire il risultato: serve a ESCLUDERLO, tramite
 * {@link sharesRunWithToken}. La forma e il tetto bastano contro i token veri,
 * ma quello è il filtro che non dipende dal formato che APNs e Google useranno
 * domani.
 */
export function reasonCode(raw: unknown, token: string): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > REASON_CODE_MAX_CHARS) return null;
  if (!REASON_CODE_SHAPE.test(value)) return null;
  if (sharesRunWithToken(value, token)) return null;
  return value;
}
