import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useDriveFile, useRecordDriveOpen } from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import type { DriveFileRow } from "../../data/types";
import { Markdown } from "../../tasks-ui/Markdown";
import { useToast } from "../../tasks-ui/Toast";
import { formatDate } from "../../notifications/time";
import { CloseIcon, ghostButton } from "../task/parts";
import { blobOf } from "./blobs";
import { previewKind } from "./driveFilters";
import { DownloadGlyph, TypeGlyph } from "./glyphs";

// L'anteprima intera di un caricato (shape drive.md §6, A9–A10): si apre
// sopra l'area di lavoro (binario e colonna restano), conta un'apertura
// (riaprirla entro 30′ no: lo decide il livello dati), ←/→ scorrono i file
// della vista, Esc chiude e torna alla riga. La miniatura nel dettaglio non
// conta: solo i gesti qui sotto chiamano `recordOpen`.

/** Un file della vista: quanto basta per contare un'apertura e ritrovarlo. */
export interface ViewItem {
  id: string;
  code: string;
}

interface PreviewState {
  code: string;
  items: ViewItem[];
}

let current: PreviewState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setPreview(next: PreviewState | null) {
  current = next;
  emit();
}

// I file della vista che l'elenco mostra adesso, nel suo ordine: l'anteprima
// aperta dal dettaglio scorre questi (←/→) come quella aperta dalla riga.
let viewItems: ViewItem[] = [];

/** L'elenco del Drive dice quali file mostra (e li toglie smontandosi). */
export function setViewItems(items: ViewItem[]): void {
  viewItems = items;
}

/** I file da scorrere a partire da `file`: la vista, se lo contiene; sennò lui solo. */
export function viewItemsFor(file: ViewItem): ViewItem[] {
  return viewItems.some((i) => i.code === file.code) ? viewItems : [file];
}

/** Chiude l'anteprima (Esc, «Open details», cambio di persona, test). */
export function closePreview(): void {
  if (current) setPreview(null);
}

// Cambio di persona: l'anteprima di chi guardava prima non resta aperta.
onBeforePersonaChange(closePreview);

function usePreviewState(): PreviewState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/**
 * I gesti che contano un'apertura: l'anteprima intera, «Open in Google
 * Drive» (nel prototipo un avviso, nessun browser) e il download (vero se
 * il file è stato caricato in questa sessione, altrimenti un avviso).
 */
export function useDriveOpeners() {
  const { t } = useTranslation();
  const toast = useToast();
  const record = useRecordDriveOpen();
  const { mutate } = record;
  const preview = useCallback(
    (file: ViewItem, items: ViewItem[]) => {
      mutate({ fileId: file.id, via: "preview" });
      setPreview({ code: file.code, items: items.length > 0 ? items : [file] });
    },
    [mutate],
  );
  const google = useCallback(
    (file: Pick<DriveFileRow, "id">) => {
      mutate({ fileId: file.id, via: "google" });
      toast.show(t("drive.google.opened"));
    },
    [mutate, toast, t],
  );
  const download = useCallback(
    (file: Pick<DriveFileRow, "id" | "name">) => {
      mutate({ fileId: file.id, via: "download" });
      const url = blobOf(file.id)?.url;
      if (url) {
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
      } else {
        toast.show(t("drive.detail.downloaded", { name: file.name }));
      }
    },
    [mutate, toast, t],
  );
  // Stabile: le righe (memo) e i loro gestori non si ridisegnano per un render della pagina.
  return useMemo(() => ({ preview, google, download }), [preview, google, download]);
}

/** Il file non ha (più) il suo contenuto in questa sessione: una pagina tipo con la nota del prototipo. */
function FakePage({ file, compact = false }: { file: Pick<DriveFileRow, "type" | "name">; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-fake-preview
      className={`flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center ${compact ? "py-4" : "py-12"}`}
    >
      <span className="text-ink-faint">
        <TypeGlyph type={file.type} size={compact ? 40 : 72} />
      </span>
      <p className={`${compact ? "text-xs" : "text-md font-medium"} max-w-[48ch] text-ink-muted`}>
        {t("drive.preview.fake")}
      </p>
      {!compact && <p className="max-w-[52ch] text-sm text-ink-faint">{t("drive.preview.fakeBody")}</p>}
    </div>
  );
}

/**
 * La miniatura nel pannello di dettaglio (16:10, con filetto): immagine,
 * prima pagina del PDF, prime righe del testo — o la pagina finta. È una
 * miniatura: non conta un'apertura (il clic che apre l'anteprima sì).
 */
export function PreviewThumb({ file }: { file: DriveFileRow }) {
  const kind = previewKind(file);
  const blob = blobOf(file.id);
  let inner;
  if (kind === "image" && blob?.url) {
    inner = <img src={blob.url} alt="" className="h-full w-full object-contain" />;
  } else if (kind === "pdf" && blob?.url) {
    inner = (
      <iframe
        src={`${blob.url}#page=1&toolbar=0&navpanes=0`}
        title={file.name}
        tabIndex={-1}
        className="pointer-events-none h-full w-full bg-surface"
      />
    );
  } else if (kind === "text" && blob?.text !== undefined) {
    inner = (
      <pre className="h-full w-full overflow-hidden p-3 text-left text-xs leading-4 whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]">
        {blob.text.split("\n").slice(0, 14).join("\n")}
      </pre>
    );
  } else {
    inner = <FakePage file={file} compact />;
  }
  return (
    <div className="aspect-[16/10] w-full overflow-hidden rounded-md border border-rule bg-ground">
      {inner}
    </div>
  );
}

/** La scheda di un file Google al posto dell'anteprima: si apre su Google. */
export function GoogleCard({ file }: { file: DriveFileRow }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex items-center gap-3 rounded-md border border-rule bg-ground px-4 py-4">
      <span className="text-ink-muted">
        <TypeGlyph type={file.type} size={40} />
      </span>
      <p className="min-w-0 text-sm text-ink-muted [overflow-wrap:anywhere]">
        {t("drive.detail.googleCard", {
          type: t(`drive.googleTypes.${file.type}`),
          owner: file.googleOwner ?? "—",
          date: formatDate(file.modifiedAt, i18n.language),
        })}
      </p>
    </div>
  );
}

/** Il contenuto dell'anteprima intera, secondo il tipo e ciò che la sessione ha del file. */
function PreviewBody({
  file,
  zoomed,
  setZoomed,
}: {
  file: DriveFileRow;
  zoomed: boolean;
  setZoomed: (fn: (z: boolean) => boolean) => void;
}) {
  const { t } = useTranslation();
  const kind = previewKind(file);
  const blob = blobOf(file.id);
  if (kind === "image" && blob?.url) {
    return (
      <div className={`h-full w-full ${zoomed ? "overflow-auto" : "grid place-items-center p-6"}`}>
        <button
          type="button"
          aria-label={zoomed ? t("drive.preview.zoomOut") : t("drive.preview.zoomIn")}
          title={zoomed ? t("drive.preview.zoomOut") : t("drive.preview.zoomIn")}
          onClick={() => setZoomed((z) => !z)}
          className={zoomed ? "cursor-zoom-out" : "grid h-full w-full cursor-zoom-in place-items-center"}
        >
          <img
            src={blob.url}
            alt={file.name}
            className={zoomed ? "max-w-none" : "max-h-full max-w-full object-contain"}
          />
        </button>
      </div>
    );
  }
  if (kind === "pdf" && blob?.url) {
    return <iframe src={blob.url} title={file.name} className="h-full w-full bg-surface" />;
  }
  if (kind === "text" && blob?.text !== undefined) {
    const markdown = /\.(md|markdown)$/i.test(file.name);
    return (
      <div className="h-full overflow-auto px-8 py-8">
        <div className="mx-auto max-w-[72ch]">
          {markdown ? (
            <Markdown source={blob.text} />
          ) : (
            <pre className="text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{blob.text}</pre>
          )}
        </div>
      </div>
    );
  }
  return <FakePage file={file} />;
}

/**
 * L'anteprima aperta, sopra l'area di lavoro: testata 48 px (codice e nome,
 * Download, «Open details», precedente/successivo, chiudi) e il file.
 * È un dialogo modale per la sola area di lavoro: il fuoco entra e, alla
 * chiusura, torna alla riga del file.
 */
export function FilePreviewHost() {
  const state = usePreviewState();
  if (!state) return null;
  return <FilePreview key={state.code} state={state} />;
}

function FilePreview({ state }: { state: PreviewState }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: file } = useDriveFile(state.code);
  const openers = useDriveOpeners();
  const root = useRef<HTMLDivElement>(null);
  const at = state.items.findIndex((i) => i.code === state.code);
  const prev = at > 0 ? state.items[at - 1] : undefined;
  const next = at >= 0 ? state.items[at + 1] : undefined;
  const missing = file === null;
  // Un'immagine ingrandita: le frecce la scorrono, non cambiano file.
  const [zoomed, setZoomed] = useState(false);

  const close = useCallback(() => {
    const code = state.code;
    closePreview();
    requestAnimationFrame(() => {
      // Sopra un dettaglio sovrapposto (modale) il fuoco torna dentro il pannello,
      // al bottone che ha aperto l'anteprima; sennò alla riga del file.
      const panel = document.querySelector<HTMLElement>('[data-detail-panel][data-mode="overlay"]');
      if (panel) {
        (panel.querySelector<HTMLElement>("[data-preview-origin]") ?? panel).focus();
        return;
      }
      document.querySelector<HTMLElement>(`[data-drive-row="${CSS.escape(code)}"]`)?.focus();
    });
  }, [state.code]);

  // Un file che chi guarda non vede più (eliminato, persona cambiata): l'anteprima si chiude.
  useEffect(() => {
    if (missing) closePreview();
  }, [missing]);

  useLayoutEffect(() => {
    root.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (zoomed) {
        return;
      } else if (e.key === "ArrowLeft" && prev) {
        e.preventDefault();
        openers.preview(prev, state.items);
      } else if (e.key === "ArrowRight" && next) {
        e.preventDefault();
        openers.preview(next, state.items);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, prev, next, openers, state.items, zoomed]);

  const openDetails = () => {
    closePreview();
    void navigate({
      to: ".",
      search: (s: Record<string, unknown>) => ({ ...s, file: state.code }),
    } as never);
  };

  const navButton = `${ghostButton} w-8 justify-center px-0 disabled:pointer-events-none disabled:opacity-40`;
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t("drive.preview.label", { code: state.code })}
      tabIndex={-1}
      data-drive-preview={state.code}
      onKeyDown={trapTab}
      className="drive-preview-enter absolute inset-0 z-[45] flex min-h-0 flex-col bg-ground outline-none"
    >
      <header className="page-header flex h-12 shrink-0 items-center gap-3 border-b border-rule pl-4 [--page-header-pr:8px]">
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
          {state.code}
        </span>
        <span title={file?.name} className="min-w-0 flex-1 truncate text-md text-ink">
          {file?.name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {file && (
            <button type="button" className={ghostButton} onClick={() => openers.download(file)}>
              <DownloadGlyph />
              {t("drive.detail.download")}
            </button>
          )}
          <button type="button" className={ghostButton} onClick={openDetails}>
            {t("drive.preview.openDetails")}
          </button>
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-rule" />
          <button
            type="button"
            aria-label={t("drive.preview.prev")}
            title={t("drive.preview.prev")}
            disabled={!prev}
            onClick={() => prev && openers.preview(prev, state.items)}
            className={navButton}
          >
            <Arrow dir="left" />
          </button>
          <button
            type="button"
            aria-label={t("drive.preview.next")}
            title={t("drive.preview.next")}
            disabled={!next}
            onClick={() => next && openers.preview(next, state.items)}
            className={navButton}
          >
            <Arrow dir="right" />
          </button>
          <button
            type="button"
            aria-label={t("drive.preview.close")}
            title={t("drive.preview.close")}
            onClick={close}
            className={`${ghostButton} w-8 justify-center px-0`}
          >
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1">{file && <PreviewBody file={file} zoomed={zoomed} setZoomed={setZoomed} />}</div>
    </div>
  );
}

/** Tab e Maiusc+Tab restano nell'anteprima (è modale per l'area di lavoro). */
export function trapTab(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const focusables = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = focusables[0];
  const last = focusables.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === e.currentTarget)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={dir === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}
