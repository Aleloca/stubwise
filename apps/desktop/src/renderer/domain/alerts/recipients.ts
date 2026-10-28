import type { AlertSubscription, AppNotification, MandatoryReason } from "../../data/model";
import type { Permission } from "../../data/viewer";
import { alertTypeOf, type AlertType } from "./catalog";

// Chi riceve un avviso del catalogo, calcolato a lettura (spec, scelta F):
// - gli obbligatori sempre, anche con l'iscrizione spenta;
// - gli iscritti secondo lo stato dell'iscrizione AL MOMENTO dell'avviso
//   (spegnere vale solo per il futuro: la storia dell'iscrizione lo dice);
// - tutti filtrati dai permessi e dalla visibilità di ADESSO (chi perde il
//   permesso smette di vedere anche gli avvisi già arrivati; se lo
//   riacquista, riprende — come «La revoca si applica a lettura»).

export type Perms = (p: Permission) => boolean;

export interface Channels {
  app: boolean;
  phone: boolean;
}

/**
 * Un momento: l'ora e, per ciò che è stato scritto nella sessione, il posto
 * nell'ordine monotono condiviso da avvisi e iscrizioni (R-K19).
 */
export interface Moment {
  at: string;
  seq?: number;
}

/** Adesso: dopo tutto ciò che è già stato scritto. */
export const latest = (at: string): Moment => ({ at, seq: Number.POSITIVE_INFINITY });

/**
 * Se una voce della storia vale per un momento. Con l'orologio fisso l'ora
 * non basta: due cose della sessione si ordinano col `seq`; una cosa della
 * sessione viene dopo ogni cosa del seme (che non ha `seq`); fra due cose
 * del seme decide l'ora.
 */
export function precedes(entry: Moment, moment: Moment): boolean {
  if (entry.seq !== undefined && moment.seq !== undefined) return entry.seq < moment.seq;
  if (entry.seq !== undefined) return false;
  if (moment.seq !== undefined) return true;
  return entry.at <= moment.at;
}

/**
 * Lo stato di un'iscrizione a un momento: l'ultima voce della storia che lo
 * precede (`precedes`); prima della prima voce (o senza riga) il default
 * del catalogo. Il default vale per i membri: chi vede il progetto senza
 * esserne membro (un full admin) parte spento. Default e appartenenza sono
 * quelli di ADESSO, non del momento dell'avviso: il prototipo non ha la
 * storia di permessi e membri, quindi chi entra oggi in un progetto (o
 * ottiene oggi il permesso) riceve per default anche gli avvisi di prima.
 * Vede comunque il progetto, quindi non tocca l'anti-obiettivo 5; R-K19
 * ordina solo le voci scritte.
 */
export function subscriptionAt(
  sub: AlertSubscription | undefined,
  def: AlertType,
  perms: Perms,
  at: Moment,
  member = true,
): Channels {
  let found: Channels | null = null;
  for (const entry of sub?.history ?? []) {
    if (precedes(entry, at)) found = { app: entry.app, phone: entry.phone };
  }
  if (found) return found;
  const on = member && def.defaultOn(perms);
  return { app: on, phone: on && def.defaultPhone };
}

/** Chi può iscriversi, o ricevere, un tipo adesso. */
export const allowedNow = (def: AlertType, perms: Perms, seesProject: boolean): boolean =>
  seesProject && (def.subscribe.perm === "member" || perms(def.subscribe.perm));

export interface RecipientContext {
  /** I membri del progetto dell'avviso. */
  members: string[];
  /** Le iscrizioni a questo tipo in questo progetto. */
  subs: AlertSubscription[];
  permsOf(personId: string): Perms;
  seesProject(personId: string): boolean;
}

export interface Recipient {
  personId: string;
  why: "subscribed" | MandatoryReason;
}

/**
 * I destinatari di un avviso del catalogo, in ordine di id. Chi è
 * obbligatorio lo è anche se iscritto: il perché è l'obbligo (la UI lo
 * scrive, e «Non avvisarmi più» non c'è).
 */
export function recipientsOf(n: AppNotification, ctx: RecipientContext): Recipient[] {
  const candidates = new Set([
    ...(n.mandatory ?? []).map((m) => m.personId),
    ...ctx.members,
    ...ctx.subs.map((s) => s.personId),
  ]);
  const out: Recipient[] = [];
  for (const personId of candidates) {
    const why = whyFor(n, personId, ctx);
    if (why) out.push({ personId, why });
  }
  return out.sort((a, b) => a.personId.localeCompare(b.personId));
}

/**
 * Se UNA persona riceve un avviso del catalogo, e perché (`null` se no):
 * la regola di `recipientsOf` valutata solo per lei, così chi chiede di
 * una persona (`whyReceives`, a ogni lettura) non calcola tutti i membri.
 */
export function whyFor(
  n: AppNotification,
  personId: string,
  ctx: RecipientContext,
): Recipient["why"] | null {
  const def = alertTypeOf(n.kind);
  if (!def) return null;
  const perms = ctx.permsOf(personId);
  if (!allowedNow(def, perms, ctx.seesProject(personId))) return null;
  const mandatory = n.mandatory?.find((m) => m.personId === personId);
  if (mandatory) return mandatory.reason;
  if (def.mandatoryOnly) return null;
  const member = ctx.members.includes(personId);
  const sub = ctx.subs.find((s) => s.personId === personId && s.type === n.kind);
  if (!member && !sub) return null;
  return subscriptionAt(sub, def, perms, { at: n.createdAt, seq: n.seq }, member).app
    ? "subscribed"
    : null;
}

/**
 * Gli obbligatori di un avviso su un merge: chi l'ha fatto; se è stato
 * fatto fuori da Stubwise da un'identità git non collegata, l'autore della
 * task collegata alla PR; altrimenti nessuno.
 */
export function mergeMandatory(
  mergedById: string | null,
  taskAuthorId: string | null,
): { personId: string; reason: MandatoryReason }[] {
  if (mergedById) return [{ personId: mergedById, reason: "merged" }];
  if (taskAuthorId) return [{ personId: taskAuthorId, reason: "task_author" }];
  return [];
}
