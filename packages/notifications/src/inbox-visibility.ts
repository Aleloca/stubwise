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
 * Visibile se:
 *  - non è di un progetto (`project_id` nullo: eventi d'istanza);
 *  - è una card della POSTA (`google.*`): è del proprietario della casella e la
 *    governa la sua audience (`mailbox_owner`), non l'appartenenza;
 *  - il destinatario è membro del progetto, o full admin (membro implicito di
 *    ogni progetto).
 *
 * Una condizione SQL autonoma sulla sola `notifications` (legge
 * `notifications.user_id`), così vale identica per l'inbox del server e per
 * il `badge` delle push del worker — la campanella e il telefono devono dire
 * lo stesso numero (vedi `unread.ts`).
 */
import { notifications, projectMembers } from "@stubwise/db";
import { sql, type SQL } from "drizzle-orm";
import { userIsFullAdmin } from "./project-access.js";

export function notificationVisibleToRecipient(): SQL {
  return sql`(
    ${notifications.projectId} is null
    or ${notifications.kind}::text like 'google.%'
    or exists (
      select 1 from ${projectMembers} vm
      where vm.project_id = ${notifications.projectId}
        and vm.user_id = ${notifications.userId}
    )
    or ${userIsFullAdmin(notifications.userId)}
  )`;
}
