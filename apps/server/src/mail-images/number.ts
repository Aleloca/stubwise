// La posizione di un'immagine remota in un'email (design
// `docs/plans/2026-11-28-proxy-immagini-posta-design.md`, §2). Lavora SOLO
// sull'HTML uscito da `sanitizeEmailHtml` (`@stubwise/google`), che lascia
// un'unica forma di immagine remota: `<img … data-src="http(s)://…">`, con
// attributi fra virgolette doppie e valori già codificati. La risposta di
// `/original` e la rotta delle immagini usano queste due funzioni sullo stesso
// HTML, quindi la posizione `n` è la stessa nei due punti.

const IMG = /<img\b[^>]*>/gi;
const DATA_SRC = /\sdata-src="([^"]*)"/i;

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

/** I valori degli attributi, decodificati come li leggerebbe il browser. */
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Gli URL delle immagini remote, in ordine di documento (la posizione è l'indice). */
export function remoteImageUrls(sanitizedHtml: string): string[] {
  const urls: string[] = [];
  for (const tag of sanitizedHtml.match(IMG) ?? []) {
    const src = DATA_SRC.exec(tag);
    if (src) urls.push(decode(src[1]!));
  }
  return urls;
}

/** Aggiunge `data-image="n"` a ogni immagine remota, nello stesso ordine di `remoteImageUrls`. */
export function numberRemoteImages(sanitizedHtml: string): string {
  let n = 0;
  return sanitizedHtml.replace(IMG, (tag) => {
    if (!DATA_SRC.test(tag)) return tag;
    const index = n++;
    if (/\sdata-image="/i.test(tag)) return tag;
    return tag.replace(/^<img\b/i, `<img data-image="${index}"`);
  });
}
