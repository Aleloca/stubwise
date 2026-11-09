import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ProductPresenceView } from "../../../data/types";
import { rangeIn } from "../editor/domRange";
import { presenceColor } from "./presenceColor";

// I cursori degli altri in un blocco di testo letto (shape product-editor.md
// §3.13, [PE 17]): una barra di 2 px nel colore della persona, alta la riga,
// all'offset; sopra, l'etichetta col NOME (il colore non è mai l'unico
// segnale), alta 14 px nello spazio fra le righe, e sotto la barra sulla
// prima riga di un blocco che ha del testo subito sopra. Una selezione
// altrui: il fondo nel suo colore al 20 %. Fermi: nessun lampeggio, con o
// senza movimento ridotto.
//
// Il disegno si misura dal DOM del blocco (`rangeIn` sugli scarti del
// testo), sopra il testo e fuori dal suo flusso: la frase letta non cambia
// di una lettera, e un clic nel blocco conta gli scarti come prima. Le
// persone arrivano da `getProductPresence` (filtrate per chi guarda, R-G5).

interface Caret {
  x: number;
  y: number;
  h: number;
  /** L'etichetta si allinea a destra della barra (vicino al bordo destro). */
  flip: boolean;
  /**
   * L'etichetta va sotto la barra: sulla prima riga di un blocco con del
   * testo subito sopra, dove coprirebbe le lettere dell'altro blocco
   * (Impeccable 8). Altrove sta sopra, nello spazio fra le righe.
   */
  below: boolean;
}

interface Geometry {
  caret: Caret | null;
  rects: { x: number; y: number; w: number; h: number }[];
}

/** Il testo del blocco dentro il suo involucro: quello di chi scrive o quello di chi legge. */
const textIn = (shell: Element | null): HTMLElement | null =>
  shell?.querySelector<HTMLElement>("[data-block-text], [data-live-text]") ?? null;

function lineHeightOf(el: HTMLElement): number {
  const value = parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).lineHeight ?? "");
  return Number.isFinite(value) && value > 0 ? value : 22;
}

/** Il blocco subito sopra è di testo (nell'ordine dei blocchi del corpo). */
function textAbove(layer: HTMLElement): boolean {
  const shell = layer.closest("[data-block-id]");
  const body = shell?.closest("[data-editor-body]");
  if (!shell || !body) return false;
  const blocks = [...body.querySelectorAll("[data-block-id]")].filter(
    (b) => b.parentElement?.closest("[data-block-id]") === null,
  );
  const above = blocks[blocks.indexOf(shell) - 1];
  return !!above && textIn(above) !== null && above.querySelector("table, img") === null;
}

function measure(layer: HTMLElement, person: ProductPresenceView): Geometry {
  const text = textIn(layer.parentElement);
  if (!text) return { caret: null, rects: [] };
  const box = layer.getBoundingClientRect();
  const textBox = text.getBoundingClientRect();
  const length = text.textContent?.length ?? 0;
  const at = Math.min(person.offset, length);
  const line = lineHeightOf(text);
  let caret: Caret = { x: textBox.left - box.left, y: textBox.top - box.top, h: line, flip: false, below: false };
  const range = rangeIn(text, at);
  if (typeof range.getBoundingClientRect === "function") {
    const r = range.getBoundingClientRect();
    // Un blocco vuoto non ha lettere: la barra sta all'inizio della prima riga.
    if (r.height > 0)
      caret = { x: r.left - box.left, y: r.top - box.top, h: r.height, flip: false, below: false };
  }
  caret.flip = caret.x > box.width - 160;
  caret.below = caret.y - (textBox.top - box.top) < caret.h / 2 && textAbove(layer);
  const rects: Geometry["rects"] = [];
  const sel = person.selection;
  if (sel && sel[0] !== sel[1]) {
    const span = rangeIn(text, Math.min(sel[0], length), Math.min(sel[1], length));
    if (typeof span.getClientRects === "function") {
      for (const r of Array.from(span.getClientRects())) {
        if (r.width > 0)
          rects.push({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
      }
    }
  }
  return { caret, rects };
}

/**
 * Le persone che scrivono in questo blocco (non quello col fuoco: lì c'è la
 * nota, [PE 18]). Va dentro l'involucro del blocco (`relative`); `contentKey`
 * cambia quando cambia la frase, per rimisurare.
 */
export function RemoteCursors({
  people,
  contentKey,
}: {
  people: ProductPresenceView[];
  contentKey: string;
}) {
  if (people.length === 0) return null;
  return (
    <>
      {people.map((p) => (
        <RemoteCursor key={p.personId} person={p} contentKey={contentKey} />
      ))}
    </>
  );
}

function RemoteCursor({ person, contentKey }: { person: ProductPresenceView; contentKey: string }) {
  const layer = useRef<HTMLSpanElement>(null);
  const [geo, setGeo] = useState<Geometry>({ caret: null, rects: [] });
  const selKey = person.selection ? person.selection.join(":") : "";

  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const update = () => {
      const next = measure(el, person);
      setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    update();
    // Il blocco cambia larghezza (finestra, colonna dei commenti): si rimisura.
    const shell = el.parentElement;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
    // si rimisura per offset, selezione e frase
  }, [person.offset, selKey, contentKey]);

  const color = presenceColor(person.color);
  const { caret, rects } = geo;
  return (
    <span ref={layer} aria-hidden="true" className="pointer-events-none absolute inset-0">
      {person.selection && person.selection[0] !== person.selection[1] && (
        <span
          data-remote-selection={person.personId}
          style={{ color }}
          className="absolute inset-0 -z-10"
        >
          {rects.map((r, i) => (
            <span
              key={i}
              className="absolute rounded-[2px] bg-current/20"
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            />
          ))}
        </span>
      )}
      <span
        data-remote-cursor={person.personId}
        className="absolute z-10 -ml-px w-0.5"
        style={{ left: caret?.x ?? 0, top: caret?.y ?? 0, height: caret?.h ?? 22 } as CSSProperties}
      >
        <span
          data-remote-caret=""
          className="absolute inset-0 rounded-full"
          style={{ background: color }}
        />
        <span
          className={`absolute rounded-[4px] px-1 py-0 text-xs leading-[14px] font-semibold whitespace-nowrap text-ground ${caret?.below ? "top-full" : "bottom-full"} ${caret?.flip ? "right-0" : "left-0"}`}
          style={{ background: color }}
        >
          {person.name}
        </span>
      </span>
    </span>
  );
}
