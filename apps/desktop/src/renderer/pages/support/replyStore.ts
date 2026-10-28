import { useSyncExternalStore } from "react";
import { getSessionPersonId } from "../../data/session";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { onBeforePersonaChange, replyToCustomerNow } from "../../data/queries";

// Ciò che la casella di Support tiene fra un montaggio e l'altro (shape
// support.md §5), per persona e conversazione:
//
// - il testo che si sta scrivendo (la «bozza» della casella): resta della
//   persona che lo scriveva anche cambiando persona o conversazione;
// - l'invio in attesa: «Invia al cliente» parte dopo 5 s, la finestra
//   dell'«Annulla» come nella Posta [A 11]. La finestra la tiene la UI: il
//   livello dati riceve `replyToCustomer` solo alla fine, quindi «Annulla»
//   non lascia traccia. Cambiare persona nella finestra NON annulla: l'invio
//   parte subito, a nome di chi ha cliccato (come la Posta, Review Focus 4).
//   Un invio alla volta: finché uno è in attesa, «Invia» è fermo (I1).
//
// Nessuna risposta parte senza il clic su «Invia al cliente», e mai da sola
// dopo un errore: un invio non riuscito torna nella casella, sotto il testo
// scritto nel frattempo, e lo dice («Non inviata»). Lo si rimanda con «Invia».

/** La finestra dell'«Annulla» dopo «Invia al cliente», come nella Posta. */
export const REPLY_UNDO_MS = 5000;

export interface PendingReply {
  personId: string;
  code: string;
  body: string;
}

const drafts = new Map<string, string>();
const pending = new Map<string, PendingReply & { timer: number | null }>();
/** Le conversazioni il cui ultimo invio non è riuscito (il testo è tornato nella casella). */
const failed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const key = (personId: string, code: string) => `${personId}:${code}`;
const emit = () => {
  version += 1;
  for (const l of listeners) l();
};

export function readDraft(personId: string, code: string): string {
  return drafts.get(key(personId, code)) ?? "";
}

export function writeDraft(personId: string, code: string, body: string): void {
  if (body) drafts.set(key(personId, code), body);
  else drafts.delete(key(personId, code));
  emit();
}

/** L'invio in attesa (nella finestra dell'«Annulla») di questa persona in questa conversazione. */
export function pendingFor(personId: string, code: string): PendingReply | null {
  const p = pending.get(key(personId, code));
  return p ? { personId: p.personId, code: p.code, body: p.body } : null;
}

/** L'ultimo invio non è riuscito: il suo testo è tornato nella casella. */
export const sendFailed = (personId: string, code: string): boolean =>
  failed.has(key(personId, code));

/** Non riuscito: il testo torna nella casella, sotto quello scritto nel frattempo. */
function giveBack(k: string, p: PendingReply) {
  if (pending.get(k) !== p) return;
  pending.delete(k);
  failed.add(k);
  writeDraft(p.personId, p.code, placeDraft(readDraft(p.personId, p.code), p.body, "below"));
}

async function deliver(k: string, onSent: () => Promise<void> | void): Promise<void> {
  const p = pending.get(k);
  if (!p) return;
  p.timer = null;
  try {
    await replyToCustomerNow(p.code, p.body);
  } catch {
    giveBack(k, p);
    return;
  }
  // Il messaggio «in invio» resta finché la conversazione riletta non ha
  // quello vero: niente buco fra i due, e il fuoco trova il messaggio inviato.
  await onSent();
  if (pending.get(k) === p) pending.delete(k);
  emit();
}

/**
 * «Invia al cliente»: parte fra `REPLY_UNDO_MS`, salvo «Annulla». Un invio
 * alla volta per conversazione: con uno già in attesa non fa nulla (la
 * casella tiene «Invia» fermo, col perché) e restituisce `false`.
 */
export function scheduleReply(
  code: string,
  body: string,
  onSent: () => Promise<void> | void,
): boolean {
  const personId = getSessionPersonId();
  const k = key(personId, code);
  if (pending.has(k)) return false;
  const entry: PendingReply & { timer: number | null } = { personId, code, body, timer: null };
  entry.timer = window.setTimeout(() => void deliver(k, onSent), REPLY_UNDO_MS);
  pending.set(k, entry);
  failed.delete(k);
  writeDraft(personId, code, "");
  return true;
}

/**
 * «Annulla»: l'invio non parte e il testo torna nella casella — sotto
 * quello scritto nel frattempo, mai al suo posto.
 */
export function takeBackReply(personId: string, code: string): boolean {
  const k = key(personId, code);
  const p = pending.get(k);
  if (!p) return false;
  if (p.timer) window.clearTimeout(p.timer);
  pending.delete(k);
  writeDraft(personId, code, placeDraft(readDraft(personId, code), p.body, "below"));
  return true;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Si rilegge a ogni cambio degli invii in attesa e della casella. */
export function usePendingReplies(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Svuota tutto (test, reset del prototipo). */
export function clearReplyStore(): void {
  for (const p of pending.values()) if (p.timer) window.clearTimeout(p.timer);
  pending.clear();
  drafts.clear();
  failed.clear();
  emit();
}

// Cambio di persona nella finestra: gli invii della persona di prima partono
// ORA, a suo nome (`writer` legge la sessione subito).
onBeforePersonaChange(() => {
  const me = getSessionPersonId();
  for (const [k, p] of pending) {
    if (p.personId !== me || p.timer === null) continue;
    window.clearTimeout(p.timer);
    p.timer = null;
    void replyToCustomerNow(p.code, p.body).then(
      () => {
        if (pending.get(k) === p) pending.delete(k);
        emit();
      },
      () => giveBack(k, p),
    );
  }
});
