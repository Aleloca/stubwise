import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderBadge } from "../../components/badges";
import { WebhookConfigPanel } from "../../components/webhook-config-panel";
import { ProjectEnvFilesSection } from "../../components/project-env-files-section";
import { RepositoryForm } from "../../components/repository-form";
import { RepositorySaveWarnings } from "../../components/repository-save-warnings";
import { patchRepository, type RepositoryPatch } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import {
  readRepositoryWarnings,
  withoutRepositoryWarnings,
} from "../../lib/repository-warnings";
import { formatDateTime } from "../../lib/format";
import {
  graphKeys,
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
  const { slug } = route.useParams();
  // `key={slug}`: passando da una repository all'altra la rotta non si
  // smonta, e lo stato locale (avvisi del salvataggio, «Modifiche salvate»)
  // è l'esito di un salvataggio di QUELLA repository — non deve comparire
  // sull'altra.
  return <RepositoryDetail key={slug} slug={slug} />;
}

function RepositoryDetail({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();

  const { data: repository } = useSuspenseQuery(repositoryQueryOptions(slug));
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  // Config webhook solo per gli admin: l'endpoint è admin-only (403 ai member).
  const { data: webhook } = useQuery({
    ...repositoryWebhookQueryOptions(slug),
    enabled: isAdmin,
  });
  const [saved, setSaved] = useState(false);
  // Avvisi NON bloccanti del salvataggio: dal PATCH qui sotto, oppure —
  // appena atterrati dal wizard — dallo stato della navigazione. Quello si
  // legge UNA volta, al montaggio, e si CONSUMA subito (sotto): `history.state`
  // sopravvive a un reload e a back/forward, e l'avviso è l'esito di UN
  // salvataggio, non una proprietà della repository. Un PATCH successivo
  // sostituisce quelli della creazione.
  const [createdWarnings] = useState(
    () => readRepositoryWarnings(router.state.location.state) ?? null,
  );
  const [patchWarnings, setPatchWarnings] = useState<string[] | null>(null);
  const warnings = patchWarnings ?? createdWarnings ?? [];

  useEffect(() => {
    if (createdWarnings === null) return;
    // Riscrive la voce di history corrente senza gli avvisi: un F5 o un
    // back/forward rileggono uno stato pulito. Idempotente (StrictMode).
    void navigate({
      to: "/repositories/$slug",
      params: { slug },
      replace: true,
      resetScroll: false,
      state: (prev) => withoutRepositoryWarnings(prev),
    });
  }, [createdWarnings, navigate, slug]);

  async function handleSubmit(patch: RepositoryPatch) {
    setSaved(false);
    setPatchWarnings([]);
    const { warnings: saveWarnings, ...updated } = await patchRepository(slug, patch);
    // Nella cache va la repository, non gli avvisi del salvataggio.
    queryClient.setQueryData(repositoryQueryOptions(slug).queryKey, updated);
    // Il nome compare nel dettaglio del progetto e nei badge dei ticket.
    await queryClient.invalidateQueries({ queryKey: ["repositories"] });
    await queryClient.invalidateQueries({
      queryKey: projectQueryOptions(repository.projectId).queryKey,
    });
    // Il toggle del knowledge graph decide cosa mostra la tab "Grafo" dello
    // spazio Docs: si rilegge subito invece di aspettare lo staleTime.
    if (patch.graphEnabled !== undefined) {
      await queryClient.invalidateQueries({ queryKey: graphKeys.detail(repository.id) });
    }
    setSaved(true);
    // `?? []`: il web fa un cast, e un server senza il ciclo non manda il campo.
    setPatchWarnings(saveWarnings ?? []);
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
                  graphEnabled: repository.graphEnabled,
                  // `?? null`: il web fa un cast, e un server senza il ciclo
                  // di correzione non manda il campo.
                  reviewGitAccountId: repository.reviewGitAccountId ?? null,
                  // Derivati dal server (revisore effettivo, predefinito
                  // saltato): `?? null` per la stessa ragione.
                  effectiveReviewAccount: repository.effectiveReviewAccount ?? null,
                  skippedDefaultReviewAccount: repository.skippedDefaultReviewAccount ?? null,
                  // Branch protetti (7 ott 2026): `?? []`, cast non parse.
                  protectedBranches: repository.protectedBranches ?? [],
                }}
                onSubmit={handleSubmit}
              />
              {saved && (
                <p role="status" className="mt-3 font-mono text-[12px] text-ok">
                  {t("repositories:detail.saved")}
                </p>
              )}
              <RepositorySaveWarnings warnings={warnings} provider={repository.provider} />
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

        {/*
          Webhook git (PR-merged) del repository: solo admin. L'ingestion NON è
          più qui (salita al progetto, Fase 3): il repo eredita quella del gruppo.
        */}
        {isAdmin && webhook && (
          <div className="min-w-0">
            <WebhookConfigPanel
              slug={repository.slug}
              webhook={webhook}
              webhookConfiguredAt={repository.webhookConfiguredAt}
              onWebhookConfigured={handleWebhookConfigured}
            />
          </div>
        )}
      </div>

      {/*
        File d'ambiente del repository: solo admin (l'endpoint è admin-only e i
        valori, ancorché write-only, non devono nemmeno comparire nella UI dei
        member).
      */}
      {isAdmin && (
        <section aria-label={t("envFiles:title")} className="mt-8 border-t border-line pt-6">
          <h2 className={sectionTitleClass}>{t("envFiles:title")}</h2>
          <ProjectEnvFilesSection repositoryId={repository.id} projectId={repository.projectId} />
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
