/**
 * CATALOGO DELLE AZIONI di una notifica: cosa si può fare su una riga d'inbox,
 * in funzione del `kind`, dello stato attuale del job e del ruolo di chi guarda.
 *
 * Modulo PURO: nessun accesso al DB, nessuna dipendenza da Fastify. Vive qui —
 * e non nel servizio inbox del server — perché ha DUE consumatori:
 *  - `apps/server/src/services/inbox.ts` (lista e esecuzione delle azioni), che
 *    lo ri-esporta per i suoi chiamanti;
 *  - il poller delle consegne del worker, che compone i bottoni Block Kit del
 *    DM Slack con le azioni calcolate PER IL DESTINATARIO (il worker non può
 *    importare da `apps/server`).
 *
 * Il catalogo è CALCOLATO, mai persistito: dipende dallo stato ATTUALE del job,
 * e persisterlo vorrebbe dire riscriverlo a ogni transizione (e sbagliarlo).
 */
import type { NotificationEvent, NotificationKind } from "./format.js";

/** Le azioni che una notifica può offrire. `open` è l'unica non eseguibile lato server. */
export type ActionId =
  | "approve_plan"
  | "reject_plan"
  | "relaunch"
  | "answer"
  | "open"
  | "snooze"
  | "handled";

/** Durate di rinvio ammesse dallo snooze. */
export type SnoozeUntil = "1h" | "tomorrow" | "3d";

/** Le durate di snooze nell'ordine in cui vanno offerte (menù Slack e UI). */
export const SNOOZE_OPTIONS: readonly SnoozeUntil[] = ["1h", "tomorrow", "3d"];

/** Ruolo di chi compie l'azione (speculare all'enum DB `user_role`). */
export type ActorRole = "admin" | "member";

/**
 * Chi compie l'azione. Strutturalmente compatibile con l'`Actor` del server
 * (`apps/server/src/services/jobs.ts`), che resta la forma canonica lato API.
 */
export interface ActionActor {
  id: string;
  role: ActorRole;
}

/**
 * Stati di un job AI considerati "in volo" (lavoro in corso o in attesa di una
 * decisione già richiesta). Definiti qui perché sono un ingrediente del
 * catalogo delle azioni; `apps/server/src/services/jobs.ts` li RI-ESPORTA come
 * `IN_FLIGHT` invece di ridichiararli, così le due liste non possono divergere.
 */
export const IN_FLIGHT_JOB_STATUSES = [
  "queued",
  "triaging",
  "fixing",
  "awaiting_plan_approval",
  // Parcheggiato su una domanda dell'agente: il lavoro non è finito, aspetta
  // una risposta. Rilanciarlo (o lanciarne un secondo) butterebbe via la
  // sessione CLI che la risposta deve riprendere.
  "awaiting_input",
] as const;

/**
 * Quel poco che serve a {@link actionsFor}: il resto della riga è irrilevante.
 *
 * `requestedByUserId` è il richiedente del job a cui la notifica è ancorata
 * (`null` per i run dell'automazione, o per le notifiche senza job). Serve alle
 * azioni il cui permesso è di IDENTITÀ e non di ruolo — oggi solo `answer`: a
 * una domanda dell'agente risponde chi ha avviato il run, o un maintainer. È un
 * campo OBBLIGATORIO, non opzionale, perché un chiamante che se lo dimentica
 * toglierebbe in silenzio al richiedente la possibilità di rispondere: meglio
 * che non compili.
 */
export interface ActionableNotification {
  kind: NotificationKind;
  requestedByUserId: string | null;
}

/**
 * IL CATALOGO, per kind: la decisione che offre, il ruolo minimo per prenderla
 * e se la riga si può archiviare a mano.
 *
 * `job.held` e `job.budget_held` sono lo stesso stato del job (`held`) con
 * `heldReason` diverso: un fermo "normale" lo può sbloccare chiunque, uno per
 * budget sforato no — è una decisione di spesa, e la portano già separata i due
 * `kind`, quindi qui non serve rileggere `ai_jobs.held_reason`.
 *
 * `archivable` sta QUI, e non in un elenco a parte dei kind "senza handled",
 * per una ragione precisa: questo Record è esaustivo su `NotificationKind`, e un
 * kind nuovo non compila finché non gli si risponde a TUTTE le domande del
 * catalogo — decisione, ruolo e archiviabilità. Un elenco separato (o un Set di
 * eccezioni) avrebbe invece un default silenzioso: chi aggiunge il kind seguente
 * non si accorgerebbe di doverci passare.
 */
const CATALOG_FOR_KIND: Record<
  NotificationKind,
  { decisions: ActionId[]; adminOnly: boolean; archivable: boolean }
> = {
  "job.plan_review": {
    decisions: ["approve_plan", "reject_plan"],
    adminOnly: true,
    archivable: true,
  },
  "job.held": { decisions: ["relaunch"], adminOnly: false, archivable: true },
  "job.budget_held": { decisions: ["relaunch"], adminOnly: true, archivable: true },
  "job.failed": { decisions: ["relaunch"], adminOnly: false, archivable: true },
  "job.pr_closed": { decisions: ["relaunch"], adminOnly: false, archivable: true },
  // Informativi: si aprono, si rinviano, si archiviano. Nient'altro.
  "job.pr_opened": { decisions: [], adminOnly: false, archivable: true },
  "review.completed": { decisions: [], adminOnly: false, archivable: true },
  "ticket.created": { decisions: [], adminOnly: false, archivable: true },
  "docs.limit_paused": { decisions: [], adminOnly: false, archivable: true },
  "monitor.alert": { decisions: [], adminOnly: false, archivable: true },
  "monitor.recovered": { decisions: [], adminOnly: false, archivable: true },
  // NON archiviabile di proposito: la domanda dell'agente si chiude solo
  // rispondendo. Archiviarla lascerebbe il job parcheggiato in `awaiting_input`
  // in silenzio, senza che nessuno si accorga che aspetta ancora qualcuno.
  //
  // ⚠️ Regge su un fatto NON LOCALE: l'unica uscita da `awaiting_input` è la
  // risposta, che chiude le copie della notifica in propagazione. Chi
  // introducesse un'altra uscita da quello stato (un annullamento, una
  // scadenza, un recovery) DEVE chiudere anche le notifiche: qui non resterebbe
  // nessuna azione utile — `answer` la nega lo stato, `handled` la nega il
  // catalogo — e la riga vivrebbe per sempre a colpi di snooze.
  "job.awaiting_input": { decisions: ["answer"], adminOnly: false, archivable: false },
};

/** Igiene dell'inbox: presente su OGNI notifica, non è una decisione. */
const HYGIENE: readonly ActionId[] = ["open", "snooze"];

/**
 * Azioni NON decisionali offerte dal kind: l'igiene, più l'archiviazione dove il
 * catalogo la ammette. Sono in coda alle decisioni in {@link actionsFor}.
 */
function hygieneFor(kind: NotificationKind): ActionId[] {
  return CATALOG_FOR_KIND[kind].archivable ? [...HYGIENE, "handled"] : [...HYGIENE];
}

/** True se lo stato del job è uno di {@link IN_FLIGHT_JOB_STATUSES} (lavoro in corso). */
function isInFlight(jobStatus: string | null | undefined): boolean {
  return jobStatus != null && (IN_FLIGHT_JOB_STATUSES as readonly string[]).includes(jobStatus);
}

/**
 * Il KIND prevede questa azione? È una domanda sul CATALOGO, indipendente da chi
 * chiede: `approve_plan` su un `job.failed` non è "vietato", è una richiesta che
 * non ha senso — e va distinta perché il chiamante risponde `invalid_action`
 * (400) invece di `forbidden` (403), che suggerirebbe a torto "riprova da admin".
 */
export function kindOffers(kind: NotificationKind, action: ActionId): boolean {
  return hygieneFor(kind).includes(action) || CATALOG_FOR_KIND[kind].decisions.includes(action);
}

/**
 * QUESTO actor può compiere l'azione? Separata da {@link kindOffers} e da
 * {@link stateAllows} perché i tre "no" hanno messaggi diversi: azione fuori
 * catalogo → `invalid_action`, permesso insufficiente → `forbidden`, stato del
 * job incompatibile → `plan_not_pending`/`job_in_flight`.
 *
 * Si chiama `actorAllows` e non `roleAllows` perché il ruolo non è più l'unico
 * criterio: quasi tutte le decisioni lo sono, `answer` no. La domanda è rivolta
 * a chi ha chiesto il run (il più delle volte un operatore, e l'unico che sa
 * rispondere nel merito), e in più a un maintainer — che deve poter sbloccare un
 * job parcheggiato da un collega in ferie. Per questo prende la notifica intera
 * e l'actor intero, identità compresa.
 */
export function actorAllows(
  notification: ActionableNotification,
  action: ActionId,
  actor: ActionActor,
): boolean {
  const { kind, requestedByUserId } = notification;
  if (!kindOffers(kind, action)) return false;
  if (hygieneFor(kind).includes(action)) return true;
  if (action === "answer") {
    return actor.role === "admin" || (requestedByUserId !== null && actor.id === requestedByUserId);
  }
  return !CATALOG_FOR_KIND[kind].adminOnly || actor.role === "admin";
}

/**
 * Lo STATO ATTUALE del job consente l'azione? `approve_plan`/`reject_plan` solo
 * su un piano davvero fermo sul gate; `answer` solo su un job davvero fermo su
 * una domanda (ripartito, la risposta non ha più nessuno che l'aspetta);
 * `relaunch` solo se l'ultimo job del ticket non è in volo (rilanciarne uno vivo
 * scippa il lavoro al worker).
 */
export function stateAllows(action: ActionId, jobStatus: string | null | undefined): boolean {
  switch (action) {
    case "approve_plan":
    case "reject_plan":
      return jobStatus === "awaiting_plan_approval";
    case "answer":
      return jobStatus === "awaiting_input";
    case "relaunch":
      return !isInFlight(jobStatus);
    default:
      return true;
  }
}

/**
 * Azioni offerte su una notifica, nell'ordine in cui vanno mostrate: prima le
 * decisioni (se chi guarda e lo stato del job le consentono), poi l'igiene
 * dell'inbox — apri/rinvia, più archivia sui kind che l'ammettono.
 *
 * `jobStatus` è lo stato dell'ULTIMO job del ticket a cui la notifica è
 * ancorata (`null` per gli eventi senza ticket, come `monitor.*`). Funzione
 * pura: nessun accesso al DB, così la si può chiamare in batch su una pagina
 * intera senza N+1.
 */
export function actionsFor(
  notification: ActionableNotification,
  jobStatus: string | null | undefined,
  actor: ActionActor,
): ActionId[] {
  const decisions = CATALOG_FOR_KIND[notification.kind].decisions.filter(
    (action) => actorAllows(notification, action, actor) && stateAllows(action, jobStatus),
  );
  return [...decisions, ...hygieneFor(notification.kind)];
}

/**
 * Dove porta `open`: la superficie su cui l'utente va a *fare* qualcosa.
 *
 * Per gli eventi il cui soggetto È la pull request (`job.pr_opened`,
 * `review.completed`) è la PR sul provider git — è lì che si legge il diff e si
 * approva. Per `job.pr_closed` no: la PR è chiusa, quello che conta è il ticket
 * riaperto. Gli eventi senza ticket portano alla loro pagina (Docs, server
 * monitorato).
 */
export function openUrl(event: NotificationEvent): string {
  switch (event.kind) {
    case "job.pr_opened":
    case "review.completed":
      return event.prUrl;
    case "docs.limit_paused":
      return event.docsUrl;
    case "monitor.alert":
    case "monitor.recovered":
      return event.url;
    case "ticket.created":
    case "job.pr_closed":
    case "job.held":
    case "job.plan_review":
    case "job.budget_held":
    case "job.failed":
    case "job.awaiting_input":
      return event.ticketUrl;
  }
}
