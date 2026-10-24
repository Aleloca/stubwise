import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import { ArrowDownGlyph } from "../claude/conversation/parts";
import { dayLabel, type FlowDay, type FlowRow } from "./flow";
import { flashMessage } from "./search";

// Il flusso del canale: una colonna di lettura allineata a sinistra con 32px
// di margine, larga fino a 760px; scorre solo in verticale (un blocco di
// codice largo scorre DENTRO il blocco, 40 reazioni vanno a capo, un nome
// lunghissimo si spezza: la pagina non si allarga mai). Giorni separati da
// un filetto con l'etichetta che resta in cima. Entrando si apre sulla riga
// «New» se c'è, altrimenti in fondo; segue il fondo solo se sei in fondo,
// altrimenti la pillola «New messages ↓». Salendo carica i più vecchi da sé
// tenendo la posizione.

/** Quanto vicino al fondo conta come «in fondo» (px). */
const BOTTOM_SLACK = 48;
/** Quanto vicino alla cima parte «Load earlier» da sé (px). */
const TOP_SLACK = 160;

export function MessageList({
  days,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  renderRow,
  onAtBottom,
  focusId,
  flashFocus = true,
  tail,
  intro,
  label,
  announce,
}: {
  days: FlowDay[];
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  renderRow: (row: FlowRow, key: string) => ReactNode;
  /** Il fondo è in vista (il canale si segna letto). */
  onAtBottom: () => void;
  /** Un messaggio da portare in vista entrando (`?message=`). */
  focusId?: string | undefined;
  /** Il messaggio portato in vista si evidenzia (no quando l'evidenza è nel thread). */
  flashFocus?: boolean;
  /** In coda al flusso: i messaggi in invio o non inviati. */
  tail?: ReactNode;
  /** In testa, quando non c'è altro prima: «This is the start of …». */
  intro?: ReactNode;
  label: string;
  /** Il testo per `aria-live` (i messaggi arrivati, raggruppati). */
  announce: string;
}) {
  const { t, i18n } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const placed = useRef(false);
  const anchor = useRef<number | null>(null);
  const [newBelow, setNewBelow] = useState(false);

  const rows = days.flatMap((d) => d.rows);
  const firstId = firstMessageId(rows);
  const lastId = lastMessageId(rows);
  const tailKey = tail ? "tail" : "";
  const seen = useRef<{ first: string | null; last: string | null }>({ first: null, last: null });
  // Un messaggio richiesto ma non ancora fra quelli letti (vecchio): si porta
  // in vista quando arriva (il canale carica i più vecchi finché c'è).
  const pendingFocus = useRef<string | null>(null);

  /** Porta `id` al centro e lo evidenzia; `false` se non è (ancora) nel flusso. */
  const reach = (id: string): boolean => {
    const el = scroller.current;
    const target = el?.querySelector<HTMLElement>(`#message-${CSS.escape(id)}`);
    if (!el || !target) return false;
    el.scrollTop = Math.max(0, target.offsetTop - (el.clientHeight - target.offsetHeight) / 2);
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (!atBottom.current) setNewBelow(false);
    if (flashFocus) flashMessage(target);
    return true;
  };

  const loadEarlier = () => {
    const el = scroller.current;
    if (!el || loadingEarlier) return;
    // Quanto manca al fondo: dopo il caricamento la stessa distanza tiene fermo ciò che si leggeva.
    anchor.current = el.scrollHeight - el.scrollTop;
    onLoadEarlier();
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || rows.length === 0) return;
    const before = seen.current;
    seen.current = { first: firstId, last: lastId };
    if (!placed.current) {
      // Entrando: il messaggio richiesto, se no la riga «New», se no il fondo.
      placed.current = true;
      if (focusId && reach(focusId)) {
        if (atBottom.current) onAtBottom();
        return;
      }
      if (focusId) pendingFocus.current = focusId;
      const target = el.querySelector<HTMLElement>("[data-new-line]");
      if (target) {
        el.scrollTop = Math.max(0, target.offsetTop - 56);
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
      } else {
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
      }
      if (atBottom.current) onAtBottom();
      return;
    }
    if (pendingFocus.current && before.first !== firstId && reach(pendingFocus.current)) {
      pendingFocus.current = null;
      anchor.current = null;
      return;
    }
    if (anchor.current !== null && before.first !== firstId) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
      return;
    }
    if (before.last !== lastId || tailKey) {
      if (atBottom.current) {
        el.scrollTop = el.scrollHeight;
        onAtBottom();
      } else if (before.last !== lastId) setNewBelow(true);
    }
    // Solo quando cambiano gli estremi del flusso o la coda.
  }, [firstId, lastId, tailKey, rows.length]);

  // Un `?message=` nuovo con il canale già aperto (un'altra menzione, un
  // link): si porta in vista quel messaggio, se è fra quelli letti.
  const lastFocus = useRef(focusId);
  useLayoutEffect(() => {
    if (focusId === lastFocus.current) return;
    lastFocus.current = focusId;
    pendingFocus.current = null;
    if (!focusId || !placed.current) return;
    if (!reach(focusId)) pendingFocus.current = focusId;
  }, [focusId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom.current) {
      setNewBelow(false);
      onAtBottom();
    }
    if (el.scrollTop < TOP_SLACK && hasMore && !loadingEarlier && anchor.current === null) {
      loadEarlier();
    }
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    atBottom.current = true;
    setNewBelow(false);
    onAtBottom();
  };

  const words = { today: t("chat.flow.today"), yesterday: t("chat.flow.yesterday") };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-chat-scroll
        role="log"
        // Il log annuncerebbe ogni messaggio (anche i 50 di «Load earlier»):
        // gli arrivi li dice, raggruppati, la regione `announce` qui sotto.
        aria-live="off"
        aria-label={label}
        className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
      >
        <div className="flex w-full max-w-[824px] min-w-0 flex-col px-6 pt-4 pb-3 @max-[620px]:px-2">
          {hasMore ? (
            <button
              type="button"
              onClick={loadEarlier}
              disabled={loadingEarlier}
              className="mb-2 self-start rounded-md px-2 py-1 text-sm font-medium text-ink-muted hover:bg-ink/6 hover:text-ink disabled:opacity-60"
            >
              {loadingEarlier ? t("chat.flow.loadingEarlier") : t("chat.flow.loadEarlier")}
            </button>
          ) : (
            intro
          )}
          {days.map((day) => (
            <section
              key={day.day}
              aria-label={dayLabel(day.day, TODAY, i18n.language, words)}
              className="min-w-0"
            >
              <h2 className="sticky top-0 z-10 flex items-center gap-3 bg-ground py-1.5 pl-2 text-xs font-semibold text-ink-muted">
                <span className="num shrink-0">
                  {dayLabel(day.day, TODAY, i18n.language, words)}
                </span>
                <span aria-hidden="true" className="h-px flex-1 bg-rule" />
              </h2>
              {day.rows.map((row, i) =>
                row.kind === "new" ? (
                  <p
                    key={`${day.day}-new`}
                    data-new-line
                    className="my-1 flex items-center gap-3 pl-2 text-xs font-semibold text-ink"
                  >
                    <span className="shrink-0">{t("chat.flow.new")}</span>
                    <span aria-hidden="true" className="h-px flex-1 bg-ink" />
                  </p>
                ) : (
                  renderRow(row, `${day.day}-${i}`)
                ),
              )}
            </section>
          ))}
          {tail}
        </div>
      </div>
      <div className="relative h-0">
        {newBelow && (
          <button
            type="button"
            onClick={toBottom}
            className="toast-enter absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-rule-strong bg-surface px-3 text-sm font-medium whitespace-nowrap text-ink shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)] hover:bg-ink/4"
          >
            {t("chat.flow.newMessages")}
            <ArrowDownGlyph />
          </button>
        )}
      </div>
      <div className="sr-only" aria-live="polite" data-chat-announce>
        {announce}
      </div>
    </div>
  );
}

function firstMessageId(rows: FlowRow[]): string | null {
  for (const r of rows) {
    if (r.kind === "message") return r.message.id;
    if (r.kind === "system") return r.messages[0]!.id;
  }
  return null;
}

function lastMessageId(rows: FlowRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "message") return r.message.id;
    if (r.kind === "system") return r.messages.at(-1)!.id;
  }
  return null;
}
