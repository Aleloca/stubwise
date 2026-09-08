/**
 * L'UNICO modulo di `@stubwise/google` che conosce il database.
 *
 * ⚠️ PERCHÉ STA QUI E NON NEL CORE. Il resto del package è un client HTTP puro
 * (`fetch` iniettabile, nessuno stato, nessuna dipendenza dal DB) e deve
 * restarlo: è ciò che lo rende testabile senza container e riusabile da server
 * e worker senza trascinarsi dietro Drizzle. Ma i due consumatori hanno lo
 * stesso bisogno noioso — «dammi il refresh token DECIFRATO di questa casella,
 * più le credenziali dell'app OAuth del suo Workspace, pronti per
 * `refreshAccessToken`» — e l'unico posto dove quella join può vivere senza
 * essere scritta due volte è questo package: il worker non può importare da
 * `apps/server`, e il server non deve reimplementare quello che fa il worker.
 *
 * È esattamente la scelta già fatta in `@stubwise/notifications/slack-client`
 * (`loadSlackCreds` / `loadSlackBotToken`): un client altrimenti puro che
 * espone una sola funzione «leggi il segreto cifrato dal DB», perché
 * l'alternativa è la stessa query duplicata in due app che poi divergono.
 *
 * Il modulo è tenuto FUORI dall'entrypoint principale ed esportato dal subpath
 * `@stubwise/google/credentials`: chi importa `@stubwise/google` non tira
 * dentro il DB, e la purezza del core resta verificabile leggendo un `import`.
 */
import { decrypt, googleAccounts, googleWorkspaces, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";

/** Connessione o transazione: la funzione non apre transazioni proprie. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Tutto ciò che serve per parlare con Google a nome di una casella, con i
 * segreti già in chiaro.
 *
 * ⚠️ Il valore restituito CONTIENE segreti (`refreshToken`, `clientSecret`):
 * non va loggato, non va serializzato in una risposta e non va messo in cache
 * su disco. Vive il tempo di un tick del poller.
 */
export interface GoogleAccountCredentials {
  accountId: string;
  /** Proprietario della casella: è a lui che vanno le proposte. */
  userId: string;
  workspaceId: string;
  email: string;
  /** `sub` Google: stabile anche se l'email viene rinominata. */
  googleSub: string;
  /** Refresh token DECIFRATO. */
  refreshToken: string;
  /** Credenziali dell'app OAuth interna del Workspace, decifrate. */
  clientId: string;
  clientSecret: string;
  /**
   * `google_workspaces.domains` del Workspace di QUESTA casella — stessa riga
   * del join già fatto per `clientId`/`clientSecret`, zero query aggiuntive.
   * Non è il perimetro dell'ammissione (fase 6c): quello vuole i domini di
   * TUTTI i Workspace registrati, non solo di quello della casella, e si
   * legge con una query dedicata (vedi `apps/worker/src/google/poller.ts`).
   * Questo campo resta comunque parte delle credenziali della casella perché
   * è la stessa riga già in mano — un consumatore che ha bisogno solo del
   * proprio Workspace non deve rifare il join.
   */
  domains: string[];
  scopes: string[];
  proposalsEnabled: boolean;
  /** Cursore della History API di Gmail (null = primo giro). */
  gmailHistoryId: string | null;
  /** Cursore incrementale del calendario `primary` (null = primo giro). */
  calendarSyncToken: string | null;
  /** Valorizzato = casella disabilitata: il chiamante decide se saltarla. */
  disabledAt: Date | null;
}

/**
 * Carica le credenziali di una casella, o `null` se non sono utilizzabili.
 *
 * `null` — e non un throw — in TUTTI i casi in cui la casella non è
 * spendibile: riga inesistente, Workspace senza `client_secret`
 * (la sentinella `""` di `google-workspaces.ts`, che NON va passata a
 * `decrypt`), payload cifrato illeggibile con la chiave corrente. Sono
 * situazioni di configurazione, non bug: chi chiama è un poller che deve
 * saltare quella casella e proseguire con le altre, non morire sul primo
 * Workspace mal configurato.
 *
 * Un `disabledAt` valorizzato NON è una di quelle situazioni: la riga torna
 * comunque, con il campo, perché lo scollegamento (che revoca il token) e la
 * riattivazione hanno bisogno delle credenziali proprio di una casella
 * disabilitata. È chi pesca le caselle da sincronizzare a filtrarle, con
 * l'indice parziale che ha già in mano.
 */
export async function loadGoogleAccountCredentials(
  db: DbOrTx,
  encryptionKey: Buffer,
  accountId: string,
): Promise<GoogleAccountCredentials | null> {
  const [row] = await db
    .select({
      accountId: googleAccounts.id,
      userId: googleAccounts.userId,
      workspaceId: googleAccounts.workspaceId,
      email: googleAccounts.email,
      googleSub: googleAccounts.googleSub,
      refreshTokenEncrypted: googleAccounts.refreshTokenEncrypted,
      scopes: googleAccounts.scopes,
      proposalsEnabled: googleAccounts.proposalsEnabled,
      gmailHistoryId: googleAccounts.gmailHistoryId,
      calendarSyncToken: googleAccounts.calendarSyncToken,
      disabledAt: googleAccounts.disabledAt,
      clientId: googleWorkspaces.clientId,
      clientSecretEncrypted: googleWorkspaces.clientSecretEncrypted,
      domains: googleWorkspaces.domains,
    })
    .from(googleAccounts)
    .innerJoin(googleWorkspaces, eq(googleWorkspaces.id, googleAccounts.workspaceId))
    .where(eq(googleAccounts.id, accountId));
  if (!row) return null;
  // La sentinella "nessun segreto" del registro Workspace: stringa vuota, che
  // non è un payload `iv.authTag.ciphertext` e farebbe lanciare `decrypt`.
  if (row.clientSecretEncrypted === "") return null;

  try {
    return {
      accountId: row.accountId,
      userId: row.userId,
      workspaceId: row.workspaceId,
      email: row.email,
      googleSub: row.googleSub,
      refreshToken: decrypt(row.refreshTokenEncrypted, encryptionKey),
      clientId: row.clientId,
      clientSecret: decrypt(row.clientSecretEncrypted, encryptionKey),
      domains: row.domains,
      scopes: row.scopes,
      proposalsEnabled: row.proposalsEnabled,
      gmailHistoryId: row.gmailHistoryId,
      calendarSyncToken: row.calendarSyncToken,
      disabledAt: row.disabledAt,
    };
  } catch {
    // Chiave sbagliata o payload manomesso (GCM autentica, non solo cifra).
    return null;
  }
}
