import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Attachment } from "../../../data/types";
import { CrossGlyph, FileGlyph } from "./parts";

/** «2.4 MB», «18 KB»: il peso di un allegato, in cifre tabellari. */
export function formatBytes(bytes: number, language: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/**
 * Un allegato: miniatura 32 px (un'immagine appena scelta) o l'icona del
 * file, nome, peso e — nella casella — × per toglierlo; in un messaggio
 * della Chat, un'azione in coda («Save to Drive»).
 */
export function AttachmentChip({
  attachment,
  previewUrl,
  onRemove,
  action,
}: {
  attachment: Attachment;
  /** La miniatura di un'immagine scelta adesso (non c'è per quelle già inviate). */
  previewUrl?: string;
  onRemove?: () => void;
  action?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  return (
    <span
      data-attachment={attachment.name}
      className="flex h-10 max-w-[280px] min-w-0 items-center gap-2 rounded-md border border-rule py-1 pr-1 pl-1"
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt=""
          className="size-8 shrink-0 rounded-[4px] border border-rule object-cover"
        />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-[4px] bg-ink/5 text-ink-muted">
          <FileGlyph />
        </span>
      )}
      <span className="flex min-w-0 flex-col pr-1">
        <span className="truncate text-sm text-ink" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="num text-xs text-ink-muted">
          {formatBytes(attachment.sizeBytes, i18n.language)}
        </span>
      </span>
      {action}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("claude.conversation.attachments.remove", { name: attachment.name })}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          <CrossGlyph size={12} />
        </button>
      )}
    </span>
  );
}
