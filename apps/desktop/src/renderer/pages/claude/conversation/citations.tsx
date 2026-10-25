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
import { ExternalGlyph, TypeGlyph } from "../../drive/glyphs";
import { useOpenDriveFile } from "../../drive/openFile";

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
    // Pagine (`AUD-D3`) e file del Drive (`AUD-F7`) hanno il loro codice; un
    // invisibile non ne ha (code null), quindi non entra: nascosto ≡ ignoto.
    if (v.code && ["task", "request", "doc", "drive"].includes(v.kind)) {
      byCode.set(v.code, v);
    }
  }
  return { byRef, byCode };
}

/**
 * Il codice di un oggetto che chi guarda non può aprire (R-E9): inchiostro
 * tenue, non un link, «You can't open this» al passaggio. Il nome non c'è:
 * il livello dati non lo dà.
 */
export function HiddenCode({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <span
      title={t("claude.conversation.citation.cantOpen")}
      data-citation="hidden"
      className="num font-semibold tracking-[0.02em] text-ink-faint"
    >
      {code}
    </span>
  );
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
    // R-E9: il codice in inchiostro tenue, che non si apre; il nome no.
    return view.code ? (
      <HiddenCode code={view.code} />
    ) : (
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
        {/* Una pagina dei Docs (`AUD-D12`) e un file del Drive (`AUD-F7`) hanno il loro codice. */}
        {view.code && <span className="num font-semibold tracking-[0.02em]">{view.code}</span>}
        {view.code && view.name && " "}
        {view.name && <span>{view.name}</span>}
        {/* Un file Google si apre su Google: la freccia d'uscita lo dice prima del clic. */}
        {view.drive?.google && (
          <span className="ml-0.5 inline-block translate-y-[1px] text-ink-muted" aria-hidden="true">
            <ExternalGlyph size={11} />
          </span>
        )}
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

  const linkClass =
    "rounded-[3px] text-ink underline decoration-transparent underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink/60 focus-visible:decoration-ink/60";
  return (
    <span className="relative inline">
      {view.kind === "drive" && view.route ? (
        <DriveAnchor view={view} common={common} className={linkClass}>
          {label}
        </DriveAnchor>
      ) : view.route ? (
        <a href={view.route} {...common} className={linkClass}>
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

/**
 * Il link di un file del Drive: l'indirizzo è il suo dettaglio (copiabile,
 * apribile in un'altra scheda), il clic APRE il file — Google o anteprima —
 * e conta, dopo aver riletto che c'è ancora.
 */
export function DriveAnchor({
  view,
  common,
  className,
  children,
}: {
  view: CitationView;
  common?: Record<string, unknown>;
  className: string;
  children: ReactNode;
}) {
  const open = useOpenDriveFile();
  return (
    <a
      href={view.route ?? undefined}
      {...common}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(view.id);
      }}
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * L'anteprima di un file del Drive (shape drive-search.md §3): glifo del
 * tipo, nome, «Google spreadsheet · AUD Audin 2.0», tre righe di riassunto,
 * aperture degli ultimi 90 giorni e cosa fa il clic. Un file non
 * disponibile lo dice al posto del clic.
 */
function DrivePreviewBody({
  view,
}: {
  view: CitationView & { drive: NonNullable<CitationView["drive"]> };
}) {
  const { t } = useTranslation();
  const d = view.drive;
  const typeLabel = t(`drive.${d.google ? "googleTypes" : "types"}.${d.type}`);
  return (
    <>
      <span className="flex items-start gap-2.5">
        <span className="shrink-0 pt-0.5 text-ink-muted" aria-hidden="true">
          <TypeGlyph type={d.type} size={24} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold [overflow-wrap:anywhere]">
            <span className="num mr-1.5">{view.code}</span>
            {view.name}
          </span>
          <span className="text-xs text-ink-muted">
            {typeLabel} · <span className="num font-semibold">{view.projectCode}</span>{" "}
            {d.projectName}
          </span>
        </span>
      </span>
      {d.summary && <span className="line-clamp-3 text-ink-muted">{d.summary}</span>}
      <span className="flex items-baseline justify-between gap-3 border-t border-rule pt-1.5 text-xs">
        <span className="num text-ink-muted">{t("drive.opens.count", { count: d.opens90d })}</span>
        {d.unavailable ? (
          <span className="text-ink-muted">{t("claude.conversation.citation.notAvailable")}</span>
        ) : (
          <span className="flex items-center gap-1 font-medium text-ink">
            {d.google ? t("drive.google.open") : t("drive.search.open")}
            {d.google && (
              <span aria-hidden="true">
                <ExternalGlyph size={11} />
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );
}

function CitationPreview({ id, view }: { id: string; view: CitationView }) {
  if (view.drive) {
    return (
      <span
        id={id}
        role="tooltip"
        className="menu-enter absolute top-full left-0 z-40 mt-1.5 flex w-[320px] max-w-[80vw] flex-col gap-2 rounded-lg border border-rule-strong bg-surface p-3 text-left text-sm whitespace-normal text-ink shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
      >
        <DrivePreviewBody view={{ ...view, drive: view.drive }} />
      </span>
    );
  }
  return <ObjectPreview id={id} view={view} />;
}

function ObjectPreview({ id, view }: { id: string; view: CitationView }) {
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
        {view.code && view.kind !== "file" && <span className="num mr-1.5">{view.code}</span>}
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
