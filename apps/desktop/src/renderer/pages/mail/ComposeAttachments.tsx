import { useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDriveFile, useDriveFiles } from "../../data/queries";
import type { DriveFileRow, DriveFileType, MailDraftAttachment, Project } from "../../data/types";
import { hasModKey } from "../../platform/platform";
import { Dialog } from "../../tasks-ui/Dialog";
import { Chevron, MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { fold, searchWords } from "../chat/search";
import {
  CrossGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../claude/conversation/parts";
import { formatSize } from "../drive/format";
import { CheckGlyph, TypeGlyph } from "../drive/glyphs";
import {
  PickerNote,
  PickerSearch,
  PickerSkeleton,
  optionClass,
  useListKeys,
} from "../drive/Picker";
import { MenuButton } from "../tasks/controls";
import { AlertGlyph } from "./glyphs";

// Gli allegati della casella di scrittura (shape mail-compose §5 [A 7] [A 8]):
// i gettoni sopra la barra (glifo, nome — col codice per un file del Drive —,
// peso tnum, ×; quello che sfora i 25 MB in `critical`) e il selettore «From
// the AUD Drive»: i file del Drive del progetto che chi scrive VEDE (lo
// stesso elenco del Drive, `canSeeDriveFile`: niente nascosti, niente
// progetti altrui), ricerca e selezione multipla, e sotto la riga che dice
// cosa riceverà il destinatario — una copia, o un link Google.

export const typeOfName = (name: string): DriveFileType =>
  /\.pdf$/i.test(name)
    ? "pdf"
    : /\.(csv|xlsx?)$/i.test(name)
      ? "sheet"
      : /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
        ? "image"
        : "other";

/** Un allegato della bozza come gettone. */
export function AttachmentToken({
  attachment,
  over,
  onRemove,
}: {
  attachment: MailDraftAttachment;
  /** Fa sforare il limite di Gmail (25 MB). */
  over: boolean;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  // Un file del Drive porta il suo codice; lo legge il Drive (solo se lo vedo).
  const file = useDriveFile(attachment.driveFileId).data;
  const link = attachment.as === "link";
  return (
    <li
      data-attachment={attachment.name}
      title={over ? t("mail.compose.tooLarge") : undefined}
      className={`flex h-8 max-w-[320px] min-w-0 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-sm ${
        over ? "border-critical text-critical" : "border-rule-strong text-ink"
      }`}
    >
      <span className={over ? "" : "text-ink-muted"}>
        {over ? (
          <AlertGlyph size={14} />
        ) : (
          <TypeGlyph type={file?.type ?? typeOfName(attachment.name)} size={14} />
        )}
      </span>
      {file && (
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em]">{file.code}</span>
      )}
      <span className="min-w-0 truncate" title={attachment.name}>
        {attachment.name}
      </span>
      <span className="num shrink-0 text-xs text-ink-faint">
        {link ? t("mail.compose.googleLink") : formatSize(attachment.sizeBytes, i18n.language)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("mail.compose.removeAttachment", { name: attachment.name })}
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <CrossGlyph size={12} />
      </button>
    </li>
  );
}

/** Il peso che conta per Gmail: i link Google non pesano. */
export const weightOf = (a: MailDraftAttachment) => (a.as === "link" ? 0 : a.sizeBytes);

/** Gli id degli allegati che, sommati in ordine, superano il limite. */
export function overLimit(list: readonly MailDraftAttachment[], limit: number): Set<string> {
  const over = new Set<string>();
  let total = 0;
  for (const a of list) {
    total += weightOf(a);
    if (total > limit) over.add(a.id);
  }
  return over;
}

/** Un file del Drive come allegato: un file di Stubwise in copia, un file Google come link. */
export function driveAttachment(file: DriveFileRow): MailDraftAttachment {
  const link = file.source === "google";
  return {
    id: `att-${file.id}`,
    name: file.name,
    sizeBytes: link ? 0 : (file.sizeBytes ?? 0),
    driveFileId: file.id,
    as: link ? "link" : "copy",
  };
}

/**
 * «From the AUD Drive»: i file del Drive di un progetto, fra quelli che chi
 * scrive vede. Con più progetti candidati (o nessuno: un'email nuova) un
 * menu in testa per sceglierlo.
 */
export function DriveAttachDialog({
  projects,
  initialProjectId,
  onAttach,
  onClose,
}: {
  /** I progetti di cui si può scegliere il Drive (quelli che vedo). */
  projects: readonly Project[];
  initialProjectId: string | null;
  onAttach: (files: DriveFileRow[]) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [projectId, setProjectId] = useState(initialProjectId);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<DriveFileRow[]>([]);
  const files = useDriveFiles(
    { projectId: projectId ?? undefined, sort: "name" },
    { enabled: !!project },
  );
  const keys = useListKeys();
  const noteId = useId();

  const words = searchWords(q);
  const rows = (files.data ?? []).filter(
    (f) => !f.unavailable && words.every((w) => fold(`${f.code} ${f.name}`).includes(w)),
  );
  const isChosen = (f: DriveFileRow) => chosen.some((c) => c.id === f.id);
  const toggle = (f: DriveFileRow) =>
    setChosen((list) => (isChosen(f) ? list.filter((c) => c.id !== f.id) : [...list, f]));
  const confirm = () => {
    if (chosen.length === 0) return;
    onAttach(chosen);
  };
  const links = chosen.some((f) => f.source === "google");
  const copies = chosen.length === 0 || chosen.some((f) => f.source !== "google");

  let list;
  if (!project) {
    list = <PickerNote>{t("mail.compose.chooseProject")}</PickerNote>;
  } else if (files.isError) {
    list = (
      <PickerNote
        action={
          <button type="button" className={quietButton} onClick={() => void files.refetch()}>
            {t("mail.compose.retry")}
          </button>
        }
      >
        {t("mail.compose.driveError")}
      </PickerNote>
    );
  } else if (files.isPending) {
    list = <PickerSkeleton />;
  } else if (rows.length === 0) {
    list = (
      <PickerNote>
        {q.trim()
          ? t("mail.compose.driveNoMatch", { q: q.trim() })
          : t("mail.compose.driveEmpty", { code: project.code })}
      </PickerNote>
    );
  } else {
    list = (
      <div
        ref={keys.list}
        role="listbox"
        aria-label={t("mail.compose.driveFiles")}
        aria-multiselectable="true"
        onKeyDown={keys.onListKeyDown}
        className="-mx-1 flex h-[288px] flex-col gap-px overflow-y-auto px-1"
      >
        {rows.map((f, i) => {
          const selected = isChosen(f);
          return (
            <div
              key={f.id}
              role="option"
              aria-selected={selected}
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
              <span
                aria-hidden="true"
                className={`grid size-4 shrink-0 place-items-center rounded-[4px] border ${selected ? "border-ink bg-ink text-ground" : "border-rule-strong"}`}
              >
                {selected && <CheckGlyph />}
              </span>
              <span className="text-ink-muted">
                <TypeGlyph type={f.type} />
              </span>
              <span className="num shrink-0 text-xs font-semibold tracking-[0.02em]">{f.code}</span>
              <span title={f.name} className="min-w-0 flex-1 truncate">
                {f.name}
              </span>
              <span className="num shrink-0 text-sm text-ink-faint">
                {f.source === "google"
                  ? t("mail.compose.googleLink")
                  : f.sizeBytes !== null
                    ? formatSize(f.sizeBytes, i18n.language)
                    : ""}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Dialog
      title={
        project
          ? t("mail.compose.fromDrive", { code: project.code })
          : t("mail.compose.fromDriveAny")
      }
      onClose={onClose}
      width={640}
    >
      <div
        className="flex flex-col gap-3"
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" && hasModKey(e)) {
            e.preventDefault();
            confirm();
          }
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          {(projects.length !== 1 || !initialProjectId) && (
            <MenuButton
              menuLabel={t("mail.compose.chooseProject")}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-2.5 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/10"
              label={
                <>
                  <span className="num font-semibold">
                    {project?.code ?? t("mail.compose.chooseProject")}
                  </span>
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <MenuGroup label={t("mail.compose.chooseProject")}>
                  {projects.map((p) => (
                    <RadioItem
                      key={p.id}
                      checked={p.id === projectId}
                      onSelect={() => {
                        setProjectId(p.id);
                        setChosen([]);
                        close();
                      }}
                    >
                      <span className="num w-9 shrink-0 text-xs font-semibold">{p.code}</span>
                      <span className="min-w-0 truncate">{p.name}</span>
                    </RadioItem>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
          )}
          <div className="min-w-0 flex-1">
            <PickerSearch
              label={t("mail.compose.driveSearch")}
              value={q}
              onChange={setQ}
              onKeyDown={keys.enterFromSearch}
            />
          </div>
        </div>
        <div className="border-y border-rule py-1">{list}</div>
        <div id={noteId} className="flex flex-col gap-0.5 text-xs text-ink-muted">
          {copies && <p>{t("mail.compose.copyNote")}</p>}
          {links && <p>{t("mail.compose.linkNote")}</p>}
        </div>
        <div className="-mx-5 -mb-5 flex items-center justify-end gap-2 border-t border-rule px-5 py-3">
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("mail.compose.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={chosen.length === 0}
            aria-describedby={noteId}
            onClick={confirm}
          >
            {t("mail.compose.driveAttach", { count: Math.max(1, chosen.length) })}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
