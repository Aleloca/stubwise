import { gate, state } from "../store";
import { canSeeMessage } from "./visibility";

// Le immagini delle email nel prototipo (design
// `docs/plans/2026-11-28-proxy-immagini-posta-design.md`). Sul server
// `/original` numera le immagini remote (`data-image="n"`) e la rotta
// `…/images/:n` le dà per posizione; il prototipo non ha rete, quindi
// numera l'HTML del seme allo stesso modo e risponde con un segnaposto.

const IMG = /<img\b[^>]*>/gi;
const REMOTE_SRC = /\ssrc\s*=\s*(["'])\s*(https?:)?\/\//i;

/** Aggiunge `data-image="n"` alle immagini remote, in ordine di documento (come `/original`). */
export function numberRawRemoteImages(html: string): string {
  let n = 0;
  return html.replace(IMG, (tag) => {
    if (!REMOTE_SRC.test(tag)) return tag;
    const index = n++;
    if (/\sdata-image\s*=/i.test(tag)) return tag;
    return tag.replace(/^<img\b/i, `<img data-image="${index}"`);
  });
}

/** Un PNG 1×1 grigio chiaro: il segnaposto del prototipo al posto dell'immagine vera. */
const PLACEHOLDER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+7dfwAJLAPQ0NWsJQAAAABJRU5ErkJggg==";

/**
 * L'immagine remota `n` di un messaggio, come `data:` (nel prototipo, un
 * segnaposto). `null` se il messaggio non c'è per chi guarda (la regola
 * `mailbox_owner` del finto) o la posizione non è nell'elenco.
 */
export async function getMessageImage(messageId: string, n: number): Promise<string | null> {
  const me = await gate("mail.getMessageImage");
  const message = state.mailMessages.find((m) => m.id === messageId);
  if (!message || !canSeeMessage(me, message) || !message.html) return null;
  const count = (numberRawRemoteImages(message.html).match(/data-image="/g) ?? []).length;
  return Number.isInteger(n) && n >= 0 && n < count ? PLACEHOLDER : null;
}
