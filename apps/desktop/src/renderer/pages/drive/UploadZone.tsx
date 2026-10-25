import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UPLOAD_LIMIT_BYTES } from "../../data/drive/content";
import { useUploadFiles } from "../../data/queries";
import type { DriveFileRow } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { ghostButton } from "../task/parts";
import { rememberBlob } from "./blobs";
import { previewKind } from "./driveFilters";
import { formatSize } from "./format";
import { ErrorGlyph } from "./glyphs";

// Il caricamento (shape drive.md §5): trascinando sulla pagina o da
// «Upload». Il renderer legge nome, tipo e dimensione veri del File; la
// barra d'avanzamento è simulata (nessun byte va da nessuna parte), poi il
// livello dati crea il riferimento (`uploadFiles`), che parte «Reading the
// content…». Oltre 100 MB la riga non parte; un nome già nel progetto
// diventa «(2)» con l'avviso «Kept both». Nessun lavoro nel processo main.

/** Quanto dura l'avanzamento simulato di un file (i test lo azzerano). */
export const UPLOAD_PACE = { ms: 1200 };
const TICK_MS = 80;

export interface UploadItem {
  key: number;
  name: string;
  sizeBytes: number;
  loaded: number;
  /** `saving` = la barra è piena e il livello dati sta creando il riferimento. */
  status: "uploading" | "saving" | "too_large" | "failed";
  projectId: string;
  file: File;
}

let nextKey = 1;

/**
 * I caricamenti di una pagina del Drive. Vivono con la pagina: cambiare
 * persona la rimonta, e i caricamenti a metà (timer compresi) se ne vanno.
 * `onUploaded` riceve la riga nuova (la pagina la segna come appena arrivata).
 */
export function useUploads(onUploaded?: (file: DriveFileRow) => void) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { mutateAsync } = useUploadFiles();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const timers = useRef(new Map<number, number>());
  const alive = useRef(true);
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;

  useEffect(() => {
    alive.current = true;
    const map = timers.current;
    return () => {
      alive.current = false;
      for (const id of map.values()) window.clearInterval(id);
      map.clear();
    };
  }, []);

  const patch = (key: number, p: Partial<UploadItem>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const drop = (key: number) => setItems((list) => list.filter((i) => i.key !== key));

  const save = useCallback(
    async (item: UploadItem) => {
      if (!alive.current) return;
      patch(item.key, { status: "saving", loaded: item.sizeBytes });
      try {
        const [result] = await mutateAsync({
          projectId: item.projectId,
          files: [
            {
              name: item.name,
              mime: item.file.type || "application/octet-stream",
              sizeBytes: item.sizeBytes,
            },
          ],
        });
        if (!alive.current) return;
        if (!result || result.error === "too_large" || !result.file) {
          patch(item.key, { status: "too_large" });
          return;
        }
        const row = result.file;
        const kind = previewKind(row);
        if (kind) await rememberBlob(row.id, item.file, kind);
        if (!alive.current) return;
        drop(item.key);
        uploaded.current?.(row);
        if (row.name !== item.name) {
          const kept = t("drive.uploads.keptBoth", { name: row.name });
          toast.show(kept);
          setAnnouncement(kept);
        } else {
          setAnnouncement(t("drive.uploads.done", { name: row.name, code: row.code }));
        }
      } catch {
        if (!alive.current) return;
        patch(item.key, { status: "failed" });
        setAnnouncement(`${item.name}: ${t("drive.uploads.failed")}`);
      }
    },
    [mutateAsync, t, toast],
  );

  const run = useCallback(
    (item: UploadItem) => {
      if (UPLOAD_PACE.ms <= 0) {
        void save(item);
        return;
      }
      const steps = Math.max(1, Math.round(UPLOAD_PACE.ms / TICK_MS));
      let step = 0;
      const id = window.setInterval(() => {
        step += 1;
        if (step >= steps) {
          window.clearInterval(id);
          timers.current.delete(item.key);
          void save(item);
          return;
        }
        patch(item.key, { loaded: Math.round((item.sizeBytes * step) / steps) });
      }, TICK_MS);
      timers.current.set(item.key, id);
    },
    [save],
  );

  /** Carica dei file nel Drive di un progetto: uno per riga, ciascuno col suo esito. */
  const start = useCallback(
    (files: readonly File[], projectId: string) => {
      const fresh: UploadItem[] = files.map((file) => ({
        key: nextKey++,
        name: file.name,
        sizeBytes: file.size,
        loaded: 0,
        status: file.size > UPLOAD_LIMIT_BYTES ? "too_large" : "uploading",
        projectId,
        file,
      }));
      setItems((list) => [...list, ...fresh]);
      const tooLarge = fresh.filter((i) => i.status === "too_large");
      if (tooLarge.length > 0) {
        setAnnouncement(
          tooLarge
            .map((i) => `${i.name}: ${t("drive.uploads.tooLarge", { size: formatSize(i.sizeBytes, i18n.language) })}`)
            .join(". "),
        );
      }
      for (const item of fresh) if (item.status === "uploading") run(item);
    },
    [run, t, i18n.language],
  );

  const cancel = (key: number) => {
    const id = timers.current.get(key);
    if (id !== undefined) window.clearInterval(id);
    timers.current.delete(key);
    drop(key);
  };
  const retry = (item: UploadItem) => {
    const again = { ...item, loaded: 0, status: "uploading" as const };
    patch(item.key, again);
    run(again);
  };

  return { items, start, cancel, retry, dismiss: drop, announcement };
}

export type Uploads = ReturnType<typeof useUploads>;

/**
 * Il gruppo UPLOADING in testa all'elenco: una riga per file, con nome,
 * «12.4 of 48 MB» e la barra d'inchiostro di 2 px («Cancel» al passaggio);
 * troppo grande o fallito con icona, parola e le sue scelte.
 */
export function UploadingGroup({ uploads }: { uploads: Uploads }) {
  const { t, i18n } = useTranslation();
  if (uploads.items.length === 0) return null;
  const size = (n: number) => formatSize(n, i18n.language);
  return (
    <section aria-label={t("drive.uploads.heading")} data-uploading className="border-b border-rule">
      <h2 className="heading-group flex h-9 items-end px-4 pb-1.5">{t("drive.uploads.heading")}</h2>
      <ul>
        {uploads.items.map((item) => (
          <li
            key={item.key}
            data-upload={item.name}
            className="group relative flex min-h-11 items-center gap-3 border-t border-rule px-4 py-1.5"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span title={item.name} className="truncate text-md text-ink">
                {item.name}
              </span>
              {item.status === "too_large" || item.status === "failed" ? (
                <span className="flex items-center gap-1.5 text-sm text-critical">
                  <ErrorGlyph />
                  {item.status === "too_large"
                    ? t("drive.uploads.tooLarge", { size: size(item.sizeBytes) })
                    : t("drive.uploads.failed")}
                </span>
              ) : (
                <span className="flex items-center gap-3">
                  <span
                    role="progressbar"
                    aria-label={t("drive.uploads.progressLabel", { name: item.name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((item.loaded / Math.max(1, item.sizeBytes)) * 100)}
                    className="relative h-0.5 max-w-80 flex-1 overflow-hidden rounded-full bg-ink/10"
                  >
                    <span
                      className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-[var(--duration-fast)] ease-linear"
                      style={{ width: `${(item.loaded / Math.max(1, item.sizeBytes)) * 100}%` }}
                    />
                  </span>
                  <span className="num shrink-0 text-xs text-ink-muted">
                    {t("drive.uploads.progress", {
                      loaded: size(item.loaded),
                      total: size(item.sizeBytes),
                    })}
                  </span>
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {item.status === "uploading" && (
                <button
                  type="button"
                  onClick={() => uploads.cancel(item.key)}
                  className={`${ghostButton} opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100`}
                >
                  {t("drive.uploads.cancel")}
                </button>
              )}
              {item.status === "failed" && (
                <button type="button" className={ghostButton} onClick={() => uploads.retry(item)}>
                  {t("drive.uploads.retry")}
                </button>
              )}
              {(item.status === "failed" || item.status === "too_large") && (
                <button type="button" className={ghostButton} onClick={() => uploads.dismiss(item.key)}>
                  {t("drive.uploads.dismiss")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Fine, errori e «Kept both», detti ai lettori di schermo (`polite`). */
export function UploadAnnouncer({ uploads }: { uploads: Uploads }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {uploads.announcement}
    </p>
  );
}

/** Il selettore dei file nascosto dietro «Upload»: `open()` lo apre. */
export function useFilePicker(onFiles: (files: File[]) => void) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      data-drive-file-input
      onChange={(e) => {
        const files = [...(e.currentTarget.files ?? [])];
        e.currentTarget.value = "";
        if (files.length > 0) onFiles(files);
      }}
    />
  );
  return { element, open: () => input.current?.click() };
}

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

/**
 * La pagina del Drive come zona di rilascio (A7): trascinando dei file
 * compare il velo con il contorno tratteggiato e «Drop to upload to AUD».
 * Senza `drive.upload` (`enabled` falso) il velo non c'è e il cursore dice
 * che non si può. Fuori dal Drive il trascinamento non fa nulla.
 */
export function DropZone({
  enabled,
  label,
  onFiles,
  children,
}: {
  enabled: boolean;
  label: string;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setOver(false);
  };
  return (
    <div
      data-drop-zone
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        if (enabled) setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = enabled ? "copy" : "none";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        reset();
        const files = [...e.dataTransfer.files];
        if (enabled && files.length > 0) onFiles(files);
      }}
    >
      {children}
      {over && (
        <div
          aria-hidden="true"
          data-drop-veil
          className="palette-backdrop pointer-events-none absolute inset-0 z-30 bg-ground/85"
        >
          <div className="absolute inset-2 grid place-items-center rounded-lg border-2 border-dashed border-rule-strong">
            <p className="text-lg font-semibold text-ink">{label}</p>
          </div>
        </div>
      )}
    </div>
  );
}
