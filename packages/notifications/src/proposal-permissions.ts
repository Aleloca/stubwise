/**
 * CHE PERMESSO SERVE A CONFERMARE UN'AZIONE DI UNA PROPOSTA DALLA POSTA
 * (fase permessi, 22 ott 2026 — design
 * `docs/plans/2026-10-22-permessi-progetto-design.md`, «Posta e calendario
 * verso progetti non visibili»).
 *
 * La classificazione considera TUTTI i progetti, quindi il proprietario di una
 * casella può ricevere una proposta per un progetto in cui non ha il permesso
 * di fare quella cosa. Confermarla richiede il permesso PERTINENTE nel
 * progetto dell'azione, cioè quello della rotta che fa la stessa cosa fuori
 * dalla posta — così la posta non diventa una porta laterale:
 *
 *  - `create_backlog_item` → `backlog.edit` (la spec lo nomina: l'intake può
 *    anche FONDERE la richiesta in una voce esistente, cioè modificarla);
 *  - `create_milestone`, `update_ticket` → `tickets.edit` (le milestone
 *    stanno dietro `tickets.edit`, ruling R16; cambiare stato o priorità è
 *    `PATCH /api/tickets/:id`);
 *  - `comment_ticket` → `tickets.comment`;
 *  - `record_decision` → `decisions.record`.
 *
 * Le altre non chiedono nessun permesso di progetto: `ignore` e
 * `acknowledge_reminder` non creano niente, `reassign_project` e
 * `hand_to_project` spostano o passano la proposta (il bersaglio della prima
 * lo valida il servizio: dev'essere un progetto che chi la sposta vede),
 * `choose_project` riattribuisce uno smistamento (la proposta che ne nasce
 * passa di nuovo di qui).
 *
 * Gli stessi permessi decidono CHI riceve la card passata
 * (`google.proposal_handed`, audience `project_deciders` in `./routing.ts`):
 * chi ne ha almeno uno nel progetto, più i full admin.
 *
 * Modulo PURO (entra in `./pure.ts`): web e app non lo usano per dedurre
 * permessi — li legge calcolati dal server — ma il worker e il server sì,
 * ed è l'unica copia della mappa.
 */
import type { ProjectPermission } from "@stubwise/shared";
import type { GoogleProposalActionType } from "./format.js";

const PERMISSION_FOR_ACTION: Record<GoogleProposalActionType, ProjectPermission | null> = {
  create_backlog_item: "backlog.edit",
  create_milestone: "tickets.edit",
  update_ticket: "tickets.edit",
  comment_ticket: "tickets.comment",
  record_decision: "decisions.record",
  choose_project: null,
  acknowledge_reminder: null,
  reassign_project: null,
  hand_to_project: null,
  ignore: null,
};

/**
 * Il permesso di progetto che serve a confermare un'azione del tipo dato, o
 * `null` se non ne serve nessuno. Un tipo sconosciuto (jsonb di una versione
 * futura) chiede il permesso più stretto fra quelli della mappa: meglio un
 * 403 che una conferma senza controllo.
 */
export function permissionForProposalAction(type: string): ProjectPermission | null {
  if (Object.hasOwn(PERMISSION_FOR_ACTION, type)) {
    return PERMISSION_FOR_ACTION[type as GoogleProposalActionType];
  }
  return "decisions.record";
}

/**
 * I permessi DISTINTI richiesti dalle azioni di una proposta, nell'ordine in
 * cui compaiono. Vuoto = nessuna azione chiede permessi.
 */
export function permissionsForProposalActions(
  actions: readonly { type: string }[],
): ProjectPermission[] {
  const out: ProjectPermission[] = [];
  for (const action of actions) {
    const permission = permissionForProposalAction(action.type);
    if (permission !== null && !out.includes(permission)) out.push(permission);
  }
  return out;
}
