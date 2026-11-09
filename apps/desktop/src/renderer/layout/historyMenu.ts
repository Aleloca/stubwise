// «Undo» / «Redo» del menu dell'app (prove a mano del 7 nov 2026, difetto 2).
//
// Coi ruoli nativi di Electron la voce del menu chiamava l'annulla del
// browser, che l'editor di prodotto non usa: ha la sua pila per sessione e
// risponde solo a ⌘Z / ⇧⌘Z dalla tastiera. Ora la voce fa la STESSA cosa del
// tasto: manda un keydown ⌘Z (o Ctrl+Z) all'elemento col fuoco. Se qualcuno
// lo gestisce (l'editor, con `preventDefault`) è fatto; se no si chiede
// l'annulla nativo con `execCommand`, come facevano i ruoli (campi di testo).
//
// Una stessa pressione del tasto può arrivare due volte: al renderer come
// keydown e al menu come acceleratore, in un ordine qualunque. Come per ⌘J
// (`claimPanelToggle`), la seconda porta entro poco dalla prima non rifà il
// passo (P18: un ⌘Z non deve mai annullare due volte).
//  - Tasto prima: se la pagina l'ha gestito (`defaultPrevented`), il menu che
//    segue è un'eco e non fa nulla. Su macOS un tasto NON gestito non annulla
//    da solo (lì l'annulla dei campi di testo passa dal menu), quindi il menu
//    deve agire; altrove il tasto fa già l'annulla nativo e il menu tace.
//  - Menu prima: il passo è già fatto, il keydown vero che arriva subito dopo
//    si ferma prima di chiunque.

const SAME_PRESS_MS = 400;

let lastKey: number | null = null;
let lastMenu: number | null = null;

type HistoryKind = "undo" | "redo";

function isHistoryKey(e: KeyboardEvent): boolean {
  return e.metaKey !== e.ctrlKey && !e.altKey && e.key.toLowerCase() === "z";
}

const within = (at: number | null) => at !== null && performance.now() - at < SAME_PRESS_MS;

/** Ascolta i ⌘Z veri per riconoscere l'eco del menu; restituisce la disiscrizione. */
export function installHistoryKeys(
  platform: string,
  /** Un tasto vero, non il keydown che manda il menu (i test lo sostituiscono). */
  isReal: (e: KeyboardEvent) => boolean = (e) => e.isTrusted,
): () => void {
  const capture = (e: KeyboardEvent) => {
    if (!isReal(e) || !isHistoryKey(e)) return;
    if (within(lastMenu)) {
      lastMenu = null;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const bubble = (e: KeyboardEvent) => {
    if (!isReal(e) || !isHistoryKey(e)) return;
    if (e.defaultPrevented || platform !== "darwin") lastKey = performance.now();
  };
  window.addEventListener("keydown", capture, true);
  window.addEventListener("keydown", bubble);
  return () => {
    window.removeEventListener("keydown", capture, true);
    window.removeEventListener("keydown", bubble);
  };
}

/** La voce «Undo» / «Redo» del menu: come il tasto, una volta sola. */
export function runMenuHistory(kind: HistoryKind, platform: string): void {
  if (within(lastKey)) {
    lastKey = null;
    return;
  }
  lastMenu = performance.now();
  const mac = platform === "darwin";
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const key = new KeyboardEvent("keydown", {
    key: "z",
    code: "KeyZ",
    metaKey: mac,
    ctrlKey: !mac,
    shiftKey: kind === "redo",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(key);
  if (!key.defaultPrevented) document.execCommand(kind);
}

/** Dimentica le pressioni viste (i test). */
export function resetHistoryKeys(): void {
  lastKey = null;
  lastMenu = null;
}
