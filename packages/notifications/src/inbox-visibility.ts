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
import { notifications, projectMembers, roles, tickets } from "@stubwise/db";
import { ALERT_TYPES, isLiveAlertType, type AlertType } from "@stubwise/shared";
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
    (
      ${cardProjectId()} is null
      or ${notifications.kind}::text = 'google.proposal'
      or exists (
        select 1 from ${projectMembers} vm
        where vm.project_id = ${cardProjectId()}
          and vm.user_id = ${notifications.userId}
      )
      or ${userIsFullAdmin(notifications.userId)}
    )
    and ${catalogPermissionVisible(ALERT_TYPES.filter((t) => isLiveAlertType(t.type)))}
  )`;
}

/**
 * Area 8, F2 (S2, «la revoca a lettura»): una card di un tipo del CATALOGO
 * che per iscriversi vuole un permesso nel progetto (`subscribe.perm`, es.
 * `repos.view`) si vede solo finché il destinatario ce l'ha — e torna
 * visibile se lo riacquista, senza riscrivere righe. Non per chi l'ha
 * ricevuta da OBBLIGATORIO (`event.alertMandatory`): quella è sua per il
 * motivo, non per l'iscrizione. I tipi con `subscribe: member` hanno già il
 * filtro dell'appartenenza qui sopra. Esportata per i test, che la provano
 * su tipi non ancora vivi.
 */
export function catalogPermissionVisible(types: readonly AlertType[]): SQL {
  const gated = types.filter((t) => t.subscribe.perm !== "member");
  if (gated.length === 0) return sql`true`;
  const clauses = gated.map(
    (t) => sql`(
      ${notifications.kind}::text <> ${t.type}
      or ${notifications.event}->>'alertMandatory' is not null
      or ${userIsFullAdmin(notifications.userId)}
      or exists (
        select 1 from ${projectMembers} cm
        inner join ${roles} cr on cr.id = cm.role_id
        where cm.project_id = ${cardProjectId()}
          and cm.user_id = ${notifications.userId}
          and cr.permissions @> array[${t.subscribe.perm}]::text[]
      )
    )`,
  );
  return sql.join(clauses, sql` and `);
}
