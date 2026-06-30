import { useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { postProject, type ProjectDraft } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatRelativeTime } from "../../lib/format";
import { projectQueryOptions, projectsQueryOptions } from "../../lib/queries";
import { FormError, SubmitButton, TextField } from "../../components/field";

/**
 * Lista dei progetti (gruppi). Ogni progetto raggruppa uno o più repository; la
 * riga porta il conteggio dei repository e linka al dettaglio. La creazione di
 * un progetto è riservata agli admin: un piccolo form inline crea il gruppo
 * (vuoto) e atterra sul suo dettaglio, da dove si aggiungono i repository.
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleCreate() {
    if (name.trim() === "") return;
    setError(null);
    setPending(true);
    try {
      const draft: ProjectDraft = { name: name.trim() };
      const project = await postProject(draft);
      // La lista è cambiata; exact per non rimarcare stantio un eventuale dettaglio.
      await queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
      queryClient.setQueryData(projectQueryOptions(project.id).queryKey, {
        ...project,
        repositories: [],
      });
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
      setPending(false);
    }
  }

  return (
    <div className="page">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">{t("projects:list.title")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("projects:list.subtitle")}</p>
        </div>
        {isAdmin && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("projects:list.newProject")}
          </button>
        )}
      </header>

      {isAdmin && creating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
          className="mt-6 flex flex-col gap-3 rounded-sm border border-line bg-ink-900 px-4 py-4"
          noValidate
        >
          <TextField
            id="new-project-name"
            label={t("projects:list.newName")}
            required
            autoFocus
            placeholder={t("projects:list.newNamePlaceholder")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <FormError message={error} />
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
                setError(null);
              }}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("projects:list.cancel")}
            </button>
            <SubmitButton pending={pending} disabled={name.trim() === ""}>
              {pending ? t("projects:list.creating") : t("projects:list.create")}
            </SubmitButton>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("projects:list.empty")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            {isAdmin ? t("projects:list.emptyHintAdmin") : t("projects:list.emptyHintMember")}
          </p>
        </div>
      ) : (
        <ul className="mt-6 rounded-sm border border-line bg-ink-900">
          {projects.map((project) => (
            <li key={project.id} className="border-b border-line last:border-b-0">
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-5 py-4 transition-colors hover:bg-ink-850"
              >
                <span className="text-[15px] font-medium text-fg">{project.name}</span>
                <span className="font-mono text-[12px] text-fg-faint">{project.slug}</span>
                <span className="font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase">
                  {t("projects:list.repositoryCount", { count: project.repositoryCount })}
                </span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-fg-muted">
                  {project.description ?? ""}
                </span>
                <span
                  className="font-mono text-[11px] whitespace-nowrap text-fg-faint"
                  title={project.createdAt}
                >
                  {t("projects:list.createdAt", { date: formatRelativeTime(project.createdAt) })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
