import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../../components/copy-button";
import { Markdown } from "../../components/markdown";
import {
  generateRepoGraph,
  openRepoGraphSetupPr,
  type RepoGraph,
  repoGraphHtmlUrl,
  repoGraphJsonUrl,
} from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import {
  graphKeys,
  repoGraphQueryOptions,
  repoGraphReportQueryOptions,
  repositoriesQueryOptions,
} from "../../lib/queries";

/**
 * TAB "GRAFO" dello spazio Docs (`/docs/$projectId/graph`, dove `$projectId` è
 * — come per tutte le rotte dello spazio — l'id del REPOSITORY): il knowledge
 * graph del codice estratto da graphify.
 *
 * Cinque stati, dallo stesso `repoGraphQueryOptions`:
 * 1. toggle spento → spiegazione + rimando al dettaglio del repository, dove
 *    vive il toggle `graphEnabled` (solo admin);
 * 2. mai generato → descrizione + "Genera grafo" (solo admin);
 * 3. build in corso (queued/running o `jobPending`) → badge di stato; il
 *    polling è già nel `refetchInterval` delle query options, la pagina si
 *    aggiorna da sé;
 * 4. build fallita → motivo dal server + "Riprova" (solo admin);
 * 5. pronto → metadati, grafo interattivo in iframe, report delle comunità e
 *    le due uscite (download del graph.json, comando `graphify query`).
 *
 * Lo stato "pronto" vince su quello "in corso": durante una RIgenerazione il
 * grafo precedente resta consultabile, con il badge di avanzamento in testa.
 */
export function DocsGraphView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/$projectId/graph" });
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const { data: graph, error, isLoading } = useQuery(repoGraphQueryOptions(projectId));

  // Un'unica mutation per generare: il parametro è `force` (rigenerazione da
  // zero), così i tre bottoni che accodano una build (Genera / Rigenera /
  // Riprova, tutti `false`) e "Rigenera da zero" (`true`) condividono stato di
  // pending ed errore.
  const generation = useMutation({
    mutationFn: (force: boolean) => generateRepoGraph(projectId, { force }),
    onSuccess: async () => {
      // Riflette subito il job appena accodato (e riaccende il polling).
      await queryClient.invalidateQueries({ queryKey: graphKeys.detail(projectId) });
    },
  });

  const setupPr = useMutation({
    mutationFn: () => openRepoGraphSetupPr(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: graphKeys.detail(projectId) });
    },
  });

  if (isLoading) return null;
  if (error) return <EmptyState title={t("docs:graph.loadError")} />;
  if (!graph) return null;

  // Lavoro di build in corso: `jobPending` copre anche il job accodato prima
  // che esista la riga `repo_graphs` (status ancora "none").
  const buildPending =
    graph.status === "queued" || graph.status === "running" || graph.jobPending;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("docs:graph.title")}</h1>
        <p className="mt-2 max-w-prose text-sm text-fg-muted">{t("docs:graph.description")}</p>
      </header>

      {!graph.enabled ? (
        <DisabledPanel isAdmin={isAdmin} repositoryId={projectId} />
      ) : graph.status === "done" ? (
        <ReadyView
          repositoryId={projectId}
          graph={graph}
          isAdmin={isAdmin}
          buildPending={buildPending}
          onGenerate={(force) => generation.mutate(force)}
          generating={generation.isPending}
          generateFailed={generation.isError}
          onSetupPr={() => setupPr.mutate()}
          setupPrStarting={setupPr.isPending}
          setupPrFailed={setupPr.isError}
        />
      ) : buildPending ? (
        <PendingPanel running={graph.status === "running"} />
      ) : graph.status === "failed" ? (
        <FailedPanel
          reason={graph.error}
          isAdmin={isAdmin}
          onRetry={() => generation.mutate(false)}
          generating={generation.isPending}
          generateFailed={generation.isError}
        />
      ) : (
        <NeverPanel
          isAdmin={isAdmin}
          onGenerate={() => generation.mutate(false)}
          generating={generation.isPending}
          generateFailed={generation.isError}
        />
      )}
    </div>
  );
}

/** Riquadro in stile terminal: intestazione mono + contenuto. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-8 rounded-sm border border-line bg-ink-900 p-4">
      <h2 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Stato di caricamento/errore centrato, coerente con le altre tab dello spazio. */
function EmptyState({ title }: { title: string }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">{title}</p>
    </div>
  );
}

/** Bottone d'azione primario (stessa forma del trigger di generazione dei Docs). */
function PrimaryButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.06em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim"
    >
      {label}
    </button>
  );
}

/** Bottone secondario (bordo, niente riempimento): azioni meno frequenti. */
function SecondaryButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
    >
      {label}
    </button>
  );
}

/** Badge mono dei metadati (contatori, commit, data). */
function MetaBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-line bg-ink-900 px-2 py-1 font-mono text-[11px] tracking-[0.04em] text-fg-muted">
      {children}
    </span>
  );
}

/** Messaggio d'errore della mutation di generazione (accodamento fallito). */
function GenerateError() {
  const { t } = useTranslation();
  return (
    <p className="mt-2 font-mono text-[11px] text-danger" role="alert">
      {t("docs:graph.generateError")}
    </p>
  );
}

/**
 * Toggle `graphEnabled` spento: nulla è mai stato generato. All'admin diamo il
 * link al dettaglio del repository (dove vive il toggle, accanto ai comandi di
 * install/test), al membro l'indicazione di chiederlo a un admin.
 *
 * Il dettaglio si raggiunge per SLUG mentre qui abbiamo solo l'id: lo traduce
 * la lista dei repository (già in cache nella maggior parte dei percorsi).
 * Finché non è disponibile la CTA punta all'elenco, che resta navigabile.
 */
function DisabledPanel({ isAdmin, repositoryId }: { isAdmin: boolean; repositoryId: string }) {
  const { t } = useTranslation();
  const { data: repositories } = useQuery({ ...repositoriesQueryOptions(), enabled: isAdmin });
  const slug = repositories?.find((repository) => repository.id === repositoryId)?.slug;
  const ctaClass =
    "mt-3 inline-block rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:border-signal/40 hover:text-signal";
  return (
    <Panel title={t("docs:graph.disabledTitle")}>
      <p className="text-sm text-fg-muted">{t("docs:graph.disabledHint")}</p>
      {!isAdmin ? (
        <p className="mt-2 text-sm text-fg-muted">{t("docs:graph.disabledMemberHint")}</p>
      ) : slug ? (
        <Link to="/repositories/$slug" params={{ slug }} className={ctaClass}>
          {t("docs:graph.disabledCta")}
        </Link>
      ) : (
        <Link to="/repositories" className={ctaClass}>
          {t("docs:graph.disabledCta")}
        </Link>
      )}
    </Panel>
  );
}

/** Grafo mai generato (toggle acceso, nessuna build): invito a generarlo. */
function NeverPanel({
  isAdmin,
  onGenerate,
  generating,
  generateFailed,
}: {
  isAdmin: boolean;
  onGenerate: () => void;
  generating: boolean;
  generateFailed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("docs:graph.neverTitle")}>
      <p className="text-sm text-fg-muted">{t("docs:graph.neverHint")}</p>
      {isAdmin && (
        <div className="mt-3">
          <PrimaryButton
            onClick={onGenerate}
            disabled={generating}
            label={generating ? t("docs:graph.generating") : t("docs:graph.generate")}
          />
        </div>
      )}
      {generateFailed && <GenerateError />}
    </Panel>
  );
}

/**
 * Build accodata o in corso: badge + nota sull'aggiornamento automatico. Senza
 * intestazione propria (la ripeterebbe dall'header della pagina): qui l'unica
 * informazione è lo stato.
 */
function PendingPanel({ running }: { running: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-8 rounded-sm border border-line bg-ink-900 p-4">
      <p className="font-mono text-[11px] text-signal" role="status">
        {running ? t("docs:graph.running") : t("docs:graph.queued")}
      </p>
      <p className="mt-1 text-[12px] text-fg-muted">{t("docs:graph.pendingHint")}</p>
    </div>
  );
}

/** Ultima build fallita: motivo dal server + riprova (solo admin). */
function FailedPanel({
  reason,
  isAdmin,
  onRetry,
  generating,
  generateFailed,
}: {
  reason: string | null;
  isAdmin: boolean;
  onRetry: () => void;
  generating: boolean;
  generateFailed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("docs:graph.failedTitle")}>
      {reason !== null && reason !== "" && (
        <p className="text-[12px] text-danger" role="alert">
          {t("docs:graph.failedReason", { reason })}
        </p>
      )}
      {isAdmin && (
        <div className="mt-3">
          <PrimaryButton
            onClick={onRetry}
            disabled={generating}
            label={generating ? t("docs:graph.generating") : t("docs:graph.retry")}
          />
        </div>
      )}
      {generateFailed && <GenerateError />}
    </Panel>
  );
}

/**
 * Grafo pronto: metadati e azioni in testa, il grafo interattivo al centro, il
 * report delle comunità e le uscite (json, comando CLI) in fondo.
 */
function ReadyView({
  repositoryId,
  graph,
  isAdmin,
  buildPending,
  onGenerate,
  generating,
  generateFailed,
  onSetupPr,
  setupPrStarting,
  setupPrFailed,
}: {
  repositoryId: string;
  graph: RepoGraph;
  isAdmin: boolean;
  buildPending: boolean;
  onGenerate: (force: boolean) => void;
  generating: boolean;
  generateFailed: boolean;
  onSetupPr: () => void;
  setupPrStarting: boolean;
  setupPrFailed: boolean;
}) {
  const { t } = useTranslation();
  const command = t("docs:graph.queryCommand");

  return (
    <>
      {/* Metadati: quando, su che commit, quanto è grande, com'è etichettato. */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {graph.generatedAt !== null && (
          <MetaBadge>
            <time dateTime={graph.generatedAt} title={formatDateTime(graph.generatedAt)}>
              {t("docs:graph.generatedAt", { date: formatRelativeTime(graph.generatedAt) })}
            </time>
          </MetaBadge>
        )}
        {graph.commitSha !== null && graph.commitSha !== "" && (
          <MetaBadge>{t("docs:graph.atCommit", { commit: graph.commitSha.slice(0, 7) })}</MetaBadge>
        )}
        {graph.nodeCount !== null && (
          <MetaBadge>{t("docs:graph.nodes", { count: graph.nodeCount })}</MetaBadge>
        )}
        {graph.edgeCount !== null && (
          <MetaBadge>{t("docs:graph.edges", { count: graph.edgeCount })}</MetaBadge>
        )}
        {graph.communityCount !== null && (
          <MetaBadge>{t("docs:graph.communities", { count: graph.communityCount })}</MetaBadge>
        )}
        <MetaBadge>{graph.labeled ? t("docs:graph.labeled") : t("docs:graph.unlabeled")}</MetaBadge>
        <MetaBadge>{t("docs:graph.autoUpdate")}</MetaBadge>
      </div>

      {/* Rigenerazione già in coda: badge in testa, il grafo sotto resta quello
          dell'ultima build riuscita (consultabile mentre la nuova procede). */}
      {buildPending && (
        <p className="mt-3 font-mono text-[11px] text-signal" role="status">
          {t("docs:graph.running")}
        </p>
      )}

      {isAdmin && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PrimaryButton
            onClick={() => onGenerate(false)}
            disabled={generating || buildPending}
            label={generating ? t("docs:graph.generating") : t("docs:graph.regenerate")}
          />
          {/* Volutamente secondaria: rifare tutto da zero costa, l'incrementale
              è la scelta giusta quasi sempre. */}
          <SecondaryButton
            onClick={() => onGenerate(true)}
            disabled={generating || buildPending}
            label={t("docs:graph.regenerateForce")}
          />
          <SetupPrAction
            graph={graph}
            onSetupPr={onSetupPr}
            starting={setupPrStarting}
            failed={setupPrFailed}
          />
        </div>
      )}
      {/* Al membro resta il link alla PR di setup, se già aperta. */}
      {!isAdmin && graph.setupPrUrl !== null && (
        <div className="mt-4">
          <SetupPrLink url={graph.setupPrUrl} />
        </div>
      )}
      {generateFailed && <GenerateError />}
      {isAdmin && <p className="mt-2 text-[12px] text-fg-faint">{t("docs:graph.setupPrHint")}</p>}

      {/* Grafo interattivo: pagina statica servita dal volume, isolata in un
          iframe sandbox (solo script, nessun accesso all'origin della SPA).
          È same-origin dietro sessione: il cookie viaggia da sé. */}
      <section aria-label={t("docs:graph.viewTitle")} className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
          {t("docs:graph.viewTitle")}
        </h2>
        <iframe
          src={repoGraphHtmlUrl(repositoryId)}
          sandbox="allow-scripts"
          title={t("docs:graph.viewLabel")}
          className="mt-3 h-[70vh] w-full rounded-sm border border-line bg-ink-950"
        />
      </section>

      {/* Report delle comunità: montato SOLO qui (status done), così la query
          non parte quando l'artefatto non esiste e non prende un 404. */}
      <GraphReport repositoryId={repositoryId} />

      {/* Uscite: il grafo grezzo e l'interrogazione dal terminale. */}
      <section aria-label={t("docs:graph.queryTitle")} className="mt-10 border-t border-line pt-6">
        <a
          href={repoGraphJsonUrl(repositoryId)}
          download
          className="inline-block rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:border-signal/40 hover:text-signal"
        >
          {t("docs:graph.downloadJson")}
        </a>
        <h2 className="mt-6 font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
          {t("docs:graph.queryTitle")}
        </h2>
        <p className="mt-2 text-[12px] text-fg-muted">{t("docs:graph.queryHint")}</p>
        <div className="mt-2 flex items-center gap-2 rounded-sm border border-line bg-ink-950 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-muted">
            {command}
          </code>
          <CopyButton text={command} label={t("docs:graph.copyCommand")} />
        </div>
      </section>
    </>
  );
}

/**
 * Azione sulla PR di setup (solo admin). Se la PR è già stata aperta mostriamo
 * il link al provider invece del bottone: riaprirla non ha senso.
 */
function SetupPrAction({
  graph,
  onSetupPr,
  starting,
  failed,
}: {
  graph: RepoGraph;
  onSetupPr: () => void;
  starting: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  if (graph.setupPrUrl !== null) return <SetupPrLink url={graph.setupPrUrl} />;
  if (graph.setupPrJobPending) {
    return (
      <span className="font-mono text-[11px] text-signal" role="status">
        {t("docs:graph.setupPrPending")}
      </span>
    );
  }
  return (
    <>
      <SecondaryButton
        onClick={onSetupPr}
        disabled={starting}
        label={starting ? t("docs:graph.setupPrPending") : t("docs:graph.setupPr")}
      />
      {(failed || graph.setupPrError !== null) && (
        <span className="font-mono text-[11px] text-danger" role="alert">
          {t("docs:graph.setupPrError")}
          {graph.setupPrError !== null && graph.setupPrError !== ""
            ? ` ${t("docs:graph.failedReason", { reason: graph.setupPrError })}`
            : ""}
        </span>
      )}
    </>
  );
}

/** Link alla PR di setup già aperta sul provider (nuova scheda). */
function SetupPrLink({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:border-signal/40 hover:text-signal"
    >
      {t("docs:graph.setupPrOpen")} ↗
    </a>
  );
}

/**
 * Report delle comunità (`GRAPH_REPORT.md`) reso come markdown. Best-effort:
 * un errore di caricamento (artefatto assente sul volume) degrada in un
 * messaggio, non nel pannello d'errore della rotta.
 */
function GraphReport({ repositoryId }: { repositoryId: string }) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useQuery(repoGraphReportQueryOptions(repositoryId));

  return (
    <section aria-label={t("docs:graph.reportTitle")} className="mt-10">
      <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
        {t("docs:graph.reportTitle")}
      </h2>
      <div className="mt-3">
        {isLoading ? null : error ? (
          <p className="text-sm text-fg-muted">{t("docs:graph.reportError")}</p>
        ) : data !== undefined && data.trim() !== "" ? (
          <Markdown source={data} />
        ) : (
          <p className="text-sm text-fg-muted">{t("docs:graph.reportEmpty")}</p>
        )}
      </div>
    </section>
  );
}
