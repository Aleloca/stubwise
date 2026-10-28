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
 * Lo stato di un'iscrizione all'istante `at`: l'ultima voce della storia
 * non successiva ad `at`; prima della prima voce (o senza riga) il default
 * del catalogo. Il default vale per i membri: chi vede il progetto senza
 * esserne membro (un full admin) parte spento.
 */
export function subscriptionAt(
  sub: AlertSubscription | undefined,
  def: AlertType,
  perms: Perms,
  at: string,
  member = true,
): Channels {
  let found: Channels | null = null;
  for (const entry of sub?.history ?? []) {
    if (entry.at <= at) found = { app: entry.app, phone: entry.phone };
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
  const def = alertTypeOf(n.kind);
  if (!def) return [];
  const out = new Map<string, Recipient["why"]>();
  for (const m of n.mandatory ?? []) {
    if (!out.has(m.personId)) out.set(m.personId, m.reason);
  }
  if (!def.mandatoryOnly) {
    const candidates = new Set([...ctx.members, ...ctx.subs.map((s) => s.personId)]);
    for (const personId of candidates) {
      if (out.has(personId)) continue;
      const sub = ctx.subs.find((s) => s.personId === personId && s.type === n.kind);
      const member = ctx.members.includes(personId);
      if (subscriptionAt(sub, def, ctx.permsOf(personId), n.createdAt, member).app)
        out.set(personId, "subscribed");
    }
  }
  return [...out]
    .filter(([personId]) => allowedNow(def, ctx.permsOf(personId), ctx.seesProject(personId)))
    .map(([personId, why]) => ({ personId, why }))
    .sort((a, b) => a.personId.localeCompare(b.personId));
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
