import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ProviderBadge } from "../../components/badges";
import { meQueryOptions } from "../../lib/auth";
import { formatRelativeTime } from "../../lib/format";
import { projectsQueryOptions } from "../../lib/queries";

/**
 * Lista dei progetti collegati ai repository. Lettura per tutti; la
 * creazione è riservata agli admin (il server la rifiuterebbe comunque,
 * qui si nasconde il bottone per non offrire un vicolo cieco).
 */
export function ProjectsPage() {
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div className="p-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Repository collegati, chiavi di ingestion e credenziali della pipeline.
          </p>
        </div>
        {isAdmin && (
          <Link
            to="/projects/new"
            className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            Nuovo progetto
          </Link>
        )}
      </header>

      {projects.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            // nessun progetto collegato
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            {isAdmin
              ? "Crea il primo progetto per ottenere una chiave di ingestion."
              : "Chiedi a un amministratore di collegare il primo repository."}
          </p>
        </div>
      ) : (
        <ul className="mt-6 rounded-sm border border-line bg-ink-900">
          {projects.map((project) => (
            <li key={project.id} className="border-b border-line last:border-b-0">
              <Link
                to="/projects/$slug"
                params={{ slug: project.slug }}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-5 py-4 transition-colors hover:bg-ink-850"
              >
                <span className="text-[15px] font-medium text-fg">{project.name}</span>
                <span className="font-mono text-[12px] text-fg-faint">{project.slug}</span>
                <ProviderBadge provider={project.provider} />
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-fg-muted">
                  {project.repoUrl}
                </span>
                <span
                  className="font-mono text-[11px] whitespace-nowrap text-fg-faint"
                  title={project.createdAt}
                >
                  creato {formatRelativeTime(project.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
