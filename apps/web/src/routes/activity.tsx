import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Component, type ReactNode, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "../components/avatar";
import type {
  ActivityCommit,
  ActivityDeveloperView,
  ActivityProjectView,
  ActivityResolvedUser,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { formatDate } from "../lib/format";
import { activityReportQueryOptions, repositoriesQueryOptions } from "../lib/queries";

/**
 * Sezione "Attività": lo standup giornaliero asincrono, visibile a ogni membro.
 * Un selettore data (default: ieri, UTC — come il poller notturno) e due viste
 * sugli stessi dati: PER PROGETTO (un blocco per progetto con gli autori del
 * giorno) e GLOBALE PER-DEV (un blocco per sviluppatore che aggrega i commit su
 * tutti i progetti). I dati veri stanno in {@link ActivityBody}, dietro un
 * confine Suspense (per la sospensione) e un {@link ActivityErrorBoundary}
 * locale (per gli errori della query). Entrambi i confini avvolgono SOLO il
 * corpo: header, selettore data e tab restano montati sia mentre il report per
 * la nuova data carica sia quando la query fallisce — l'utente può cambiare data
 * o riprovare senza perdere i controlli. `useSuspenseQuery` lancerebbe altrimenti
 * l'errore fino all'error component del router, smontando l'intera pagina.
 */
export function ActivityPage() {
  const { t } = useTranslation();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  const [date, setDate] = useState(yesterdayUtc);
  const [view, setView] = useState<"project" | "dev">("project");

  return (
    <div className="page">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("activity:title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("activity:subtitle")}</p>
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <DateSelector date={date} onChange={setDate} />
        <ViewTabs view={view} onChange={setView} />
      </div>

      <div className="mt-6">
        {/*
         * L'error boundary avvolge il Suspense: un errore della query per la
         * data selezionata mostra il fallback SOLO qui, senza smontare i
         * controlli. `resetKey={date}` azzera il boundary al cambio data, così
         * la query della nuova data riparte pulita.
         */}
        <ActivityErrorBoundary
          resetKey={date}
          fallback={(reset) => <ActivityError date={date} onRetry={reset} />}
        >
          <Suspense fallback={<ActivityLoading />}>
            <ActivityBody date={date} view={view} isAdmin={isAdmin} />
          </Suspense>
        </ActivityErrorBoundary>
      </div>
    </div>
  );
}

/** Data di ieri in UTC (`YYYY-MM-DD`), coerente col giorno prodotto dal poller. */
export function yesterdayUtc(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

/** Data di oggi in UTC (`YYYY-MM-DD`): tetto del selettore (niente giorni futuri). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Error boundary locale al corpo Attività. `useSuspenseQuery` rilancia gli
 * errori OLTRE il `<Suspense>` (che cattura solo la sospensione): senza questo
 * confine finirebbero all'error component del router, smontando tutta la pagina.
 * `resetKey` (la data selezionata) azzera lo stato d'errore quando cambia, così
 * scegliere un'altra data fa ripartire la query invece di restare bloccati sul
 * fallback.
 */
class ActivityErrorBoundary extends Component<
  { resetKey: string; fallback: (reset: () => void) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.reset);
    return this.props.children;
  }
}

/**
 * Fallback d'errore del corpo Attività: messaggio i18n + "Riprova". Il retry
 * resetta la query della data corrente (scartando l'errore in cache) e azzera il
 * boundary, così la query riparte. Cambiare data resetta comunque il boundary
 * (vedi {@link ActivityErrorBoundary}).
 */
function ActivityError({ date, onRetry }: { date: string; onRetry: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const retry = (): void => {
    void queryClient.resetQueries({ queryKey: ["activity", date] });
    onRetry();
  };
  return (
    <div
      role="alert"
      className="w-full max-w-md rounded-sm border border-danger/30 bg-ink-900 p-6"
    >
      <p className="font-mono text-[11px] tracking-[0.18em] text-danger uppercase">
        {t("common:error")}
      </p>
      <p className="mt-2 text-sm text-fg-muted">{t("activity:loadError")}</p>
      <button
        type="button"
        onClick={retry}
        className="mt-4 rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
      >
        {t("common:retry")}
      </button>
    </div>
  );
}

/** Sposta una data `YYYY-MM-DD` di `deltaDays` giorni, restando in UTC. */
function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** SHA breve (7 caratteri) per la lista commit. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Selettore data: bottoni ±1 giorno + input date nativo (con etichetta leggibile
 * della data scelta). Il tetto è OGGI in UTC: `max` sull'input impedisce di
 * digitare giorni futuri e il bottone "giorno successivo" è disabilitato quando
 * la data è già l'ultima disponibile (il poller produce solo giorni passati).
 */
function DateSelector({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  const { t } = useTranslation();
  const today = todayUtc();
  const atMax = date >= today;
  const stepButton =
    "tap rounded-sm border border-line-strong px-2 py-1.5 font-mono text-[12px] text-fg-muted transition-colors hover:border-signal-dim/40 hover:text-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-fg-muted";
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">
        {/* Etichetta leggibile: mezzogiorno locale per non slittare di giorno. */}
        {formatDate(`${date}T12:00:00`)}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t("activity:previousDay")}
          onClick={() => onChange(shiftDate(date, -1))}
          className={stepButton}
        >
          ‹
        </button>
        <input
          type="date"
          aria-label={t("activity:dateLabel")}
          value={date}
          max={today}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value);
          }}
          className="rounded-sm border border-line-strong bg-ink-950 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
        <button
          type="button"
          aria-label={t("activity:nextDay")}
          onClick={() => onChange(shiftDate(date, 1))}
          disabled={atMax}
          className={stepButton}
        >
          ›
        </button>
      </div>
    </div>
  );
}

/** Switch tra le due viste (per progetto / per sviluppatore). */
function ViewTabs({
  view,
  onChange,
}: {
  view: "project" | "dev";
  onChange: (view: "project" | "dev") => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="tablist" aria-label={t("activity:tabsLabel")} className="flex items-center gap-1">
      <ViewTab
        active={view === "project"}
        label={t("activity:viewProject")}
        onClick={() => onChange("project")}
      />
      <ViewTab
        active={view === "dev"}
        label={t("activity:viewDeveloper")}
        onClick={() => onChange("dev")}
      />
    </div>
  );
}

function ViewTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-sm px-3 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors ${
        active
          ? "bg-ink-800 text-fg shadow-[inset_0_-2px_0_0_var(--color-signal)]"
          : "text-fg-faint hover:text-fg-muted"
      }`}
    >
      {label}
    </button>
  );
}

/** Fallback Suspense mentre il report della data selezionata carica. */
function ActivityLoading() {
  const { t } = useTranslation();
  return (
    <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
      {t("common:loading")}
    </p>
  );
}

/**
 * Corpo dati: legge il report della data (suspende finché non è in cache) e
 * risolve i nomi dei repository best-effort per etichettare i commit. Un errore
 * della lista repository lascia comunque i commit con l'id grezzo del repo.
 */
function ActivityBody({
  date,
  view,
  isAdmin,
}: {
  date: string;
  view: "project" | "dev";
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const report = useSuspenseQuery(activityReportQueryOptions(date)).data;
  // Mappa repoId → nome, best-effort: la lista è admin-agnostica e degrada senza
  // bloccare la pagina (fallback all'id grezzo del repo).
  const reposQuery = useQuery(repositoriesQueryOptions());
  const repoName = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reposQuery.data ?? []) map.set(r.id, r.name);
    return (repoId: string) => map.get(repoId) ?? repoId;
  }, [reposQuery.data]);

  const isEmpty = view === "project" ? report.projects.length === 0 : report.developers.length === 0;
  if (isEmpty) {
    return (
      <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-20">
        <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("activity:noReport")}
        </p>
        <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
          {t("activity:noReportHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {view === "project"
        ? report.projects.map((project) => (
            <ProjectBlock
              key={project.project.id}
              project={project}
              isAdmin={isAdmin}
              repoName={repoName}
            />
          ))
        : report.developers.map((dev, index) => (
            <DeveloperBlock
              key={dev.resolvedUser?.id ?? dev.gitEmail ?? `dev-${index}`}
              dev={dev}
              isAdmin={isAdmin}
              repoName={repoName}
            />
          ))}
    </div>
  );
}

/** Blocco vista-progetto: header col nome/status e una riga per autore. */
function ProjectBlock({
  project,
  isAdmin,
  repoName,
}: {
  project: ActivityProjectView;
  isAdmin: boolean;
  repoName: (repoId: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="truncate font-mono text-[13px] font-medium text-fg">{project.project.name}</h2>
        <StatusBadge status={project.status} />
      </header>
      {project.entries.length === 0 ? (
        <p className="px-4 py-4 font-mono text-[12px] text-fg-faint">{t("activity:noActivity")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {project.entries.map((entry) => (
            <li key={entry.gitEmail} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <AuthorLabel
                  resolvedUser={entry.resolvedUser}
                  gitEmail={entry.gitEmail}
                  authorName={entry.authorName}
                  isAdmin={isAdmin}
                />
                <span className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
                  {t("activity:commits", { count: entry.commitCount })}
                </span>
                <DiffStat additions={entry.additions} deletions={entry.deletions} />
              </div>
              {entry.aiSummary && (
                <p className="text-sm text-fg-muted">{entry.aiSummary}</p>
              )}
              <CommitList commits={entry.commits} repoName={repoName} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Blocco vista-dev: totali dell'autore + un sotto-blocco per progetto. */
function DeveloperBlock({
  dev,
  isAdmin,
  repoName,
}: {
  dev: ActivityDeveloperView;
  isAdmin: boolean;
  repoName: (repoId: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <AuthorLabel
          resolvedUser={dev.resolvedUser}
          gitEmail={dev.gitEmail}
          authorName={dev.authorName}
          isAdmin={isAdmin}
        />
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
            {t("activity:commits", { count: dev.totalCommits })}
          </span>
          <DiffStat additions={dev.totalAdditions} deletions={dev.totalDeletions} />
        </div>
      </header>
      <ul className="divide-y divide-line">
        {dev.perProject.map((proj) => (
          <li key={proj.projectId} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-[13px] text-fg">{proj.projectName}</span>
              <span className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
                {t("activity:commits", { count: proj.commitCount })}
              </span>
            </div>
            {proj.aiSummary && <p className="text-sm text-fg-muted">{proj.aiSummary}</p>}
            <CommitList commits={proj.commits} repoName={repoName} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Etichetta autore: il membro Stubwise risolto (avatar + email) o, se l'email
 * git non è associata a nessun membro, l'email grezza in corsivo con un hint
 * "associa in Team" mostrato solo agli admin. In vista-dev l'email può mancare:
 * si ripiega su authorName o su un segnaposto.
 */
function AuthorLabel({
  resolvedUser,
  gitEmail,
  authorName,
  isAdmin,
}: {
  resolvedUser: ActivityResolvedUser | null;
  gitEmail: string | null;
  authorName: string | null;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  if (resolvedUser) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Avatar src={resolvedUser.avatarUrl} label={resolvedUser.email} size={22} />
        <span className="truncate font-mono text-[13px] text-fg">{resolvedUser.email}</span>
      </span>
    );
  }
  const raw = gitEmail ?? authorName ?? t("activity:unknownAuthor");
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="truncate font-mono text-[13px] text-fg-muted italic"
        title={t("activity:unresolvedTitle")}
      >
        {raw}
      </span>
      {isAdmin && (
        <Link
          to="/team"
          className="shrink-0 font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase transition-colors hover:text-signal"
        >
          {t("activity:linkHint")}
        </Link>
      )}
    </span>
  );
}

/** Conteggio additions/deletions in stile diff (verde/rosso). */
function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-[11px]">
      <span className="text-ok">+{additions}</span>{" "}
      <span className="text-danger">-{deletions}</span>
    </span>
  );
}

/** Badge dello stato di un report di progetto (queued/running/done/failed). */
function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const done = status === "done";
  const failed = status === "failed";
  const color = failed
    ? "border-danger/40 text-danger"
    : done
      ? "border-ok/40 text-ok"
      : "border-line-strong text-fg-faint";
  return (
    <span
      className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ${color}`}
    >
      {t(`activity:status.${status}`, status)}
    </span>
  );
}

/** Lista compatta dei commit: oggetto + repo + sha breve. */
function CommitList({
  commits,
  repoName,
}: {
  commits: ActivityCommit[];
  repoName: (repoId: string) => string;
}) {
  if (commits.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {commits.map((commit) => (
        <li key={commit.sha} className="flex flex-wrap items-baseline gap-2 font-mono text-[12px]">
          <span className="text-fg-faint">{shortSha(commit.sha)}</span>
          <span className="min-w-0 flex-1 truncate text-fg-muted">{commit.subject}</span>
          <span className="shrink-0 text-[10px] tracking-[0.08em] text-fg-faint uppercase">
            {repoName(commit.repoId)}
          </span>
        </li>
      ))}
    </ul>
  );
}
