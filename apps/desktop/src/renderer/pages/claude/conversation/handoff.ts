import type { Attachment } from "../../../data/types";

// Il primo messaggio di una conversazione appena nata (l'atterraggio, una
// continuazione) lo manda la conversazione stessa, non la pagina da cui si
// parte: così passa dalla sua casella — «Delivering…» finché è in coda, e
// se non va a buon fine resta lì con «didn't go through · Resend».

export interface PendingSend {
  text: string;
  attachments: Attachment[];
}

const pending = new Map<string, PendingSend>();

/** Affida il primo messaggio alla conversazione `id`, che lo manderà appena aperta. */
export function handOffFirstMessage(id: string, message: PendingSend): void {
  pending.set(id, { text: message.text, attachments: [...message.attachments] });
}

/** Lo prende (una volta sola): chi lo prende lo manda. */
export function takeFirstMessage(id: string): PendingSend | null {
  const message = pending.get(id) ?? null;
  pending.delete(id);
  return message;
}
