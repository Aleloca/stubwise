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
  "project.brief": "push.title.project.brief",
  "google.proposal": "push.title.google.proposal",
};

/**
 * Deep link del payload: la RIGA D'INBOX per ogni kind, TRANNE uno.
 *
 * `google.proposal` con `source: "email"` E `projectId` risolto è l'eccezione
 * (App M3, Fase C, Task 7 — architettura di navigazione §5 regola 2: "da una
 * notifica si arriva all'oggetto, mai a un elenco"): porta DIRETTAMENTE al
 * dettaglio della email (`stubwise://mail/email/:proposalId`), non alla card
 * generica d'inbox. Stesso campo che il web usa per lo stesso scopo
 * (`apps/web/src/components/inbox-item.tsx`, il link "Leggi in Stubwise").
 *
 * ⚠️ **`projectId !== undefined` non è un dettaglio, è la guardia che rende
 * questo link corretto invece che rotto.** `proposalId` è `email_proposals.id`
 * SOLO per una proposta VERA (`buildEmailProposalEvent`, `apps/worker/src/
 * google/proposal.ts` — l'unico chiamante che passa `proposalId: row.
 * proposalId`, un fix di correttezza di questo stesso task: prima non lo
 * passava, e il campo era un `randomUUID()` senza relazione con
 * `email_proposals`, esattamente come già documentato per il calendario, ma
 * MAI corretto per l'email). Per una proposta di **smistamento**
 * (`buildTriageProposalEvent`) e per il **calendario**
 * (`buildCalendarProposalEvent`) resta un `randomUUID()` VOLUTO — non c'è un
 * `email_proposals.id` a cui somigli, perché uno smistamento vive sul PADRE
 * (nessun figlio) e un evento di calendario non ha un dettaglio dedicato. Le
 * due proposte VERE si distinguono dallo smistamento per `projectId`: sempre
 * presente sulle prime (`assembleEvent({ projectId: proposal.projectId,
 * ... })`, mai opzionale nel percorso nuovo), sempre assente sul secondo
 * ("NIENTE projectId/projectName: qui il progetto è ciò che manca" — vedi il
 * docblock di `buildTriageProposalEvent`). Senza questa guardia, la card di
 * uno smistamento erediterebbe lo stesso link della email vera e punterebbe a
 * un `id` che non esiste in `email_proposals` — un 404 silenzioso al primo
 * tap, non un errore che questo file avrebbe mai sollevato da solo.
 *
 * **`source: "calendar"` è la SECONDA eccezione da App M3, Fase D**, ora che
 * una schermata calendario esiste: `stubwise://calendar/<YYYY-MM-DD>` porta
 * alla griglia sul giorno dell'appuntamento, e
 * `stubwise://calendar/<YYYY-MM-DD>/<calendarEventId>` direttamente
 * sull'appuntamento.
 *
 * Due campi e non uno, e nessuno dei due è `proposalId`:
 * - il GIORNO viene da `receivedAt`, che per una proposta di calendario È
 *   `calendar_events.starts_at` (`buildCalendarProposalEvent`). Serve perché
 *   la griglia carica per INTERVALLO — senza il giorno un client non saprebbe
 *   nemmeno quale mese chiedere — e c'è su OGNI card, comprese quelle
 *   pubblicate prima di questa fase: è ciò che rende il link retroattivo
 *   senza backfill.
 * - `calendarEventId` (`calendar_events.id`) apre l'appuntamento. Assente —
 *   una card storica — si apre la sola giornata, che è meno di quanto
 *   l'architettura §5 chiede ma è la degradazione onesta, la stessa di
 *   `proposalId` assente sulla posta.
 *
 * ⚠️ **`proposalId` NON è servito e non va usato qui**: per il calendario è
 * un `randomUUID()`, e deve restarlo — è la chiave di claim di
 * `propagateHandled`, e `publishProposal` ritrova la notifica appena scritta
 * con `event->>'proposalId' = … limit 1`. Renderlo stabile per riga
 * romperebbe quella query su un percorso raggiungibile dalla UI («Riproponi»
 * su un evento di calendario ripubblica per la stessa riga). Chi in futuro
 * fosse tentato di «semplificare» unificando i due campi legga il docblock
 * di `inboxGoogleSchema.calendarEventId` in `@stubwise/shared`.
 *
 * Per uno smistamento e per ogni altro kind resta il comportamento di
 * sempre: l'oggetto è la card d'inbox stessa, le azioni vivono lì.
 */
function deepLinkFor(event: NotificationEvent, ctx: PushPayloadContext): string {
  if (event.kind === "google.proposal" && event.source === "email" && event.projectId !== undefined) {
    return `stubwise://mail/email/${event.proposalId}`;
  }
  if (event.kind === "google.proposal" && event.source === "calendar") {
    const day = calendarDayOf(event.receivedAt);
    if (day !== null) {
      return event.calendarEventId !== undefined
        ? `stubwise://calendar/${day}/${event.calendarEventId}`
        : `stubwise://calendar/${day}`;
    }
  }
  return `stubwise://inbox/${ctx.notificationId}`;
}

/**
 * Il giorno `YYYY-MM-DD` di un istante ISO, in UTC, o `null` se il campo
 * manca o non è una data.
 *
 * **UTC e non locale**, e qui il fuso non è una svista da correggere: questo
 * codice gira sul WORKER, il cui fuso non ha niente a che vedere con quello
 * di chi riceverà la push. Un appuntamento delle 09:00 di Roma è
 * `07:00Z`, e il giorno UTC è lo stesso — sfasa solo nelle poche ore a
 * cavallo della mezzanotte, dove il link porta al giorno adiacente e
 * l'appuntamento è comunque a un tocco (la griglia mostra il mese intero, e
 * con `calendarEventId` il foglio si apre lo stesso). Calcolarlo nel fuso
 * del destinatario richiederebbe di conoscerlo: non lo conosciamo, e
 * inventarlo sarebbe peggio.
 */
function calendarDayOf(receivedAt: string | undefined): string | null {
  if (receivedAt === undefined) return null;
  const at = new Date(receivedAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 10);
}

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
  if (event.kind === "project.brief") return { project: event.projectName };
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
      // Un'eccezione (`google.proposal` da email): vedi {@link deepLinkFor}.
      deepLink: deepLinkFor(event, ctx),
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
