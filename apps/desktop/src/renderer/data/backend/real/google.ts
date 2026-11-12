import { ApiError } from "@stubwise/api-client";
import type { GoogleAccount as ServerGoogleAccount } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { GoogleAccount, GoogleWorkspaceChoice } from "../../types";
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

function accountOf(a: ServerGoogleAccount): GoogleAccount {
  const expired = needsReconnect(a);
  return {
    personId: session.personId ?? "",
    email: a.email,
    status: expired ? "expired" : "connected",
    since: a.disabledAt ?? a.connectedAt,
  };
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

export const googleDriveFunctions: Partial<Drive> = {
  getGoogleAccount,
  listGoogleWorkspaces,
  connectGoogle,
  disconnectGoogle,
};
