// Un file in un blocco immagine (shape product-editor.md §3.6, §9): sempre
// un `data:` URL (nessun `fetch`, nessun `file://`; la CSP ammette solo
// `img-src 'self' data:`), al più 5 MB, solo PNG, JPEG, GIF e WebP — niente
// SVG, che può portare script. Il tipo si controlla prima della misura: un
// PDF grande è «solo immagini», non «troppo grande».

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageRefusal = "too_large" | "unsupported";

const isImageType = (type: string): boolean => (PRODUCT_IMAGE_TYPES as readonly string[]).includes(type);

/** Un file in un blocco immagine (`data:` URL), o il motivo del rifiuto. */
export function readImageFile(
  file: File,
): Promise<{ ok: true; src: string; alt: string } | { ok: false; reason: ImageRefusal }> {
  if (!isImageType(file.type)) return Promise.resolve({ ok: false, reason: "unsupported" });
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return Promise.resolve({ ok: false, reason: "too_large" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      // Un risultato che non è un'immagine `data:` non entra in un blocco.
      if (!src.startsWith(`data:${file.type}`)) return resolve({ ok: false, reason: "unsupported" });
      resolve({ ok: true, src, alt: file.name.replace(/\.[^.]+$/, "") });
    };
    reader.onerror = () => resolve({ ok: false, reason: "unsupported" });
    reader.readAsDataURL(file);
  });
}

/**
 * I file incollati, trascinati o scelti, come elenco (vuoto senza file). Non
 * filtra: è `readImageFile` a rifiutare ciò che non è un'immagine.
 */
export const filesOf = (list: FileList | readonly File[] | null | undefined): File[] =>
  list ? Array.from(list as ArrayLike<File>) : [];

/** Il testo che conta in un HTML incollato: senza stili, script, commenti e tag. */
const htmlText = (html: string): string =>
  html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();

/**
 * Le immagini da mettere per un incolla (fix round 1): Word ed Excel mettono
 * negli appunti, accanto all'HTML e al testo, un'immagine della selezione.
 * Il testo vince: i file entrano solo se negli appunti non c'è un testo che
 * conti (nessun `text/plain`, un HTML che è solo `<img>`).
 */
export function pastedImages(clip: { html: string | null; text: string; files?: readonly File[] }): File[] {
  const files = clip.files ?? [];
  if (files.length === 0) return [];
  if (clip.text.trim() !== "" || (clip.html && htmlText(clip.html) !== "")) return [];
  return [...files];
}
