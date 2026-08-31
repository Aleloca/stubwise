import { useState } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ProviderBadge } from "../../components/badges";
import { IntegrationPanel } from "../../components/integration-panel";
import { MilestoneManager } from "../../components/milestone-manager";
import { ProjectForm } from "../../components/project-form";
import { ProjectServersSection } from "../../components/project-servers-section";
import { WidgetsSection } from "../../components/widgets-section";
import { deleteProject, patchProject, putMyFollows, type ProjectPatch } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { myFollowsQueryOptions, projectQueryOptions } from "../../lib/queries";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/projects/$projectId");

/**
 * Dettaglio di un PROGETTO (gruppo): impostazioni di prodotto (nome,
 * descrizione, provider AI, auto-update Docs — solo admin), l'elenco dei suoi
 * repository (con link al dettaglio del singolo repository) e le milestone del
 * progetto. La configurazione git vive sul singolo repository.
 */
export function ProjectDetailPage() {
  const { t } = useTranslation();
  const { projectId } = route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSubmit(patch: ProjectPatch) {
    setSaved(false);
    const updated = await patchProject(projectId, patch);
    queryClient.setQueryData(projectQueryOptions(projectId).queryKey, {
      ...project,
      ...updated,
    });
    // Il nome/descrizione compaiono in lista: exact per non rimarcare stantio
    // il dettaglio appena aggiornato.
    await queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    setSaved(true);
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteProject(projectId);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({ to: "/projects" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page">
      <Link
        to="/projects"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("projects:detail.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold">{project.name}</h1>
            <span className="font-mono text-[12px] text-fg-faint">{project.slug}</span>
          </div>
          <FollowProjectButton projectId={project.id} />
        </div>
        {project.description && (
          <p className="mt-2 text-sm text-fg-muted">{project.description}</p>
        )}
        <p className="mt-2 font-mono text-[12px] text-fg-muted">
          {t("projects:detail.createdAt")} {formatDateTime(project.createdAt)}
        </p>
      </header>

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2">
        {/* Impostazioni del progetto (provider AI + auto-update): solo admin. */}
        <div className="min-w-0">
          <h2 className={sectionTitleClass}>{t("projects:detail.settings")}</h2>
          {isAdmin ? (
            <>
              <ProjectForm
                key={project.id}
                initial={{
                  name: project.name,
                  description: project.description,
                  aiProviderId: project.aiProviderId,
                  docAutoUpdate: project.docAutoUpdate,
                  dailyReportEnabled: project.dailyReportEnabled,
                  backlogEnabled: project.backlogEnabled,
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
              <ReadOnlyRow
                label={t("projects:form.docAutoUpdate")}
                value={project.docAutoUpdate ? t("common:on") : t("common:off")}
              />
              <ReadOnlyRow
                label={t("projects:form.dailyReport")}
                value={project.dailyReportEnabled ? t("common:on") : t("common:off")}
              />
              <ReadOnlyRow
                label={t("projects:form.backlog")}
                value={project.backlogEnabled ? t("common:on") : t("common:off")}
              />
              <p className="pt-1 font-mono text-[11px] text-fg-faint">
                {t("projects:detail.readOnlyHint")}
              </p>
            </dl>
          )}
        </div>

        {/* Repository del progetto: link al dettaglio del singolo repository. */}
        <div className="min-w-0">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className={sectionTitleClass + " mb-0"}>{t("projects:detail.repositories")}</h2>
            {isAdmin && (
              <Link
                to="/projects/$projectId/repositories/new"
                params={{ projectId }}
                className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
              >
                {t("projects:detail.addRepository")}
              </Link>
            )}
          </div>
          {project.repositories.length === 0 ? (
            <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-12">
              <p className="font-mono text-[12px] tracking-[0.16em] text-fg-faint uppercase">
                {t("projects:detail.noRepositories")}
              </p>
              <p className="mt-2 text-sm text-fg-muted">
                {isAdmin
                  ? t("projects:detail.noRepositoriesHintAdmin")
                  : t("projects:detail.noRepositoriesHintMember")}
              </p>
            </div>
          ) : (
            <ul className="rounded-sm border border-line bg-ink-900">
              {project.repositories.map((repository) => (
                <li key={repository.id} className="border-b border-line last:border-b-0">
                  <Link
                    to="/repositories/$slug"
                    params={{ slug: repository.slug }}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-ink-850"
                  >
                    <span className="text-sm font-medium text-fg">{repository.name}</span>
                    <span className="font-mono text-[12px] text-fg-faint">{repository.slug}</span>
                    <ProviderBadge provider={repository.provider} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/*
        Integrazione del progetto (Fase 3): la chiave di ingestion è salita dal
        repository al progetto, quindi vale per tutti i repo del gruppo. Visibile
        a tutti gli utenti autenticati (integrare l'SDK non richiede privilegi).
      */}
      <section
        aria-label={t("integration:title")}
        className="mt-8 border-t border-line pt-6"
      >
        <h2 className={sectionTitleClass}>{t("integration:title")}</h2>
        <IntegrationPanel
          ingestionKey={project.ingestionKey}
          slug={project.slug}
          projectName={project.name}
        />
      </section>

      {/*
        Widget di assistenza (Fase widget): chat incorporabile che risponde dai
        Docs del progetto e può aprire un ticket. Lettura per tutti; il salvataggio
        è solo admin (il server arbitra i permessi, la UI nasconde il submit).
      */}
      <section aria-label={t("widget:title")} className="mt-8 border-t border-line pt-6">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className={sectionTitleClass + " mb-0"}>{t("widget:title")}</h2>
          <Link
            to="/projects/$projectId/conversations"
            params={{ projectId: project.id }}
            className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
          >
            {t("widget:conversations.link")}
          </Link>
        </div>
        <WidgetsSection
          projectId={project.id}
          repositories={project.repositories}
          slug={project.slug}
          projectName={project.name}
          isAdmin={isAdmin}
        />
      </section>

      {/*
        Server monitorati associati al progetto: le stesse ServerCard della
        sezione Monitor, filtrate per progetto. L'associazione si gestisce nel
        Monitor; lo stato vuoto ci rimanda. Lettura per tutti.
      */}
      <section aria-label={t("projects:detail.servers")} className="mt-8 border-t border-line pt-6">
        <h2 className={sectionTitleClass}>{t("projects:detail.servers")}</h2>
        <ProjectServersSection projectId={project.id} />
      </section>

      {/*
        Gestione milestone: vivono per-progetto (gruppo). Visibile a tutti gli
        utenti autenticati (il server arbitra i permessi).
      */}
      <section aria-label={t("milestones:title")} className="mt-8 border-t border-line pt-6">
        <h2 className={sectionTitleClass}>{t("milestones:title")}</h2>
        <MilestoneManager projectId={project.id} />
      </section>

      {/* Eliminazione del progetto (solo admin): cancella in cascata i repository. */}
      {isAdmin && (
        <section className="mt-8 border-t border-line pt-6">
          <h2 className={sectionTitleClass}>{t("projects:detail.dangerZone")}</h2>
          {confirmingDelete ? (
            <div className="flex flex-col gap-3 rounded-sm border border-danger/30 bg-danger/10 px-4 py-4">
              <p className="font-mono text-[12px] text-danger">
                {t("projects:detail.deleteConfirm")}
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                  className="rounded-sm border border-danger/40 px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-danger uppercase transition-colors hover:bg-danger/20 disabled:opacity-50"
                >
                  {deleting ? t("projects:detail.deleting") : t("projects:detail.deleteConfirmYes")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
                >
                  {t("projects:detail.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-sm border border-danger/30 px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-danger uppercase transition-colors hover:bg-danger/10"
            >
              {t("projects:detail.deleteProject")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Bottone Segui / Non seguire del progetto.
 *
 * I follow sono l'ingresso dell'instradamento delle notifiche: seguire un
 * progetto significa riceverne gli eventi in inbox (e in DM, se attivo). La PUT
 * SOSTITUISCE l'insieme completo, quindi si manda l'insieme corrente più/meno
 * questo progetto — mai un delta.
 *
 * `useQuery` (non suspense) e nessun bottone finché l'insieme non è noto: se la
 * GET fallisce non si mostra uno stato inventato, e il dettaglio del progetto
 * resta comunque leggibile. Aggiornamento ottimistico con rollback: il click si
 * vede subito e torna indietro se il server rifiuta.
 */
function FollowProjectButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: follows } = useQuery(myFollowsQueryOptions);

  const mutation = useMutation({
    mutationFn: (projectIds: string[]) => putMyFollows(projectIds),
    onMutate: async (projectIds) => {
      await queryClient.cancelQueries({ queryKey: myFollowsQueryOptions.queryKey });
      const previous = queryClient.getQueryData(myFollowsQueryOptions.queryKey);
      queryClient.setQueryData(myFollowsQueryOptions.queryKey, { projectIds });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(myFollowsQueryOptions.queryKey, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: myFollowsQueryOptions.queryKey }),
  });

  if (follows === undefined) return null;

  const following = follows.projectIds.includes(projectId);

  return (
    <button
      type="button"
      disabled={mutation.isPending}
      aria-pressed={following}
      onClick={() => {
        const next = new Set(follows.projectIds);
        if (following) next.delete(projectId);
        else next.add(projectId);
        mutation.mutate([...next]);
      }}
      className={`shrink-0 rounded-sm border px-3 py-2 font-mono text-[12px] tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        following
          ? "border-signal-dim/40 text-signal hover:border-signal"
          : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {following ? t("projects:detail.unfollow") : t("projects:detail.follow")}
    </button>
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
