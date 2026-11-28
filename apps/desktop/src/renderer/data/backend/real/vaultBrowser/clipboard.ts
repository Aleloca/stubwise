// Gli appunti della cassaforte nel browser (design §6, I4): `writeText`, e
// dopo 30 s si svuotano se contengono ancora la password (o se non si
// possono leggere). Senza fuoco `writeText("")` fallisce in silenzio: lo
// svuotamento si RIPROVA a `focus` e a `visibilitychange` → visible finché
// non riesce, e si svuota anche alla chiusura della cassaforte.

export const CLIPBOARD_CLEAR_MS = 30_000;

/** La password ancora da togliere dagli appunti, finché non si toglie. */
let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let wired = false;

async function tryClear(): Promise<void> {
  if (pending === null) return;
  const clipboard = navigator.clipboard;
  let current: string | null = null;
  try {
    current = await clipboard.readText();
  } catch {
    current = null; // Non si legge: si svuota comunque.
  }
  if (current !== null && current !== pending) {
    // Ci si è copiato altro: non si tocca.
    pending = null;
    return;
  }
  try {
    await clipboard.writeText("");
    pending = null;
  } catch {
    // Senza fuoco: si riprova al ritorno.
  }
}

function onReturn(): void {
  if (document.visibilityState !== "hidden") void tryClear();
}

function wire(): void {
  if (wired) return;
  wired = true;
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
}

/** Copia la password e ne programma lo svuotamento. */
export async function copyWithAutoClear(password: string): Promise<void> {
  wire();
  await navigator.clipboard.writeText(password);
  pending = password;
  clearTimeout(timer);
  timer = setTimeout(() => void tryClear(), CLIPBOARD_CLEAR_MS);
}

/** Alla chiusura della cassaforte: subito, se c'è ancora la password. */
export async function clearNow(): Promise<void> {
  clearTimeout(timer);
  await tryClear();
}

/** Solo per i test. */
export function __resetClipboardForTests(): void {
  pending = null;
  clearTimeout(timer);
  timer = undefined;
  if (wired) {
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  }
  wired = false;
}
