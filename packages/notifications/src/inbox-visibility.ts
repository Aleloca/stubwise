/**
 * QUALI CARD D'INBOX IL DESTINATARIO PUÒ ANCORA VEDERE (permessi di progetto,
 * design `docs/plans/2026-10-22-permessi-progetto-design.md`, «Revoca
 * dell'accesso»).
 *
 * Una card è consegnata a UNA persona (`notifications.user_id`) al momento
 * della publish; se poi quella persona perde l'accesso al progetto della card,
 * la riga resta com'è — nessun processo la riscrive — e il filtro sta a
 * LETTURA: la card smette di comparire nell'elenco e nel conteggio, e le sue
 * azioni rispondono come per una card che non esiste.
 *
 * Il progetto della card è `project_id`, oppure — per le card pubblicate
 * PRIMA che la colonna esistesse, che in produzione hanno `project_id` nullo
 * ma un ticket — quello del ticket (`coalesce`, stessa derivazione di R34 per
 * le azioni). Senza questo ripiego una card vecchia di un ticket sfuggirebbe
 * alla revoca, trattata come un evento d'istanza.
 *
 * Visibile se:
 *  - non è di un progetto (né `project_id` né ticket: eventi d'istanza);
 *  - è la card della POSTA del proprietario (`google.proposal`): è sua e la
 *    governa la sua audience (`mailbox_owner`), non l'appartenenza. SOLO
 *    quel kind, non `google.*`: la proposta PASSATA al progetto
 *    (`google.proposal_handed`) è una card di progetto come le altre, e chi
 *    perde l'accesso al progetto smette di vederla;
 *  - il destinatario è membro del progetto, o full admin (membro implicito di
 *    ogni progetto).
 *
 * Una condizione SQL autonoma sulla sola `notifications` (legge
 * `notifications.user_id`), così vale identica per l'inbox del server e per
 * il `badge` delle push del worker — la campanella e il telefono devono dire
 * lo stesso numero (vedi `unread.ts`).
 */
import { notifications, projectMembers, tickets } from "@stubwise/db";
import { sql, type SQL } from "drizzle-orm";
import { userIsFullAdmin } from "./project-access.js";

/** Il progetto della card: la colonna, o quello del suo ticket (card vecchie). */
function cardProjectId(): SQL {
  return sql`coalesce(
    ${notifications.projectId},
    (select vt.project_id from ${tickets} vt where vt.id = ${notifications.ticketId})
  )`;
}

export function notificationVisibleToRecipient(): SQL {
  return sql`(
    ${cardProjectId()} is null
    or ${notifications.kind}::text = 'google.proposal'
    or exists (
      select 1 from ${projectMembers} vm
      where vm.project_id = ${cardProjectId()}
        and vm.user_id = ${notifications.userId}
    )
    or ${userIsFullAdmin(notifications.userId)}
  )`;
}
