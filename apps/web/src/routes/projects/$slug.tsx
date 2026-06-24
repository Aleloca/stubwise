import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderBadge } from "../../components/badges";
import { IntegrationPanel } from "../../components/integration-panel";
import { MilestoneManager } from "../../components/milestone-manager";
import { ProjectEnvFilesSection } from "../../components/project-env-files-section";
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
  const { t } = useTranslation();
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

  // Stato complessivo: un progetto ha sempre un account git collegato (le
  // credenziali vivono lì), quindi "configurato" dipende solo dal webhook. Il
  // banner di conferma compare quando il webhook è a posto; se manca, è la
  // sezione Integrazione a guidare l'utente.
  const fullyConfigured = project.webhookConfiguredAt !== null;

  return (
    <div className="page">
      <Link
        to="/projects"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("projects:detail.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <span className="font-mono text-[12px] text-fg-faint">{project.slug}</span>
          <ProviderBadge provider={project.provider} />
        </div>
        <p className="mt-2 font-mono text-[12px] text-fg-muted">
          {project.repoUrl} · {t("projects:detail.branch")} {project.defaultBranch} ·{" "}
          {t("projects:detail.createdAt")} {formatDateTime(project.createdAt)}
        </p>
      </header>

      {isAdmin && fullyConfigured && (
        <p
          data-testid="project-configured-banner"
          role="status"
          className="mt-6 rounded-sm border border-ok/30 bg-ok/10 px-4 py-2.5 font-mono text-[12px] tracking-[0.04em] text-ok"
        >
          {t("projects:detail.configuredBanner")}
        </p>
      )}

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h2 className={sectionTitleClass}>{t("projects:detail.configuration")}</h2>
          {isAdmin ? (
            <>
              <ProjectForm
                // key sullo slug: cambiando progetto il form riparte dai
                // valori giusti invece di trascinarsi lo stato precedente.
                key={project.slug}
                initial={{
                  name: project.name,
                  repoUrl: project.repoUrl,
                  defaultBranch: project.defaultBranch,
                  gitAccountId: project.gitAccountId,
                  testCommand: project.testCommand,
                  installCommand: project.installCommand,
                  docAutoUpdate: project.docAutoUpdate,
                  docAutoUpdateProviderId: project.docAutoUpdateProviderId,
                }}
                onSubmit={handleSubmit}
              />
              {saved && (
                <p role="status" className="mt-3 font-mono text-[12px] text-ok">
                  {t("projects:detail.saved")}
                </p>
              )}
            </>
          ) : (
            <dl className="space-y-3 rounded-sm border border-line bg-ink-900 px-4 py-4">
              <ReadOnlyRow label={t("projects:detail.name")} value={project.name} />
              <ReadOnlyRow label={t("projects:detail.repoUrl")} value={project.repoUrl} />
              <ReadOnlyRow label={t("projects:detail.defaultBranch")} value={project.defaultBranch} />
              <ReadOnlyRow label={t("projects:detail.gitAccount")} value={project.gitAccountName} />
              <div className="flex flex-col gap-1">
                <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                  {t("projects:detail.status")}
                </dt>
                <dd className="flex flex-col gap-1 font-mono text-[12px]">
                  <span className={project.webhookConfiguredAt ? "text-ok" : "text-fg-faint"}>
                    {project.webhookConfiguredAt
                      ? t("projects:detail.webhookConfiguredAt", {
                          date: formatDateTime(project.webhookConfiguredAt),
                        })
                      : t("projects:detail.webhookNotConfigured")}
                  </span>
                </dd>
              </div>
              <p className="pt-1 font-mono text-[11px] text-fg-faint">
                {t("projects:detail.readOnlyHint")}
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

      {/*
        Gestione milestone: vivono per-progetto, quindi il dettaglio progetto è
        la loro casa naturale. Visibile a tutti gli utenti autenticati (la
        gestione delle milestone non è admin-only: il server arbitra i permessi).
      */}
      <section aria-label={t("milestones:title")} className="mt-8 border-t border-line pt-6">
        <h2 className={sectionTitleClass}>{t("milestones:title")}</h2>
        <MilestoneManager projectId={project.id} />
      </section>

      {/*
        File d'ambiente del progetto: solo admin (l'endpoint è admin-only e i
        valori, ancorché write-only, non devono nemmeno comparire nella UI dei
        member). I valori non sono MAI mostrati: si scrivono soltanto.
      */}
      {isAdmin && (
        <section
          aria-label={t("envFiles:title")}
          className="mt-8 border-t border-line pt-6"
        >
          <h2 className={sectionTitleClass}>{t("envFiles:title")}</h2>
          <ProjectEnvFilesSection projectId={project.id} />
        </section>
      )}
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
