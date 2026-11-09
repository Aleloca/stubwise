import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHistoryKeys, resetHistoryKeys, runMenuHistory } from "./historyMenu";

// Il difetto 2 delle prove a mano del 7 nov 2026: «Undo»/«Redo» del menu
// non facevano nulla nell'editor di prodotto. Ora fanno quello che fa il
// tasto, e la stessa pressione arrivata da tastiera e da menu conta una volta.

const REAL = "data-real";
/** Nei test un tasto «vero» è quello marcato: il keydown del menu non lo è. */
const isReal = (e: KeyboardEvent) => (e as KeyboardEvent & { [REAL]?: boolean })[REAL] === true;

function realKey(target: EventTarget, init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true, ...init });
  Object.assign(e, { [REAL]: true });
  target.dispatchEvent(e);
  return e;
}

let editor: HTMLDivElement;
let steps: string[];
let uninstall: () => void;
let exec: ReturnType<typeof vi.fn>;

/** Un editor che fa come quello di prodotto: ⌘Z / ⇧⌘Z sono suoi. */
function mountEditor() {
  editor = document.createElement("div");
  editor.tabIndex = 0;
  editor.addEventListener("keydown", (e) => {
    if (e.metaKey && e.key === "z") {
      e.preventDefault();
      steps.push(e.shiftKey ? "redo" : "undo");
    }
  });
  document.body.append(editor);
  editor.focus();
}

beforeEach(() => {
  steps = [];
  exec = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
});

afterEach(() => {
  uninstall?.();
  resetHistoryKeys();
  document.body.innerHTML = "";
});

describe("«Undo» / «Redo» del menu", () => {
  it("nell'editor fanno lo stesso passo di ⌘Z / ⇧⌘Z, senza l'annulla nativo", () => {
    uninstall = installHistoryKeys("darwin", isReal);
    mountEditor();
    runMenuHistory("undo", "darwin");
    runMenuHistory("redo", "darwin");
    expect(steps).toEqual(["undo", "redo"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("fuori dall'editor (un campo di testo) chiedono l'annulla nativo, come i ruoli di prima", () => {
    uninstall = installHistoryKeys("darwin", isReal);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    runMenuHistory("undo", "darwin");
    runMenuHistory("redo", "darwin");
    expect(exec.mock.calls).toEqual([["undo"], ["redo"]]);
  });

  it("su Windows e Linux il keydown del menu è Ctrl+Z", () => {
    uninstall = installHistoryKeys("win32", isReal);
    const seen: KeyboardEvent[] = [];
    document.body.addEventListener("keydown", (e) => seen.push(e));
    runMenuHistory("undo", "win32");
    expect(seen[0]).toMatchObject({ ctrlKey: true, metaKey: false, shiftKey: false });
  });
});

describe("una pressione sola (P18: ⌘Z non annulla mai due volte)", () => {
  it("tasto gestito dall'editor, poi l'eco del menu: un passo", () => {
    uninstall = installHistoryKeys("darwin", isReal);
    mountEditor();
    realKey(editor, { metaKey: true });
    runMenuHistory("undo", "darwin");
    expect(steps).toEqual(["undo"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("prima il menu, poi il keydown vero della stessa pressione: un passo", () => {
    uninstall = installHistoryKeys("darwin", isReal);
    mountEditor();
    runMenuHistory("undo", "darwin");
    const key = realKey(editor, { metaKey: true });
    expect(steps).toEqual(["undo"]);
    expect(key.defaultPrevented).toBe(true);
  });

  it("macOS, tasto non gestito in un campo: il menu fa l'annulla (il tasto da solo non lo fa)", () => {
    uninstall = installHistoryKeys("darwin", isReal);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    realKey(input, { metaKey: true });
    runMenuHistory("undo", "darwin");
    expect(exec.mock.calls).toEqual([["undo"]]);
  });

  it("Windows, tasto non gestito in un campo: l'annulla l'ha già fatto il tasto, il menu tace", () => {
    uninstall = installHistoryKeys("win32", isReal);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    realKey(input, { ctrlKey: true });
    runMenuHistory("undo", "win32");
    expect(exec).not.toHaveBeenCalled();
  });

  it("due pressioni distanti contano due volte", () => {
    vi.useFakeTimers();
    try {
      uninstall = installHistoryKeys("darwin", isReal);
      mountEditor();
      realKey(editor, { metaKey: true });
      vi.advanceTimersByTime(1000);
      runMenuHistory("undo", "darwin");
      expect(steps).toEqual(["undo", "undo"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
