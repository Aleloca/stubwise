import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { usePeople } from "../../../data/queries";
import type { CitationRef, CitationView } from "../../../data/types";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { BreakablePath } from "../../../tasks-ui/Markdown";

// Le citazioni del flusso: chi guarda le legge UNA volta per conversazione
// (`useCitations` nel componente principale) e le trova qui per id e per
// codice. Un oggetto che non vede non ha nome né codice: resta una scritta
// tenue che non si apre («You can't open this»).

export interface CitationIndex {
  byRef: Map<string, CitationView>;
  byCode: Map<string, CitationView>;
}

export const refKey = (ref: CitationRef) => `${ref.kind}:${ref.id}`;

export function indexCitations(views: readonly CitationView[] | undefined): CitationIndex {
  const byRef = new Map<string, CitationView>();
  const byCode = new Map<string, CitationView>();
  for (const v of views ?? []) {
    byRef.set(refKey(v), v);
    if (v.visible && v.code && (v.kind === "task" || v.kind === "request")) byCode.set(v.code, v);
  }
  return { byRef, byCode };
}

const CitationContext = createContext<CitationIndex>(indexCitations([]));
export const CitationProvider = CitationContext.Provider;
export const useCitationIndex = () => useContext(CitationContext);

/** Quanto si aspetta prima di mostrare l'anteprima (ms). */
const PREVIEW_DELAY = 250;

/**
 * Un oggetto citato: codice (600, cifre tabellari) e nome, apribile se chi
 * guarda lo può aprire; al passaggio (o al fuoco) un'anteprima con stato e
 * persona. Un file è il suo percorso, che non si apre.
 */
export function CitationLink({ view }: { view: CitationView }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const previewId = useId();
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!view.visible) {
    return (
      <span
        title={t("claude.conversation.citation.cantOpen")}
        className="text-ink-faint"
        data-citation="hidden"
      >
        {t("claude.conversation.citation.hidden")}
      </span>
    );
  }

  const label =
    view.kind === "file" ? (
      <BreakablePath path={view.name ?? ""} />
    ) : (
      <>
        {view.code && view.kind !== "doc" && (
          <span className="num font-semibold tracking-[0.02em]">{view.code}</span>
        )}
        {view.code && view.kind !== "doc" && view.name && " "}
        {view.name && <span>{view.name}</span>}
      </>
    );

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPreview(true), PREVIEW_DELAY);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPreview(false);
  };

  const common = {
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    "aria-describedby": preview ? previewId : undefined,
    "data-citation": `${view.kind}:${view.id}`,
  };

  return (
    <span className="relative inline">
      {view.route ? (
        <a
          href={view.route}
          {...common}
          className="rounded-[3px] text-ink underline decoration-transparent underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink/60 focus-visible:decoration-ink/60"
        >
          {label}
        </a>
      ) : (
        <span {...common} tabIndex={0} className="text-ink">
          {label}
        </span>
      )}
      {preview && <CitationPreview id={previewId} view={view} />}
    </span>
  );
}

function CitationPreview({ id, view }: { id: string; view: CitationView }) {
  const { t } = useTranslation();
  const person = usePeople().data?.find((p) => p.id === view.personId);
  const status =
    view.kind === "request" && view.status
      ? t(`requests.status.${view.status}`, { defaultValue: view.status })
      : view.status;
  return (
    <span
      id={id}
      role="tooltip"
      className="menu-enter absolute top-full left-0 z-40 mt-1.5 flex w-[320px] max-w-[80vw] flex-col gap-1.5 rounded-lg border border-rule-strong bg-surface p-3 text-left text-sm whitespace-normal text-ink shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      <span className="flex items-baseline gap-2">
        <span className="text-xs text-ink-muted">
          {t(`claude.conversation.citation.kind.${view.kind}`)}
        </span>
        {view.projectCode && (
          <span className="num text-xs font-semibold text-ink-muted">{view.projectCode}</span>
        )}
      </span>
      <span className="font-semibold">
        {view.code && view.kind !== "doc" && view.kind !== "file" && (
          <span className="num mr-1.5">{view.code}</span>
        )}
        {view.kind === "file" ? <BreakablePath path={view.name ?? ""} /> : view.name}
      </span>
      {(status || person) && (
        <span className="flex items-center gap-3 text-ink-muted">
          {status && <span>{status}</span>}
          {person && (
            <span className="flex items-center gap-1.5">
              <Avatar person={person} />
              {person.name}
            </span>
          )}
        </span>
      )}
      {!view.route && view.kind === "file" && (
        <span className="text-xs text-ink-faint">{t("claude.conversation.citation.fileNote")}</span>
      )}
    </span>
  );
}

/** La riga «Used: …» in coda a un messaggio: gli oggetti che Claude ha letto. */
export function UsedLine({ refs }: { refs: readonly CitationRef[] }): ReactNode {
  const { t } = useTranslation();
  const index = useCitationIndex();
  const views = refs.map((ref) => index.byRef.get(refKey(ref))).filter((v) => v !== undefined);
  if (views.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-sm text-ink-muted">
      <span>{t("claude.conversation.citation.used")}</span>
      {views.map((view, i) => (
        <span key={refKey(view)} className="inline">
          <CitationLink view={view} />
          {i < views.length - 1 && <span aria-hidden="true"> · </span>}
        </span>
      ))}
    </p>
  );
}
