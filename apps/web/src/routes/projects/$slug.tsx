import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ProviderBadge } from "../../components/badges";
import { IntegrationPanel } from "../../components/integration-panel";
import { ProjectForm } from "../../components/project-form";
import { patchProject, type ProjectPatch } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { projectQueryOptions, projectWebhookQueryOptions } from "../../lib/queries";

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
  // Config webhook solo per gli admin: l'endpoint è admin-only (403 ai
  // member) e il segreto non deve raggiungere la loro cache.
  const { data: webhook } = useQuery({
    ...projectWebhookQueryOptions(slug),
    enabled: isAdmin,
  });
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

  // Dopo una (ri)configurazione del webhook la proiezione del progetto cambia
  // (webhookConfiguredAt): si rilegge per riflettere lo stato "configurato"
  // senza reload manuale.
  function handleWebhookConfigured() {
    void queryClient.invalidateQueries({ queryKey: projectQueryOptions(slug).queryKey });
  }

  // Stato complessivo: credenziali salvate + webhook configurato. Il banner di
  // conferma compare solo quando tutto è a posto; se manca qualcosa sono le
  // sezioni a guidare l'utente.
  const fullyConfigured = project.hasCredentials && project.webhookConfiguredAt !== null;

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

      {isAdmin && fullyConfigured && (
        <p
          data-testid="project-configured-banner"
          role="status"
          className="mt-6 rounded-sm border border-ok/30 bg-ok/10 px-4 py-2.5 font-mono text-[12px] tracking-[0.04em] text-ok"
        >
          ✓ Progetto configurato correttamente
        </p>
      )}

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
                credentialsConfigured={project.hasCredentials}
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
              <div className="flex flex-col gap-1">
                <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                  Stato
                </dt>
                <dd className="flex flex-col gap-1 font-mono text-[12px]">
                  <span className={project.hasCredentials ? "text-ok" : "text-fg-faint"}>
                    {project.hasCredentials
                      ? "✓ Credenziali git configurate"
                      : "— Credenziali git non configurate"}
                  </span>
                  <span className={project.webhookConfiguredAt ? "text-ok" : "text-fg-faint"}>
                    {project.webhookConfiguredAt
                      ? `✓ Webhook configurato il ${formatDateTime(project.webhookConfiguredAt)}`
                      : "— Webhook non configurato"}
                  </span>
                </dd>
              </div>
              <p className="pt-1 font-mono text-[11px] text-fg-faint">
                // sola lettura: la configurazione la modificano gli admin
              </p>
            </dl>
          )}
        </div>

        <div className="min-w-0">
          <IntegrationPanel
            ingestionKey={project.ingestionKey}
            slug={project.slug}
            webhook={isAdmin ? webhook : undefined}
            webhookConfiguredAt={isAdmin ? project.webhookConfiguredAt : undefined}
            onWebhookConfigured={handleWebhookConfigured}
          />
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
