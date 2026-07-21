import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "../lib/api";
import { FormError, SelectField, TextField } from "./field";
import { MarkdownEditor } from "./markdown-editor";

interface NewBacklogItemDialogProps {
  /** Progetti (gruppi) disponibili: il primo è preselezionato. */
  projects: Project[];
  /** Accoda la voce; il rigetto mostra l'errore e lascia il dialog aperto. */
  onSubmit: (input: { projectId: string; title: string; body: string }) => Promise<void>;
  onClose: () => void;
}

/**
 * Dialog di creazione manuale di una voce del backlog (pattern
 * {@link NewTicketDialog}). Titolo e descrizione sono entrambi obbligatori: il
 * server accoda un job `intake` che dedup-a e suggerisce i metadati, quindi
 * serve un corpo da elaborare. Escape o Annulla per chiudere.
 */
export function NewBacklogItemDialog({ projects, onSubmit, onClose }: NewBacklogItemDialogProps) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canSubmit = title.trim() !== "" && body.trim() !== "" && projectId !== "";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      await onSubmit({ projectId, title: title.trim(), body: body.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-3 backdrop-blur-[2px] sm:p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-backlog-title"
        className="w-full max-w-lg border border-line bg-ink-900 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        <header className="flex items-baseline justify-between border-b border-line px-5 py-4">
          <h2 id="new-backlog-title" className="text-lg font-semibold">
            {t("backlog:newDialog.title")}
          </h2>
          <span className="font-mono text-[10px] tracking-[0.18em] text-fg-faint uppercase">
            {t("backlog:newDialog.badge")}
          </span>
        </header>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4 px-5 py-5"
          noValidate
        >
          <TextField
            id="backlog-title"
            label={t("backlog:newDialog.itemTitle")}
            required
            autoFocus
            placeholder={t("backlog:newDialog.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <SelectField
            id="backlog-project"
            label={t("backlog:newDialog.project")}
            required
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="backlog-body"
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("backlog:newDialog.description")}
            </label>
            <MarkdownEditor
              id="backlog-body"
              value={body}
              onChange={setBody}
              placeholder={t("backlog:newDialog.descriptionPlaceholder")}
            />
          </div>

          <FormError message={error} />

          <div className="mt-1 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("backlog:newDialog.cancel")}
            </button>
            <button
              type="submit"
              disabled={pending || !canSubmit}
              className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
            >
              {pending ? t("backlog:newDialog.submitPending") : t("backlog:newDialog.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
