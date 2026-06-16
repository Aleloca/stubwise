import { useId, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ALLOWED_ATTACHMENT_MIME_TYPES, uploadAttachment } from "../lib/api";
import { ticketKeys } from "../lib/queries";
import { FormError } from "./field";

interface AttachmentUploadProps {
  ticketId: string;
  /** Lega l'allegato a un commento specifico; assente = allegato del ticket. */
  commentId?: string;
  /** Storage non configurato: input disabilitato + hint. */
  disabled?: boolean;
}

/** Limite di dimensione del singolo allegato, gemello di quello server (10MB). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** `accept` dell'input file derivato dalla allowlist MIME condivisa con l'API. */
const ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(",");

/**
 * Caricamento di un allegato su un ticket. Valida tipo e dimensione lato client
 * PRIMA di toccare l'API (così un file rifiutato non fa un round-trip), poi
 * carica via multipart. Al successo invalida la lista allegati (e il feed, dove
 * gli allegati possono comparire). Quando `disabled` (storage off) l'input è
 * inerte e si mostra un hint.
 */
export function AttachmentUpload({ ticketId, commentId, disabled = false }: AttachmentUploadProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (file: File) =>
      uploadAttachment(ticketId, file, commentId ? { commentId } : undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.attachments(ticketId) });
      // Gli allegati possono comparire nel feed: lo si riconcilia col backend.
      void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(ticketId) });
      // Pulisce il campo: lo stesso file può essere ricaricato e l'onChange
      // riscatta anche se si riseleziona lo stesso path.
      if (inputRef.current) inputRef.current.value = "";
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : t("tickets:attachments.uploadFailed"));
    },
  });

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);

    if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(t("tickets:attachments.errorType"));
      event.target.value = "";
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(t("tickets:attachments.errorSize"));
      event.target.value = "";
      return;
    }

    mutation.mutate(file);
  }

  const busy = disabled || mutation.isPending;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={inputId}
        className="block font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase"
      >
        {t("tickets:attachments.attach")}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT}
        disabled={busy}
        onChange={handleChange}
        className="block w-full font-mono text-[12px] text-fg-muted file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-line-strong file:bg-ink-900 file:px-3 file:py-1.5 file:font-mono file:text-[12px] file:font-semibold file:tracking-[0.08em] file:text-fg-muted file:uppercase hover:file:border-signal-dim hover:file:text-signal disabled:cursor-not-allowed disabled:opacity-50"
      />
      {disabled && (
        <p className="font-mono text-[11px] text-fg-faint">
          {t("tickets:attachments.disabledHint")}
        </p>
      )}
      {mutation.isPending && (
        <p className="font-mono text-[11px] text-fg-muted">{t("tickets:attachments.uploading")}</p>
      )}
      <FormError message={error} />
    </div>
  );
}
