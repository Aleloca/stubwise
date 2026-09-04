import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Reader, SessionUser } from "@stubwise/shared";
import * as Keychain from "react-native-keychain";

/**
 * Servizio Keychain sotto cui vive la sessione. Un valore fisso, non legato
 * all'URL dell'istanza: un device è loggato su UN'istanza alla volta (il
 * logout — Task 20 — cancella questa riga prima di salvarne una nuova su
 * un'istanza diversa), quindi non serve una chiave per-baseUrl.
 */
const KEYCHAIN_SERVICE = "com.app.aleloca.stubwise.session";

/**
 * `username` di {@link Keychain.setGenericPassword}: un valore costante, non
 * un vero username. Il payload vero (baseUrl, token, patId, user) vive
 * serializzato in JSON nel campo `password` — usiamo il Keychain come uno
 * store chiave/valore per un blob, non per una vera coppia utente/password.
 */
const KEYCHAIN_USERNAME = "stubwise-session";

/**
 * Sessione salvata nel Keychain dopo un login riuscito.
 *
 * `patId` non serve a NULLA in questo task: è qui perché il Task 20 (logout)
 * dovrà revocare il PAT che `mobile-login` ha emesso
 * (`DELETE /api/pats/:id`), e quel PAT non è il token stesso — è la sua riga
 * nel catalogo. Salvarlo ORA, insieme al resto della sessione, evita di dover
 * fare una GET aggiuntiva al momento del logout per scoprire quale riga
 * revocare (il server non espone "qual è il PAT di QUESTA richiesta").
 */
export interface StoredSession {
  baseUrl: string;
  token: string;
  patId: string;
  // Reader<SessionUser>, non SessionUser: questo è esattamente il valore che
  // arriva da mobile-login attraverso @stubwise/api-client, e i suoi campi
  // enum (role, language) ammettono già il segnaposto UNKNOWN di un server
  // più nuovo dell'app — vedi packages/shared/src/reader.ts. Tipizzarlo
  // stretto qui mentirebbe al compilatore sul dato che arriva davvero.
  user: Reader<SessionUser>;
}

/** Salva la sessione (login riuscito). Sovrascrive una sessione precedente. */
export async function saveSession(session: StoredSession): Promise<void> {
  await Keychain.setGenericPassword(KEYCHAIN_USERNAME, JSON.stringify(session), {
    service: KEYCHAIN_SERVICE,
  });
}

/**
 * Legge la sessione salvata, o `null` se non ce n'è una — sia perché non si è
 * mai fatto login, sia perché il blob salvato non è un JSON valido (Keychain
 * corrotto, versione precedente dell'app con una forma diversa): un dato
 * illeggibile equivale a nessuna sessione, non a un crash all'avvio.
 */
export async function loadSession(): Promise<StoredSession | null> {
  const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  if (!result) return null;
  try {
    return JSON.parse(result.password) as StoredSession;
  } catch {
    return null;
  }
}

/** Cancella la sessione (logout, o risposta a un 401 — vedi `lib/client.ts`). */
export async function clearSession(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
}

/**
 * Chiave AsyncStorage dell'ultima sincronizzazione riuscita: la usa il
 * banner offline (Task 14) per "ultima sincronizzazione…". Vive fuori dal
 * Keychain perché non è un segreto — è un timestamp — e AsyncStorage è
 * anche dove vive la cache persistita di TanStack Query (vedi
 * `src/app/providers.tsx`), quindi tenerla nello stesso store evita una
 * seconda dipendenza di storage per un valore così piccolo.
 */
const LAST_SYNC_KEY = "stubwise:lastSyncAt";

/** ISO 8601 dell'ultima sincronizzazione riuscita, o `null` se non è mai avvenuta. */
export async function getLastSyncAt(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_SYNC_KEY);
}

export async function setLastSyncAt(isoDate: string): Promise<void> {
  await AsyncStorage.setItem(LAST_SYNC_KEY, isoDate);
}

/**
 * Chiave AsyncStorage dell'ultimo progetto scelto nella sheet di cattura
 * rapida del backlog (Task 17, canvas `3b`: il picker progetto vuole
 * "ultimo usato" come default). Stesso store di {@link LAST_SYNC_KEY} e per
 * lo stesso motivo (non un segreto, il Keychain non serve).
 */
const LAST_BACKLOG_PROJECT_KEY = "stubwise:lastBacklogProjectId";

/** Id dell'ultimo progetto scelto in cattura rapida, o `null` se non è mai successo. */
export async function getLastBacklogProjectId(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_BACKLOG_PROJECT_KEY);
}

export async function setLastBacklogProjectId(projectId: string): Promise<void> {
  await AsyncStorage.setItem(LAST_BACKLOG_PROJECT_KEY, projectId);
}
