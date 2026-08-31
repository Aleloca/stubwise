import {
  publishNotification,
  type NotificationEvent,
  type PublishOpts,
} from "@stubwise/notifications";
import type { Db } from "@stubwise/db";

/**
 * Notifiche del worker: helper condivisi tra le fasi della pipeline (fix e
 * triage). Le notifiche sono BEST-EFFORT e vanno emesse DOPO che lo stato del
 * job è committato, così riflettono realtà committata. La publishNotification
 * reale non lancia mai; il wrapper qui sotto difende comunque da una publish
 * iniettata che lancia (nei test), perché una notifica non deve mai alterare
 * l'esito di un job.
 *
 * PUBBLICARE, non spedire: dalla Fase 0 il worker scrive inbox + outbox e
 * l'invio verso i canali è del poller. Per questo ogni chiamata porta con sé i
 * RIFERIMENTI dell'evento (`projectId`/`ticketId`/`jobId`): sono ciò che
 * instrada la notifica alle persone giuste e ciò che permette poi di chiudere
 * in blocco le notifiche di un job risolto.
 */

/** Firma della publish iniettabile (default: publishNotification). */
export type PublishFn = typeof publishNotification;

/** Opzioni di notifica comuni alle fasi della pipeline. */
export interface NotifyDeps {
  /** URL pubblico dell'istanza (PUBLIC_URL, senza slash finali); vuoto = il
   * link al ticket è il solo path. */
  publicUrl?: string;
  /** Nome del progetto da mostrare nel messaggio. */
  projectName?: string;
  /** Publish iniettabile nei test. Default: publishNotification. */
  publish?: PublishFn;
}

/** Compone l'URL del ticket: assoluto se publicUrl è valorizzato, altrimenti path. */
export function ticketUrl(publicUrl: string | undefined, ticketId: string): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  return `${base}/tickets/${ticketId}`;
}

/**
 * Pubblica una notifica best-effort. Mai propaga: un errore (inclusa una
 * publish iniettata che lancia) viene inghiottito così la notifica non altera
 * il job.
 *
 * `opts` è OBBLIGATORIO (anche `{}`): i riferimenti sono la parte che si
 * dimentica per prima, e un parametro esplicito costringe ogni punto di
 * emissione a dichiarare cosa sa dell'origine dell'evento.
 */
export async function notify(
  deps: NotifyDeps,
  db: Db,
  event: NotificationEvent,
  opts: PublishOpts,
): Promise<void> {
  const publish = deps.publish ?? publishNotification;
  try {
    await publish(db, event, opts);
  } catch {
    // Best-effort: vedi docblock del modulo.
  }
}
