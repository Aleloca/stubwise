import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ProjectForm } from "../../components/project-form";
import { postProject, type ProjectDraft } from "../../lib/api";
import { projectQueryOptions } from "../../lib/queries";

/**
 * Creazione di un progetto (solo admin, guardia nella route). Sul 201 il
 * dettaglio appena creato viene messo in cache e si atterra sulla sua
 * pagina, dove campeggiano chiave di ingestion e snippet.
 */
export function NewProjectPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleSubmit(draft: ProjectDraft) {
    const project = await postProject(draft);
    queryClient.setQueryData(projectQueryOptions(project.slug).queryKey, project);
    // La lista è cambiata; exact per non rimarcare stantio il dettaglio
    // appena messo in cache.
    await queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    await navigate({ to: "/projects/$slug", params: { slug: project.slug } });
  }

  return (
    <div className="p-8">
      <Link
        to="/projects"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        ← Tutti i progetti
      </Link>

      <header className="mt-3 border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Nuovo progetto</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Collega un repository: slug e chiave di ingestion vengono generati alla creazione.
        </p>
      </header>

      <div className="mt-6 max-w-2xl">
        <ProjectForm mode="create" onSubmit={handleSubmit} />
      </div>
    </div>
  );
}
