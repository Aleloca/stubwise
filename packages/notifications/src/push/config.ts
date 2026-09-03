/**
 * Configurazione delle push, letta dall'ambiente e validata FAIL-FAST.
 *
 * Una sola variabile, `PUSH_RELAY_URL`, con tre valori possibili e tre
 * significati distinti — la distinzione fra i primi due è il punto di tutto il
 * file:
 *
 *  - ASSENTE → il relay pubblico ({@link DEFAULT_PUSH_RELAY_URL}). È il caso
 *    normale: un'istanza self-hosted appena installata riceve le push senza
 *    configurare niente, perché il relay è nostro e l'app sugli store è una
 *    sola.
 *  - STRINGA VUOTA → `null`, push spente. È l'interruttore documentato del
 *    deploy: `PUSH_RELAY_URL=` in `.env` e il canale tace, senza toccare né
 *    schema né immagini. Per questo il valore NON passa da un
 *    `emptyAsUndefined` come le altre env del worker: lì vuoto significa
 *    "usa il default", qui significa l'opposto.
 *  - UN URL → quel relay (per i test, o per chi si costruisce il suo).
 */

/** Il relay che gestiamo noi: il default di ogni istanza. */
export const DEFAULT_PUSH_RELAY_URL = "https://push.stubwise.thecove.it";

export interface PushConfig {
  /** Base del relay, senza slash finale. */
  relayUrl: string;
}

/**
 * Host di loopback ammessi in chiaro.
 *
 * ⚠️ Il confronto è sull'HOSTNAME, non sul prefisso della stringa: un controllo
 * scritto come `url.startsWith("http://localhost")` lascerebbe passare
 * `http://localhost.evil.example`, che è un host remoto a tutti gli effetti e
 * si prenderebbe in chiaro i titoli dei ticket di tutta l'istanza.
 * `new URL(...).hostname` di `http://localhost@evil.example` vale
 * `evil.example`, quindi anche quella forma viene rifiutata.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Legge la configurazione push dall'ambiente. Ritorna `null` quando le push
 * sono spente, e LANCIA su un valore inutilizzabile.
 *
 * Lanciare invece di degradare è la scelta di {@link PUSH_RELAY_URL} come
 * `PULSE_TIMEZONE`: la si chiama all'avvio del worker, quindi un URL sbagliato
 * fa fallire l'avvio invece di lasciar partire un processo che ogni cinque
 * secondi tenta di consegnare su un indirizzo che non esiste. Chi voleva
 * spegnere le push ha la stringa vuota.
 *
 * L'`http` in chiaro è vietato fuori dal loopback perché il payload NON è un
 * dato tecnico: `title` e `body` sono contenuto reale (titoli di ticket,
 * domande dell'agente, messaggi d'errore dei run), e viaggerebbero leggibili
 * verso un host remoto.
 *
 * Il messaggio d'errore NOMINA la variabile ma non RIPETE il valore: finisce
 * nel log d'avvio, e un URL può contenere un host interno o addirittura delle
 * credenziali in forma `user:pass@`.
 */
export function loadPushConfig(env: Record<string, string | undefined>): PushConfig | null {
  const raw = env.PUSH_RELAY_URL;
  if (raw === undefined) return { relayUrl: DEFAULT_PUSH_RELAY_URL };

  // Trim prima del confronto col vuoto: in un `.env` scritto a mano uno spazio
  // di troppo dopo l'`=` è indistinguibile dall'intenzione "spegni".
  const value = raw.trim().replace(/\/+$/, "");
  if (value === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUSH_RELAY_URL non è un URL valido (atteso https://…)");
  }
  if (parsed.protocol === "https:") return { relayUrl: value };
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { relayUrl: value };
  }
  throw new Error(
    "PUSH_RELAY_URL deve usare https (http è ammesso solo su localhost): il payload della push contiene testo dell'utente",
  );
}
