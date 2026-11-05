import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ClaudeMark } from "../components/ClaudeMark";
import { CodeLink } from "../components/CodeLink";
import { useSessionPersonId } from "../data/queries";
import { getSessionPersonId } from "../data/session";

// Il segno «Claude's draft» (area 10b, Task 10; shape `claude-drafts.md`
// §3.1): UNO, per i quattro campi (risposta di supporto, corpo dell'email,
// note di rilascio, descrizione) e per qualunque strada sia arrivata la
// bozza — il riquadro, «Ask Claude» della Posta, «Use draft» e «Ask
// Claude» del Supporto. Una nota a piè del campo, non un'etichetta sul
// testo: resta finché il testo è IDENTICO a quello messo da Claude, sparisce
// alla prima differenza (una modifica, l'invio, il salvataggio) e non torna
// più, nemmeno se il testo torna com'era [DR 2]. Non entra mai nel testo.

interface Placed {
  text: string;
  /** Chi l'ha chiesta: col «vedi come» il testo resta, il segno no [DR 12]. */
  by: string;
  /** Il campo l'ha mostrato almeno una volta: da lì, una differenza lo toglie. */
  seen: boolean;
}

/** Il segno resta finché `current === placed`. */
export function useClaudeDraftMark(current: string): {
  placed: string | null;
  place(text: string): void;
  clear(): void;
  shown: boolean;
  /**
   * Il segno vale ADESSO per questo testo (letto dal valore vivo del campo):
   * per il riquadro, che lo chiede fra un render e l'altro. Vero solo finché
   * la bozza è nel campo, non inviata né salvata (I1).
   */
  isMarked(text: string): boolean;
} {
  const me = useSessionPersonId();
  const [mark, setMarkState] = useState<Placed | null>(null);
  /** Lo stesso segno, aggiornato subito (non al render dopo). */
  const live = useRef<Placed | null>(null);
  const setMark = (next: Placed | null) => {
    live.current = next;
    setMarkState(next);
  };
  const same = mark !== null && current === mark.text;
  // `place` e il testo del campo possono arrivare in due render diversi: la
  // differenza conta solo dopo che il campo ha mostrato il testo di Claude.
  useEffect(() => {
    if (!mark) return;
    if (same && !mark.seen) setMark({ ...mark, seen: true });
    else if (!same && mark.seen) setMark(null);
  }, [mark, same]);
  return {
    placed: mark?.text ?? null,
    place: (text) => setMark({ text, by: me, seen: false }),
    clear: () => setMark(null),
    shown: same && mark.by === me,
    isMarked: (text) =>
      live.current !== null &&
      live.current.text === text &&
      live.current.by === getSessionPersonId(),
  };
}

/** Una fonte della bozza: il codice (600, cifre tabellari) e, se c'è, il titolo. */
export interface DraftSource {
  code: string;
  title?: string;
}

/** Oltre queste fonti, «+N» col `title` dell'elenco. */
const SOURCES_SHOWN = 2;

/**
 * La riga del segno, dentro il bordo della casella sotto l'area di
 * scrittura: l'anello fermo · «Claude's draft» · «edit it before sending»
 * (o «saving»), poi «Used: …» con le fonti apribili (`CodeLink`). `id` va
 * nell'`aria-describedby` del campo.
 */
export function ClaudeDraftMark({
  id,
  action,
  sources = [],
  trailing,
  className = "",
}: {
  id: string;
  /** «edit it before sending» (risposta, email) o «saving» (note, descrizione). */
  action: "send" | "save";
  sources?: readonly DraftSource[];
  /** Solo per «Ask Claude» della Posta: «Undo» · «Try again» a destra [DR 7]. */
  trailing?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const shown = sources.slice(0, SOURCES_SHOWN);
  const more = sources.slice(SOURCES_SHOWN);
  return (
    <p
      id={id}
      data-claude-draft-mark
      className={`event-enter flex min-h-6 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted ${className}`}
    >
      <span className="sr-only">{t("claude.drafts.mark.sr")}</span>
      <span aria-hidden="true" className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
        <ClaudeMark />
        <span className="font-semibold text-ink">{t("claude.drafts.mark.label")}</span>
        <span>· {t(`claude.drafts.mark.${action}`)}</span>
      </span>
      {/* Le fonti a capo da sole, senza un «·» scritto davanti (m8): le separa lo spazio. */}
      {sources.length > 0 && (
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t("claude.drafts.mark.used")}{" "}
          {/* Come «Used:» nella conversazione: codice in grassetto, « · » fra le fonti. */}
          {shown.map((s, i) => (
            <span key={s.code}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              <CodeLink code={s.code} withName title={s.title} quiet />
            </span>
          ))}
          {more.length > 0 && (
            <span className="num" title={more.map((s) => s.code).join(", ")}>
              {" "}
              +{more.length}
            </span>
          )}
        </span>
      )}
      {trailing && <span className="ml-auto inline-flex items-center gap-1.5">{trailing}</span>}
    </p>
  );
}
