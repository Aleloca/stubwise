import {
  ticketPrioritySchema,
  ticketTypeSchema,
  type TicketPriority,
  type TicketType,
} from "@stubwise/shared";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Project, TicketDraft } from "../lib/api";
import { PRIORITY_LABEL_KEYS, TYPE_LABEL_KEYS } from "./badges";
import { FormError, SelectField, TextField } from "./field";
import { MarkdownEditor } from "./markdown-editor";

interface NewTicketDialogProps {
  projects: Project[];
  /** Crea il ticket; il rigetto mostra l'errore e lascia il dialog aperto. */
  onSubmit: (draft: TicketDraft) => Promise<void>;
  onClose: () => void;
}

/**
 * Dialog di creazione manuale di un ticket, per tutto ciò che non arriva
 * dagli SDK. Pannello modale in stile sala controllo: overlay scuro, panel
 * rialzato, Escape o Annulla per chiudere. Volutamente minimale: assegnatario
 * e label si impostano dal dettaglio.
 */
export function NewTicketDialog({ projects, onSubmit, onClose }: NewTicketDialogProps) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TicketType>("task");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === "" || projectId === "") return;
    setError(null);
    setPending(true);
    try {
      const trimmedBody = body.trim();
      await onSubmit({
        projectId,
        title: title.trim(),
        ...(trimmedBody !== "" && { body: trimmedBody }),
        type,
        priority,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-6 backdrop-blur-[2px]"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onMouseDown={(event) => {
        // Click sull'overlay (non sul pannello) = chiusura.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-ticket-title"
        className="w-full max-w-lg border border-line bg-ink-900 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        <header className="flex items-baseline justify-between border-b border-line px-5 py-4">
          <h2 id="new-ticket-title" className="text-lg font-semibold">
            {t("tickets:newDialog.title")}
          </h2>
          <span className="font-mono text-[10px] tracking-[0.18em] text-fg-faint uppercase">
            {t("tickets:newDialog.badge")}
          </span>
        </header>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4 px-5 py-5"
          noValidate
        >
          <TextField
            id="ticket-title"
            label={t("tickets:newDialog.ticketTitle")}
            required
            // Dialog appena aperto: il focus parte dal primo campo.
            autoFocus
            placeholder={t("tickets:newDialog.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <SelectField
            id="ticket-project"
            label={t("tickets:newDialog.project")}
            required
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              id="ticket-type"
              label={t("tickets:newDialog.type")}
              value={type}
              onChange={(event) => setType(event.target.value as TicketType)}
              options={ticketTypeSchema.options.map((kind) => ({
                value: kind,
                label: t(TYPE_LABEL_KEYS[kind]),
              }))}
            />
            <SelectField
              id="ticket-priority"
              label={t("tickets:newDialog.priority")}
              value={priority}
              onChange={(event) => setPriority(event.target.value as TicketPriority)}
              options={ticketPrioritySchema.options.map((level) => ({
                value: level,
                label: t(PRIORITY_LABEL_KEYS[level]),
              }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="ticket-body"
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("tickets:newDialog.description")}
            </label>
            <MarkdownEditor
              id="ticket-body"
              value={body}
              onChange={setBody}
              placeholder={t("tickets:newDialog.descriptionPlaceholder")}
            />
          </div>

          <FormError message={error} />

          <div className="mt-1 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("tickets:newDialog.cancel")}
            </button>
            <button
              type="submit"
              disabled={pending || title.trim() === ""}
              className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
            >
              {pending ? t("tickets:newDialog.submitPending") : t("tickets:newDialog.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
