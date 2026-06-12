import { dispatchNotification, type NotificationEvent } from "@stubwise/notifications";
import type { Db } from "@stubwise/db";

/**
 * Notifiche del worker: helper condivisi tra le fasi della pipeline (fix e
 * triage). Le notifiche sono BEST-EFFORT e vanno emesse DOPO che lo stato del
 * job è committato, così riflettono realtà committata. La dispatchNotification
 * reale non lancia mai; il wrapper qui sotto difende comunque da un dispatch
 * iniettato che lancia (nei test), perché una notifica non deve mai alterare
 * l'esito di un job.
 */

/** Firma del dispatch iniettabile (default: dispatchNotification). */
export type DispatchFn = (db: Db, event: NotificationEvent) => Promise<void>;

/** Opzioni di notifica comuni alle fasi della pipeline. */
export interface NotifyDeps {
  /** URL pubblico dell'istanza (PUBLIC_URL, senza slash finali); vuoto = il
   * link al ticket è il solo path. */
  publicUrl?: string;
  /** Nome del progetto da mostrare nel messaggio. */
  projectName?: string;
  /** Dispatch iniettabile nei test. Default: dispatchNotification. */
  dispatch?: DispatchFn;
}

/** Compone l'URL del ticket: assoluto se publicUrl è valorizzato, altrimenti path. */
export function ticketUrl(publicUrl: string | undefined, ticketId: string): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  return `${base}/tickets/${ticketId}`;
}

/**
 * Emette una notifica best-effort. Mai propaga: un errore (incluso un dispatch
 * iniettato che lancia) viene inghiottito così la notifica non altera il job.
 */
export async function notify(deps: NotifyDeps, db: Db, event: NotificationEvent): Promise<void> {
  const dispatch = deps.dispatch ?? dispatchNotification;
  try {
    await dispatch(db, event);
  } catch {
    // Best-effort: vedi docblock del modulo.
  }
}
