import { useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAddGoogleFile, useGoogleAccount, useGoogleFiles } from "../../data/queries";
import type { GoogleFileChoice, Project } from "../../data/types";
import { hasModKey } from "../../platform/platform";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { ConnectGoogleStep } from "./GoogleAccountCard";
import { CheckGlyph, TypeGlyph } from "./glyphs";
import { modifiedLabel } from "./format";
import { PickerNote, PickerSearch, PickerSkeleton, optionClass, useListKeys } from "./Picker";

// «Add from Google Drive» (shape drive-google.md §3, A10): i file che il mio
// account Google vede, cercabili per nome, con le caselle (selezione
// multipla, Space spunta, ⌘Enter aggiunge). I file già in questo progetto si
// leggono ma non si scelgono («Already in AUD»); uno già in un ALTRO progetto
// diventa un riferimento nuovo, col suo codice. Nessun avviso di cartella,
// ma una riga sotto: tutti i membri potranno leggerli.

export function AddFromGoogleDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation();
  const account = useGoogleAccount();
  const connected = account.data?.status === "connected";
  return (
    <Dialog
      title={t("drive.add.title", { code: project.code })}
      onClose={onClose}
      width={640}
      footer={
        connected ? undefined : (
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("drive.add.cancel")}
          </button>
        )
      }
    >
      {account.isPending ? (
        <PickerSkeleton />
      ) : connected ? (
        <FilePicker project={project} onClose={onClose} />
      ) : (
        <ConnectGoogleStep />
      )}
    </Dialog>
  );
}

function FilePicker({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [q, setQ] = useState("");
  const files = useGoogleFiles(project.id, q.trim());
  const add = useAddGoogleFile();
  const keys = useListKeys();
  const noteId = useId();
  const [chosen, setChosen] = useState<GoogleFileChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const isChosen = (f: GoogleFileChoice) => chosen.some((c) => c.googleFileId === f.googleFileId);
  const toggle = (f: GoogleFileChoice) => {
    if (f.alreadyInProject) return;
    setChosen((list) =>
      isChosen(f) ? list.filter((c) => c.googleFileId !== f.googleFileId) : [...list, f],
    );
  };

  // Uno per volta: un file che non entra non ferma gli altri, e chi è entrato resta.
  const confirm = async () => {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    setFailed(false);
    let added = 0;
    const left: GoogleFileChoice[] = [];
    for (const f of chosen) {
      try {
        await add.mutateAsync({ projectId: project.id, googleFileId: f.googleFileId });
        added += 1;
      } catch {
        left.push(f);
      }
    }
    setBusy(false);
    if (added > 0) toast.show(t("drive.add.added", { count: added, code: project.code }));
    if (left.length === 0) onClose();
    else {
      setChosen(left);
      setFailed(true);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && hasModKey(e)) {
      e.preventDefault();
      void confirm();
    }
  };

  const rows = files.data ?? [];
  let list;
  if (files.isError) {
    list = (
      <PickerNote
        action={
          <button type="button" className={quietButton} onClick={() => void files.refetch()}>
            {t("drive.link.retry")}
          </button>
        }
      >
        {t("drive.link.error")}
      </PickerNote>
    );
  } else if (files.isPending) {
    list = <PickerSkeleton />;
  } else if (rows.length === 0) {
    list = <PickerNote>{q.trim() ? t("drive.add.noMatch", { q: q.trim() }) : t("drive.add.empty")}</PickerNote>;
  } else {
    list = (
      <div
        ref={keys.list}
        role="listbox"
        aria-label={t("drive.add.list")}
        aria-multiselectable="true"
        onKeyDown={keys.onListKeyDown}
        className="-mx-1 flex h-[288px] flex-col gap-px overflow-y-auto px-1"
      >
        {rows.map((f, i) => {
          const selected = isChosen(f);
          const disabled = f.alreadyInProject;
          return (
            <div
              key={f.googleFileId}
              role="option"
              aria-selected={selected}
              aria-disabled={disabled || undefined}
              tabIndex={i === 0 ? 0 : -1}
              onClick={() => toggle(f)}
              onKeyDown={(e) => {
                if (e.key === " " || (e.key === "Enter" && !hasModKey(e))) {
                  e.preventDefault();
                  toggle(f);
                }
              }}
              className={`${optionClass} aria-selected:bg-ink/6`}
            >
              {/* La casella: disegnata, non nativa (l'opzione è già il controllo). */}
              <span
                aria-hidden="true"
                className={`grid size-4 shrink-0 place-items-center rounded-[4px] border ${selected ? "border-ink bg-ink text-ground" : disabled ? "border-rule" : "border-rule-strong"}`}
              >
                {selected && <CheckGlyph />}
              </span>
              <span className={disabled ? "text-ink-faint" : "text-ink-muted"}>
                <TypeGlyph type={f.type} />
              </span>
              <span title={f.name} className="min-w-0 flex-1 truncate">
                {f.name}
              </span>
              <span className="num max-w-[45%] shrink-0 truncate text-sm text-ink-faint">
                {disabled
                  ? t("drive.add.already", { code: project.code })
                  : t("drive.add.meta", {
                      owner: f.owner,
                      date: modifiedLabel(f.modifiedAt, t, i18n.language),
                    })}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <PickerSearch
        label={t("drive.add.search")}
        value={q}
        onChange={setQ}
        onKeyDown={keys.enterFromSearch}
      />
      <div className="border-y border-rule py-1">{list}</div>
      <p id={noteId} className="text-md text-ink">
        {t("drive.add.note", { code: project.code })}
      </p>
      {failed && (
        <p role="alert" className="text-sm text-critical">
          {t("drive.google.failed")}
        </p>
      )}
      <div className="-mx-5 -mb-5 flex items-center justify-end gap-2 border-t border-rule px-5 py-3">
        <button type="button" className={secondaryButton} onClick={onClose}>
          {t("drive.add.cancel")}
        </button>
        <button
          type="button"
          className={`${primaryButton} disabled:opacity-40`}
          disabled={chosen.length === 0 || busy}
          aria-describedby={noteId}
          aria-keyshortcuts="Meta+Enter"
          onClick={() => void confirm()}
        >
          {chosen.length === 0
            ? t("drive.add.confirmNone")
            : t("drive.add.confirm", { count: chosen.length })}
        </button>
      </div>
    </div>
  );
}
