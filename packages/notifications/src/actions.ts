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
export type ActionId = "approve_plan" | "reject_plan" | "relaunch" | "open" | "snooze" | "handled";

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
] as const;

/** Quel poco che serve a {@link actionsFor}: il resto della riga è irrilevante. */
export interface ActionableNotification {
  kind: NotificationKind;
}

/**
 * Azione DECISIONALE offerta da ciascun kind, col ruolo minimo per compierla.
 *
 * `job.held` e `job.budget_held` sono lo stesso stato del job (`held`) con
 * `heldReason` diverso: un fermo "normale" lo può sbloccare chiunque, uno per
 * budget sforato no — è una decisione di spesa, e la portano già separata i due
 * `kind`, quindi qui non serve rileggere `ai_jobs.held_reason`.
 *
 * Record esaustivo su `NotificationKind`: un kind nuovo non compila finché non
 * gli si decide un'azione (anche "nessuna").
 */
const DECISION_FOR_KIND: Record<NotificationKind, { actions: ActionId[]; adminOnly: boolean }> = {
  "job.plan_review": { actions: ["approve_plan", "reject_plan"], adminOnly: true },
  "job.held": { actions: ["relaunch"], adminOnly: false },
  "job.budget_held": { actions: ["relaunch"], adminOnly: true },
  "job.failed": { actions: ["relaunch"], adminOnly: false },
  "job.pr_closed": { actions: ["relaunch"], adminOnly: false },
  // Informativi: si aprono, si rinviano, si archiviano. Nient'altro.
  "job.pr_opened": { actions: [], adminOnly: false },
  "review.completed": { actions: [], adminOnly: false },
  "ticket.created": { actions: [], adminOnly: false },
  "docs.limit_paused": { actions: [], adminOnly: false },
  "monitor.alert": { actions: [], adminOnly: false },
  "monitor.recovered": { actions: [], adminOnly: false },
};

/** Azioni disponibili su OGNI notifica: sono igiene dell'inbox, non decisioni. */
const ALWAYS: ActionId[] = ["open", "snooze", "handled"];

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
  return ALWAYS.includes(action) || DECISION_FOR_KIND[kind].actions.includes(action);
}

/**
 * Il RUOLO consente l'azione? Separata da {@link kindOffers} e da
 * {@link stateAllows} perché i tre "no" hanno messaggi diversi: azione fuori
 * catalogo → `invalid_action`, ruolo insufficiente → `forbidden`, stato del job
 * incompatibile → `plan_not_pending`/`job_in_flight`.
 */
export function roleAllows(kind: NotificationKind, action: ActionId, role: ActorRole): boolean {
  if (!kindOffers(kind, action)) return false;
  if (ALWAYS.includes(action)) return true;
  return !DECISION_FOR_KIND[kind].adminOnly || role === "admin";
}

/**
 * Lo STATO ATTUALE del job consente l'azione? `approve_plan`/`reject_plan` solo
 * su un piano davvero fermo sul gate; `relaunch` solo se l'ultimo job del ticket
 * non è in volo (rilanciarne uno vivo scippa il lavoro al worker).
 */
export function stateAllows(action: ActionId, jobStatus: string | null | undefined): boolean {
  switch (action) {
    case "approve_plan":
    case "reject_plan":
      return jobStatus === "awaiting_plan_approval";
    case "relaunch":
      return !isInFlight(jobStatus);
    default:
      return true;
  }
}

/**
 * Azioni offerte su una notifica, nell'ordine in cui vanno mostrate: prima le
 * decisioni (se il ruolo e lo stato le consentono), poi apri/rinvia/archivia.
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
  const decisions = DECISION_FOR_KIND[notification.kind].actions.filter(
    (action) => roleAllows(notification.kind, action, actor.role) && stateAllows(action, jobStatus),
  );
  return [...decisions, ...ALWAYS];
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
      return event.ticketUrl;
  }
}
