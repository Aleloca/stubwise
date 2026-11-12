import type * as Fake from "../../api";
import type { MailboxView } from "../../types";
import { appClient, session } from "./client";
import { myAccounts, needsReconnect } from "./google";
import { partialNamespace } from "./notIntegrated";

// La Posta nella build app (area 6, fetta 1): la lettura che il server sa già
// fare (la posta TRATTATA, le proposte per casella), più «Aggiorna ora» e
// letto/non letto sincronizzato con Gmail. Qui, per ora, le caselle.

type Mail = typeof Fake.mail;

/** Una casella non allineata da più di 5 minuti è «vecchia», come nel prototipo. */
const MAIL_STALE_MS = 5 * 60_000;

/** Tutte le mie caselle, una per Workspace (la Posta le mostra tutte, decisione B(a)). */
const listMailboxes: Mail["listMailboxes"] = async () => {
  const at = Date.now();
  return (await myAccounts()).map<MailboxView>((a) => {
    const syncedAt = a.lastSyncAt ?? a.connectedAt;
    return {
      personId: session.personId ?? "",
      email: a.email,
      proposalsEnabled: a.proposalsEnabled,
      syncedAt,
      sync: "ok",
      stale: at - Date.parse(syncedAt) > MAIL_STALE_MS,
      expired: needsReconnect(a),
    };
  });
};

/** «Proposte attive per questa casella»: la casella della sua email; una che non è mia è `not_found`. */
const setProposalsEnabled: Mail["setProposalsEnabled"] = async (email, on) => {
  const account = (await myAccounts()).find((a) => a.email === email);
  if (!account) throw new Error("not_found");
  await appClient().google.setProposals(account.id, on);
};

export const mailFunctions: Partial<Mail> = {
  listMailboxes,
  setProposalsEnabled,
};

export const mail: Mail = partialNamespace<Mail>("mail", mailFunctions);
