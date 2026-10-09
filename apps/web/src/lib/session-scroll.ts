import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Entro questi pixel dal fondo si è «in fondo»: un residuo di scorrimento non stacca la vista. */
export const AT_BOTTOM_THRESHOLD_PX = 48;

/**
 * Lo scroller della pagina: il `<main>` del layout (`data-scroll-container`),
 * non `window`, che non scorre. Fuori dal layout (un test che monta il solo
 * componente) non c'è: la vista allora non scorre da sé.
 */
function scrollerOf(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>("[data-scroll-container]") ?? null;
}

/**
 * La coda della trascrizione: ciò che, CRESCENDO, è testo nuovo. L'id
 * dell'ultimo evento (il passato caricato dopo ha id più vecchi e non lo
 * sposta), la lunghezza del testo dal vivo, interventi e domande.
 */
export interface TranscriptTail {
  lastEventId: string;
  live: number;
  inputs: number;
  questions: number;
}

/**
 * Vero solo se è arrivato qualcosa: un evento più recente, testo dal vivo che
 * si allunga, un intervento o una domanda in più. Un parziale AZZERATO (il
 * recupero a sessione finita, senza eventi nuovi) accorcia la trascrizione e
 * non è testo nuovo.
 */
function grew(prev: TranscriptTail, next: TranscriptTail): boolean {
  return (
    next.lastEventId !== prev.lastEventId ||
    next.live > prev.live ||
    next.inputs > prev.inputs ||
    next.questions > prev.questions
  );
}

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
}

/**
 * Lo scorrimento della chat di una sessione (web; l'app ha la lista invertita
 * e lo fa da sé).
 *
 * - **Apertura**: una volta sola, quando `ready` (dettaglio e PRIMA pagina di
 *   eventi nella vista: prima scorrerebbe a vuoto, lo stesso difetto di
 *   `#question`), la vista va in fondo — salvo `skipOpen` (`#question` con una
 *   domanda aperta: vince lei).
 * - **Testo nuovo**: quando `tail` CRESCE (`grew`: eventi, parziali che si
 *   allungano, interventi, domande) e l'utente era in fondo la vista lo segue,
 *   altrimenti non si muove e `hasNew` accende il bottone «nuovi messaggi».
 * - **Il proprio messaggio**: `pinToBottom()` (all'invio) porta in fondo anche
 *   da risaliti e tiene agganciati, così la bolla che arriva dopo è seguita.
 * - **Il passato** («Carica i precedenti») si antepone senza cambiare `tail`:
 *   la vista non lo tocca, l'ancoraggio lo tiene il browser (`overflow-anchor`).
 *
 * «In fondo» si misura allo scroll dell'utente, non dopo il commit: quando il
 * contenuto nuovo è nel DOM il fondo si è già spostato.
 */
export function useSessionScroll(
  anchorRef: RefObject<HTMLElement | null>,
  { ready, skipOpen, tail }: { ready: boolean; skipOpen: boolean; tail: TranscriptTail },
) {
  const opened = useRef(false);
  const atBottom = useRef(true);
  const lastTail = useRef(tail);
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const el = scrollerOf(anchorRef.current);
    if (el === null) return;
    const onScroll = () => {
      atBottom.current = isAtBottom(el);
      if (atBottom.current) setHasNew(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [anchorRef]);

  const scrollToBottom = useCallback(() => {
    const el = scrollerOf(anchorRef.current);
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setHasNew(false);
  }, [anchorRef]);

  // Layout effect: si scorre prima del paint, senza un fotogramma fuori posto.
  const { lastEventId, live, inputs, questions } = tail;
  useLayoutEffect(() => {
    if (opened.current || !ready) return;
    opened.current = true;
    lastTail.current = { lastEventId, live, inputs, questions };
    if (skipOpen) {
      atBottom.current = false;
      return;
    }
    scrollToBottom();
  }, [ready, skipOpen, lastEventId, live, inputs, questions, scrollToBottom]);

  useLayoutEffect(() => {
    if (!opened.current) return;
    const next = { lastEventId, live, inputs, questions };
    const prev = lastTail.current;
    lastTail.current = next;
    if (!grew(prev, next)) return;
    if (atBottom.current) scrollToBottom();
    else setHasNew(true);
  }, [lastEventId, live, inputs, questions, scrollToBottom]);

  return { hasNew, scrollToBottom, pinToBottom: scrollToBottom };
}
