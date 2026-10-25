import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useGoogleAccount, useGoogleFolders, useLinkFolder, usePeople } from "../../data/queries";
import type { GoogleFolderChoice, Project } from "../../data/types";
import { hasModKey } from "../../platform/platform";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { ConnectGoogleStep } from "./GoogleAccountCard";
import { CheckGlyph, FolderGlyph } from "./glyphs";
import { PickerNote, PickerSearch, PickerSkeleton, optionClass, useListKeys } from "./Picker";

// «Link a Google folder» (shape drive-google.md §3, A2): un navigatore di
// cartelle simulato dentro Stubwise, con le briciole («My Drive › Clienti»)
// e la ricerca per nome. Doppio clic (o Enter) entra in una cartella che ne
// contiene altre, clic (o Enter) sceglie una cartella da collegare, ⌫ torna
// su. Le cartelle già collegate al progetto si leggono ma non si scelgono.
// Il momento focale: sotto la scelta, sempre visibile e legata al bottone
// (`aria-describedby`), la frase che dice chi leggerà cosa — tutti i membri
// del progetto, anche chi su Google non può aprirla — e con quale account.
// Senza account collegato il dialogo parte dal passo «Connect…».

const ROOT = ["My Drive"];

/** Una riga del navigatore: una cartella da collegare o una che ne contiene altre. */
type Entry =
  | { kind: "folder"; folder: GoogleFolderChoice }
  | { kind: "dir"; name: string; path: string[]; folders: number };

const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);
const startsWith = (a: readonly string[], prefix: readonly string[]) =>
  prefix.every((s, i) => a[i] === s);

/** Cosa c'è dentro `path`: prima le cartelle che ne contengono altre, poi quelle da collegare. */
function entriesAt(folders: GoogleFolderChoice[], path: string[]): Entry[] {
  const dirs = new Map<string, number>();
  for (const f of folders) {
    if (f.path.length > path.length && startsWith(f.path, path)) {
      const name = f.path[path.length]!;
      dirs.set(name, (dirs.get(name) ?? 0) + 1);
    }
  }
  const own = folders.filter((f) => samePath(f.path, path));
  return [
    ...[...dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, n]): Entry => ({ kind: "dir", name, path: [...path, name], folders: n })),
    ...own
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder): Entry => ({ kind: "folder", folder })),
  ];
}

export function LinkFolderDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation();
  const account = useGoogleAccount();
  const connected = account.data?.status === "connected";
  return (
    <Dialog
      title={t("drive.link.title", { code: project.code })}
      onClose={onClose}
      width={560}
      footer={
        connected ? undefined : (
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("drive.link.cancel")}
          </button>
        )
      }
    >
      {account.isPending ? (
        <PickerSkeleton />
      ) : connected ? (
        <FolderPicker project={project} email={account.data!.email} onClose={onClose} />
      ) : (
        <ConnectGoogleStep />
      )}
    </Dialog>
  );
}

function FolderPicker({
  project,
  email,
  onClose,
}: {
  project: Project;
  email: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const people = usePeople().data;
  const folders = useGoogleFolders(project.id);
  const link = useLinkFolder();
  const keys = useListKeys();
  const warningId = useId();
  const [path, setPath] = useState<string[]>(ROOT);
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<GoogleFolderChoice | null>(null);

  // Le persone del progetto (Claude non conta: non è una persona che legge).
  const memberCount = useMemo(
    () =>
      project.memberIds.filter((id) => !people?.find((p) => p.id === id)?.isClaude).length,
    [project.memberIds, people],
  );

  const needle = q.trim().toLowerCase();
  const entries: Entry[] = useMemo(() => {
    const all = folders.data ?? [];
    if (!needle) return entriesAt(all, path);
    return all
      .filter((f) => f.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ kind: "folder", folder }));
  }, [folders.data, path, needle]);

  const enter = (to: string[]) => {
    setPath(to);
    setQ("");
  };
  const pick = (folder: GoogleFolderChoice) => {
    if (!folder.alreadyLinked) setChosen(folder);
  };
  const confirm = () => {
    if (!chosen || link.isPending) return;
    link.mutate(
      { projectId: project.id, googleFolderId: chosen.googleFolderId },
      {
        onSuccess: (view) => {
          onClose();
          toast.show(t("drive.link.linked", { name: view.name, count: view.fileCount }));
        },
      },
    );
  };

  const onEntryKey = (e: KeyboardEvent<HTMLElement>, entry: Entry) => {
    if (e.key === "Enter" && !hasModKey(e)) {
      e.preventDefault();
      if (entry.kind === "dir") enter(entry.path);
      else pick(entry.folder);
    } else if (e.key === " " && entry.kind === "folder") {
      e.preventDefault();
      pick(entry.folder);
    } else if (e.key === "Backspace" && path.length > 1 && !needle) {
      e.preventDefault();
      enter(path.slice(0, -1));
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && hasModKey(e)) {
      e.preventDefault();
      confirm();
    }
  };

  let list;
  if (folders.isError) {
    list = (
      <PickerNote
        action={
          <button type="button" className={quietButton} onClick={() => void folders.refetch()}>
            {t("drive.link.retry")}
          </button>
        }
      >
        {t("drive.link.error")}
      </PickerNote>
    );
  } else if (folders.isPending) {
    list = <PickerSkeleton />;
  } else if (entries.length === 0) {
    list = <PickerNote>{needle ? t("drive.link.noMatch", { q: q.trim() }) : t("drive.link.empty")}</PickerNote>;
  } else {
    list = (
      <div
        ref={keys.list}
        role="listbox"
        aria-label={t("drive.link.list")}
        onKeyDown={keys.onListKeyDown}
        className="-mx-1 flex h-[236px] flex-col gap-px overflow-y-auto px-1"
      >
        {entries.map((entry, i) => {
          const disabled = entry.kind === "folder" && entry.folder.alreadyLinked;
          const selected = entry.kind === "folder" && entry.folder.googleFolderId === chosen?.googleFolderId;
          const meta =
            entry.kind === "dir"
              ? t("drive.link.folders", { count: entry.folders })
              : entry.folder.alreadyLinked
                ? t("drive.link.already")
                : needle
                  ? `${entry.folder.path.join(" › ")} · ${t("drive.link.files", { count: entry.folder.fileCount })}`
                  : t("drive.link.files", { count: entry.folder.fileCount });
          return (
            <div
              key={entry.kind === "dir" ? `dir:${entry.name}` : entry.folder.googleFolderId}
              role="option"
              aria-selected={selected}
              aria-disabled={disabled || undefined}
              tabIndex={selected || (!chosen && i === 0) ? 0 : -1}
              onClick={() => (entry.kind === "folder" ? pick(entry.folder) : undefined)}
              onDoubleClick={() => (entry.kind === "dir" ? enter(entry.path) : undefined)}
              onKeyDown={(e) => onEntryKey(e, entry)}
              className={optionClass}
            >
              <span className={disabled ? "text-ink-faint" : "text-ink-muted"}>
                <FolderGlyph />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {entry.kind === "dir" ? entry.name : entry.folder.name}
              </span>
              {selected && (
                <span className="text-ink">
                  <CheckGlyph />
                </span>
              )}
              <span className="num max-w-[50%] shrink-0 truncate text-sm text-ink-faint">{meta}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex min-w-0 items-center gap-3">
        <nav aria-label={t("drive.link.crumbs")} className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center text-sm">
            {path.map((seg, i) => {
              const last = i === path.length - 1;
              return (
                <li key={`${i}:${seg}`} className="flex min-w-0 items-center">
                  {i > 0 && (
                    <span aria-hidden="true" className="px-1 text-ink-faint">
                      ›
                    </span>
                  )}
                  {last && !needle ? (
                    <span aria-current="location" className="truncate font-semibold text-ink">
                      {seg}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => enter(path.slice(0, i + 1))}
                      className="truncate rounded-sm px-0.5 text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink hover:underline"
                    >
                      {seg}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="w-52 shrink-0">
          <PickerSearch
            label={t("drive.link.search")}
            value={q}
            onChange={setQ}
            onKeyDown={keys.enterFromSearch}
          />
        </div>
      </div>
      <div className="border-y border-rule py-1">{list}</div>
      <p id={warningId} className={`min-h-[60px] text-md ${chosen ? "text-ink" : "text-ink-muted"}`}>
        {chosen
          ? t("drive.link.warning", {
              code: project.code,
              count: memberCount,
              folder: chosen.name,
              email,
            })
          : t("drive.link.pick")}
      </p>
      {link.isError && (
        <p role="alert" className="text-sm text-critical">
          {t("drive.google.failed")}
        </p>
      )}
      <div className="-mx-5 -mb-5 flex items-center justify-end gap-2 border-t border-rule px-5 py-3">
        <p className="mr-auto hidden text-xs text-ink-faint sm:block">{t("drive.link.keys")}</p>
        <button type="button" className={secondaryButton} onClick={onClose}>
          {t("drive.link.cancel")}
        </button>
        <button
          type="button"
          className={`${primaryButton} disabled:opacity-40`}
          disabled={!chosen || link.isPending}
          aria-describedby={warningId}
          aria-keyshortcuts="Meta+Enter"
          onClick={confirm}
        >
          {t("drive.link.confirm")}
        </button>
      </div>
    </div>
  );
}
