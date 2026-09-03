/**
 * CONFIGURAZIONE DEL RELAY, letta dall'ambiente e validata FAIL-FAST.
 *
 * Il relay è il bersaglio di maggior valore di tutto il sistema: tiene le
 * chiavi APNs e FCM legate alla NOSTRA identità di publisher, e chi le ruba può
 * mandare notifiche a nome di Stubwise a ogni telefono su cui l'app è
 * installata. Da qui due conseguenze su questo file:
 *
 *  1. **Niente valore di segreto in un messaggio d'errore.** Gli errori qui
 *     finiscono nel log d'avvio del container: si NOMINA la variabile, non si
 *     ripete mai il suo contenuto. Un test lo verifica su ogni ramo.
 *  2. **Si lancia invece di degradare.** Un relay che parte con una
 *     configurazione a metà è peggio di un relay che non parte: le push
 *     fallirebbero una a una, in silenzio, contro un servizio che sembra vivo.
 */

/** Host di produzione e di sandbox di APNs. La scelta la fa `APNS_SANDBOX`. */
export const APNS_PRODUCTION_HOST = "https://api.push.apple.com";
export const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";

export interface ApnsCredentials {
  /** Il contenuto PEM della `.p8` scaricata da Apple (già decodificato). */
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  sandbox: boolean;
}

export interface RelayConfig {
  port: number;
  /**
   * A quale servizio vanno i token registrati con `platform: "ios"`.
   *
   * ⚠️ Default `fcm`, ed è la scelta che conta di più in questo file. In v1
   * l'app usa `@react-native-firebase/messaging` anche su iOS, quindi un token
   * `ios` è un token FCM (Firebase media verso APNs) e il client APNs diretto
   * resta inattivo fino alla fase 4b, quando l'app registrerà token APNs
   * nativi. L'interruttore esiste perché quel passaggio sia una variabile
   * d'ambiente e non una modifica di codice — e perché il ramo APNs resti
   * raggiungibile dai test invece di marcire.
   *
   * L'asimmetria del danno è ciò che fissa il default, non una preferenza:
   * sbagliare verso APNs fa rispondere `BadDeviceToken` e — se lo si mappasse
   * su `invalid_token` — **spegnerebbe ogni device iOS**, con rimedio un
   * re-login su ogni telefono; sbagliare verso FCM perde la notifica e lascia
   * il device sano. Fra due incertezze si sceglie quella che si può correggere.
   */
  iosPushVia: "fcm" | "apns";
  /** `null` quando `iosPushVia` è `fcm`: le chiavi APNs allora non servono. */
  apns: ApnsCredentials | null;
  fcm: {
    projectId: string;
    /** Il JSON del service account, già decodificato e validato. */
    serviceAccountJson: string;
  };
  rate: {
    perTokenHour: number;
    perTokenDay: number;
    perIpMinute: number;
  };
}

type Env = Record<string, string | undefined>;

/**
 * Base64 STRETTO.
 *
 * `Buffer.from(x, "base64")` non lancia mai: ignora i caratteri fuori alfabeto
 * e restituisce comunque dei byte. Un `.p8` incollato male produrrebbe quindi
 * una chiave "decodificata" fatta di spazzatura, e il guasto si scoprirebbe
 * alla prima consegna invece che all'avvio — cioè esattamente ciò che questo
 * file esiste per evitare. Si valida perciò l'ALFABETO prima di decodificare.
 * Gli a-capo sono ammessi: `base64 -i file.p8` li produce, ed è il comando che
 * il README dà al maintainer.
 */
const BASE64_SHAPE = /^[A-Za-z0-9+/\r\n]*={0,2}$/;

function decodeBase64(value: string, variable: string): string {
  const compact = value.trim();
  if (compact === "" || !BASE64_SHAPE.test(compact)) {
    throw new Error(`${variable} non è base64 valido`);
  }
  const decoded = Buffer.from(compact, "base64").toString("utf8");
  if (decoded === "") throw new Error(`${variable} non è base64 valido`);
  return decoded;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} mancante`);
  return value;
}

/**
 * Un intero positivo, oppure il default. `Number()` accetterebbe `"1.5"`,
 * `"0"`, `" "` e la notazione esponenziale: un tetto di rate limit letto male è
 * un tetto che non protegge (o che blocca tutto), quindi si valida invece di
 * fidarsi della coercizione.
 */
function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} deve essere un intero positivo`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} deve essere un intero positivo`);
  }
  return value;
}

/**
 * Booleano ESATTO: `"true"` o `"false"`, nient'altro.
 *
 * ⚠️ Nessuna truthiness, e non è pignoleria. `APNS_SANDBOX=1` letto come falso
 * (o `APNS_SANDBOX=0` letto come vero) manda ogni push all'ambiente sbagliato,
 * e Apple risponde `BadDeviceToken` — lo STESSO codice che manda per un token
 * inventato. Il relay non può distinguere i due casi, quindi l'unico posto in
 * cui l'errore si può ancora vedere è QUI, all'avvio. Meglio un relay che non
 * parte di uno che parla con l'ambiente sbagliato.
 */
function exactBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} accetta solo "true" o "false" (niente 1/0/yes)`);
}

export function loadRelayConfig(env: Env): RelayConfig {
  /**
   * FCM è obbligatorio SEMPRE: è l'unico canale attivo in v1 e serve comunque
   * per Android, qualunque cosa dica `IOS_PUSH_VIA`.
   */
  const serviceAccountJson = decodeBase64(
    required(env, "FCM_SERVICE_ACCOUNT_JSON"),
    "FCM_SERVICE_ACCOUNT_JSON",
  );
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    // La `cause` NON si allega: il messaggio di JSON.parse cita il testo che
    // non ha saputo leggere, cioè la chiave privata del service account.
    throw new Error("FCM_SERVICE_ACCOUNT_JSON non è un JSON valido");
  }
  if (typeof serviceAccount !== "object" || serviceAccount === null) {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON non è un oggetto JSON");
  }
  const account = serviceAccount as Record<string, unknown>;
  for (const field of ["project_id", "client_email", "private_key"]) {
    if (typeof account[field] !== "string" || account[field] === "") {
      throw new Error(`FCM_SERVICE_ACCOUNT_JSON è privo del campo ${field}`);
    }
  }

  const iosPushViaRaw = env.IOS_PUSH_VIA?.trim() ?? "fcm";
  if (iosPushViaRaw !== "fcm" && iosPushViaRaw !== "apns") {
    throw new Error('IOS_PUSH_VIA accetta solo "fcm" o "apns"');
  }
  const iosPushVia = iosPushViaRaw;

  /**
   * Le `APNS_*` sono obbligatorie SOLO con `IOS_PUSH_VIA=apns`.
   *
   * Pretenderle sempre costringerebbe il maintainer a generare un `.p8` da
   * Apple e a metterlo in base64 nel `.env` del VPS per alimentare un client
   * che, col default, non viene mai chiamato. Con l'interruttore su `apns`
   * invece mancano davvero, e l'errore va dato al BOOT: alla prima consegna
   * sarebbe già troppo tardi.
   */
  const apns: ApnsCredentials | null =
    iosPushVia === "apns"
      ? {
          keyP8: decodeBase64(required(env, "APNS_KEY_P8"), "APNS_KEY_P8"),
          keyId: required(env, "APNS_KEY_ID"),
          teamId: required(env, "APNS_TEAM_ID"),
          bundleId: required(env, "APNS_BUNDLE_ID"),
          sandbox: exactBoolean(env, "APNS_SANDBOX", false),
        }
      : null;

  if (apns !== null && !apns.keyP8.includes("-----BEGIN")) {
    // Decodificata ma non è una chiave: quasi sempre un `.p8` incollato senza
    // passare da base64. Il testo decodificato NON si mostra.
    throw new Error("APNS_KEY_P8 decodificata non è una chiave PEM (attesa una .p8 in base64)");
  }

  return {
    port: positiveInt(env, "PORT", 8090),
    iosPushVia,
    apns,
    fcm: { projectId: account["project_id"] as string, serviceAccountJson },
    rate: {
      perTokenHour: positiveInt(env, "RELAY_RATE_PER_TOKEN_HOUR", 60),
      perTokenDay: positiveInt(env, "RELAY_RATE_PER_TOKEN_DAY", 500),
      perIpMinute: positiveInt(env, "RELAY_RATE_PER_IP_MINUTE", 600),
    },
  };
}
