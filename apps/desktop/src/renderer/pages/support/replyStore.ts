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
//
// Nessuna risposta parte senza il clic su «Invia al cliente», e mai da sola
// dopo un errore: «Non inviata» aspetta «Riprova» o «Modifica».

/** La finestra dell'«Annulla» dopo «Invia al cliente», come nella Posta. */
export const REPLY_UNDO_MS = 5000;

export interface PendingReply {
  personId: string;
  code: string;
  body: string;
  status: "sending" | "failed";
}

const drafts = new Map<string, string>();
const pending = new Map<string, PendingReply & { timer: number | null }>();
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

/** L'invio in attesa (o fallito) di questa persona in questa conversazione. */
export function pendingFor(personId: string, code: string): PendingReply | null {
  const p = pending.get(key(personId, code));
  return p ? { personId: p.personId, code: p.code, body: p.body, status: p.status } : null;
}

async function deliver(k: string, onSent: () => void): Promise<void> {
  const p = pending.get(k);
  if (!p || p.status !== "sending") return;
  p.timer = null;
  try {
    await replyToCustomerNow(p.code, p.body);
    if (pending.get(k) === p) pending.delete(k);
    onSent();
  } catch {
    if (pending.get(k) === p) p.status = "failed";
  }
  emit();
}

/** «Invia al cliente»: parte fra `REPLY_UNDO_MS`, salvo «Annulla». */
export function scheduleReply(
  code: string,
  body: string,
  onSent: () => void,
  fromComposer = true,
): void {
  const personId = getSessionPersonId();
  const k = key(personId, code);
  const old = pending.get(k);
  if (old?.timer) window.clearTimeout(old.timer);
  const entry: PendingReply & { timer: number | null } = {
    personId,
    code,
    body,
    status: "sending",
    timer: null,
  };
  entry.timer = window.setTimeout(() => void deliver(k, onSent), REPLY_UNDO_MS);
  pending.set(k, entry);
  // Dalla casella: il testo è partito, la casella si svuota. «Riprova» no:
  // nella casella può esserci già un testo nuovo.
  if (fromComposer) writeDraft(personId, code, "");
  else emit();
}

/**
 * «Annulla» (o «Modifica» di un invio fallito): l'invio non parte e il testo
 * torna nella casella — sotto quello scritto nel frattempo, mai al suo posto.
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

/** «Riprova» su un invio fallito: riparte con la finestra, come nella Posta. */
export function retryReply(personId: string, code: string, onSent: () => void): void {
  const p = pending.get(key(personId, code));
  if (!p || p.status !== "failed") return;
  scheduleReply(code, p.body, onSent, false);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Si rilegge a ogni cambio degli invii in attesa. */
export function usePendingReplies(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Svuota tutto (test, reset del prototipo). */
export function clearReplyStore(): void {
  for (const p of pending.values()) if (p.timer) window.clearTimeout(p.timer);
  pending.clear();
  drafts.clear();
  emit();
}

// Cambio di persona nella finestra: gli invii della persona di prima partono
// ORA, a suo nome (`writer` legge la sessione subito).
onBeforePersonaChange(() => {
  const me = getSessionPersonId();
  for (const [k, p] of pending) {
    if (p.personId !== me || p.status !== "sending") continue;
    if (p.timer) window.clearTimeout(p.timer);
    p.timer = null;
    void replyToCustomerNow(p.code, p.body).then(
      () => {
        if (pending.get(k) === p) pending.delete(k);
        emit();
      },
      () => {
        if (pending.get(k) === p) p.status = "failed";
        emit();
      },
    );
  }
});
