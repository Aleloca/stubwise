import { isHumanId, refuse } from "../admin/common";
import { linkGoogleAccount, unlinkGoogleAccount } from "../drive/writes";
import { writeProposalsEnabled } from "../mail/writes";
import { gate, state } from "../store";
import { writer } from "../writer";
import type { GoogleConnectOutcome, MeResult, MyMailbox, MyMailboxes } from "./types";

// Le caselle Google personali (area 9a, Preferenze → Account). Sono le
// STESSE caselle che Posta e Calendario leggono (area 6, `state.mailboxes`
// e `state.googleAccounts`): collegare, ricollegare, scollegare e
// l'interruttore «Proposals» passano dagli unici scrittori
// (`linkGoogleAccount`/`unlinkGoogleAccount` del Drive,
// `writeProposalsEnabled` della Posta), quindi lo stato cambia insieme
// ovunque. Una casella per persona, come nell'area 6: il suo id è
// l'indirizzo.
//
// SOLO PROTOTIPO: Google risponde con l'esito scelto nel riquadro
// «Prototype only» del dialogo (`outcome`).

const workspaceOf = (email: string) => {
  const domain = email.split("@")[1]?.toLowerCase();
  return state.googleWorkspaces.find((w) => domain && w.domains.includes(domain)) ?? null;
};

function viewOf(me: string): MyMailbox[] {
  const account = state.googleAccounts.find((a) => a.personId === me);
  return state.mailboxes
    .filter((b) => b.personId === me)
    .map((b) => ({
      id: b.email,
      email: b.email,
      workspaceName: workspaceOf(b.email)?.name ?? null,
      status: account?.status === "connected" ? "connected" : "needs_reconnect",
      sync: b.sync,
      syncedAt: b.syncedAt,
      proposalsEnabled: b.proposalsEnabled,
    }));
}

/** Le mie caselle, con lo stato che leggono anche Posta e Calendario, e i Workspace fra cui scegliere. */
export async function listMyMailboxes(): Promise<MyMailboxes> {
  const me = await gate("me.listMyMailboxes");
  return {
    mailboxes: viewOf(me),
    workspaces: state.googleWorkspaces.map((w) => ({ id: w.id, name: w.name })),
  };
}

const mine = (me: string, id: string) =>
  state.mailboxes.find((b) => b.personId === me && b.email === id);

/**
 * Collega una casella passando dal Workspace scelto. Google risponde con
 * `outcome` (prototipo): un esito negativo non cambia niente e torna in
 * parole (`invalid` col motivo del web). Una casella sola per persona.
 */
export async function connectMailbox(
  workspaceId: string,
  outcome: GoogleConnectOutcome = "connected",
): Promise<MeResult<{ mailbox: MyMailbox }>> {
  const me = await writer("me.connectMailbox");
  if (!isHumanId(me)) return refuse.forbidden();
  if (!state.googleWorkspaces.some((w) => w.id === workspaceId)) return refuse.notFound();
  if (state.mailboxes.some((b) => b.personId === me)) return refuse.invalid("already_connected");
  if (outcome !== "connected") return refuse.invalid(outcome);
  linkGoogleAccount(me);
  return { ok: true, mailbox: viewOf(me)[0]! };
}

/** «Reconnect» su una casella che ha perso l'accesso: lo stesso consenso, con lo stesso esito simulato. */
export async function reconnectMailbox(
  id: string,
  outcome: GoogleConnectOutcome = "connected",
): Promise<MeResult> {
  const me = await writer("me.reconnectMailbox");
  if (!mine(me, id)) return refuse.notFound();
  if (outcome !== "connected") return refuse.invalid(outcome);
  linkGoogleAccount(me);
  return { ok: true };
}

/** Scollega: Posta e Calendario smettono di mostrarla; la posta arrivata e le proposte fatte restano. */
export async function disconnectMailbox(id: string): Promise<MeResult> {
  const me = await writer("me.disconnectMailbox");
  if (!mine(me, id)) return refuse.notFound();
  unlinkGoogleAccount(me);
  return { ok: true };
}

/** L'interruttore «Proposals» della casella: lo stesso della Posta. */
export async function setProposals(id: string, on: boolean): Promise<MeResult> {
  const me = await writer("me.setProposals");
  if (!mine(me, id)) return refuse.notFound();
  writeProposalsEnabled(me, id, on);
  return { ok: true };
}
