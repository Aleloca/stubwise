import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useAddGoogleFile,
  usePinnedProjects,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import type { Project } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { hasModKey } from "../../platform/platform";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CheckGlyph } from "./glyphs";
import { PickerNote, PickerSearch, optionClass, useListKeys } from "./Picker";

// «Which project?» (shape drive-google.md §3, A5): un file Google fuori dai
// progetti, aperto dalla ricerca del Drive o da ⌘K (Task 8), si apre su
// Google — avviso, nessun browser — e POI Stubwise chiede a quale progetto
// aggiungerlo. Non è mai un muro: «Not now» chiude e il file resta aperto.
// Solo i progetti dove chi guarda ha `drive.upload`, i fissati in testa;
// senza progetti idonei il dialogo non compare e l'avviso lo dice. Un
// progetto solo è già scelto. Chi lo apre chiama `openGoogleOutsideFile`;
// il dialogo vive nel layout (`WhichProjectHost`) e si chiude al cambio di
// persona.

/** Il file Google fuori dai progetti appena aperto: quanto basta per aggiungerlo. */
export interface OutsideGoogleFile {
  googleFileId: string;
  name: string;
}

let pending: OutsideGoogleFile | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Apre un file Google fuori dai progetti: avviso «Opened in Google Drive»
 * (nel prototipo nessun browser; un file senza riferimento non ha aperture
 * da contare) e poi «Which project?». Riusata dalla ricerca (Task 8).
 */
export function openGoogleOutsideFile(file: OutsideGoogleFile): void {
  pending = { ...file };
  seq += 1;
  emit();
}

/** Chiude la domanda (Not now, Esc, cambio di persona, test). */
export function closeWhichProject(): void {
  if (!pending) return;
  pending = null;
  emit();
}

// Cambio di persona: la domanda di chi guardava prima non resta in sospeso.
onBeforePersonaChange(closeWhichProject);

function usePending(): OutsideGoogleFile | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}

/** I progetti dove chi guarda può aggiungere file: i fissati prima, poi per codice. */
export function useUploadProjects(): Project[] | undefined {
  const { viewer } = useViewer();
  const projects = useProjects().data;
  const pinned = usePinnedProjects().data;
  return useMemo(() => {
    if (!projects || !pinned) return undefined;
    const allowed = projects.filter((p) => can(viewer, "drive.upload", p.id));
    const order = new Map(pinned.map((p, i) => [p.id, i]));
    return [...allowed].sort((a, b) => {
      const pa = order.get(a.id);
      const pb = order.get(b.id);
      if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity);
      return a.code.localeCompare(b.code);
    });
  }, [projects, pinned, viewer]);
}

/** Montato dal layout. */
export function WhichProjectHost() {
  const me = useSessionPersonId();
  const file = usePending();
  if (!file) return null;
  return <WhichProject key={`${me}:${seq}`} file={file} onClose={closeWhichProject} />;
}

/** Oltre questo numero di progetti compare il campo di ricerca. */
const SEARCH_FROM = 8;

function WhichProject({ file, onClose }: { file: OutsideGoogleFile; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const eligible = useUploadProjects();
  const add = useAddGoogleFile();
  const announced = useRef(false);

  // Prima l'apertura (sempre), poi la domanda — o, senza progetti idonei, solo l'avviso.
  useEffect(() => {
    if (!eligible || announced.current) return;
    announced.current = true;
    if (eligible.length === 0) {
      toast.show(t("drive.which.none"));
      onClose();
      return;
    }
    toast.show(t("drive.google.opened"));
  }, [eligible, toast, t, onClose]);

  if (!eligible || eligible.length === 0) return null;

  const confirm = (project: Project) => {
    if (add.isPending) return;
    add.mutate(
      { projectId: project.id, googleFileId: file.googleFileId },
      {
        onSuccess: (row) => {
          onClose();
          toast.show(t("drive.which.added", { code: project.code, fileCode: row.code }), {
            action: {
              label: t("drive.which.open"),
              run: () =>
                void navigate({
                  to: "/p/$code/$section",
                  params: { code: project.code, section: "drive" },
                  search: { file: row.code } as never,
                }),
            },
          });
        },
      },
    );
  };

  return (
    <ProjectChoiceDialog
      title={t("drive.which.title", { name: file.name })}
      description={t("drive.which.body")}
      confirmLabel={t("drive.which.confirm")}
      eligible={eligible}
      pending={add.isPending}
      failed={add.isError ? t("drive.google.failed") : null}
      onConfirm={confirm}
      onClose={onClose}
    />
  );
}

/**
 * La domanda «in quale progetto?» (forma del dialogo «Which project?»):
 * l'elenco dei progetti idonei (i fissati in testa), uno solo già scelto,
 * il campo di ricerca oltre 8, la nota «Everyone in the project will be able
 * to read it», «Not now» e la conferma (anche ⌘↵). La usano «Which
 * project?» di un file Google e «Save to Drive» di un allegato della Chat.
 */
export function ProjectChoiceDialog({
  title,
  description,
  confirmLabel,
  eligible,
  pending,
  failed,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  eligible: Project[];
  pending: boolean;
  /** Il messaggio di un tentativo fallito, o `null`. */
  failed: string | null;
  onConfirm: (project: Project) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<string | undefined>(
    eligible.length === 1 ? eligible[0]!.id : undefined,
  );
  const keys = useListKeys();
  const noteId = useId();

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? eligible.filter((p) => `${p.code} ${p.name}`.toLowerCase().includes(needle))
    : eligible;

  const confirm = () => {
    const project = eligible.find((p) => p.id === chosen);
    if (project && !pending) onConfirm(project);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && hasModKey(e)) {
      e.preventDefault();
      confirm();
    }
  };

  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("drive.which.notNow")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!chosen || pending}
            aria-describedby={noteId}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
        {eligible.length > SEARCH_FROM && (
          <PickerSearch
            label={t("drive.which.search")}
            value={q}
            onChange={setQ}
            onKeyDown={keys.enterFromSearch}
          />
        )}
        {shown.length === 0 ? (
          <PickerNote>{t("drive.which.noMatch", { q: q.trim() })}</PickerNote>
        ) : (
          <div
            ref={keys.list}
            role="listbox"
            aria-label={t("drive.which.list")}
            onKeyDown={keys.onListKeyDown}
            className="-mx-1 flex max-h-[296px] flex-col gap-px overflow-y-auto px-1"
          >
            {shown.map((p, i) => {
              const selected = p.id === chosen;
              // Un solo posto nella tastiera, sempre: la scelta se è in vista, altrimenti la prima.
              const stop = i === Math.max(0, shown.findIndex((x) => x.id === chosen));
              return (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={selected}
                  tabIndex={stop ? 0 : -1}
                  data-autofocus={eligible.length <= SEARCH_FROM && stop ? "" : undefined}
                  onClick={() => setChosen(p.id)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" && !hasModKey(e)) || e.key === " ") {
                      e.preventDefault();
                      setChosen(p.id);
                    }
                  }}
                  className={optionClass}
                >
                  <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em]">
                    {p.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-muted">{p.name}</span>
                  {selected && (
                    <span className="text-ink">
                      <CheckGlyph />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p id={noteId} className="text-sm text-ink">
          {t("drive.which.note")}
        </p>
        {failed && (
          <p role="alert" className="text-sm text-critical">
            {failed}
          </p>
        )}
      </div>
    </Dialog>
  );
}
