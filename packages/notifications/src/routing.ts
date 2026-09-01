import type { NotificationEvent, NotificationKind } from "./format.js";

/**
 * Instradamento PURO delle notifiche: da un evento (+ il contesto già risolto
 * dal chiamante) all'elenco dei destinatari che se lo vedranno comparire in
 * inbox.
 *
 * Nessun I/O qui: le query che risolvono admin, follower, richiedente e persone
 * del ticket vivono in `./publish.ts`. Tenere la decisione separata dalla
 * lettura la rende testabile senza DB ed è l'unico punto da cambiare quando le
 * regole di routing evolvono.
 */

/** Chi è coinvolto da un evento, già risolto in id utente dal chiamante. */
export interface RoutingContext {
  /** Tutti gli amministratori dell'istanza: ricevono ogni evento. */
  admins: string[];
  /** Chi segue il progetto dell'evento (`project_follows`). */
  followers: string[];
  /** Operatore che ha lanciato il job (`ai_jobs.requested_by_user_id`). */
  requestedBy?: string;
  /** Assegnatario del ticket (`tickets.assignee_id`). */
  assignee?: string;
  /**
   * Chi ha aperto il ticket. Oggi lo schema NON ha una colonna reporter (i
   * ticket nascono da ingestion/widget/Slack, senza autore interno): il campo
   * resta nel contratto perché il routing lo prevede e `publish` lo popolerà
   * appena la colonna esiste, senza toccare queste regole.
   */
  reporter?: string;
}

/** I pubblici possibili di un kind (vedi {@link AUDIENCE_FOR_KIND}). */
export type Audience = "admins" | "broadcast" | "requester";

/**
 * Pubblico di un kind: `admins` per gli eventi che richiedono una DECISIONE
 * (solo chi può prenderla) o che non hanno un progetto dietro; `broadcast` per
 * gli eventi di AVANZAMENTO, che interessano anche le persone del ticket e chi
 * segue il progetto; `requester` per le domande dell'AI, che riguardano chi ha
 * lanciato il job (più gli admin, che possono sempre sbloccarlo).
 *
 * Record esaustivo su `NotificationKind`: un kind nuovo non compila finché non
 * gli si sceglie un pubblico.
 */
const AUDIENCE_FOR_KIND: Record<NotificationKind, Audience> = {
  // Decisionali: qualcuno deve approvare il piano o sbloccare un job fermo.
  "job.plan_review": "admins",
  "job.held": "admins",
  "job.budget_held": "admins",
  // Avanzamento del lavoro su un ticket.
  "ticket.created": "broadcast",
  "job.pr_opened": "broadcast",
  "job.pr_closed": "broadcast",
  "job.failed": "broadcast",
  "review.completed": "broadcast",
  // Senza ticket né progetto seguibile: sono fatti d'istanza.
  "docs.limit_paused": "admins",
  "monitor.alert": "admins",
  "monitor.recovered": "admins",
  // La domanda dell'AI è rivolta a chi ha chiesto quel lavoro: chi segue il
  // progetto, l'assegnatario e il reporter non c'entrano — rispondere è una
  // decisione sul come procedere, non un aggiornamento da leggere.
  "job.awaiting_input": "requester",
};

/** Pubblico del kind. Unico punto in cui si legge {@link AUDIENCE_FOR_KIND}. */
export function audienceFor(kind: NotificationKind): Audience {
  return AUDIENCE_FOR_KIND[kind];
}

/**
 * Destinatari dell'evento, senza duplicati e in ordine stabile (admin prima,
 * poi le persone del ticket, infine i follower del progetto). L'ordine non ha
 * significato funzionale ma rende deterministici test e insert.
 */
export function recipientsFor(event: NotificationEvent, ctx: RoutingContext): string[] {
  switch (audienceFor(event.kind)) {
    case "admins":
      return dedupe(ctx.admins);
    case "requester":
      // Chi ha lanciato il job più gli admin. Senza richiedente (run
      // dell'automazione) restano i soli admin: qualcuno deve pur rispondere.
      return dedupe([...ctx.admins, ctx.requestedBy]);
    case "broadcast":
      return dedupe([
        ...ctx.admins,
        ctx.requestedBy,
        ctx.assignee,
        ctx.reporter,
        ...ctx.followers,
      ]);
  }
}

/** Scarta i valori non risolti e i doppioni, preservando la prima occorrenza. */
function dedupe(ids: (string | undefined | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}
