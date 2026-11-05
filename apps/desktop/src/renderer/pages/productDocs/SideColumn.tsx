import { useRef, useState, type ReactNode } from "react";
import type { ProductPageView } from "../../data/types";

// La colonna a destra della lettura (shape product-editor.md §6,
// product-comments-history.md §3.3, §3.7): commenti OPPURE cronologia,
// mai tutt'e due ([PE 19]). Da 1200 è agganciata (296, filetto a sinistra)
// e scorre col testo, così i fili stanno accanto ai loro blocchi; il
// pannello della task ne prende il posto e lei torna alla sua chiusura.
// Sotto i 1200 è sovrapposta (360) dal bordo destro e col pannello della
// task vince l'ultimo aperto: l'altro resta montato dietro ([PE 22]).
//
// Quando si apre ([PC 14], maintainer 5 nov 2026): aprendo una pagina con
// fili aperti i commenti si aprono da soli, senza restano chiusi. «Comments»
// e × si ricordano PER PERSONA (non per pagina) in `localStorage`, e
// prevalgono sulla regola automatica; senza archivio (bloccato, privato) vale
// la regola. La cronologia non si apre mai da sola.

export type Side = "comments" | "history" | null;

/** La casella di un commento nuovo: ancora e frase scelte (`n` = una richiesta nuova). */
export interface CommentDraft {
  anchorId: string;
  quote: string;
  n: number;
}

/** Il filo da mostrare col fuoco (`?comment=`, il segno, un commento appena scritto). */
export interface ThreadFocus {
  rootId: string;
  n: number;
}

/** La chiave del gesto a mano: di chi guarda, non della pagina. */
export const commentsPrefKey = (personId: string) => `stubwise.productComments.${personId}`;

export function readCommentsPref(personId: string): "open" | "closed" | null {
  try {
    const raw = window.localStorage.getItem(commentsPrefKey(personId));
    return raw === "open" || raw === "closed" ? raw : null;
  } catch {
    return null;
  }
}

function writeCommentsPref(personId: string, value: "open" | "closed"): void {
  try {
    window.localStorage.setItem(commentsPrefKey(personId), value);
  } catch {
    // Niente archivio: il gesto vale finché la pagina è aperta, poi torna la regola.
  }
}

interface State {
  /** Persona e pagina per cui vale lo stato: cambiate, si riparte (§5: le caselle si scartano). */
  key: string | null;
  side: Side;
  draft: CommentDraft | null;
  focus: ThreadFocus | null;
  /** Il filo attivo: il suo blocco ha la tinta. */
  active: string | null;
  /** L'ultimo `?comment=` già seguito (si segue una volta). */
  param: string | null;
  /** Sovrapposta, chi sta davanti fra la colonna e il pannello della task. */
  front: "column" | "task";
  taskWas: boolean;
}

let counter = 0;

export interface SideColumn {
  side: Side;
  draft: CommentDraft | null;
  focus: ThreadFocus | null;
  active: string | null;
  /** Sovrapposta: la colonna sta davanti al pannello della task. */
  front: boolean;
  /** «Comments» nella barra: apre o chiude (e lo ricorda); dietro al pannello, la riporta davanti. */
  toggleComments(): void;
  /** × della colonna dei commenti (lo ricorda). */
  closeComments(): void;
  toggleHistory(): void;
  closeHistory(): void;
  /** «Comment» su una frase: la casella nella colonna. */
  start(anchorId: string, quote: string): void;
  /** La colonna su un filo, col fuoco. */
  focusThread(rootId: string): void;
  /** La casella nuova è stata inviata o lasciata. */
  endDraft(): void;
  setActive(rootId: string | null): void;
}

export function useSideColumn({
  personId,
  page,
  commentParam,
  taskOpen,
  overlay,
}: {
  personId: string;
  page: ProductPageView | null;
  commentParam: string | undefined;
  taskOpen: boolean;
  overlay: boolean;
}): SideColumn {
  const [stored, setStored] = useState<State>(() => ({
    key: null,
    side: null,
    draft: null,
    focus: null,
    active: null,
    param: null,
    front: "column",
    taskWas: taskOpen,
  }));
  const key = page ? `${personId}:${page.id}` : null;

  // Lo stato si deriva durante il disegno (nessun lampo chiuso → aperto):
  // una pagina o una persona nuova ripartono dalla regola; un `?comment=`
  // nuovo apre i commenti su quel filo; un pannello della task appena aperto
  // passa davanti.
  let s = stored;
  if (s.key !== key) {
    const pref = page ? readCommentsPref(personId) : null;
    const auto = page !== null && page.openComments > 0;
    s = {
      ...s,
      key,
      side: (pref === null ? auto : pref === "open") ? "comments" : null,
      draft: null,
      focus: null,
      active: null,
      param: null,
      front: "column",
    };
  }
  if (page && commentParam && s.param !== commentParam) {
    s = { ...s, side: "comments", focus: { rootId: commentParam, n: ++counter }, param: commentParam, front: "column" };
  }
  if (taskOpen !== s.taskWas) s = { ...s, taskWas: taskOpen, front: taskOpen ? "task" : s.front };
  if (s !== stored) setStored(s);

  const latest = useRef(s);
  latest.current = s;
  const update = (patch: Partial<State>) => setStored((prev) => ({ ...prev, ...patch }));
  const behind = () => overlay && taskOpen && latest.current.front === "task";

  return {
    side: s.side,
    draft: s.draft,
    focus: s.focus,
    active: s.active,
    front: s.front === "column" || !taskOpen,
    toggleComments() {
      if (latest.current.side === "comments" && !behind()) {
        writeCommentsPref(personId, "closed");
        update({ side: null, draft: null });
        return;
      }
      writeCommentsPref(personId, "open");
      update({ side: "comments", front: "column" });
    },
    closeComments() {
      writeCommentsPref(personId, "closed");
      update({ side: null, draft: null });
    },
    toggleHistory() {
      if (latest.current.side === "history" && !behind()) update({ side: null });
      else update({ side: "history", draft: null, front: "column" });
    },
    closeHistory() {
      update({ side: null });
    },
    start(anchorId, quote) {
      update({ side: "comments", draft: { anchorId, quote, n: ++counter }, front: "column" });
    },
    focusThread(rootId) {
      update({ side: "comments", focus: { rootId, n: ++counter }, active: rootId, front: "column" });
    },
    endDraft() {
      update({ draft: null });
    },
    setActive(rootId) {
      if (latest.current.active !== rootId) update({ active: rootId });
    },
  };
}

/**
 * L'involucro della colonna: agganciata (296, dentro lo scorrimento della
 * lettura, filetto a sinistra) o sovrapposta (360 dal bordo destro, sopra la
 * lettura; davanti o dietro al pannello della task). `data-product-side`
 * lo legge anche il riquadro di Claude, che si mette alla sua sinistra.
 */
export function SideColumnFrame({
  mode,
  front,
  children,
}: {
  mode: "docked" | "overlay";
  front: boolean;
  children: ReactNode;
}) {
  if (mode === "docked") {
    return (
      <div data-product-side="docked" className="relative flex w-[296px] shrink-0 flex-col border-l border-rule">
        {children}
      </div>
    );
  }
  return (
    <div
      data-product-side="overlay"
      data-front={front ? "true" : "false"}
      // Il pannello della task, sovrapposto, sta a z-40: davanti o dietro di lui.
      className={`panel-enter absolute top-10 right-0 bottom-0 flex w-[360px] max-w-full flex-col overflow-y-auto border-l border-rule-strong bg-surface ${front ? "z-[45]" : "z-[35]"}`}
    >
      {children}
    </div>
  );
}
