/**
 * DA EVENTO A NOTIFICA PUSH: la traduzione di un {@link NotificationEvent} nel
 * `payload` del contratto del relay (`@stubwise/shared`).
 *
 * Divisione del lavoro con `../format.ts`: il CORPO della push è la stessa
 * frase che l'inbox mostra e che il webhook generico porta come `message`
 * (`formatNotificationText`) — una sola fonte testuale, nessuna variante da
 * tenere allineata. Qui si aggiungono solo le cose che esistono unicamente sul
 * telefono: un TITOLO corto, il deep link verso la riga d'inbox, il pallino sul
 * badge e i due identificatori con cui il sistema operativo raggruppa e
 * sostituisce le notifiche.
 */
import { t, type Language } from "@stubwise/i18n";
import {
  PUSH_BODY_MAX_CHARS,
  PUSH_TITLE_MAX_CHARS,
  type PushPayload,
} from "@stubwise/shared";
import { formatNotificationText, type NotificationEvent, type NotificationKind } from "../format.js";
import { truncate } from "./truncate.js";

/**
 * Chiave del catalogo col titolo della push, per kind.
 *
 * `Record<NotificationKind, string>` ESAUSTIVO, e non un template
 * `push.title.${kind}` costruito al volo: `t()` ritorna la chiave stessa quando
 * manca dal catalogo, quindi un kind nuovo produrrebbe una push col titolo
 * `push.title.qualcosa` — brutta ma non vuota, cioè invisibile a qualunque
 * controllo generico. Con il Record il compilatore rifiuta un kind senza
 * titolo, e un test verifica che ogni chiave qui elencata esista sia in `en`
 * sia in `it`. I due guardiani coprono i due errori diversi: dimenticare la
 * VOCE (tsc) e dimenticare la TRADUZIONE (test).
 */
export const PUSH_TITLE_KEY: Record<NotificationKind, string> = {
  "ticket.created": "push.title.ticket.created",
  "job.pr_opened": "push.title.job.pr_opened",
  "job.pr_closed": "push.title.job.pr_closed",
  "job.held": "push.title.job.held",
  "job.plan_review": "push.title.job.plan_review",
  "job.budget_held": "push.title.job.budget_held",
  "review.completed": "push.title.review.completed",
  "job.failed": "push.title.job.failed",
  "docs.limit_paused": "push.title.docs.limit_paused",
  "monitor.alert": "push.title.monitor.alert",
  "monitor.recovered": "push.title.monitor.recovered",
  "job.awaiting_input": "push.title.job.awaiting_input",
  "project.pulse": "push.title.project.pulse",
};

/**
 * Ciò che il payload sa della CONSEGNA e che l'evento non porta: lo sa il
 * poller, che ha davanti la riga di `notifications`.
 */
export interface PushPayloadContext {
  /** Riga d'inbox del destinatario: ancora del deep link e del `collapseId`. */
  notificationId: string;
  /** Notifiche non lette del destinatario: diventa il pallino sull'icona. */
  unreadCount: number;
  /**
   * Progetto della notifica, per raggruppare le push sul telefono.
   *
   * Sta QUI e non si legge dall'evento perché l'evento porta il NOME del
   * progetto, non il suo id: l'id vive su `notifications.project_id` (e su
   * `PublishOpts`), ed è nullable — i kind senza progetto esistono davvero.
   */
  projectId?: string | null;
}

/**
 * Parametri interpolati nel TITOLO. Oggi ne ha uno solo il pulse; la funzione
 * esiste perché aggiungerne un altro non richieda di ricordarsi di passarlo (un
 * test verifica che nessun titolo esca con un `{segnaposto}` non risolto).
 */
function titleParams(event: NotificationEvent): Record<string, string | number> {
  if (event.kind === "project.pulse") return { project: event.projectName };
  return {};
}

/**
 * Costruisce il payload push per un destinatario, nella sua lingua.
 *
 * IL TETTO NON È DECORATIVO: oltre 4096 byte APNs risponde `PayloadTooLarge` e
 * FCM `invalid-argument`. Un `job.failed` porta nella frase il messaggio
 * d'errore del run — che è `err.message`, cioè testo di lunghezza arbitraria —
 * e un titolo di ticket non ha un tetto stretto: senza troncatura quella push
 * verrebbe rifiutata, il relay tornerebbe `retry` e il poller ritenterebbe la
 * stessa consegna fino a esaurire i tentativi. Meglio un corpo tagliato che una
 * notifica che non arriva: chi la apre vede comunque la riga d'inbox intera.
 * Il tetto lo fa rispettare CHI COSTRUISCE il payload, così lo schema del
 * contratto non viene mai violato dall'interno.
 */
export function buildPushPayload(
  event: NotificationEvent,
  lang: Language,
  ctx: PushPayloadContext,
): PushPayload {
  return {
    title: truncate(t(lang, PUSH_TITLE_KEY[event.kind], titleParams(event)), PUSH_TITLE_MAX_CHARS),
    body: truncate(formatNotificationText(event, lang), PUSH_BODY_MAX_CHARS),
    // Su iOS è la `UNNotificationCategory` (i bottoni d'azione rapida), su
    // Android il `channel_id`: in entrambi i casi è il kind.
    category: event.kind,
    data: {
      notificationId: ctx.notificationId,
      kind: event.kind,
      // Il deep link porta alla RIGA D'INBOX, non al ticket: è lì che stanno
      // le azioni (approva, rispondi, rinvia) e da lì si arriva al resto.
      deepLink: `stubwise://inbox/${ctx.notificationId}`,
    },
    badge: ctx.unreadCount,
    // Raggruppamento per progetto sul telefono. Omesso — non `null` — quando la
    // notifica non ha un progetto: il contratto lo dichiara opzionale.
    ...(ctx.projectId ? { threadId: ctx.projectId } : {}),
    // Stessa notifica = stessa riga sul telefono: una consegna ritentata
    // SOSTITUISCE quella già arrivata invece di accodarne una seconda. È anche
    // ciò che rende innocuo il ritentativo di una spedizione spezzata in più
    // chiamate (vedi `relay-client.ts`).
    collapseId: ctx.notificationId,
  };
}
