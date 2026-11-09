import { Fragment, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CodeLink } from "../../../components/CodeLink";
import { CODE_IN_TEXT, type Ev } from "./flow";

// «Hypothesis» e «Details» sotto una risposta (area 10b, Task 11; shape
// `claude-scenarios.md` §3.2). L'ipotesi è una deduzione, non un fatto: una
// riga a sé col filetto tratteggiato (lo stesso tratteggio dell'anello di
// Claude) e la parola davanti — due segni, mai il solo colore. «Details» è
// come è contato: chiuso, si apre con Invio o Spazio, filetto continuo. Il
// testo è di Claude, nella lingua di chi ha chiesto (ruling T5).

export function AsideRow({ event }: { event: Ev<"aside"> }) {
  return event.kind === "hypothesis" ? (
    <Hypothesis text={event.text} />
  ) : (
    <Details text={event.text} />
  );
}

/** Il testo con i codici apribili per chi li vede (`CodeLink`): la deduzione cita ciò su cui ragiona. */
function withCodes(text: string): ReactNode {
  const re = new RegExp(CODE_IN_TEXT.source, "g");
  const out: ReactNode[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(<Fragment key={`t${last}`}>{text.slice(last, m.index)}</Fragment>);
    out.push(<CodeLink key={`c${m.index}`} code={m[0]} />);
    last = m.index + m[0].length;
  }
  out.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return out;
}

function Hypothesis({ text }: { text: string }) {
  const { t } = useTranslation();
  const word = t("claude.conversation.aside.hypothesis");
  return (
    <p
      data-aside="hypothesis"
      className="event-enter relative max-w-[68ch] pl-3 text-sm text-ink-muted [overflow-wrap:anywhere]"
    >
      <span
        aria-hidden="true"
        data-aside-rule="dashed"
        className="absolute inset-y-0.5 left-0 border-l-2 border-dashed border-ink-faint"
      />
      <span aria-hidden="true" className="text-xs font-semibold text-ink-muted">
        {word}
      </span>
      <span className="sr-only">{`${word}:`}</span>
      <span aria-hidden="true"> · </span>
      {withCodes(text)}
    </p>
  );
}

function Details({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div data-aside="details" className="event-enter flex min-w-0 flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 self-start rounded-md pr-1.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink"
      >
        <svg
          viewBox="0 0 16 16"
          width={12}
          height={12}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-[var(--duration-fast)] ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth={1.6} />
        </svg>
        {t("claude.conversation.aside.details")}
      </button>
      {open && (
        <p
          id={bodyId}
          className="max-w-[68ch] border-l border-rule pl-3 text-sm text-ink-muted [overflow-wrap:anywhere]"
        >
          {withCodes(text)}
        </p>
      )}
    </div>
  );
}
