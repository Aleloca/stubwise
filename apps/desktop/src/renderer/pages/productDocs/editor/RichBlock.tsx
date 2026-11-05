import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RichText } from "../../../data/types";
import { applyInput } from "./input";
import { offsetOf, placeCaret, selectionIn } from "./domRange";
import { RichView, paintRich } from "./RichView";

// Un blocco di testo per chi scrive (shape product-editor.md §3, §9): un
// `contenteditable` CONTROLLATO. Fuori dal fuoco è la frase da leggere
// (`RichView`: i link si aprono, i codici sono `CodeLink`); col fuoco il
// blocco ridisegna da sé il suo DOM a ogni cambio (`paintRich`), ogni
// `beforeinput` si annulla e passa da `applyInput`, e il cursore si rimette
// con `placeCaret`. Il DOM non è mai la fonte: un nodo estraneo sparisce al
// ridisegno. L'IME scrive alla fine della composizione.
//
// Le due forme sono due elementi diversi (si rimontano al passaggio): così
// React non mescola i suoi nodi con quelli disegnati a mano.

export interface Selection {
  start: number;
  end: number;
}

/** Ciò che il blocco chiede all'editor: l'editor decide, il blocco disegna. */
export interface RichBlockHandlers {
  /** Entrare nel blocco (clic o fuoco da tastiera) con questa selezione. */
  enter(id: string, sel: Selection): void;
  /** Un `beforeinput` applicato: la frase nuova e la selezione dopo. */
  input(id: string, content: RichText, sel: Selection, inputType: string): void;
  /** Un tasto: `true` se l'editor l'ha preso (si annulla). */
  key(id: string, e: ReactKeyboardEvent<HTMLDivElement>, sel: Selection): boolean;
  /** Un incolla: l'HTML, il testo e i file (un'immagine dagli appunti, Task 9). */
  paste(id: string, clip: { html: string | null; text: string; files?: File[] }, sel: Selection): void;
  /** La selezione nel blocco è cambiata (frecce, mouse). */
  select(id: string, sel: Selection): void;
  /** Il fuoco esce dal blocco, verso `related` (o nessuno). */
  leave(id: string, related: Element | null): void;
  /** ⌘Z / ⇧⌘Z arrivati dal menu Modifica (`historyUndo` / `historyRedo`). */
  history(kind: "undo" | "redo"): void;
}

/**
 * Fine e Inizio (⇧ per estendere) portano il cursore al bordo della riga, e
 * basta: lasciati al browser, con il cursore già lì Chromium fa scorrere la
 * colonna fino in fondo (o in cima). Si annulla il default solo quando
 * `Selection.modify` c'è a fare lo stesso lavoro.
 */
function lineBoundary(e: ReactKeyboardEvent<HTMLDivElement>): boolean {
  if ((e.key !== "End" && e.key !== "Home") || e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = e.currentTarget.ownerDocument.getSelection() as (globalThis.Selection & { modify?: unknown }) | null;
  if (!sel || typeof sel.modify !== "function") return false;
  e.preventDefault();
  (sel.modify as (alter: string, direction: string, granularity: string) => void)(
    e.shiftKey ? "extend" : "move",
    e.key === "End" ? "forward" : "backward",
    "lineboundary",
  );
  return true;
}

/** Il segnaposto di un blocco vuoto, `ink-faint`, dal `data-placeholder`. */
const placeholderClass =
  "empty:before:pointer-events-none empty:before:text-ink-faint empty:before:content-[attr(data-placeholder)]";

interface Common {
  id: string;
  content: RichText;
  /** Il nome accessibile dal tipo («Paragraph», «Heading 2»…). */
  label: string;
  className: string;
}

/** La frase da leggere, per chi non scrive: nessun `contenteditable`. */
export function RichReadOnly({ content, className }: { content: RichText; className: string }) {
  return (
    <div className={className}>
      <RichView content={content} />
    </div>
  );
}

/** Il blocco di chi scrive, fuori dal fuoco: si legge, e un clic (non su un link) ci entra. */
export function RichBlockRead({
  id,
  content,
  label,
  className,
  tabStop,
  placeholder,
  handlers,
}: Common & {
  tabStop: boolean;
  /** Il segnaposto del primo blocco di una pagina vuota. */
  placeholder: string | null;
  handlers: RichBlockHandlers;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  const end = content.text.length;
  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      tabIndex={tabStop ? 0 : -1}
      data-block-text={id}
      data-placeholder={placeholder ?? undefined}
      className={`${className} cursor-text outline-none ${placeholder ? placeholderClass : ""}`}
      onMouseDown={() => {
        pointer.current = true;
      }}
      onFocus={() => {
        // Dalla tastiera: si entra alla fine. Col mouse decide il clic.
        if (pointer.current) return;
        handlers.enter(id, { start: end, end });
      }}
      onBlur={() => {
        pointer.current = false;
      }}
      onClick={(e) => {
        pointer.current = false;
        // Un link fuori dal fuoco si apre (il browser di sistema, o la rotta del codice).
        if ((e.target as Element).closest("a")) return;
        handlers.enter(id, (ref.current && selectionIn(ref.current)) ?? { start: end, end });
      }}
    >
      <RichView content={content} />
    </div>
  );
}

/** Il blocco col fuoco: il `contenteditable` controllato. */
export function RichBlockEdit({
  id,
  content,
  label,
  className,
  selection,
  nonce,
  placeholder,
  listbox,
  handlers,
}: Common & {
  selection: Selection;
  /** Cambia quando l'editor vuole rimettere il cursore (`selection`). */
  nonce: number;
  placeholder: string | null;
  /** Il menu «/» aperto: il fuoco resta qui (`aria-activedescendant`). */
  listbox: { id: string; active: string | null } | null;
  handlers: RichBlockHandlers;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const composing = useRef<Selection | null>(null);
  const latest = useRef({ content, selection, handlers });
  latest.current = { content, selection, handlers };

  // Il ridisegno: dalla frase, poi il cursore dove l'editor lo vuole. Una
  // frase uguale (riletta dopo il salvataggio) non ridisegna; un nodo
  // estraneo infilato nel DOM se ne va comunque al primo ridisegno.
  const painted = useRef<{ text: string; nonce: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || composing.current) return;
    const text = JSON.stringify(content);
    if (painted.current?.text === text && painted.current.nonce === nonce) return;
    painted.current = { text, nonce };
    paintRich(el, content);
    const active = el.ownerDocument.activeElement;
    // Il campo del link (o un altro strumento dell'editor) tiene il suo fuoco.
    if (active?.closest?.("[data-editor-floating]")) return;
    if (active !== el) el.focus();
    placeCaret(el, latest.current.selection.start, latest.current.selection.end);
  }, [content, nonce]);

  // `beforeinput` nativo (quello di React non dice `inputType`).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (ev: InputEvent) => {
      if (ev.inputType === "insertCompositionText" || composing.current) return;
      ev.preventDefault();
      const { content: rt, selection: stored, handlers: h } = latest.current;
      if (ev.inputType === "historyUndo") return h.history("undo");
      if (ev.inputType === "historyRedo") return h.history("redo");
      let sel = selectionIn(el) ?? stored;
      let data = ev.data;
      if (ev.inputType === "insertReplacementText") {
        // Il correttore dice dove sostituire con i suoi intervalli, non con la selezione.
        const range = typeof ev.getTargetRanges === "function" ? ev.getTargetRanges()[0] : undefined;
        if (range) {
          const a = offsetOf(el, range.startContainer, range.startOffset);
          const b = offsetOf(el, range.endContainer, range.endOffset);
          sel = { start: Math.min(a, b), end: Math.max(a, b) };
        }
        data = data ?? ev.dataTransfer?.getData("text/plain") ?? null;
      }
      const out = applyInput(rt, sel, { inputType: ev.inputType, data });
      if (!out) return;
      const keep = ev.inputType === "formatBold" || ev.inputType === "formatItalic";
      h.input(id, out.content, keep ? sel : { start: out.caret, end: out.caret }, ev.inputType);
    };
    const onSelection = () => {
      if (composing.current) return;
      const sel = selectionIn(el);
      if (!sel) return;
      const stored = latest.current.selection;
      if (sel.start !== stored.start || sel.end !== stored.end) latest.current.handlers.select(id, sel);
    };
    el.addEventListener("beforeinput", onBeforeInput);
    el.ownerDocument.addEventListener("selectionchange", onSelection);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.ownerDocument.removeEventListener("selectionchange", onSelection);
    };
  }, [id]);

  const current = (): Selection => (ref.current && selectionIn(ref.current)) ?? latest.current.selection;

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-controls={listbox?.id}
      aria-activedescendant={listbox?.active ?? undefined}
      contentEditable
      spellCheck
      tabIndex={0}
      data-block-text={id}
      data-editing=""
      data-placeholder={placeholder ?? undefined}
      className={`${className} cursor-text whitespace-pre-wrap outline-none [overflow-wrap:anywhere] ${placeholder ? placeholderClass : ""}`}
      onKeyDown={(e) => {
        if (composing.current || e.nativeEvent.isComposing) return;
        if (lineBoundary(e)) return;
        if (handlers.key(id, e, current())) e.preventDefault();
      }}
      onPaste={(e) => {
        e.preventDefault();
        const html = e.clipboardData.getData("text/html");
        const files = Array.from((e.clipboardData.files ?? []) as ArrayLike<File>);
        handlers.paste(id, { html: html || null, text: e.clipboardData.getData("text/plain"), files }, current());
      }}
      onDrop={(e) => e.preventDefault()}
      onCompositionStart={() => {
        composing.current = current();
      }}
      onCompositionEnd={(e) => {
        const at = composing.current ?? latest.current.selection;
        composing.current = null;
        const out = applyInput(latest.current.content, at, { inputType: "insertText", data: e.data });
        if (out) {
          handlers.input(id, out.content, { start: out.caret, end: out.caret }, "insertCompositionText");
        } else if (ref.current) {
          // Niente da scrivere: via ciò che l'IME ha lasciato nel DOM.
          paintRich(ref.current, latest.current.content);
          placeCaret(ref.current, at.start, at.end);
        }
      }}
      onBlur={(e) => handlers.leave(id, e.relatedTarget as Element | null)}
    />
  );
}
