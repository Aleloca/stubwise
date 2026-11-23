import type { GoogleAccount as ServerGoogleAccount } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { MyMailbox } from "../../me/types";
import { appClient } from "./client";
import { googleDriveFunctions, myAccounts, needsReconnect, syncStateOf } from "./google";

// Registro, A9 r.1200 (decisione del maintainer del 23 nov 2026: «Anche in
// Preferenze»): le caselle Google in Preferenze → Account nella build app.
// Sono le STESSE del cassetto Google e della Posta (`/api/me/google`), come
// nel prototipo (`data/me/google.ts`): collegare e ricollegare passano dal
// consenso nel browser del cassetto (`connectGoogle`, che rilegge le caselle
// finché quella nuova non c'è), scollegare e «Proposals» dalle rotte della
// casella. L'id di una casella è quello del server. L'esito simulato del
// prototipo (`outcome`) qui non c'è: lo dice Google, nella pagina del web.

type Me = typeof Fake.me;

const connectGoogle = googleDriveFunctions.connectGoogle!;

function mailboxOf(a: ServerGoogleAccount): MyMailbox {
  return {
    id: a.id,
    email: a.email,
    workspaceName: (a as { workspaceName?: string | null }).workspaceName ?? null,
    status: needsReconnect(a) ? "needs_reconnect" : "connected",
    sync: syncStateOf(a),
    syncedAt: a.lastSyncAt ?? a.connectedAt,
    proposalsEnabled: a.proposalsEnabled,
  };
}

/** I Workspace fra cui scegliere: quelli utilizzabili (col segreto del client), come nel cassetto. */
async function usableWorkspaces(): Promise<{ id: string; name: string }[]> {
  return (await googleDriveFunctions.listGoogleWorkspaces!()).map((w) => ({
    id: w.id,
    name: w.name,
  }));
}

const mine = async (id: string) => (await myAccounts()).find((a) => a.id === id) ?? null;

/** Un «Collega» che non va (consenso non arrivato in tempo, Workspace non più utilizzabile): un rifiuto in parole. */
const failed = { ok: false as const, error: "invalid" as const, reason: "failed" };
const notFound = { ok: false as const, error: "not_found" as const };

const listMyMailboxes: Me["listMyMailboxes"] = async () => {
  const [accounts, workspaces] = await Promise.all([myAccounts(), usableWorkspaces()]);
  return { mailboxes: accounts.map(mailboxOf), workspaces };
};

const connectMailbox: Me["connectMailbox"] = async (workspaceId) => {
  try {
    const connected = await connectGoogle({ workspaceId });
    const account = (await myAccounts()).find((a) => a.email === connected.email);
    if (!account) return failed;
    return { ok: true, mailbox: mailboxOf(account) };
  } catch {
    return failed;
  }
};

const reconnectMailbox: Me["reconnectMailbox"] = async (id) => {
  const account = await mine(id);
  if (!account) return notFound;
  try {
    await connectGoogle({ workspaceId: account.workspaceId });
    return { ok: true };
  } catch {
    return failed;
  }
};

const disconnectMailbox: Me["disconnectMailbox"] = async (id) => {
  if (!(await mine(id))) return notFound;
  await appClient().google.disconnect(id);
  return { ok: true };
};

const setProposals: Me["setProposals"] = async (id, on) => {
  if (!(await mine(id))) return notFound;
  await appClient().google.setProposals(id, on);
  return { ok: true };
};

export const liveMeMailboxes: Partial<Me> = {
  listMyMailboxes,
  connectMailbox,
  reconnectMailbox,
  disconnectMailbox,
  setProposals,
};
