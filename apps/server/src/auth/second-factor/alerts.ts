import {
  publishNotification,
  type DbOrTx,
  type SecurityAlertSubject,
} from "@stubwise/notifications";

/**
 * Avviso di sicurezza all'interessato (`security.alert`): inbox, push e DM
 * Slack, non spegnibili dalle preferenze (`MANDATORY_KINDS`), al solo titolare
 * dell'account (audience `account_owner`) — mai agli admin per ruolo, mai al
 * webhook d'istanza. Niente email: Stubwise non ne manda.
 *
 * `actorEmail` è chi ha agito, da nominare nella frase («azzerato da …»);
 * `null` quando non c'è nessuno da nominare (il blocco per tentativi).
 *
 * Come `publishNotification`, non lancia mai: un avviso mancato non fa
 * fallire l'azione di sicurezza che lo genera. Passando il `tx` del chiamante
 * l'avviso nasce o non nasce insieme a quell'azione.
 */
export async function publishSecurityAlert(
  db: DbOrTx,
  userId: string,
  subject: SecurityAlertSubject,
  actorEmail: string | null,
): Promise<void> {
  await publishNotification(db, { kind: "security.alert", subject, actorEmail }, { accountUserId: userId });
}
