import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { CitationRef } from "../../../data/types";
import type { Suggestion } from "./MentionMenu";

// Il campo di una casella con i menu «#»/«@» (e «/» dove c'è): lo usano la
// conversazione con Claude (`Composer`) e il canale della Chat
// (`ChatComposer`). Tiene il cursore, il carattere del menu aperto, la riga
// attiva, i gettoni (un oggetto scelto entra come testo che Backspace toglie
// intero) e l'altezza che cresce con il testo. Il testo resta del chiamante.

export type Trigger = { char: "/" | "#" | "@"; query: string; start: number; end: number };

/**
 * Il carattere di un menu appena prima del cursore: «/» solo all'inizio del
 * messaggio, «#» e «@» all'inizio di una parola.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S{0,40})$/.exec(before);
  if (slash) return { char: "/", query: slash[1]!, start: 0, end: caret };
  const mention = /(^|\s)([#@])([^\s#@]{0,40})$/.exec(before);
  if (!mention) return null;
  const start = caret - mention[3]!.length - 1;
  return { char: mention[2] as "#" | "@", query: mention[3]!, start, end: caret };
}

/** Un oggetto scelto da un menu: il testo inserito (e, per «#», l'oggetto citato). */
export interface ComposerToken {
  insert: string;
  ref?: CitationRef;
}

const LINE_PX = 20;

export interface ComposerField {
  field: RefObject<HTMLTextAreaElement | null>;
  trigger: Trigger | null;
  menuOpen: boolean;
  tokens: ComposerToken[];
  /** La riga attiva del menu, dentro le `count` opzioni. */
  activeIndex: (count: number) => number;
  /** Il testo cambia (scritto o riscritto): cursore, riga attiva e gettoni seguono. */
  update: (next: string, at: number) => void;
  setCaret: (at: number) => void;
  /** Mette il cursore in `at` e ridà il fuoco al campo. */
  place: (at: number) => void;
  /** Mette la scelta al posto di «#…»/«@…»/«/…»; `token` = entra come gettone. */
  insert: (s: Suggestion, token: ComposerToken | null) => void;
  /** Dopo l'invio: testo, cursore e gettoni da capo. */
  reset: () => void;
  /**
   * Frecce, Invio/Tab ed Esc del menu aperto, poi Backspace su un gettone.
   * `true` = il tasto era suo (il chiamante non fa altro).
   */
  handleKey: (e: KeyboardEvent<HTMLTextAreaElement>, options: readonly Suggestion[]) => boolean;
}

export function useComposerField({
  text,
  onText,
  maxLines,
  allowSlash,
}: {
  text: string;
  onText: (next: string) => void;
  maxLines: number;
  /** I comandi «/» (la conversazione sì, la Chat no). */
  allowSlash: boolean;
}): ComposerField {
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [tokens, setTokens] = useState<ComposerToken[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const raw = triggerAt(text, caret);
  const trigger = raw && (allowSlash || raw.char !== "/") ? raw : null;
  const menuOpen = trigger !== null && dismissed !== trigger.start;

  // Il campo cresce con il testo, fino a `maxLines` righe.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxLines * LINE_PX + 16)}px`;
  }, [text, maxLines]);

  const update = (next: string, at: number) => {
    onText(next);
    setCaret(at);
    setActive(0);
    // Un gettone modificato a mano non è più un gettone.
    setTokens((list) => list.filter((tok) => next.includes(tok.insert)));
  };

  const place = (at: number) =>
    requestAnimationFrame(() => {
      field.current?.setSelectionRange(at, at);
      field.current?.focus();
    });

  const insert = (s: Suggestion, token: ComposerToken | null) => {
    if (!trigger) return;
    const piece = `${s.insert} `;
    const next = text.slice(0, trigger.start) + piece + text.slice(trigger.end);
    const at = trigger.start + piece.length;
    update(next, at);
    if (token) setTokens((list) => [...list, token]);
    place(at);
  };

  const reset = () => {
    onText("");
    setCaret(0);
    setTokens([]);
  };

  const activeIndex = (count: number) => Math.min(active, Math.max(0, count - 1));

  const handleKey = (
    e: KeyboardEvent<HTMLTextAreaElement>,
    options: readonly Suggestion[],
  ): boolean => {
    if (menuOpen && options.length > 0) {
      const current = activeIndex(options.length);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + options.length) % options.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        // La scelta la fa il chiamante (un comando o un oggetto hanno effetti diversi).
        return false;
      }
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(trigger!.start);
      return true;
    }
    if (e.key === "Backspace") {
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return false;
      const before = text.slice(0, el.selectionStart);
      const token = tokens.find((tok) => {
        const tail = before.endsWith(`${tok.insert} `)
          ? `${tok.insert} `
          : before.endsWith(tok.insert)
            ? tok.insert
            : null;
        if (!tail) return false;
        const at = before.length - tail.length;
        return at === 0 || /\s/.test(before[at - 1]!);
      });
      if (token) {
        e.preventDefault();
        const length = before.endsWith(`${token.insert} `)
          ? token.insert.length + 1
          : token.insert.length;
        const at = before.length - length;
        update(text.slice(0, at) + text.slice(el.selectionStart), at);
        setTokens((list) => list.filter((tok) => tok !== token));
        place(at);
        return true;
      }
    }
    return false;
  };

  return {
    field,
    trigger,
    menuOpen,
    tokens,
    activeIndex,
    update,
    setCaret,
    place,
    insert,
    reset,
    handleKey,
  };
}

/** Il menu è aperto e Invio/Tab scelgono la riga attiva. */
export const picksWithKey = (
  e: KeyboardEvent<HTMLTextAreaElement>,
  menuOpen: boolean,
  options: readonly Suggestion[],
) => menuOpen && options.length > 0 && (e.key === "Enter" || e.key === "Tab");
