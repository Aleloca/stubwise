import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderBadge } from "../../components/badges";
import { IntegrationPanel } from "../../components/integration-panel";
import { ProjectEnvFilesSection } from "../../components/project-env-files-section";
import { RepositoryForm } from "../../components/repository-form";
import { patchRepository, type RepositoryPatch } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import {
  projectQueryOptions,
  repositoryQueryOptions,
  repositoryWebhookQueryOptions,
} from "../../lib/queries";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/repositories/$slug");

/**
 * Dettaglio di un REPOSITORY: configurazione git (repoUrl, branch, account,
 * comandi), sezione Integrazione (chiave di ingestion, DSN, snippet, webhook) e
 * file d'ambiente. Provider AI e auto-update Docs NON sono qui: sono saliti al
 * progetto (gruppo). Il pannello di generazione Docs resta nello spazio Docs del
 * repository, raggiungibile dal link in testata.
 */
export function RepositoryDetailPage() {
  const { t } = useTranslation();
  const { slug } = route.useParams();
  const queryClient = useQueryClient();

  const { data: repository } = useSuspenseQuery(repositoryQueryOptions(slug));
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  // Config webhook solo per gli admin: l'endpoint è admin-only (403 ai member).
  const { data: webhook } = useQuery({
    ...repositoryWebhookQueryOptions(slug),
    enabled: isAdmin,
  });
  const [saved, setSaved] = useState(false);

  async function handleSubmit(patch: RepositoryPatch) {
    setSaved(false);
    const updated = await patchRepository(slug, patch);
    queryClient.setQueryData(repositoryQueryOptions(slug).queryKey, updated);
    // Il nome compare nel dettaglio del progetto e nei badge dei ticket.
    await queryClient.invalidateQueries({ queryKey: ["repositories"] });
    await queryClient.invalidateQueries({
      queryKey: projectQueryOptions(repository.projectId).queryKey,
    });
    setSaved(true);
  }

  // Dopo una (ri)configurazione del webhook la proiezione del repository cambia
  // (webhookConfiguredAt): si rilegge per riflettere lo stato "configurato".
  function handleWebhookConfigured() {
    void queryClient.invalidateQueries({ queryKey: repositoryQueryOptions(slug).queryKey });
  }

  const fullyConfigured = repository.webhookConfiguredAt !== null;

  return (
    <div className="page">
      <Link
        to="/projects/$projectId"
        params={{ projectId: repository.projectId }}
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("repositories:detail.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{repository.name}</h1>
          <span className="font-mono text-[12px] text-fg-faint">{repository.slug}</span>
          <ProviderBadge provider={repository.provider} />
        </div>
        <p className="mt-2 font-mono text-[12px] text-fg-muted">
          {repository.repoUrl} · {t("repositories:detail.branch")} {repository.defaultBranch} ·{" "}
          {t("repositories:detail.createdAt")} {formatDateTime(repository.createdAt)}
        </p>
        <div className="mt-3">
          <Link
            to="/docs/$projectId"
            params={{ projectId: repository.id }}
            className="inline-flex items-center rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
          >
            {t("repositories:detail.openDocs")}
          </Link>
        </div>
      </header>

      {isAdmin && fullyConfigured && (
        <p
          data-testid="repository-configured-banner"
          role="status"
          className="mt-6 rounded-sm border border-ok/30 bg-ok/10 px-4 py-2.5 font-mono text-[12px] tracking-[0.04em] text-ok"
        >
          {t("repositories:detail.configuredBanner")}
        </p>
      )}

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h2 className={sectionTitleClass}>{t("repositories:detail.configuration")}</h2>
          {isAdmin ? (
            <>
              <RepositoryForm
                key={repository.slug}
                initial={{
                  name: repository.name,
                  repoUrl: repository.repoUrl,
                  defaultBranch: repository.defaultBranch,
                  gitAccountId: repository.gitAccountId,
                  testCommand: repository.testCommand,
                  installCommand: repository.installCommand,
                }}
                onSubmit={handleSubmit}
              />
              {saved && (
                <p role="status" className="mt-3 font-mono text-[12px] text-ok">
                  {t("repositories:detail.saved")}
                </p>
              )}
            </>
          ) : (
            <dl className="space-y-3 rounded-sm border border-line bg-ink-900 px-4 py-4">
              <ReadOnlyRow label={t("repositories:detail.name")} value={repository.name} />
              <ReadOnlyRow label={t("repositories:detail.repoUrl")} value={repository.repoUrl} />
              <ReadOnlyRow
                label={t("repositories:detail.defaultBranch")}
                value={repository.defaultBranch}
              />
              <ReadOnlyRow
                label={t("repositories:detail.gitAccount")}
                value={repository.gitAccountName}
              />
              <div className="flex flex-col gap-1">
                <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                  {t("repositories:detail.status")}
                </dt>
                <dd className="flex flex-col gap-1 font-mono text-[12px]">
                  <span className={repository.webhookConfiguredAt ? "text-ok" : "text-fg-faint"}>
                    {repository.webhookConfiguredAt
                      ? t("repositories:detail.webhookConfiguredAt", {
                          date: formatDateTime(repository.webhookConfiguredAt),
                        })
                      : t("repositories:detail.webhookNotConfigured")}
                  </span>
                </dd>
              </div>
              <p className="pt-1 font-mono text-[11px] text-fg-faint">
                {t("repositories:detail.readOnlyHint")}
              </p>
            </dl>
          )}
        </div>

        <div className="min-w-0">
          <IntegrationPanel
            ingestionKey={repository.ingestionKey}
            slug={repository.slug}
            webhook={isAdmin ? webhook : undefined}
            webhookConfiguredAt={isAdmin ? repository.webhookConfiguredAt : undefined}
            onWebhookConfigured={handleWebhookConfigured}
          />
        </div>
      </div>

      {/*
        File d'ambiente del repository: solo admin (l'endpoint è admin-only e i
        valori, ancorché write-only, non devono nemmeno comparire nella UI dei
        member).
      */}
      {isAdmin && (
        <section aria-label={t("envFiles:title")} className="mt-8 border-t border-line pt-6">
          <h2 className={sectionTitleClass}>{t("envFiles:title")}</h2>
          <ProjectEnvFilesSection projectId={repository.id} />
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
