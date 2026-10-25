import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useDriveFiles,
  useFolderLinks,
  usePeople,
  useProject,
  useProjects,
  useSetDriveHidden,
  useSyncFolder,
  useUnlinkFolder,
} from "../../data/queries";
import type {
  DriveFileRow,
  DriveFilters,
  DriveSort,
  FolderLinkView,
  Project,
} from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { hasModKey } from "../../platform/platform";
import { Dialog } from "../../tasks-ui/Dialog";
import { Chip } from "../../tasks-ui/FilterBar";
import { MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { MoreIcon, ghostButton } from "../task/parts";
import { Chevron, MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { AddFromGoogleDialog } from "./AddFromGoogleDialog";
import { ExpiredLinkBanners } from "./DriveBanners";
import { DriveList, DriveSkeleton } from "./DriveList";
import type { RowActions } from "./DriveRow";
import {
  DRIVE_SORTS,
  DRIVE_SOURCES,
  DRIVE_TYPES,
  driveFiltersFrom,
  hasDriveFilter,
  previewKind,
  type DriveSearch,
} from "./driveFilters";
import { useDriveOpeners } from "./FilePreview";
import { GoogleDriveGlyph, HiddenGlyph, UploadGlyph } from "./glyphs";
import { LinkFolderDialog } from "./LinkFolderDialog";
import {
  DropZone,
  UploadAnnouncer,
  UploadingGroup,
  useFilePicker,
  useUploads,
} from "./UploadZone";

// Il Drive (shape drive.md): la sezione di un progetto (`#/p/AUD/drive`) o la
// destinazione con i file di tutti i progetti che vedo (`#/drive`). Testata
// (h1 col conteggio, «Upload»), barra (ordinamento e filtri, tutti
// nell'indirizzo), elenco. Il dettaglio (`?file=`) e l'anteprima intera
// stanno sopra, montati dall'`AppLayout`. Google (Task 7, shape
// drive-google.md): «Add from Google Drive» (`drive.upload`) accanto a
// «Upload», «Link a Google folder» nel «⋯» della testata (`drive.manage`),
// il «⋯» di ogni cartella (apri, sincronizza, copia, scollega), la fascia
// del collegamento scaduto (solo chi gestisce) e il filtro «Hidden» (solo
// chi gestisce: per gli altri `?hidden=1` non vale). I dialoghi vivono qui:
// la pagina è legata alla persona, e un cambio di persona li chiude. La
// ricerca (⌘F) arriva dopo.

type PageSearch = DriveSearch & { file?: string };

/** Quanto resta segnata come «appena arrivata» una riga caricata. */
const ARRIVE_MS = 600;

export function DrivePage({ projectCode }: { projectCode?: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as PageSearch;
  const global = !projectCode;
  const projectQuery = useProject(projectCode ?? "");
  const project = projectCode ? (projectQuery.data ?? undefined) : undefined;
  const projects = useProjects().data;
  const people = usePeople().data;

  const codeToId = useCallback(
    // Un progetto che non vedo (o che non esiste) non filtra «tutto»: non trova niente.
    (code: string) => projects?.find((p) => p.code === code)?.id ?? `none:${code}`,
    [projects],
  );
  // Chi gestisce il Drive (qui, o in almeno un progetto nella destinazione) ha il filtro «Hidden».
  const canManage = project
    ? can(viewer, "drive.manage", project.id)
    : (projects ?? []).some((p) => can(viewer, "drive.manage", p.id));
  const filters: DriveFilters = driveFiltersFrom(search, { projectId: project?.id, codeToId });
  if (!canManage) delete filters.hidden;
  const hiddenView = filters.hidden === true;
  const base: DriveFilters = project ? { projectId: project.id, sort: filters.sort } : { sort: filters.sort };
  const enabled = global ? !!projects : !!project;
  const filesQuery = useDriveFiles(filters, { enabled });
  const allQuery = useDriveFiles(base, { enabled });
  const hiddenQuery = useDriveFiles({ ...base, hidden: true }, { enabled: enabled && canManage });
  const folders = useFolderLinks(project?.id ?? "").data ?? [];
  const rows = enabled ? filesQuery.data : undefined;
  const canAddGoogle = !!project && can(viewer, "drive.upload", project.id);

  const peopleNames = useMemo(() => new Map((people ?? []).map((p) => [p.id, p.name])), [people]);
  const projectNames = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p.name])),
    [projects],
  );
  // Dove si può caricare (solo `drive.upload`); il progetto filtrato, se c'è, per primo.
  const uploadTargets = useMemo(() => {
    const list = (projects ?? []).filter((p) => can(viewer, "drive.upload", p.id));
    const first = global ? search.prj : undefined;
    return first ? [...list.filter((p) => p.code === first), ...list.filter((p) => p.code !== first)] : list;
  }, [projects, viewer, global, search.prj]);
  const canUpload = project ? can(viewer, "drive.upload", project.id) : uploadTargets.length > 0;

  function setSearch(patch: Partial<PageSearch>, replace = false) {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace,
    } as never);
  }
  const clearFilters = () =>
    setSearch(
      { type: undefined, source: undefined, addedBy: undefined, prj: undefined, hidden: undefined },
      true,
    );

  // Le righe appena caricate prendono il loro posto (200 ms), poi tornano normali.
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const arriveTimers = useRef<number[]>([]);
  useEffect(() => () => arriveTimers.current.forEach((id) => window.clearTimeout(id)), []);
  const uploads = useUploads((row) => {
    setArrived((s) => new Set(s).add(row.id));
    arriveTimers.current.push(
      window.setTimeout(
        () =>
          setArrived((s) => {
            const n = new Set(s);
            n.delete(row.id);
            return n;
          }),
        ARRIVE_MS,
      ),
    );
  });

  // Dove va un caricamento: il progetto della sezione; nella destinazione lo
  // si chiede SEMPRE (A5) — dal menu di «Upload» o, trascinando, dal dialogo.
  const target = useRef<string | undefined>(undefined);
  const picker = useFilePicker((files) => {
    const pid = project?.id ?? target.current;
    if (pid) uploads.start(files, pid);
  });
  const [choosing, setChoosing] = useState<File[] | null>(null);
  const uploadButton = useRef<HTMLSpanElement>(null);
  const pickFor = (p: Project) => {
    target.current = p.id;
    picker.open();
  };
  const onDropped = (files: File[]) => {
    if (project) uploads.start(files, project.id);
    else setChoosing(files);
  };
  const upload = () => {
    if (project) picker.open();
    else uploadButton.current?.querySelector("button")?.click();
  };

  // ⌘⇧U: Upload, come il bottone.
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    if (!canUpload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !hasModKey(e) || !e.shiftKey || e.key.toLowerCase() !== "u") return;
      e.preventDefault();
      uploadRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canUpload]);

  const openers = useDriveOpeners();
  const toast = useToast();
  const setHidden = useSetDriveHidden();
  const syncFolder = useSyncFolder();
  const unlinkFolder = useUnlinkFolder();
  const [googleDialog, setGoogleDialog] = useState<"link" | "add" | null>(null);
  const [unlinking, setUnlinking] = useState<FolderLinkView | null>(null);

  // Il «⋯» di una cartella collegata: apri (avviso), sincronizza e scollega (chi gestisce), copia.
  const folderMenu = (link: FolderLinkView) => (
    <MenuButton
      menuLabel={t("drive.google.folderActions", { name: link.name })}
      ariaLabel={t("drive.google.folderActions", { name: link.name })}
      title={t("drive.google.folderActions", { name: link.name })}
      align="right"
      className={`${ghostButton} w-7 justify-center px-0 opacity-70 group-hover/folder:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100`}
      label={<MoreIcon />}
    >
      {(close) => {
        const item = (label: string, run: () => void) => (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={itemClass}
            onClick={() => {
              close();
              run();
            }}
          >
            {label}
          </button>
        );
        const manage = project ? can(viewer, "drive.manage", project.id) : false;
        return (
          <>
            {item(t("drive.google.open"), () => toast.show(t("drive.google.folderOpened", { name: link.name })))}
            {manage &&
              link.status === "ok" &&
              item(t("drive.google.syncNow"), () =>
                syncFolder.mutate(link.id, {
                  onSuccess: (view) =>
                    toast.show(
                      view.status === "expired"
                        ? t("drive.google.syncExpired", { name: view.name })
                        : t("drive.google.synced", { name: view.name }),
                    ),
                  onError: () => toast.error(t("drive.google.failed")),
                }),
              )}
            {item(t("drive.google.copyFolderLink"), () => {
              void navigator.clipboard
                ?.writeText(`https://drive.google.com/drive/folders/${link.googleFolderId}`)
                .catch(() => {});
              toast.show(t("drive.google.folderLinkCopied"));
            })}
            {manage && item(t("drive.google.unlink"), () => setUnlinking(link))}
          </>
        );
      }}
    </MenuButton>
  );
  const actions = useMemo<RowActions>(
    () => ({
      onOpen: (row) =>
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({ ...prev, file: row.code }),
        } as never),
      onPrimary: (row, view) => {
        if (row.source === "google") {
          if (row.unavailable === null) openers.google(row);
          // Non disponibile: lo dice, invece di non fare nulla.
          else toast.show(t(`drive.row.cantOpen.${row.unavailable}`, { code: row.code }));
          return;
        }
        if (previewKind(row)) {
          openers.preview(row, (view ?? [row]).filter((r) => previewKind(r)));
          return;
        }
        // Senza anteprima: il dettaglio, dove l'azione primaria è «Download».
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({ ...prev, file: row.code }),
        } as never);
      },
      onDownload: (row) => openers.download(row),
      onShowAgain: (row) =>
        setHidden.mutate(
          { id: row.id, hidden: false },
          {
            onSuccess: () => toast.show(t("drive.hidden.shown", { code: row.code })),
            onError: () => toast.error(t("drive.detail.failed")),
          },
        ),
    }),
    [navigate, openers, toast, t, setHidden],
  );
  const onMoveOpen = useCallback(
    (row: DriveFileRow) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, file: row.code }),
        replace: true,
      } as never),
    [navigate],
  );

  const total = allQuery.data?.length;
  const title = t("drive.title");
  const scopeName = project?.name ?? "";

  let body: ReactNode;
  if (filesQuery.isError || allQuery.isError) {
    body = (
      <PageError
        message={t("drive.states.error")}
        onRetry={() => {
          void filesQuery.refetch();
          void allQuery.refetch();
        }}
      />
    );
  } else if (!rows || (projectCode && !project)) {
    body = <DriveSkeleton />;
  } else if (rows.length === 0 && hiddenView) {
    body = (
      <PageEmpty
        title={t("drive.hidden.emptyTitle")}
        body={t("drive.hidden.emptyBody")}
        action={
          <button type="button" className={secondaryButton} onClick={clearFilters}>
            {t("drive.filters.clear")}
          </button>
        }
      />
    );
  } else if (rows.length === 0 && (total ?? 0) > 0) {
    body = (
      <>
        <UploadingGroup uploads={uploads} />
        <PageEmpty
          title={t("drive.states.noMatchTitle")}
          action={
            <button type="button" className={secondaryButton} onClick={clearFilters}>
              {t("drive.filters.clear")}
            </button>
          }
        />
      </>
    );
  } else if (rows.length === 0) {
    body = (
      <>
        <UploadingGroup uploads={uploads} />
        {global ? (
          <PageEmpty title={t("drive.states.emptyAllTitle")} body={t("drive.states.emptyAll")} />
        ) : canUpload ? (
          <div className="flex max-w-[60ch] flex-col items-start gap-2 px-4 py-10">
            <h2 className="text-lg font-semibold text-ink">
              {t("drive.states.emptyTitle", { code: project?.code })}
            </h2>
            <p className="text-md text-ink-muted">{t("drive.states.emptyCan")}</p>
            <div className="mt-2 flex items-center gap-2">
              {/* Il primario resta «Upload» in testata: qui il secondario, una sola azione piena. */}
              <button type="button" className={secondaryButton} onClick={upload}>
                {t("drive.states.uploadFirst")}
              </button>
              <button type="button" className={quietButton} onClick={() => setGoogleDialog("add")}>
                {t("drive.google.addFrom")}
              </button>
              {canManage && (
                <button type="button" className={quietButton} onClick={() => setGoogleDialog("link")}>
                  {t("drive.google.linkFolder")}
                </button>
              )}
            </div>
            <p className="text-sm text-ink-faint">{t("drive.states.emptyDrop")}</p>
          </div>
        ) : (
          <PageEmpty
            title={t("drive.states.emptyTitle", { code: project?.code })}
            body={t("drive.states.emptyCant")}
          />
        )}
      </>
    );
  } else {
    body = (
      <DriveList
        rows={rows}
        global={global}
        label={global ? t("drive.listAll") : t("drive.list", { name: scopeName })}
        folders={hiddenView ? [] : folders}
        folderMenu={hiddenView ? undefined : folderMenu}
        sort={filters.sort}
        onSort={(sort) => setSearch({ sort: sort === "most_used" ? undefined : sort }, true)}
        openCode={search.file}
        personId={viewer.personId}
        storageScope={project?.id ?? "all"}
        peopleNames={peopleNames}
        projectNames={projectNames}
        arrived={arrived}
        actions={actions}
        onMoveOpen={onMoveOpen}
        top={<UploadingGroup uploads={uploads} />}
      />
    );
  }

  return (
    <DropZone
      enabled={canUpload}
      label={project ? t("drive.uploads.drop", { code: project.code }) : t("drive.uploads.dropAny")}
      onFiles={onDropped}
    >
    <section className="flex h-full min-h-0 flex-col" data-drive-page={project?.code ?? "all"}>
      <header className="page-header flex shrink-0 flex-col gap-3 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold text-ink">{title}</h1>
          {total !== undefined && (
            <span className="num text-lg text-ink-faint">
              <span aria-hidden="true">{total}</span>
              <span className="sr-only">{t("drive.count", { count: total })}</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 self-center">
            {canAddGoogle && (
              <button type="button" className={secondaryButton} onClick={() => setGoogleDialog("add")}>
                <GoogleDriveGlyph />
                {t("drive.google.addFrom")}
              </button>
            )}
            {canUpload && project && (
              <button
                type="button"
                className={primaryButton}
                onClick={upload}
                aria-keyshortcuts="Meta+Shift+U"
              >
                <UploadGlyph />
                {t("drive.upload")}
              </button>
            )}
            {canUpload && !project && (
              <span ref={uploadButton} className="inline-flex">
                <MenuButton
                    menuLabel={t("drive.uploadWhere")}
                    align="right"
                    className={primaryButton}
                    label={
                      <>
                        <UploadGlyph />
                        {t("drive.upload")}
                      </>
                    }
                  >
                    {(close) => (
                      <MenuGroup label={t("drive.uploadWhere")}>
                        {uploadTargets.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            className={itemClass}
                            onClick={() => {
                              close();
                              pickFor(p);
                            }}
                          >
                            <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em]">
                              {p.code}
                            </span>
                            <span className="min-w-0 truncate text-ink-muted">{p.name}</span>
                          </button>
                        ))}
                      </MenuGroup>
                    )}
                  </MenuButton>
              </span>
            )}
            {project && canManage && (
              <MenuButton
                menuLabel={t("drive.google.more")}
                ariaLabel={t("drive.google.more")}
                title={t("drive.google.more")}
                align="right"
                className={`${ghostButton} h-8 w-8 justify-center px-0`}
                label={<MoreIcon />}
              >
                {(close) => (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      close();
                      setGoogleDialog("link");
                    }}
                  >
                    {t("drive.google.linkFolder")}
                  </button>
                )}
              </MenuButton>
            )}
          </div>
        </div>
        {project && <ExpiredLinkBanners project={project} folders={folders} />}
        <DriveToolbar
          search={search}
          sort={filters.sort}
          setSearch={setSearch}
          clearFilters={clearFilters}
          global={global}
          allRows={allQuery.data}
          peopleNames={peopleNames}
          projects={projects}
          me={viewer.personId}
          hiddenCount={canManage ? hiddenQuery.data?.length : undefined}
        />
      </header>
      <div data-drive-body className="min-h-0 flex-1 overflow-auto border-t border-rule">
        {body}
      </div>
      {picker.element}
      <UploadAnnouncer uploads={uploads} />
      {project && googleDialog === "link" && (
        <LinkFolderDialog project={project} onClose={() => setGoogleDialog(null)} />
      )}
      {project && googleDialog === "add" && (
        <AddFromGoogleDialog project={project} onClose={() => setGoogleDialog(null)} />
      )}
      {project && unlinking && (
        <Dialog
          title={t("drive.unlink.title", { folder: unlinking.name, code: project.code })}
          description={t("drive.unlink.body", { count: unlinking.fileCount, code: project.code })}
          onClose={() => setUnlinking(null)}
          width={480}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setUnlinking(null)}>
                {t("drive.unlink.cancel")}
              </button>
              <button
                type="button"
                data-autofocus
                className="inline-flex h-8 shrink-0 items-center rounded-md bg-critical px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 disabled:opacity-40"
                disabled={unlinkFolder.isPending}
                onClick={() => {
                  const link = unlinking;
                  unlinkFolder.mutate(link.id, {
                    onSuccess: () => {
                      setUnlinking(null);
                      toast.show(t("drive.unlink.done", { name: link.name, code: project.code }));
                    },
                    onError: () => toast.error(t("drive.google.failed")),
                  });
                }}
              >
                {t("drive.unlink.confirm")}
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
      {choosing && (
        <Dialog
          title={t("drive.uploads.chooseTitle")}
          description={t("drive.uploads.chooseBody", { count: choosing.length })}
          onClose={() => setChoosing(null)}
          width={440}
          footer={
            <button type="button" className={secondaryButton} onClick={() => setChoosing(null)}>
              {t("drive.uploads.cancelChoice")}
            </button>
          }
        >
          <ul className="flex max-h-80 flex-col gap-px overflow-y-auto">
            {uploadTargets.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={itemClass}
                  onClick={() => {
                    const files = choosing;
                    setChoosing(null);
                    uploads.start(files, p.id);
                  }}
                >
                  <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em]">{p.code}</span>
                  <span className="min-w-0 truncate text-ink-muted">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </section>
    </DropZone>
  );
}

/**
 * La barra del Drive: «Sort: Most used ▾» e i filtri a gettone (Type,
 * Source, Added by e, nella destinazione, Project), «Clear filters» quando
 * ce n'è uno. Tutto nell'indirizzo: indietro torna alla vista di prima.
 */
function DriveToolbar({
  search,
  sort,
  setSearch,
  clearFilters,
  global,
  allRows,
  peopleNames,
  projects,
  me,
  hiddenCount,
}: {
  search: DriveSearch;
  sort: DriveSort;
  setSearch: (patch: Partial<DriveSearch>, replace?: boolean) => void;
  clearFilters: () => void;
  global: boolean;
  allRows: DriveFileRow[] | undefined;
  peopleNames: ReadonlyMap<string, string>;
  projects: Project[] | undefined;
  me: string;
  /** I nascosti (solo chi gestisce: per gli altri il filtro non c'è). */
  hiddenCount: number | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<"type" | "source" | "addedBy" | "prj" | null>(null);
  const set = (patch: Partial<DriveSearch>) => {
    setOpen(null);
    setSearch(patch, true);
  };
  // Chi ha aggiunto file, e i progetti che ne hanno: le scelte vengono dall'elenco intero.
  const adders = useMemo(() => {
    const ids = [...new Set((allRows ?? []).map((r) => r.addedById))];
    return ids
      .map((id) => ({ id, name: peopleNames.get(id) ?? t("drive.row.someone") }))
      .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)));
  }, [allRows, peopleNames, me, t]);
  const withFiles = useMemo(() => {
    const ids = new Set((allRows ?? []).map((r) => r.projectId));
    return (projects ?? []).filter((p) => ids.has(p.id));
  }, [allRows, projects]);

  const chip = (
    key: "type" | "source" | "addedBy" | "prj",
    name: string,
    summary: string | null,
    items: { value: string; label: ReactNode }[],
  ) => (
    <Chip
      name={name}
      summary={summary}
      open={open === key}
      onOpenChange={(o) => setOpen(o ? key : null)}
      onRemove={() => set({ [key]: undefined })}
    >
      <MenuGroup>
        {items.map((it) => (
          <RadioItem
            key={it.value}
            checked={search[key] === it.value}
            onSelect={() => set({ [key]: search[key] === it.value ? undefined : it.value })}
          >
            {it.label}
          </RadioItem>
        ))}
      </MenuGroup>
    </Chip>
  );

  const typeSummary = search.type && (DRIVE_TYPES as readonly string[]).includes(search.type)
    ? t(`drive.types.${search.type}`)
    : null;
  const sourceSummary = search.source && (DRIVE_SOURCES as readonly string[]).includes(search.source)
    ? t(`drive.sources.${search.source}`)
    : null;
  // Mai un id grezzo: una persona che non conosco è «someone».
  const adderSummary = search.addedBy
    ? (peopleNames.get(search.addedBy) ?? t("drive.row.someone"))
    : null;

  return (
    <div
      role="toolbar"
      aria-label={t("drive.commands")}
      className="flex flex-wrap items-center gap-x-2 gap-y-2"
    >
      <MenuButton
        menuLabel={t("drive.sort.label")}
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
        label={
          <>
            <span>{t("drive.sort.label")}:</span>
            <span className="font-medium text-ink">{t(`drive.sort.${sort}`)}</span>
            <Chevron />
          </>
        }
      >
        {(close) => (
          <MenuGroup>
            {DRIVE_SORTS.map((s) => (
              <RadioItem
                key={s}
                checked={s === sort}
                onSelect={() => {
                  close();
                  setSearch({ sort: s === "most_used" ? undefined : s }, true);
                }}
              >
                {t(`drive.sort.${s}`)}
              </RadioItem>
            ))}
          </MenuGroup>
        )}
      </MenuButton>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-rule" />
      {global &&
        chip(
          "prj",
          t("drive.filters.project"),
          search.prj ?? null,
          withFiles.map((p) => ({
            value: p.code,
            label: (
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="num text-xs font-semibold">{p.code}</span>
                <span className="truncate text-ink-muted">{p.name}</span>
              </span>
            ),
          })),
        )}
      {chip(
        "type",
        t("drive.filters.type"),
        typeSummary,
        DRIVE_TYPES.map((v) => ({ value: v, label: t(`drive.types.${v}`) })),
      )}
      {chip(
        "source",
        t("drive.filters.source"),
        sourceSummary,
        DRIVE_SOURCES.map((v) => ({ value: v, label: t(`drive.sources.${v}`) })),
      )}
      {chip(
        "addedBy",
        t("drive.filters.addedBy"),
        adderSummary,
        adders.map((p) => ({ value: p.id, label: p.name })),
      )}
      {hiddenCount !== undefined && (hiddenCount > 0 || search.hidden === "1") && (
        <button
          type="button"
          aria-pressed={search.hidden === "1"}
          aria-label={t("drive.hidden.chipLabel", { count: hiddenCount })}
          onClick={() => setSearch({ hidden: search.hidden === "1" ? undefined : "1" }, true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-rule-strong px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-pressed:border-ink/50 aria-pressed:bg-ink/10 aria-pressed:text-ink"
        >
          <HiddenGlyph />
          {t("drive.hidden.chip")}
          <span className="num text-ink-faint">{hiddenCount}</span>
        </button>
      )}
      {hasDriveFilter(search) && (
        <button type="button" className={quietButton} onClick={clearFilters}>
          {t("drive.filters.clear")}
        </button>
      )}
    </div>
  );
}
