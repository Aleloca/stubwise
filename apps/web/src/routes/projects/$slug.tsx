import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ProviderBadge } from "../../components/badges";
import { IntegrationPanel } from "../../components/integration-panel";
import { ProjectForm } from "../../components/project-form";
import { patchProject, type ProjectPatch } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { projectQueryOptions } from "../../lib/queries";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/projects/$slug");

/**
 * Dettaglio di un progetto: sezione Integrazione (chiave, DSN, snippet)
 * visibile a tutti — serve a chi integra l'SDK — e form di modifica solo
 * per gli admin. I member vedono i campi in sola lettura.
 */
export function ProjectDetailPage() {
  const { slug } = route.useParams();
  const queryClient = useQueryClient();

  const { data: project } = useSuspenseQuery(projectQueryOptions(slug));
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  const [saved, setSaved] = useState(false);

  async function handleSubmit(patch: ProjectPatch) {
    setSaved(false);
    const updated = await patchProject(slug, patch);
    queryClient.setQueryData(projectQueryOptions(slug).queryKey, updated);
    // Il nome compare in lista, filtri e dettagli ticket: exact per non
    // rimarcare stantio il dettaglio appena aggiornato.
    await queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    setSaved(true);
  }

  return (
    <div className="p-8">
      <Link
        to="/projects"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        ← Tutti i progetti
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <span className="font-mono text-[12px] text-fg-faint">{project.slug}</span>
          <ProviderBadge provider={project.provider} />
        </div>
        <p className="mt-2 font-mono text-[12px] text-fg-muted">
          {project.repoUrl} · branch {project.defaultBranch} · creato{" "}
          {formatDateTime(project.createdAt)}
        </p>
      </header>

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h2 className={sectionTitleClass}>Configurazione</h2>
          {isAdmin ? (
            <>
              <ProjectForm
                // key sullo slug: cambiando progetto il form riparte dai
                // valori giusti invece di trascinarsi lo stato precedente.
                key={project.slug}
                mode="edit"
                initial={{
                  name: project.name,
                  provider: project.provider,
                  repoUrl: project.repoUrl,
                  defaultBranch: project.defaultBranch,
                }}
                onSubmit={handleSubmit}
              />
              {saved && (
                <p role="status" className="mt-3 font-mono text-[12px] text-ok">
                  Modifiche salvate.
                </p>
              )}
            </>
          ) : (
            <dl className="space-y-3 rounded-sm border border-line bg-ink-900 px-4 py-4">
              <ReadOnlyRow label="Nome" value={project.name} />
              <ReadOnlyRow label="URL repository" value={project.repoUrl} />
              <ReadOnlyRow label="Branch di default" value={project.defaultBranch} />
              <p className="pt-1 font-mono text-[11px] text-fg-faint">
                // sola lettura: la configurazione la modificano gli admin
              </p>
            </dl>
          )}
        </div>

        <div className="min-w-0">
          <IntegrationPanel ingestionKey={project.ingestionKey} slug={project.slug} />
        </div>
      </div>
    </div>
  );
}

const sectionTitleClass =
  "mb-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">{label}</dt>
      <dd className="font-mono text-[13px] break-all text-fg">{value}</dd>
    </div>
  );
}
