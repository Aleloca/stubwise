import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { RepositoryWizard } from "../../components/repository-wizard";
import { postRepository, type RepositoryDraft } from "../../lib/api";
import { projectQueryOptions, repositoryQueryOptions } from "../../lib/queries";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/projects/$projectId/repositories/new");

/**
 * Aggiunta di un repository a un progetto (solo admin, guardia nella route)
 * tramite wizard: account git → repository → branch. Sul 201 il dettaglio
 * appena creato viene messo in cache e si atterra sulla sua pagina, dove
 * campeggiano chiave di ingestion e snippet.
 */
export function NewRepositoryPage() {
  const { t } = useTranslation();
  const { projectId } = route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleSubmit(draft: RepositoryDraft) {
    const repository = await postRepository(draft);
    queryClient.setQueryData(repositoryQueryOptions(repository.slug).queryKey, repository);
    // Il progetto ora ha un repo in più: invalida liste e dettaglio del gruppo.
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: projectQueryOptions(projectId).queryKey });
    await queryClient.invalidateQueries({ queryKey: ["repositories"] });
    await navigate({ to: "/repositories/$slug", params: { slug: repository.slug } });
  }

  return (
    <div className="page">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("repositories:new.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("repositories:new.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("repositories:new.subtitle")}</p>
      </header>

      <div className="mt-6 max-w-2xl">
        <RepositoryWizard projectId={projectId} onSubmit={handleSubmit} />
      </div>
    </div>
  );
}
