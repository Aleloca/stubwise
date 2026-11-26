import { useTranslation } from "react-i18next";
import { useDownloadAttachment } from "../../data/queries";
import type { Attachment } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";

// «Download» sull'allegato di un messaggio (area 4, fetta 4, build app) o di
// una task (voce Trasversali del registro). Sul
// desktop lo scarica il main e chiede dove salvarlo; sul web un link, col
// cookie. Annullare la finestra «Salva» non è un errore; un allegato che non si
// vede più (eliminato, canale lasciato) lo dice.

const DownloadGlyph = () => (
  <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** `of`: l'allegato di un messaggio della Chat o di una task (le rotte sono diverse). */
export function DownloadAttachmentButton({
  attachment,
  of = "chat",
  className,
}: {
  attachment: Attachment;
  of?: "chat" | "task";
  className?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const download = useDownloadAttachment(of);
  const name = attachment.name;
  return (
    <button
      type="button"
      aria-label={t("chat.attachments.download", { name })}
      title={t("chat.attachments.download", { name })}
      disabled={download.isPending}
      onClick={() =>
        download.mutate(attachment.id, {
          onSuccess: (result) => {
            if (result.ok || result.reason === "canceled") return;
            toast.error(
              result.reason === "not_found"
                ? t("chat.attachments.downloadGone", { name })
                : t("chat.attachments.downloadFailed", { name }),
            );
          },
          onError: () => toast.error(t("chat.attachments.downloadFailed", { name })),
        })
      }
      className={
        className ??
        "grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink disabled:opacity-40"
      }
    >
      <DownloadGlyph />
    </button>
  );
}
