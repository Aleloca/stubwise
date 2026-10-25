import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useDriveFiles,
  useFolderLinks,
  usePeople,
  useProject,
  useProjects,
} from "../../data/queries";
import type { DriveFileRow, DriveFilters, DriveSort, Project } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { hasModKey } from "../../platform/platform";
import { Dialog } from "../../tasks-ui/Dialog";
import { Chip } from "../../tasks-ui/FilterBar";
import { MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { Chevron, MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { DriveList } from "./DriveList";
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
import { UploadGlyph } from "./glyphs";
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
// stanno sopra, montati dall'`AppLayout`. La ricerca (⌘F) e Google
// («Add from Google Drive», le cartelle, i nascosti) arrivano dopo: qui
// restano i loro posti.

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
  const filters: DriveFilters = driveFiltersFrom(search, { projectId: project?.id, codeToId });
  const base: DriveFilters = project ? { projectId: project.id, sort: filters.sort } : { sort: filters.sort };
  const enabled = global ? !!projects : !!project;
  const filesQuery = useDriveFiles(filters, { enabled });
  const allQuery = useDriveFiles(base, { enabled });
  const folders = useFolderLinks(project?.id ?? "").data ?? [];
  const rows = enabled ? filesQuery.data : undefined;

  const peopleNames = useMemo(() => new Map((people ?? []).map((p) => [p.id, p.name])), [people]);
  const projectNames = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p.name])),
    [projects],
  );
  const uploadTargets = useMemo(
    () => (projects ?? []).filter((p) => can(viewer, "drive.upload", p.id)),
    [projects, viewer],
  );
  const filteredProject = global && search.prj ? uploadTargets.find((p) => p.code === search.prj) : undefined;
  const canUpload = project ? can(viewer, "drive.upload", project.id) : uploadTargets.length > 0;

  function setSearch(patch: Partial<PageSearch>, replace = false) {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace,
    } as never);
  }
  const clearFilters = () =>
    setSearch({ type: undefined, source: undefined, addedBy: undefined, prj: undefined }, true);

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

  // Dove va un caricamento: il progetto della sezione; nella destinazione
  // quello scelto (menu, dialogo) o quello filtrato, se ci si può caricare.
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
    else if (filteredProject) uploads.start(files, filteredProject.id);
    else if (uploadTargets.length === 1) uploads.start(files, uploadTargets[0]!.id);
    else setChoosing(files);
  };
  const upload = () => {
    if (project) picker.open();
    else if (filteredProject) pickFor(filteredProject);
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
    }),
    [navigate, openers],
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
    body = <PageSkeleton />;
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
        folders={folders}
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
                {filteredProject ? (
                  <button type="button" className={primaryButton} onClick={upload}>
                    <UploadGlyph />
                    {t("drive.upload")}
                  </button>
                ) : (
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
                )}
              </span>
            )}
          </div>
        </div>
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
        />
      </header>
      <DropZone
        enabled={canUpload}
        label={
          project
            ? t("drive.uploads.drop", { code: project.code })
            : filteredProject
              ? t("drive.uploads.drop", { code: filteredProject.code })
              : t("drive.uploads.dropAny")
        }
        onFiles={onDropped}
      >
        <div data-drive-body className="min-h-0 flex-1 overflow-auto border-t border-rule">
          {body}
        </div>
      </DropZone>
      {picker.element}
      <UploadAnnouncer uploads={uploads} />
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
      .map((id) => ({ id, name: peopleNames.get(id) ?? id }))
      .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)));
  }, [allRows, peopleNames, me]);
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
  const adderSummary = search.addedBy ? (peopleNames.get(search.addedBy) ?? search.addedBy) : null;

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
      {hasDriveFilter(search) && (
        <button type="button" className={quietButton} onClick={clearFilters}>
          {t("drive.filters.clear")}
        </button>
      )}
    </div>
  );
}
