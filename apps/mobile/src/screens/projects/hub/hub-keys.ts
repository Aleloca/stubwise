import { backlogKeys } from "../../../lib/backlog-mutations";
import { inboxKeys, ticketKeys } from "../../../lib/query-keys";

/**
 * Le chiavi di query delle ANTEPRIME dell'hub (tab Lavoro del dettaglio v3).
 *
 * Sono DISTINTE da quelle delle schermate piene (`ticketKeys.list`,
 * `backlogKeys.list`, `projectInboxKey`) perché chiedono un `limit` diverso:
 * la stessa chiave farebbe servire una pagina da tre righe alla schermata
 * intera.
 *
 * ⚠️ **Ma stanno sotto i prefissi ESISTENTI — `["tickets"]`, `["backlog"]`,
 * `["inbox"]` — e quella è la parte che conta.** Non è un modo di
 * raggruppare: è ciò che le fa invalidare insieme al resto, da ogni
 * mutazione di oggi e da quelle che verranno. In un namespace proprio
 * (`["projects","hub",…]`, com'erano nate) nessuna invalidazione le
 * raggiungeva: il dettaglio resta MONTATO sotto, nello stack nativo, mentre
 * si è nella schermata figlia, e l'app non ha refetch-on-focus da nessuna
 * parte — si tornava indietro dopo aver convertito una voce o risposto a una
 * proposta e si vedeva il numero vecchio.
 *
 * Chi le sposta «per ordine» sotto un namespace `projects` riapre quel
 * difetto.
 */
export const hubKeys = {
  tickets: (projectId: string) => ticketKeys.hub(projectId),
  backlog: (projectId: string) => [...backlogKeys.all, "list", "hub", projectId] as const,
  inbox: (projectId: string) => [...inboxKeys.all, "list", "hub", projectId] as const,
};
