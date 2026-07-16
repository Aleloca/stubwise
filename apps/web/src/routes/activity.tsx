import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Component, type ReactNode, Suspense, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "../components/avatar";
import { ComboboxPicker } from "../components/combobox-picker";
import { Markdown } from "../components/markdown";
import {
  generateActivity,
  linkGitIdentity,
  type ActivityCommit,
  type ActivityDeveloperView,
  type ActivityProjectView,
  type ActivityResolvedUser,
  type TeamUser,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { formatDate, formatTime } from "../lib/format";
import { activityReportQueryOptions, usersQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

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
          className="date-input rounded-sm border border-line-strong bg-ink-950 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
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
 * rende la vista selezionata sul payload PER-COMMIT.
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

  // `isEmpty` è derivato dall'ESISTENZA del report per il giorno, uguale in
  // entrambe le viste: un report appena accodato ha `projects` popolato (status
  // queued) ma `developers: []`, quindi legarlo a `developers` in vista-dev
  // farebbe riapparire l'empty state (+ pulsante "Genera") su un report già in
  // corso. Il ramo dev gestisce a parte il caso `developers` vuoto (sotto).
  const isEmpty = report.projects.length === 0;
  if (isEmpty) {
    return (
      <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-20">
        <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("activity:noReport")}
        </p>
        <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
          {t("activity:noReportHint")}
        </p>
        {isAdmin && <GenerateReport key={date} date={date} />}
      </div>
    );
  }

  // Nasconde i progetti la cui generazione è FINITA senza alcuna attività
  // (`done` + 0 commit): sono le card "No activity" che sporcano la vista. I
  // progetti ancora `queued`/`running` restano (mostrano "in generazione") anche
  // se non hanno ancora commit; i `done` con commit restano.
  const visibleProjects = report.projects.filter(
    (p) => !(p.status === "done" && p.commits.length === 0),
  );

  return (
    <div className="flex flex-col gap-6">
      <RecountBar date={date} staleCommitTotal={report.staleCommitTotal} isAdmin={isAdmin} />
      {view === "project" ? (
        visibleProjects.length === 0 ? (
          <NoActivityDay />
        ) : (
          visibleProjects.map((project) => (
            <ProjectBlock key={project.project.id} project={project} isAdmin={isAdmin} />
          ))
        )
      ) : report.developers.length === 0 ? (
        <DeveloperEmpty projects={report.projects} />
      ) : (
        report.developers.map((dev, index) => (
          <DeveloperBlock
            key={dev.resolvedUser?.id ?? dev.gitEmail ?? `dev-${index}`}
            dev={dev}
            isAdmin={isAdmin}
            summaryPending={report.developersSummaryPending === true}
          />
        ))
      )}
    </div>
  );
}

/**
 * Messaggio a livello di giornata quando esistono report per la data ma nessuno
 * ha attività (tutti `done` con zero commit → tutte le card filtrate via). NON
 * mostra il pulsante "Genera" (il report esiste già), a differenza dell'empty
 * state di {@link ActivityBody} che scatta quando non c'è alcun report.
 */
function NoActivityDay() {
  const { t } = useTranslation();
  return (
    <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-20">
      <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
        {t("activity:noActivityDay")}
      </p>
    </div>
  );
}

/**
 * Placeholder della vista-dev quando `report.developers` è vuoto ma un report
 * per il giorno esiste (`projects` popolato): report appena accodato/in corso,
 * oppure un giorno "done" senza alcun commit. Senza questo, il ramo dev
 * renderebbe un contenitore vuoto (schermata bianca). Il messaggio è coerente
 * col {@link ProjectBlock}: "Generating…" se almeno un progetto è queued/running,
 * altrimenti "No activity".
 */
function DeveloperEmpty({ projects }: { projects: ActivityProjectView[] }) {
  const { t } = useTranslation();
  const generating = projects.some(
    (p) => p.status === "queued" || p.status === "running",
  );
  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <p className="px-4 py-4 font-mono text-[12px] text-fg-faint">
        {generating ? t("activity:inProgress") : t("activity:noActivity")}
      </p>
    </section>
  );
}

/**
 * Trigger admin per la generazione manuale dei report attività di un giorno
 * senza report. Al click accoda i progetti abilitati via
 * `POST /api/activity/generate`: se qualcuno viene accodato, invalida la query
 * del giorno (fa ripartire il refetch + il polling adattivo che porta la vista
 * dallo stato "in generazione" al report vero); se nessun progetto ha il report
 * abilitato (`queued: 0`) mostra un hint. Gli errori si localizzano inline.
 */
function GenerateReport({ date }: { date: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => generateActivity(date),
    onSuccess: (res) => {
      setError(null);
      if (res.queued > 0) {
        setNotice(null);
        void queryClient.invalidateQueries({ queryKey: ["activity", date] });
      } else {
        setNotice(t("activity:noEnabledProjects"));
      }
    },
    onError: (cause) => {
      setNotice(null);
      setError(translateApiError(cause, t));
    },
  });
  return (
    <div className="mt-6 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        aria-busy={mutation.isPending}
        className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-fg-muted"
      >
        {mutation.isPending ? t("activity:generating") : t("activity:generate")}
      </button>
      {notice && (
        <p role="status" className="text-center text-sm text-fg-muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-center text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Barra in cima al corpo quando un report per il giorno ESISTE già (a differenza
 * di {@link GenerateReport}, che compare solo su un giorno senza alcun report).
 * Mostra due cose, indipendenti:
 * - un AVVISO di giornata (visibile a tutti) quando `staleCommitTotal > 0`: sono
 *   arrivati nuovi commit dopo l'ultima generazione, non ancora inclusi;
 * - il pulsante "Rigenera" (solo admin), che riaccoda il giorno con `force` per
 *   incorporare quei commit.
 * Se non c'è nulla da mostrare (nessun commit mancante e utente non admin) non
 * rende nulla.
 */
function RecountBar({
  date,
  staleCommitTotal,
  isAdmin,
}: {
  date: string;
  staleCommitTotal: number;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const hasStale = staleCommitTotal > 0;
  if (!hasStale && !isAdmin) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {hasStale ? (
        <p role="status" className="font-mono text-[12px] text-signal">
          ⚠ {t("activity:staleWarning", { count: staleCommitTotal })}
        </p>
      ) : (
        <span />
      )}
      {isAdmin && <RegenerateButton date={date} />}
    </div>
  );
}

/**
 * Pulsante admin "Rigenera": riaccoda il giorno con `force` (include i commit
 * arrivati dopo l'ultima generazione). Al successo invalida la query del giorno
 * (fa ripartire il refetch + il polling adattivo, riportando la vista in stato
 * "in generazione"). Errori localizzati inline.
 */
function RegenerateButton({ date }: { date: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => generateActivity(date, { force: true }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["activity", date] });
    },
    onError: (cause) => setError(translateApiError(cause, t)),
  });
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        aria-busy={mutation.isPending}
        className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-fg-muted"
      >
        {mutation.isPending ? t("activity:regenerating") : t("activity:regenerate")}
      </button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Riga di un singolo commit, condivisa dalle due viste: SHA breve (con lo SHA
 * completo nel `title`) + orario `HH:MM` + oggetto + diffstat, poi l'eventuale
 * autore (slot `author`, presente solo in vista-progetto dove l'autore non è
 * implicito). La descrizione AI in markdown è COLLASSATA di default: la riga
 * compatta è un pulsante che la espande/richiude (`aria-expanded` + pannello con
 * id). Un commit senza `aiDescription` non è espandibile: la riga è statica e
 * mostra solo l'oggetto. L'autore vive fuori dal pulsante (contiene controlli
 * interattivi propri — il picker "Link team member" — che non possono annidarsi
 * in un `<button>`).
 */
function CommitRow({ commit, author }: { commit: ActivityCommit; author?: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const description = commit.aiDescription;
  const summary = (
    <>
      <span aria-hidden="true" className="w-3 shrink-0 font-mono text-[11px] text-fg-faint">
        {description ? (expanded ? "▾" : "▸") : ""}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-fg-faint" title={commit.sha}>
        {shortSha(commit.sha)}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-fg-faint">
        {formatTime(commit.committedAt)}
      </span>
      <span className="min-w-0 flex-1 text-sm text-fg">{commit.subject}</span>
      <DiffStat additions={commit.additions} deletions={commit.deletions} />
    </>
  );
  return (
    <div className="flex flex-col gap-1.5">
      {description ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          aria-label={t(expanded ? "activity:collapseCommit" : "activity:expandCommit", {
            subject: commit.subject,
          })}
          className="tap flex w-full flex-wrap items-baseline gap-2 text-left transition-colors hover:text-signal"
        >
          {summary}
        </button>
      ) : (
        <div className="flex flex-wrap items-baseline gap-2">{summary}</div>
      )}
      {author && <div className="flex items-center gap-2">{author}</div>}
      {expanded && description && (
        <div id={panelId} className="pl-5">
          <Markdown source={description} />
        </div>
      )}
    </div>
  );
}

/**
 * Riassunto narrativo del giorno in cima al pannello di una card (progetto o
 * sviluppatore), PRIMA della lista commit. Se `summary` è presente lo rende come
 * markdown (NON fidato → `<Markdown>`) in un blocco tenue distinto dai commit; se
 * è `null` mostra un placeholder discreto SOLO quando la generazione è ancora in
 * corso (`pending`), altrimenti nulla (run senza riassunto: niente ingombro).
 */
function DaySummary({ summary, pending }: { summary: string | null; pending: boolean }) {
  const { t } = useTranslation();
  if (summary) {
    return (
      <div
        role="region"
        aria-label={t("activity:summaryLabel")}
        aria-live="polite"
        className="border-b border-line bg-ink-950/40 px-4 py-3"
      >
        <Markdown source={summary} />
      </div>
    );
  }
  if (pending) {
    return (
      <p
        role="region"
        aria-label={t("activity:summaryLabel")}
        aria-live="polite"
        className="border-b border-line px-4 py-3 font-mono text-[12px] text-fg-faint"
      >
        {t("activity:summaryPending")}
      </p>
    );
  }
  return null;
}

/**
 * Blocco vista-progetto: header col nome/status e i totali del giorno, poi il
 * riassunto narrativo del giorno e la lista dei commit (uno per riga, con autore
 * risolto/grezzo e descrizione AI espandibile).
 */
function ProjectBlock({
  project,
  isAdmin,
}: {
  project: ActivityProjectView;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const { header } = project;
  const [collapsed, setCollapsed] = useState(false);
  const panelId = useId();
  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header
        className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${
          collapsed ? "" : "border-b border-line"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="flex min-w-0 items-center">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-controls={collapsed ? undefined : panelId}
              className="tap flex min-w-0 items-center gap-2 text-left transition-colors hover:text-signal"
            >
              <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-fg-faint">
                {collapsed ? "▸" : "▾"}
              </span>
              <span className="truncate font-mono text-[13px] font-medium text-fg">
                {project.project.name}
              </span>
            </button>
          </h2>
          <StatusBadge status={project.status} />
          {project.staleCommitCount > 0 && (
            <span className="shrink-0 rounded-sm border border-signal/40 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] text-signal uppercase">
              {t("activity:staleBadge", { count: project.staleCommitCount })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
            {t("activity:commits", { count: header.commitCount })}
          </span>
          <DiffStat additions={header.additions} deletions={header.deletions} />
          <span className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">
            {t("activity:authors", { count: header.authorCount })}
          </span>
        </div>
      </header>
      {!collapsed && (
        <div id={panelId}>
          <DaySummary
            summary={project.summary ?? null}
            pending={project.status === "queued" || project.status === "running"}
          />
          {project.commits.length === 0 ? (
            <p className="px-4 py-4 font-mono text-[12px] text-fg-faint">
              {project.status === "queued" || project.status === "running"
                ? t("activity:inProgress")
                : t("activity:noActivity")}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {project.commits.map((commit) => (
                <li key={commit.sha} className="px-4 py-3">
                  <CommitRow
                    commit={commit}
                    author={
                      <AuthorLabel
                        resolvedUser={commit.resolvedUser ?? null}
                        gitEmail={null}
                        linkEmail={commit.authorEmail ?? null}
                        authorName={commit.authorName ?? null}
                        isAdmin={isAdmin}
                      />
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Blocco vista-dev: header con l'autore e i suoi totali, poi un sotto-blocco per
 * progetto con i relativi commit (l'autore è implicito, non ripetuto per riga).
 */
function DeveloperBlock({
  dev,
  isAdmin,
  summaryPending,
}: {
  dev: ActivityDeveloperView;
  isAdmin: boolean;
  /** Rollup dei riassunti per-dev ancora in corso (dal report a livello giorno). */
  summaryPending: boolean;
}) {
  const { t } = useTranslation();
  const { header } = dev;
  const [collapsed, setCollapsed] = useState(false);
  const panelId = useId();
  const label = dev.resolvedUser?.email ?? dev.gitEmail ?? dev.authorName ?? t("activity:unknownAuthor");
  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header
        className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${
          collapsed ? "" : "border-b border-line"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <CollapseToggle
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            panelId={panelId}
            label={label}
          />
          <h2 className="flex min-w-0 items-center">
            <AuthorLabel
              resolvedUser={dev.resolvedUser}
              gitEmail={dev.gitEmail}
              linkEmail={dev.gitEmail}
              authorName={dev.authorName}
              isAdmin={isAdmin}
            />
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
            {t("activity:commits", { count: header.commitCount })}
          </span>
          <DiffStat additions={header.additions} deletions={header.deletions} />
          <span className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">
            {t("activity:projects", { count: header.projectCount })}
          </span>
        </div>
      </header>
      {!collapsed && (
        <div id={panelId}>
          <DaySummary summary={dev.summary ?? null} pending={summaryPending} />
          <ul className="divide-y divide-line">
          {dev.byProject.map((proj) => (
            <li key={proj.project.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <h3 className="font-mono text-[13px] text-fg">{proj.project.name}</h3>
                <span className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
                  {t("activity:commits", { count: proj.commits.length })}
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {proj.commits.map((commit) => (
                  <li key={commit.sha}>
                    <CommitRow commit={commit} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Chevron toggle per collassare/espandere un blocco (progetto o sviluppatore).
 * `▾` espanso, `▸` collassato. `aria-expanded` riflette lo stato e `aria-controls`
 * punta al pannello del contenuto; l'`aria-label` è localizzata col nome del blocco.
 * Il pannello è smontato da collassato (per non renderizzare contenuto pesante),
 * quindi `aria-controls` è omesso in quello stato: puntare a un id non montato è
 * una violazione ARIA.
 */
function CollapseToggle({
  collapsed,
  onToggle,
  panelId,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  panelId: string;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={collapsed ? undefined : panelId}
      aria-label={t(collapsed ? "activity:expandBlock" : "activity:collapseBlock", {
        name: label,
      })}
      className="tap shrink-0 font-mono text-[12px] text-fg-faint transition-colors hover:text-signal"
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

/**
 * Etichetta autore: il membro Stubwise risolto (avatar + email) o, se l'email
 * git non è associata a nessun membro, l'email grezza in corsivo con un pulsante
 * "Link team member" (solo admin) che apre un picker per associarla inline (vedi
 * {@link LinkMemberControl}). In vista-dev l'email può mancare: si ripiega su
 * authorName o su un segnaposto.
 */
function AuthorLabel({
  resolvedUser,
  gitEmail,
  linkEmail,
  authorName,
  isAdmin,
}: {
  resolvedUser: ActivityResolvedUser | null;
  gitEmail: string | null;
  /** Email git da associare a un membro (link inline, solo admin). */
  linkEmail: string | null;
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
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span
        className="truncate font-mono text-[13px] text-fg-muted italic"
        title={t("activity:unresolvedTitle")}
      >
        {raw}
      </span>
      {isAdmin && linkEmail && <LinkMemberControl email={linkEmail} />}
    </span>
  );
}

/**
 * Controllo admin per associare l'email git di un autore NON risolto a un membro
 * del team, inline nella sezione Attività (sostituisce il vecchio link a /team).
 * Un pulsante apre un combobox con autocomplete sui membri (caricati solo
 * all'apertura); selezionandone uno si chiama `linkGitIdentity(memberId, email)`.
 * Al successo si invalidano per prefisso le query attività (l'autore si risolve
 * al refetch) e la lista membri; gli errori (es. 409 `git_identity_taken`) si
 * mostrano inline.
 */
function LinkMemberControl({ email }: { email: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // I membri servono solo a picker aperto: `enabled` evita N fetch quando la
  // pagina ha molti autori non risolti. Query condivisa (staleTime) con /team.
  // `isLoading` distingue "sto caricando" da "nessun membro": a cache fredda il
  // combobox mostrerebbe altrimenti il noResults durante il fetch (fuorviante).
  const { data: users, isLoading } = useQuery({ ...usersQueryOptions, enabled: picking });
  const members = users ?? [];

  const mutation = useMutation({
    mutationFn: (memberId: string) => linkGitIdentity(memberId, email),
    onSuccess: () => {
      setPicking(false);
      // Invalidazione per prefisso: rifà TUTTI i giorni cacheati (report
      // giornalieri, costo trascurabile) senza dover filare la `date` fin qui.
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: usersQueryOptions.queryKey });
    },
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  if (!picking) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setPicking(true);
        }}
        className="tap shrink-0 rounded-sm border border-line-strong px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal"
      >
        {t("activity:linkMember")}
      </button>
    );
  }

  if (isLoading) {
    return (
      <span className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">
        {t("activity:loadingMembers")}
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <ComboboxPicker<TeamUser>
        items={members}
        getKey={(u) => u.id}
        matches={(u, q) => u.email.toLowerCase().includes(q)}
        isDisabled={() => false}
        renderOption={(u) => (
          <>
            <Avatar src={u.avatarUrl} label={u.email} size={20} />
            <span className="min-w-0 truncate text-fg">{u.email}</span>
          </>
        )}
        onPick={(u) => {
          setError(null);
          mutation.mutate(u.id);
        }}
        pending={mutation.isPending}
        pendingLabel={t("activity:linking")}
        onCancel={() => setPicking(false)}
        labels={{
          pickerLabel: t("activity:pickMember"),
          placeholder: t("activity:pickMember"),
          noResults: t("activity:memberNoResults"),
          cancel: t("activity:cancel"),
          moreResults: (count) => t("activity:memberMoreResults", { count }),
        }}
      />
      {error && (
        <span role="alert" className="text-[11px] text-danger">
          {error}
        </span>
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
