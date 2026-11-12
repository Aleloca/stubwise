import { ApiError } from "@stubwise/api-client";
import type { GoogleAccount as ServerGoogleAccount } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { GoogleAccount, GoogleFeature, GoogleWorkspaceChoice } from "../../types";
import { appClient, session } from "./client";

// Il cassetto Google nella build app (area 6, fetta 1): le caselle di
// `/api/me/google`, comuni a Drive, Posta e Calendario. Il prototipo ha UN
// account Google per persona; il server una casella per Workspace. Il
// cassetto mostra quella da ricollegare, se c'è, altrimenti la prima
// (decisione B(a) dell'orchestratrice; più account nel cassetto: registro);
// la Posta le mostra tutte (`mail.ts`).

type Drive = typeof Fake.drive;

/** Una casella da ricollegare: disattivata (token revocato) o senza gli scope del riconsenso unico. */
export const needsReconnect = (a: ServerGoogleAccount) => a.disabledAt !== null || a.missingScopes.length > 0;

/** Le mie caselle; 404/403 (Google non configurato sull'istanza) è nessuna. */
export async function myAccounts(): Promise<ServerGoogleAccount[]> {
  try {
    return (await appClient().google.accounts()) as ServerGoogleAccount[];
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return [];
    throw error;
  }
}

/** La casella del cassetto: quella da ricollegare, se c'è, altrimenti la prima. */
const drawerAccount = (accounts: readonly ServerGoogleAccount[]) => accounts.find(needsReconnect) ?? accounts[0] ?? null;

/**
 * Le funzioni di OGGI che ogni scope apre, per dire cosa manca a una casella
 * da ricollegare. Solo quelle che esistono già: `calendar.events` (F4) e
 * `drive.readonly` (F5) entrano con le loro fette; l'invio (F3) è anch'esso
 * di `gmail.modify`.
 */
const FEATURES_OF_SCOPE: Readonly<Record<string, readonly GoogleFeature[]>> = {
  "https://www.googleapis.com/auth/gmail.modify": ["markRead"],
};

function accountOf(a: ServerGoogleAccount): GoogleAccount {
  const base = { personId: session.personId ?? "", email: a.email };
  if (a.disabledAt !== null) return { ...base, status: "expired", reconnect: "expired", since: a.disabledAt };
  if (a.missingScopes.length > 0) {
    const missing = [...new Set(a.missingScopes.flatMap((s) => FEATURES_OF_SCOPE[s] ?? []))];
    return { ...base, status: "expired", reconnect: "scopes", missing, since: a.connectedAt };
  }
  return { ...base, status: "connected", since: a.connectedAt };
}

const getGoogleAccount: Drive["getGoogleAccount"] = async () => {
  const account = drawerAccount(await myAccounts());
  return account ? accountOf(account) : null;
};

/** I Workspace utilizzabili (con il segreto del client): fra cui scegliere se sono più d'uno. */
const listGoogleWorkspaces: Drive["listGoogleWorkspaces"] = async () => {
  const all = await appClient().google.workspaces();
  return all
    .filter((w) => w.clientSecretSet)
    .map<GoogleWorkspaceChoice>((w) => ({ id: w.id, name: w.name, domains: [...w.domains] }));
};

/** Ogni quanto si rileggono le caselle mentre «Collega» aspetta il consenso nel browser. */
const CONNECT_POLL_MS = 3_000;
/** Dopo quanto «Collega» smette di aspettare e dice l'errore («Try again»). */
const CONNECT_TIMEOUT_MS = 10 * 60_000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * «Collega» (o «Ricollega»): l'URL di consenso di Google si apre FUORI
 * dall'app (sul desktop i link http(s) vanno al browser di sistema), il
 * callback resta quello del web, che dice l'esito; qui si rileggono le
 * caselle ogni 3 s finché non c'è quella nuova o ricollegata (decisione
 * dell'orchestratrice: nessun deep link). Con più Workspace utilizzabili
 * serve la scelta (`invalid: workspace`); con nessuno, `invalid:
 * google_not_configured`. Dopo 10 minuti senza esito, `failed`.
 */
const connectGoogle: Drive["connectGoogle"] = async (options = {}) => {
  const usable = await listGoogleWorkspaces();
  if (usable.length === 0) throw new Error("invalid: google_not_configured");
  const workspaceId = options.workspaceId ?? (usable.length === 1 ? usable[0]!.id : null);
  if (!workspaceId || !usable.some((w) => w.id === workspaceId)) throw new Error("invalid: workspace");
  const before = new Map((await myAccounts()).map((a) => [a.id, a]));
  const { authorizeUrl } = await appClient().google.connect(workspaceId);
  // Con `noopener` `window.open` dà sempre null: non dice se s'è aperta.
  window.open(authorizeUrl, "_blank", "noopener");
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    await pause(CONNECT_POLL_MS);
    const accounts = await myAccounts();
    // Collegata: una casella sana che prima non c'era, o era da ricollegare, o è stata ricollegata adesso.
    const done = accounts.find((a) => {
      if (needsReconnect(a)) return false;
      const was = before.get(a.id);
      return !was || needsReconnect(was) || was.connectedAt !== a.connectedAt;
    });
    if (done) return accountOf(done);
    if (Date.now() >= deadline) throw new Error("failed");
  }
};

/** Scollega la casella del cassetto: revoca su Google e toglie la sua posta. */
const disconnectGoogle: Drive["disconnectGoogle"] = async () => {
  const account = drawerAccount(await myAccounts());
  if (!account) return;
  await appClient().google.disconnect(account.id);
};

// --- «Aggiorna ora» (F1.2) -------------------------------------------------------

/** Ogni quanto si rilegge la casella mentre il suo giro è in coda o in corso. */
const SYNC_POLL_MS = 2_000;
/** Dopo quanto si smette di aspettare: la casella dice da sé com'è andata. */
const SYNC_WAIT_MS = 2 * 60_000;

/**
 * Per client: le caselle di cui ho chiesto il giro, con il `lastSyncAt` di
 * quel momento (un giro finito senza che avanzi non è riuscito), e le attese
 * in corso (`whenSynced`).
 */
const syncs = new WeakMap<object, { asked: Map<string, string | null>; waits: Set<Promise<void>> }>();
function syncsOf() {
  const client = appClient();
  let entry = syncs.get(client);
  if (!entry) {
    entry = { asked: new Map(), waits: new Set() };
    syncs.set(client, entry);
  }
  return entry;
}

/**
 * L'allineamento di una casella: «in allineamento» finché il server ha una
 * richiesta in attesa; dopo una richiesta mia, «non riuscito» se `lastSyncAt`
 * non è avanzato.
 */
export function syncStateOf(a: ServerGoogleAccount): "ok" | "syncing" | "failed" {
  if (a.syncRequestedAt !== null) return "syncing";
  const { asked } = syncsOf();
  if (!asked.has(a.id)) return "ok";
  if (asked.get(a.id) === a.lastSyncAt) return "failed";
  asked.delete(a.id);
  return "ok";
}

/**
 * La casella si allinea con «Aggiorna ora»: ogni casella collegata, anche
 * con le proposte spente (decisione del maintainer, come il prototipo). Un
 * server che risponde ancora `proposals_disabled` dà l'errore.
 */
export const syncable = (a: ServerGoogleAccount) => a.disabledAt === null;

/**
 * «Aggiorna ora» di una casella. Una richiesta già in attesa o di meno di un
 * minuto fa (429) non è un errore: il giro c'è già. Scaduta →
 * `google_not_connected` («Ricollega»), proposte spente → `proposals_disabled`.
 */
export async function requestSync(a: ServerGoogleAccount): Promise<void> {
  try {
    await appClient().google.sync(a.id);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 429) return;
      if (error.code === "account_disabled") throw new Error("google_not_connected");
      if (error.code === "proposals_disabled") throw new Error("proposals_disabled");
      if (error.status === 404) throw new Error("not_found");
    }
    throw error;
  }
  const { asked, waits } = syncsOf();
  asked.set(a.id, a.lastSyncAt);
  const wait = (async () => {
    const deadline = Date.now() + SYNC_WAIT_MS;
    while (Date.now() < deadline) {
      await pause(SYNC_POLL_MS);
      const now = (await myAccounts()).find((x) => x.id === a.id);
      if (!now || now.syncRequestedAt === null) return;
    }
  })().catch(() => undefined);
  waits.add(wait);
  void wait.finally(() => waits.delete(wait));
}

/** Finiscono i giri chiesti da qui (o si smette di aspettarli). */
export async function whenSynced(): Promise<void> {
  await Promise.all([...syncsOf().waits]);
}

export const googleDriveFunctions: Partial<Drive> = {
  getGoogleAccount,
  listGoogleWorkspaces,
  connectGoogle,
  disconnectGoogle,
};
