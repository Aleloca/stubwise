// Copiare un testo e scaricarlo come file, nel renderer: solo API del browser
// (appunti, Blob, `a[download]`), niente Node. In Electron lo scaricamento
// passa dal salvataggio di Chromium, come in un browser.

/** Copia negli appunti; rifiuta se gli appunti non ci sono o non si possono scrivere. */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}

/** Scarica `text` come file `fileName` (Markdown di base). */
export function downloadText(fileName: string, text: string, type = "text/markdown"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Il link serve solo al clic: lo si libera subito dopo.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
