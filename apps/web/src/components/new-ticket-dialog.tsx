import {
  ticketPrioritySchema,
  ticketTypeSchema,
  type TicketPriority,
  type TicketType,
} from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Project, TicketDraft } from "../lib/api";
import { repositoriesQueryOptions } from "../lib/queries";
import { PRIORITY_LABEL_KEYS, TYPE_LABEL_KEYS } from "./badges";
import { FormError, SelectField, TextField } from "./field";
import { MarkdownEditor } from "./markdown-editor";

interface NewTicketDialogProps {
  /** Progetti (gruppi) disponibili: il primo è preselezionato. */
  projects: Project[];
  /** Crea il ticket; il rigetto mostra l'errore e lascia il dialog aperto. */
  onSubmit: (draft: TicketDraft) => Promise<void>;
  onClose: () => void;
}

/**
 * Dialog di creazione manuale di un ticket. Si sceglie il PROGETTO (gruppo) e,
 * fra i suoi repository, il REPOSITORY BERSAGLIO del fix (obbligatorio): il
 * dropdown dei repository si popola dal progetto selezionato. Pannello modale in
 * stile sala controllo: Escape o Annulla per chiudere. Assegnatario e label si
 * impostano dal dettaglio.
 */
export function NewTicketDialog({ projects, onSubmit, onClose }: NewTicketDialogProps) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [repositoryId, setRepositoryId] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TicketType>("task");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Repository del progetto selezionato: alimentano il dropdown del bersaglio.
  const { data: repositories } = useQuery({
    ...repositoriesQueryOptions(projectId),
    enabled: projectId !== "",
  });

  // Cambiato progetto (o caricati i repo): preseleziona il primo repository del
  // progetto e azzera la scelta se non appartiene più al progetto corrente.
  useEffect(() => {
    const repos = repositories ?? [];
    if (repos.length === 0) {
      setRepositoryId("");
      return;
    }
    setRepositoryId((current) =>
      repos.some((repo) => repo.id === current) ? current : (repos[0]?.id ?? ""),
    );
  }, [repositories]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === "" || projectId === "" || repositoryId === "") return;
    setError(null);
    setPending(true);
    try {
      const trimmedBody = body.trim();
      await onSubmit({
        projectId,
        repositoryId,
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

  const repositoryOptions = (repositories ?? []).map((repo) => ({
    value: repo.id,
    label: repo.name,
  }));
  const noRepositories = projectId !== "" && repositories !== undefined && repositoryOptions.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-3 backdrop-blur-[2px] sm:p-6"
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

          <div>
            <SelectField
              id="ticket-repository"
              label={t("tickets:newDialog.repository")}
              required
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
              options={repositoryOptions}
            />
            {noRepositories && (
              <p role="alert" className="mt-1.5 font-mono text-[11px] text-danger">
                {t("tickets:newDialog.noRepositories")}
              </p>
            )}
          </div>

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
              disabled={pending || title.trim() === "" || repositoryId === ""}
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
