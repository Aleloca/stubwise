import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttachmentWithUrl } from "../lib/api";
import { deleteAttachment } from "../lib/api";
import { ticketKeys } from "../lib/queries";
import { formatBytes } from "../lib/format";
import { FormError } from "./field";

interface AttachmentListProps {
  ticketId: string;
  attachments: AttachmentWithUrl[];
  /**
   * Decide se mostrare il bottone "remove" per un allegato. Assente = nessuna
   * rimozione (lista in sola lettura). Il server applica comunque il 403
   * (uploader o admin): la UI nasconde dove può, ma non è l'autorità finale.
   */
  canDelete?: (attachment: AttachmentWithUrl) => boolean;
}

/**
 * Lista degli allegati di un ticket: anteprima inline per le immagini,
 * etichetta nome + dimensione leggibile per gli altri tipi, ciascuno con link
 * di download (il server fa 302 verso l'URL presigned). Quando `canDelete` lo
 * consente, una rimozione a conferma-doppia chiama la DELETE e invalida la
 * lista (e il feed). La mutation vive qui per tenere il chiamante semplice.
 */
export function AttachmentList({ ticketId, attachments, canDelete }: AttachmentListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Conferma inline a due click: id dell'allegato in attesa di conferma.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: string) => deleteAttachment(attachmentId),
    onSuccess: () => {
      setConfirmingId(null);
      void queryClient.invalidateQueries({ queryKey: ticketKeys.attachments(ticketId) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(ticketId) });
    },
  });

  // Primo click: arma la conferma. Secondo click sulla stessa riga: DELETE.
  const handleRemove = (attachmentId: string) => {
    if (confirmingId === attachmentId) {
      deleteMutation.mutate(attachmentId);
    } else {
      setConfirmingId(attachmentId);
    }
  };

  if (attachments.length === 0) {
    return <p className="font-mono text-[12px] text-fg-faint">{t("tickets:attachments.empty")}</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-3">
        {attachments.map((attachment) => (
          <AttachmentCard
            key={attachment.id}
            attachment={attachment}
            removable={canDelete?.(attachment) ?? false}
            confirming={confirmingId === attachment.id}
            removing={deleteMutation.isPending && confirmingId === attachment.id}
            onRemove={() => handleRemove(attachment.id)}
          />
        ))}
      </ul>
      {deleteMutation.isError && <FormError message={deleteMutation.error.message} />}
    </div>
  );
}

function AttachmentCard({
  attachment,
  removable,
  confirming,
  removing,
  onRemove,
}: {
  attachment: AttachmentWithUrl;
  removable: boolean;
  confirming: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const isImage = attachment.mimeType.startsWith("image/");

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line bg-ink-900 p-2">
      <a
        href={attachment.downloadUrl}
        target="_blank"
        rel="noreferrer"
        download={attachment.filename}
        className="group flex min-w-0 items-center gap-2"
      >
        {isImage ? (
          <img
            src={attachment.downloadUrl}
            alt={attachment.filename}
            loading="lazy"
            className="h-20 w-20 rounded-sm border border-line object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-line-strong font-mono text-[11px] text-fg-faint uppercase"
          >
            {fileExtension(attachment.filename)}
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="min-w-0 truncate font-mono text-[12px] text-fg-muted transition-colors group-hover:text-signal">
            {attachment.filename}
          </span>
          <span className="font-mono text-[11px] text-fg-faint">
            {formatBytes(attachment.sizeBytes)}
          </span>
        </span>
      </a>
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={t("tickets:attachments.removeFile", { filename: attachment.filename })}
          aria-pressed={confirming}
          className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            confirming
              ? "text-danger underline decoration-dotted underline-offset-2"
              : "text-fg-faint hover:text-danger"
          }`}
        >
          {confirming ? t("tickets:attachments.confirmRemove") : t("tickets:attachments.remove")}
        </button>
      )}
    </li>
  );
}

/** Estensione in maiuscolo per l'icona generica (es. "PDF", "ZIP", "TXT"). */
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "FILE";
  return filename.slice(dot + 1, dot + 5).toUpperCase();
}
