import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useConnectGoogle,
  useDeleteDriveFile,
  useDriveFile,
  useFolderLinks,
  usePeople,
  useProjects,
  useRemoveGoogleFile,
  useRetryExtraction,
  useSessionPersonId,
  useSetDriveHidden,
} from "../../data/queries";
import type { DriveFileDetail, DriveOpen } from "../../data/types";
import {
  DOCKED_PANEL_QUERY,
  DetailPanel,
  forcesOverlay,
  type DetailPanelMode,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { formatDate, formatDateTime } from "../../notifications/time";
import { Dialog } from "../../tasks-ui/Dialog";
import { itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { TrapFocus } from "../chat/ThreadPanel";
import { CloseIcon, MoreIcon, Section, ghostButton, smallPrimary, smallSecondary } from "../task/parts";
import { MenuButton, dangerSolidButton, secondaryButton } from "../tasks/controls";
import { forgetBlob } from "./blobs";
import { fileHref } from "./DriveList";
import { previewKind } from "./driveFilters";
import { GoogleCard, PreviewThumb, useDriveOpeners, viewItemsFor } from "./FilePreview";
import { ShareToChatDialog, writableChannels } from "./ShareToChat";
import { formatSize, modifiedLabel } from "./format";
import {
  DownloadGlyph,
  ErrorGlyph,
  ExternalGlyph,
  OpenGlyph,
  Spinner,
  TypeGlyph,
  UnavailableGlyph,
} from "./glyphs";

// Il pannello di dettaglio di un file (`?file=AUD-F7`, shape drive.md §6):
// stessa meccanica del dettaglio della task — affiancato da 1200 px,
// sovrapposto sotto (col velo, il fuoco dentro e il ritorno alla riga).
// Dall'alto: testata, nome, anteprima (o scheda Google), azioni, SUMMARY,
// DETAILS, OPENS e, con `drive.history`, WHO OPENED IT. Le azioni non
// permesse non compaiono (le decide il «server»: `permissions`).

/** Quante aperture dello storico si vedono prima di «Show all» (drive-google.md A8). */
const HISTORY_PREVIEW = 10;

export function DriveDetailHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { file?: string };
  const personId = useSessionPersonId();
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const overlayOnly = useRouterState({ select: (s) => forcesOverlay(s.location.pathname) });
  const mode: DetailPanelMode = wide && !overlayOnly ? "docked" : "overlay";
  const code = search.file;

  const close = useCallback(
    (focusRow = true) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, file: undefined }),
      } as never);
      if (focusRow && code) {
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-drive-row="${CSS.escape(code)}"]`)
            ?.focus({ preventScroll: true }),
        );
      }
    },
    [navigate, code],
  );

  // Cambio di persona: il pannello si chiude, e niente della persona di prima
  // (storico, azioni, conferme a metà) resta aperto per quella nuova.
  const [viewer, setViewer] = useState(personId);
  const [suppressed, setSuppressed] = useState<string | null>(null);
  if (viewer !== personId) {
    setViewer(personId);
    if (code) setSuppressed(code);
  }
  useEffect(() => {
    if (suppressed && code === suppressed) close(false);
    if (!code && suppressed) setSuppressed(null);
  }, [suppressed, code, close]);

  if (!code || code === suppressed) return null;
  return (
    <>
      {mode === "overlay" && (
        <div
          aria-hidden="true"
          data-drive-scrim
          className="palette-backdrop fixed inset-0 z-30 bg-[var(--scrim)]"
          onClick={() => close()}
        />
      )}
      <DetailPanel mode={mode} label={t("drive.detail.label", { code })} onClose={close} modal>
        <TrapFocus active={mode === "overlay"}>
          <DriveDetail key={`${personId}:${code}`} code={code} onClose={close} />
        </TrapFocus>
      </DetailPanel>
    </>
  );
}

/** La barra in cima quando non c'è un file da mostrare: il codice e «Close». */
function BareTop({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="page-header box-content flex h-12 shrink-0 items-center gap-2 pl-4 [--page-header-pr:8px]">
      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">{code}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("drive.detail.close")}
        title={t("drive.detail.close")}
        className={`${ghostButton} ml-auto w-8 justify-center px-0`}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function DriveDetail({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: file, isPending, isError, refetch } = useDriveFile(code);
  if (isError) {
    return (
      <>
        <BareTop code={code} onClose={onClose} />
        <PageError message={t("drive.detail.error")} onRetry={() => void refetch()} />
      </>
    );
  }
  if (isPending) {
    return (
      <>
        <BareTop code={code} onClose={onClose} />
        <div aria-busy="true" className="skeleton-breathe flex flex-col gap-4 px-4 pt-2 pb-6">
          <span role="status" className="sr-only">
            {t("taskUi.states.loading")}
          </span>
          <span className="h-5 w-4/5 rounded-sm bg-ink/8" />
          <span className="aspect-[16/10] w-full rounded-md bg-ink/6" />
          <span className="h-2.5 w-1/2 rounded-sm bg-ink/8" />
        </div>
      </>
    );
  }
  // Un file che chi guarda non vede risponde come uno che non esiste (R-G5).
  if (!file) {
    return (
      <>
        <BareTop code={code} onClose={onClose} />
        <p className="px-4 py-6 text-md font-semibold text-ink">{t("drive.detail.notFound")}</p>
      </>
    );
  }
  return <FileBody file={file} onClose={onClose} />;
}

type Confirming = "delete" | "remove" | null;

function FileBody({ file, onClose }: { file: DriveFileDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const projects = useProjects().data;
  const project = projects?.find((p) => p.id === file.projectId);
  const people = usePeople().data;
  const personName = (id: string) => people?.find((p) => p.id === id)?.name ?? t("drive.row.someone");
  const openers = useDriveOpeners();
  const del = useDeleteDriveFile();
  const remove = useRemoveGoogleFile();
  const hide = useSetDriveHidden();
  const retry = useRetryExtraction();
  // «Cite in Chat»: solo se c'è almeno un canale in cui chi guarda può scrivere.
  const writable = writableChannels(useChatChannels({ scope: "all" }).data);
  const [sharing, setSharing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  // L'anteprima scorre (←/→) i file della vista dell'elenco, come dalla riga.
  const openPreview = () => openers.preview(file, viewItemsFor(file));

  const kind = previewKind(file);
  const google = file.source === "google";
  const available = file.unavailable === null;

  const copyLink = () => {
    void navigator.clipboard?.writeText(fileHref(file)).catch(() => {});
    toast.show(t("drive.detail.linkCopied"));
  };
  // «Cite in Chat» (A11): il dialogo «Share to…».
  const cite = () => setSharing(true);
  // Un nascosto (lo vede solo chi gestisce, dal filtro «Hidden»): «Show again».
  const doShow = () =>
    hide.mutate(
      { id: file.id, hidden: false },
      {
        onSuccess: () => toast.show(t("drive.hidden.shown", { code: file.code })),
        onError: () => toast.error(t("drive.detail.failed")),
      },
    );
  const doHide = () =>
    hide.mutate(
      { id: file.id, hidden: true },
      {
        onSuccess: () => {
          onClose();
          toast.show(t("drive.detail.hidden", { code: file.code }), {
            action: {
              label: t("drive.detail.undo"),
              run: () => hide.mutate({ id: file.id, hidden: false }),
            },
          });
        },
        onError: () => toast.error(t("drive.detail.failed")),
      },
    );
  const confirmGone = () => {
    const which = confirming;
    setConfirming(null);
    const mutation = which === "delete" ? del : remove;
    mutation.mutate(file.id, {
      onSuccess: () => {
        forgetBlob(file.id);
        onClose();
        toast.show(
          t(which === "delete" ? "drive.detail.deleted" : "drive.detail.removed", { code: file.code }),
        );
      },
      onError: () => toast.error(t("drive.detail.failed")),
    });
  };

  const primary: ReactNode = google ? (
    available ? (
      <button type="button" className={smallPrimary} onClick={() => openers.google(file)}>
        <span className="flex items-center gap-1.5">
          {t("drive.google.open")}
          <ExternalGlyph />
        </span>
      </button>
    ) : null
  ) : kind ? (
    <button type="button" data-preview-origin className={smallPrimary} onClick={openPreview}>
      <span className="flex items-center gap-1.5">
        <OpenGlyph />
        {t("drive.detail.open")}
      </span>
    </button>
  ) : (
    <button type="button" className={smallPrimary} onClick={() => openers.download(file)}>
      <span className="flex items-center gap-1.5">
        <DownloadGlyph />
        {t("drive.detail.download")}
      </span>
    </button>
  );

  const typeName = google ? t(`drive.googleTypes.${file.type}`) : t(`drive.types.${file.type}`);

  return (
    <div data-drive-detail={file.code} className="flex flex-col pb-6">
      <div className="page-header box-content flex h-12 shrink-0 items-center gap-1 pl-4 [--page-header-pr:8px]">
        <p className="min-w-0 flex-1 truncate text-xs text-ink-muted">
          <span className="num font-semibold tracking-[0.02em] text-ink">{file.code}</span>
          {project && <span> · {project.name}</span>}
        </p>
        <MenuButton
          menuLabel={t("drive.detail.more", { code: file.code })}
          ariaLabel={t("drive.detail.more", { code: file.code })}
          title={t("drive.detail.more", { code: file.code })}
          align="right"
          className={`${ghostButton} w-8 justify-center px-0`}
          label={<MoreIcon />}
        >
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  close();
                  copyLink();
                }}
              >
                {t("drive.detail.copyLink")}
              </button>
              {writable.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    cite();
                  }}
                >
                  {t("drive.detail.cite")}
                </button>
              )}
            </>
          )}
        </MenuButton>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("drive.detail.close")}
          title={t("drive.detail.close")}
          className={`${ghostButton} w-8 justify-center px-0`}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <h2 className="text-xl font-semibold text-ink [overflow-wrap:anywhere]">{file.name}</h2>
        {google && !available ? (
          <UnavailableBand
            file={file}
            onRemove={file.permissions.remove ? () => setConfirming("remove") : undefined}
          />
        ) : google ? (
          <GoogleCard file={file} />
        ) : kind ? (
          // La miniatura non conta: conta il clic che apre l'anteprima intera (A9).
          <button
            type="button"
            aria-label={t("drive.detail.open")}
            onClick={openPreview}
            className="block w-full cursor-zoom-in rounded-md text-left transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90"
          >
            <PreviewThumb file={file} />
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-md border border-rule bg-ground px-4 py-4">
            <span className="text-ink-muted">
              <TypeGlyph type={file.type} size={40} />
            </span>
            <p className="text-sm text-ink-muted">
              {typeName}
              {file.sizeBytes !== null && ` · ${formatSize(file.sizeBytes, i18n.language)}`}
            </p>
          </div>
        )}
        {/* Due righe decise, sullo stesso bordo sinistro: aprire (o
            scaricare) sopra, le azioni secondarie sotto. Nessuna va a capo
            per caso quando il pannello è stretto o la lingua è lunga. */}
        <div className="flex flex-col items-start gap-1.5">
          {(primary || (!google && kind)) && (
            <div className="flex items-center gap-1.5">
              {primary}
              {!google && kind && (
                <button type="button" className={smallSecondary} onClick={() => openers.download(file)}>
                  <span className="flex items-center gap-1.5">
                    <DownloadGlyph />
                    {t("drive.detail.download")}
                  </span>
                </button>
              )}
            </div>
          )}
          <div className="ml-0.5 flex items-center gap-1">
            <button type="button" className={ghostButton} onClick={copyLink}>
              {t("drive.detail.copyLink")}
            </button>
            {writable.length > 0 && (
              <button type="button" className={ghostButton} onClick={cite}>
                {t("drive.detail.cite")}
              </button>
            )}
          </div>
        </div>
      </div>

      <Section title={t("drive.detail.summary")}>
        <ContentSummary
          file={file}
          onRetry={file.permissions.retry ? () => retry.mutate(file.id) : undefined}
        />
      </Section>

      <Section title={t("drive.detail.details")}>
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <Field label={t("drive.detail.fields.type")}>{typeName}</Field>
          <Field label={t("drive.detail.fields.size")}>
            <span className="num">
              {file.sizeBytes === null ? "—" : formatSize(file.sizeBytes, i18n.language)}
            </span>
          </Field>
          <Field label={t("drive.detail.fields.source")}>
            {google ? t("drive.detail.sourceGoogle") : t("drive.detail.sourceUpload")}
            {file.folder && <span className="text-ink-muted"> · {t("drive.folder.in", { name: file.folder.name })}</span>}
          </Field>
          <Field label={t("drive.detail.fields.addedBy")}>
            {t("drive.detail.addedOn", {
              name: personName(file.addedById),
              date: formatDate(file.addedAt, i18n.language),
            })}
          </Field>
          <Field label={t("drive.detail.fields.modified")}>
            <span className="num">{modifiedLabel(file.modifiedAt, t, i18n.language)}</span>
          </Field>
        </dl>
      </Section>

      <Section title={t("drive.detail.opens")}>
        <p className="num text-sm text-ink">
          {t("drive.opens.summary", { count: file.opens90d, total: file.opensTotal })}
        </p>
      </Section>

      {file.history !== null && <History history={file.history} personName={personName} />}

      {(file.permissions.delete || (file.permissions.remove && available) || file.permissions.hide) && (
        <div className="flex flex-wrap gap-1.5 border-t border-rule px-4 pt-4">
          {file.permissions.delete && (
            <button type="button" className={dangerGhost} onClick={() => setConfirming("delete")}>
              {t("drive.detail.delete")}
            </button>
          )}
          {file.permissions.remove && available && (
            <button type="button" className={dangerGhost} onClick={() => setConfirming("remove")}>
              {t("drive.detail.remove")}
            </button>
          )}
          {file.permissions.hide &&
            (file.hidden ? (
              <button type="button" className={ghostButton} onClick={doShow}>
                {t("drive.hidden.showAgain")}
              </button>
            ) : (
              <button type="button" className={ghostButton} onClick={doHide}>
                {t("drive.detail.hide")}
              </button>
            ))}
        </div>
      )}

      {sharing && (
        <ShareToChatDialog file={file} channels={writable} onClose={() => setSharing(false)} />
      )}
      {confirming && (
        <Dialog
          title={t(
            confirming === "delete" ? "drive.detail.confirmDelete.title" : "drive.detail.confirmRemove.title",
            { code: file.code },
          )}
          description={t(
            confirming === "delete" ? "drive.detail.confirmDelete.body" : "drive.detail.confirmRemove.body",
            { name: file.name },
          )}
          onClose={() => setConfirming(null)}
          width={440}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setConfirming(null)}>
                {t("drive.detail.confirmDelete.cancel")}
              </button>
              <button type="button" className={dangerSolidButton} onClick={confirmGone}>
                {t(
                  confirming === "delete"
                    ? "drive.detail.confirmDelete.confirm"
                    : "drive.detail.confirmRemove.confirm",
                )}
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </div>
  );
}

/**
 * Un file Google non disponibile, al posto della scheda (drive-google.md,
 * «Non disponibile»): la causa in parole — cancellato su Google, o accesso
 * perso perché l'account di chi ha collegato la cartella è scollegato (chi
 * è, se lo è), o perché la cartella è cambiata su Google — e cosa si può
 * fare: «Reconnect» per chi ha collegato la cartella, «Remove from project»
 * per chi può toglierlo.
 */
function UnavailableBand({ file, onRemove }: { file: DriveFileDetail; onRemove?: () => void }) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const people = usePeople().data;
  const links = useFolderLinks(file.projectId).data;
  const connect = useConnectGoogle();
  const link = file.folder ? links?.find((l) => l.id === file.folder!.id) : undefined;
  const accountGone = file.unavailable === "access_lost" && link?.status === "expired";
  const linkerName = link ? (people?.find((p) => p.id === link.linkedById)?.name ?? t("drive.row.someone")) : "";
  const cause =
    file.unavailable === "deleted"
      ? t("drive.notAvailable.deleted")
      : accountGone
        ? link!.linkedById === me
          ? t("drive.notAvailable.accessLostMine")
          : t("drive.notAvailable.accessLostOther", { name: linkerName })
        : t("drive.notAvailable.accessLost");
  const canReconnect = accountGone && link!.linkedById === me;
  return (
    <div
      data-drive-unavailable
      className="flex flex-col gap-2 rounded-md border border-rule bg-ground px-4 py-3"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <UnavailableGlyph />
        {t("drive.notAvailable.title")}
      </p>
      <p className="text-md text-ink">{cause}</p>
      <p className="text-xs text-ink-muted">{t("drive.notAvailable.note")}</p>
      {(canReconnect || onRemove) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {canReconnect && (
            <button
              type="button"
              className={smallSecondary}
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t("drive.notAvailable.reconnect")}
            </button>
          )}
          {onRemove && (
            <button type="button" className={dangerGhost} onClick={onRemove}>
              {t("drive.detail.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const dangerGhost =
  "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-medium text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** Il contenuto per esteso: il riassunto intero, o lo stato in parole (con «Retry» per chi gestisce). */
function ContentSummary({ file, onRetry }: { file: DriveFileDetail; onRetry?: () => void }) {
  const { t } = useTranslation();
  if (file.unavailable) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ink-muted">
        <UnavailableGlyph />
        {t(`drive.unavailable.${file.unavailable}`)}
      </p>
    );
  }
  if (file.content === "processing") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ink-muted">
        <Spinner />
        {t("drive.content.processing")}
      </p>
    );
  }
  if (file.content === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-sm text-critical">
          <ErrorGlyph />
          {t("drive.content.error")}
        </p>
        {onRetry && (
          <button type="button" className={ghostButton} onClick={onRetry}>
            {t("drive.content.retry")}
          </button>
        )}
      </div>
    );
  }
  if (file.content !== "ready") {
    return <p className="text-sm text-ink-faint">{t(`drive.content.${file.content}`)}</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {file.summary ? (
        <p className="text-md text-ink">{file.summary}</p>
      ) : (
        <p className="text-sm text-ink-faint">{t("drive.content.noSummary")}</p>
      )}
      {file.summary && <p className="text-xs text-ink-faint">{t("drive.detail.summaryNote")}</p>}
      {file.ocr && <p className="text-xs text-ink-muted">{t("drive.content.ocr")}</p>}
    </div>
  );
}

/**
 * WHO OPENED IT (solo con `drive.history`): una riga per apertura — persona,
 * modo, data e ora — le più recenti in alto, 10 e «Show all». Nessun totale
 * per persona, nessuna classifica (drive-google.md, storico).
 */
function History({
  history,
  personName,
}: {
  history: DriveOpen[];
  personName: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const [all, setAll] = useState(false);
  const listId = useId();
  const shown = all ? history : history.slice(0, HISTORY_PREVIEW);
  return (
    <Section title={t("drive.detail.history")} empty={history.length === 0 ? t("drive.detail.historyEmpty") : undefined}>
      {history.length > 0 && (
        <ul id={listId} aria-label={t("drive.detail.history")} className="flex flex-col">
          {shown.map((o, i) => (
            <li key={`${o.at}-${o.personId}-${i}`} className="flex h-8 items-center gap-2 text-sm">
              <span className="scale-[0.9]">
                <Avatar person={people?.find((p) => p.id === o.personId)} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink">{personName(o.personId)}</span>
              <span className="shrink-0 text-ink-muted">{t(`drive.detail.via.${o.via}`)}</span>
              <span className="num w-[92px] shrink-0 text-right text-xs text-ink-muted">
                {formatDateTime(o.at, i18n.language)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!all && history.length > HISTORY_PREVIEW && (
        <button
          type="button"
          aria-controls={listId}
          className={`${ghostButton} self-start`}
          onClick={() => setAll(true)}
        >
          {t("drive.detail.showAll", { count: history.length })}
        </button>
      )}
      <p className="text-xs text-ink-faint">{t("drive.detail.historyNote")}</p>
    </Section>
  );
}
