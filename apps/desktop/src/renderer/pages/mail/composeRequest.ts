import { onBeforePersonaChange } from "../../data/session";
import type { MailDraft } from "../../data/types";

// La richiesta di aprire la casella di scrittura di una conversazione da
// fuori dal pannello di lettura: R/A/F dall'elenco, «Undo» di un invio,
// «Edit» di un invio fallito. Resta in attesa finché il pannello di quella
// conversazione (o la nuova email, `threadId: null`) non la prende — anche
// se nel frattempo si deve ancora aprire. Cambiare persona la cancella:
// nessuna casella di chi guardava prima si riapre a chi guarda adesso.

export interface ComposeRequest {
  threadId: string | null;
  mode: MailDraft["mode"];
  /** Il fuoco nel corpo (dopo «Undo», «Edit»), o nel primo campo della modalità (R/A/F). */
  focus: "body" | "start";
  /** Un'email nuova nel suo slot (R-K14); assente = la nuova email. */
  slot?: string;
}

let pending: ComposeRequest | null = null;
const listeners = new Set<(req: ComposeRequest) => void>();

export function requestCompose(req: ComposeRequest): void {
  pending = req;
  for (const l of listeners) l(req);
}

/** Il pannello di `threadId` (o dello slot dell'email nuova) prende la richiesta (una volta). */
export function takeCompose(threadId: string | null, slot?: string): ComposeRequest | null {
  if (!pending || pending.threadId !== threadId || pending.slot !== slot) return null;
  const req = pending;
  pending = null;
  return req;
}

export function onComposeRequest(fn: (req: ComposeRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

onBeforePersonaChange(() => {
  pending = null;
});

// La casella aperta di una conversazione, per chiuderla da fuori PRIMA che
// una bozza torni dal livello dati («Undo», «Edit», «Delete»): chiudendo
// salva il suo testo, e solo dopo la bozza tornata ci si unisce (R-I9) —
// altrimenti la casella ancora aperta la sovrascriverebbe col suo.
const closers = new Map<string, () => Promise<void>>();
const place = (threadId: string | null, slot?: string) => threadId ?? slot ?? "new";

export function registerComposer(
  threadId: string | null,
  close: () => Promise<void>,
  slot?: string,
): () => void {
  closers.set(place(threadId, slot), close);
  return () => {
    if (closers.get(place(threadId, slot)) === close) closers.delete(place(threadId, slot));
  };
}

/** Chiude la casella della conversazione, se è aperta, e aspetta che la bozza sia salvata. */
export async function closeComposer(threadId: string | null, slot?: string): Promise<void> {
  await closers.get(place(threadId, slot))?.();
}
