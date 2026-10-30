import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { aiTabsFor } from "../../../data/adminSections";
import {
  useInstanceStatus,
  useRetryJob,
  type InstanceJob,
  type InstanceStatusView,
} from "../../../data/queries";
import { WORK_KINDS, WORK_STATES } from "../../../data/routes";
import { useViewer } from "../../../data/viewer";
import { Dialog } from "../../../tasks-ui/Dialog";
import { Chip } from "../../../tasks-ui/FilterBar";
import { RadioItem } from "../../../tasks-ui/Menu";
import { useToast } from "../../../tasks-ui/Toast";
import { Segmented } from "../../automations/builder/controls";
import { formatDate } from "../../../notifications/time";
import { ErrorLine } from "../../entry/parts";
import { OpenCircleGlyph, TriangleGlyph } from "../../preferences/glyphs";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { CrossGlyph } from "../integrations/parts";
import { countsWords, QueueTable, refusalWords, whenWords } from "./QueueTable";

// Lo Stato dell'istanza (area 9b, Task 13, shape admin-instance.md
// «Instance status»): un quadro di controllo che si legge dall'alto — le
// code dei progetti (dove si agisce), poi i lavori uno per uno (dove si
// capisce), di lato le macchine e la notte [IS 1]. Due colonne quando c'è
// posto (1440), una sola a 1024 [IS 4].
//
// Si rilegge da sola ogni 10 secondi (`useInstanceStatus`): le righe nuove
// hanno lo sfondo per 2 s, quelle uscite svaniscono in 150 ms, il fuoco
// resta dov'era; `aria-live` dice solo i cambi dei conteggi di una coda e
// un lavoro fallito nuovo. Un giro che non riesce non svuota la pagina.
//
// Ogni regola sta nel livello dati: la vista dice chi può fare cosa
// (`pause`, `retry`, `retryNeeds`), quando un lavoro si ferma al piano
// (`retryStopsAtPlan`), se un fallimento è una ripartenza da tradurre
// (`startFailed`). Le sole azioni sono Pause/Resume e «Rimetti in coda»,
// sulla coda di Stubwise: niente riavvia un server, un worker o un deploy,
// e la pagina lo scrive.

type View = InstanceStatusView;
type Job = InstanceJob;

/** Gli stati e i tipi dei filtri: quelli che l'indirizzo accetta (`data/routes.ts`). */
const STATES = WORK_STATES satisfies readonly Job["state"][];
type StateFilter = (typeof STATES)[number];
/** I tipi nel menu: il giro notturno sta solo nella colonna laterale. */
const KINDS = WORK_KINDS satisfies readonly Job["kind"][];
/** Quante righe di lavori per volta (shape §5, «Show 50 more»). */
const PAGE = 50;
/** Quanto resta lo sfondo di una riga nuova, quanto svanisce una uscita. */
const FRESH_MS = 2000;
const LEAVE_MS = 150;

interface StatusSearch {
  status?: string;
  project?: string;
  kind?: string;
}

// --- parole ----------------------------------------------------------------------

/** «12 min», «2 h», «yesterday», «3 days»: rispetto all'adesso della vista. */
function ageWords(t: TFunction, since: string, reference: string): string {
  const minutes = Math.floor((Date.parse(reference) - Date.parse(since)) / 60_000);
  if (minutes < 1) return t("admin.status.age.now");
  if (minutes < 60) return t("admin.status.age.minutes", { count: minutes });
  const day = (x: string) => Date.parse(`${x.slice(0, 10)}T00:00:00Z`);
  const days = Math.round((day(reference) - day(since)) / 86_400_000);
  if (days < 1) return t("admin.status.age.hours", { count: Math.floor(minutes / 60) });
  if (days === 1) return t("admin.status.age.yesterday");
  return t("admin.status.age.days", { count: days });
}

const START_ERRORS = ["conflict", "forbidden", "monthly_budget", "status"] as const;

/**
 * La frase di un fallimento. Una ripartenza fallita porta il messaggio
 * dell'errore («conflict», «invalid: monthly_budget»): si traduce qui, a
 * lettura (Minor del Task 5); un codice che non si conosce dice solo che non
 * è partito.
 */
function failureWords(t: TFunction, summary: string | null, startFailed: boolean): string | null {
  if (!startFailed) return summary;
  const code = (summary ?? "").replace(/^invalid: /, "");
  const known = (START_ERRORS as readonly string[]).includes(code) ? code : "other";
  return t(`admin.status.work.startFailed.${known}`);
}

/** «16:00» lo stesso giorno, «Nov 2» oltre (la banda «At the limit until …» di admin-ai.md). */
function untilWords(until: string, reference: string, language: string): string {
  return until.slice(0, 10) === reference.slice(0, 10)
    ? until.slice(11, 16)
    : formatDate(until, language);
}

/**
 * L'ora dell'orologio vero, non dell'adesso del prototipo: quando QUESTA
 * finestra ha letto o ha provato a leggere. Eccezione dichiarata alla GC
 * dell'orologio (ruling T13 I3): «Updated hh:mm:ss» e «Couldn't update at…»
 * dicono un fatto del client, non del dato; l'adesso del prototipo è fermo
 * e li renderebbe inutili. Età e date dei lavori restano su `refreshedAt`.
 */
const clock = (ms: number, language: string) =>
  new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));

/** Un indirizzo del livello dati (`#/p/ACQ/tasks?task=ACQ-3`) come destinazione del router. */
function linkTo(href: string): { to: "/"; search: Record<string, string> } {
  const [path, query] = href.replace(/^#/, "").split("?");
  return {
    to: path as "/",
    search: Object.fromEntries(new URLSearchParams(query ?? "")),
  };
}

// --- glifi -----------------------------------------------------------------------

function RunningGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}

function WaitingGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

function DoneGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function StateGlyph({ state }: { state: Job["state"] | "done" }) {
  if (state === "running") return <RunningGlyph />;
  if (state === "waiting") return <WaitingGlyph />;
  if (state === "done") return <DoneGlyph />;
  return <CrossGlyph />;
}

// --- presenza delle righe -----------------------------------------------------------

interface Presence {
  job: Job;
  fresh: boolean;
  leaving: boolean;
}

/**
 * Le righe nuove e quelle uscite fra un giro e l'altro (shape «Confine,
 * aggiornamento»): una nuova ha lo sfondo per 2 s, una uscita resta 150 ms
 * per svanire. Al primo giro niente è nuovo. Si guarda l'elenco intero, non
 * quello filtrato: cambiare filtro non fa comparire né svanire niente.
 */
function usePresence(jobs: Job[] | undefined): Presence[] {
  const previous = useRef<Job[] | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<{ job: Job; index: number }[]>([]);
  // I timer stanno fuori dall'effetto: un giro nuovo entro 2 s non deve
  // cancellare quello che spegne lo sfondo di una riga del giro prima
  // (revisione T13, I4). Si cancellano solo allo smontaggio.
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    },
    [],
  );
  const later = (run: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id);
      run();
    }, ms);
    timers.current.push(id);
  };

  useEffect(() => {
    if (!jobs) return;
    const before = previous.current;
    previous.current = jobs;
    if (!before) return;
    const ids = new Set(jobs.map((j) => j.id));
    const old = new Set(before.map((j) => j.id));
    const added = jobs.filter((j) => !old.has(j.id)).map((j) => j.id);
    const gone = before.flatMap((job, index) => (ids.has(job.id) ? [] : [{ job, index }]));
    if (added.length > 0) {
      setFresh((s) => new Set([...s, ...added]));
      later(() => setFresh((s) => new Set([...s].filter((id) => !added.includes(id)))), FRESH_MS);
    }
    if (gone.length > 0) {
      setLeaving((l) => [...l.filter((x) => !ids.has(x.job.id)), ...gone]);
      later(
        () => setLeaving((l) => l.filter((x) => !gone.some((g) => g.job.id === x.job.id))),
        LEAVE_MS,
      );
    }
    // `later` scrive solo nel ref: non è una dipendenza.
  }, [jobs]);

  return useMemo(() => {
    const rows: Presence[] = (jobs ?? []).map((job) => ({
      job,
      fresh: fresh.has(job.id),
      leaving: false,
    }));
    const live = new Set(rows.map((r) => r.job.id));
    for (const { job, index } of leaving) {
      if (live.has(job.id)) continue;
      rows.splice(Math.min(index, rows.length), 0, { job, fresh: false, leaving: true });
    }
    return rows;
  }, [jobs, fresh, leaving]);
}

/**
 * Le frasi per `aria-live` (shape: solo i cambi dei conteggi di una coda e
 * un lavoro fallito nuovo, non ogni giro).
 */
function useAnnouncement(view: View | undefined): string {
  const { t } = useTranslation();
  const previous = useRef<View | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!view) return;
    const before = previous.current;
    previous.current = view;
    if (!before) return;
    const lines: string[] = [];
    for (const q of view.queues) {
      const old = before.queues.find((b) => b.projectId === q.projectId);
      const now = countsWords(t, q);
      if (old && countsWords(t, old) !== now)
        lines.push(t("admin.status.queues.announce", { code: q.code, counts: now }));
    }
    const failedBefore = new Set(before.jobs.filter((j) => j.state === "failed").map((j) => j.id));
    for (const j of view.jobs)
      if (j.state === "failed" && !failedBefore.has(j.id))
        lines.push(t("admin.status.work.announceFailed", { code: j.code ?? j.projectCode }));
    if (lines.length > 0) setMessage(lines.join(" "));
  }, [view, t]);
  return message;
}

// --- pagina ----------------------------------------------------------------------

export function InstanceStatusPage() {
  const { t, i18n } = useTranslation();
  const status = useInstanceStatus();
  const view = status.data;
  const announcement = useAnnouncement(view);

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="@container max-w-[1080px]">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">
              {t("admin.sections.status")}
            </h1>
            <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">
              {t("admin.status.intro")}
            </p>
          </div>
          {view && (
            <p className="num pt-2 text-xs text-ink-faint">
              {t("admin.status.updated", { time: clock(status.dataUpdatedAt, i18n.language) })}
            </p>
          )}
        </div>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {view && status.isRefetchError && (
          <p role="status" className="mt-3 text-xs text-ink-muted">
            {t("admin.status.updateFailed", {
              failed: clock(status.errorUpdatedAt, i18n.language),
              shown: clock(status.dataUpdatedAt, i18n.language),
            })}
          </p>
        )}
        {view ? (
          <StatusBody view={view} />
        ) : status.isError ? (
          <div className="mt-6 border-t border-rule pt-5">
            <ErrorLine
              action={
                <button
                  type="button"
                  onClick={() => void status.refetch()}
                  className={`${secondaryButton} ml-2 h-7 px-2.5`}
                >
                  {t("admin.status.loadAgain")}
                </button>
              }
            >
              {t("admin.status.loadError")}
            </ErrorLine>
          </div>
        ) : (
          <Skeleton />
        )}
        <div className="mt-10 border-t border-rule pt-4">
          <p className="flex items-start gap-1.5 text-sm text-pretty text-ink-muted">
            <span className="mt-[3px] shrink-0">
              <OpenCircleGlyph size={12} />
            </span>
            <span>{t("admin.status.boundary")}</span>
          </p>
        </div>
      </div>
    </section>
  );
}

/** Le due colonne a 1440, una sola a 1024 (con worker e account affiancati). */
function StatusBody({ view }: { view: View }) {
  return (
    <div className="mt-8 flex flex-col gap-10 @min-[960px]:flex-row @min-[960px]:gap-0">
      <div className="flex min-w-0 flex-1 flex-col gap-10 @min-[960px]:max-w-[720px] @min-[960px]:pr-8">
        <QueueTable view={view} />
        <WorkSection view={view} />
      </div>
      <aside className="grid min-w-0 grid-cols-2 gap-x-8 gap-y-10 @min-[960px]:flex @min-[960px]:w-[320px] @min-[960px]:shrink-0 @min-[960px]:flex-col @min-[960px]:border-l @min-[960px]:border-rule @min-[960px]:pl-8">
        <Workers view={view} />
        <Accounts view={view} />
        <div className="col-span-2">
          <RecentErrors view={view} />
        </div>
        <div className="col-span-2">
          <Nightly view={view} />
        </div>
      </aside>
    </div>
  );
}

function Skeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  const rows = (n: number, height: string) =>
    Array.from({ length: n }, (_, i) => (
      <div key={i} className={`flex ${height} items-center gap-3 border-b border-rule px-1`}>
        <span className={`h-2.5 w-10 ${bar}`} />
        <span className={`h-2.5 ${bar}`} style={{ width: `${30 + ((i * 17) % 30)}%` }} />
        <span className={`ml-auto h-2.5 w-14 ${bar}`} />
      </div>
    ));
  return (
    <div
      aria-busy="true"
      className="skeleton-breathe mt-8 flex flex-col gap-10 @min-[960px]:flex-row"
    >
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-10 @min-[960px]:max-w-[720px]">
        <div className="border-t border-rule">{rows(4, "h-14")}</div>
        <div className="border-t border-rule">{rows(6, "h-[52px]")}</div>
      </div>
      <div className="flex flex-col gap-3 @min-[960px]:w-[320px] @min-[960px]:pl-8">
        {[0.5, 0.7, 0.6, 0.8, 0.4].map((w) => (
          <span key={w} className={`h-2.5 ${bar}`} style={{ width: `${w * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

/** Il titolo di una parte, con l'id per `aria-labelledby` (la regione si chiama così). */
function Part({
  title,
  children,
  headingRef,
}: {
  title: string;
  children: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col">
      <h2 id={id} ref={headingRef} tabIndex={-1} className="heading-group pb-2 outline-none">
        {title}
      </h2>
      {children}
    </section>
  );
}

// --- WORK ------------------------------------------------------------------------

function WorkSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as StatusSearch;
  const [open, setOpen] = useState<null | "project" | "type">(null);
  const [shown, setShown] = useState(PAGE);
  // Il dialogo tiene il lavoro e la pausa com'erano all'apertura: il giro ogni 10
  // secondi non ne cambia il contenuto.
  const [retrying, setRetrying] = useState<{ job: Job; queuePaused: boolean } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const rows = usePresence(view.jobs);
  // Dopo la conferma di Retry il fuoco torna alla riga, non al bottone: al
  // giro dopo il bottone sparisce (il fallito è superato), la riga resta
  // (shape §6). L'effetto gira dopo che il dialogo ha restituito il fuoco.
  const [focusRow, setFocusRow] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRow) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-job-row]") ?? [])].find(
      (r) => r.dataset.jobRow === focusRow,
    );
    row?.focus();
    setFocusRow(null);
  }, [focusRow]);

  const set = (patch: StatusSearch) =>
    void navigate({
      to: ".",
      search: (prev: StatusSearch) => ({ ...prev, ...patch }),
      replace: true,
    });
  const state = (STATES as readonly string[]).includes(search.status ?? "")
    ? (search.status as StateFilter)
    : null;
  const projects = view.queues.map((q) => ({ code: q.code, name: q.name }));
  const project = projects.find((p) => p.code === search.project) ?? null;
  const kind = (KINDS as readonly string[]).includes(search.kind ?? "")
    ? (search.kind as Job["kind"])
    : null;
  const filtered = state !== null || project !== null || kind !== null;
  const matching = rows.filter(
    ({ job }) =>
      (!state || job.state === state) &&
      (!project || job.projectCode === project.code) &&
      (!kind || job.kind === kind),
  );
  const pausedIn = new Set(view.queues.filter((q) => q.paused).map((q) => q.projectId));

  return (
    <Part title={t("admin.status.work.heading")} headingRef={heading}>
      <div
        role="group"
        aria-label={t("admin.status.work.filters")}
        className="flex flex-wrap items-center gap-2 pb-3"
      >
        <Segmented<StateFilter | "all">
          label={t("admin.status.work.show")}
          value={state ?? "all"}
          options={[
            { value: "all", label: t("admin.status.work.all") },
            ...STATES.map((s) => ({ value: s, label: t(`admin.status.work.${s}`) })),
          ]}
          onChange={(v) => set({ status: v === "all" ? undefined : v })}
        />
        <Chip
          name={t("admin.status.work.project")}
          summary={project?.code ?? null}
          open={open === "project"}
          onOpenChange={(o) => setOpen(o ? "project" : null)}
          onRemove={() => set({ project: undefined })}
        >
          {projects.map((p) => (
            <RadioItem
              key={p.code}
              checked={p.code === project?.code}
              onSelect={() => {
                set({ project: p.code });
                setOpen(null);
              }}
            >
              <span className="num w-9 shrink-0 font-semibold">{p.code}</span>
              <span className="min-w-0 truncate text-ink-muted">{p.name}</span>
            </RadioItem>
          ))}
        </Chip>
        <Chip
          name={t("admin.status.work.type")}
          summary={kind ? t(`admin.status.work.kinds.${kind}`) : null}
          open={open === "type"}
          onOpenChange={(o) => setOpen(o ? "type" : null)}
          onRemove={() => set({ kind: undefined })}
        >
          {KINDS.map((k) => (
            <RadioItem
              key={k}
              checked={k === kind}
              onSelect={() => {
                set({ kind: k });
                setOpen(null);
              }}
            >
              {t(`admin.status.work.kinds.${k}`)}
            </RadioItem>
          ))}
        </Chip>
      </div>
      {view.jobs.length === 0 ? (
        <p className="border-t border-rule py-4 text-md text-ink-muted">
          {t("admin.status.work.empty")}
        </p>
      ) : matching.length === 0 ? (
        <div className="flex items-center gap-3 border-t border-rule py-4">
          <p className="text-md text-ink-muted">{t("admin.status.work.noMatch")}</p>
          {filtered && (
            <button
              type="button"
              onClick={() => set({ status: undefined, project: undefined, kind: undefined })}
              className={`${secondaryButton} h-7 px-2.5`}
            >
              {t("admin.status.work.clear")}
            </button>
          )}
        </div>
      ) : (
        <ul
          ref={list}
          aria-label={t("admin.status.work.list")}
          className="@container border-t border-rule"
        >
          {matching.slice(0, shown).map((r) => (
            <JobRow
              key={r.job.id}
              presence={r}
              reference={view.refreshedAt}
              onRetry={() =>
                setRetrying({ job: r.job, queuePaused: pausedIn.has(r.job.projectId) })
              }
              onLostFocus={() => heading.current?.focus()}
            />
          ))}
        </ul>
      )}
      {matching.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className={`${secondaryButton} mt-3 h-7 self-start px-2.5`}
        >
          {t("admin.status.work.more")}
        </button>
      )}
      {retrying && (
        <RetryDialog
          job={retrying.job}
          queuePaused={retrying.queuePaused}
          onClose={() => setRetrying(null)}
          onDone={() => setFocusRow(retrying.job.id)}
        />
      )}
    </Part>
  );
}

/** Lo stato in parole, seconda riga della riga di un lavoro. */
function StateWords({ job, reference }: { job: Job; reference: string }) {
  const { t, i18n } = useTranslation();
  if (job.state === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-ink">
        <RunningGlyph />
        {job.workerId
          ? t("admin.status.work.state.running", { n: job.workerId.slice(-1) })
          : t("admin.status.work.state.runningUnassigned")}
      </span>
    );
  }
  if (job.state === "waiting") {
    const text = !job.waiting
      ? t("admin.status.work.state.stopped")
      : job.waiting.reason === "monthly_budget"
        ? t("instanceEffects.budget.waiting")
        : t("instanceEffects.queue.waiting", { name: job.waiting.byName });
    return (
      <span className="inline-flex items-center gap-1.5 text-ink">
        <WaitingGlyph />
        {text}
      </span>
    );
  }
  const summary = failureWords(t, job.summary, job.startFailed);
  return (
    <span className="min-w-0">
      <span className="inline-flex items-center gap-1.5 font-medium text-critical">
        <CrossGlyph />
        {t("admin.status.work.state.failed", {
          when: whenWords(t, job.since, reference, i18n.language),
        })}
      </span>
      {summary && <span className="text-ink-muted"> · {summary}</span>}
    </span>
  );
}

function JobRow({
  presence: { job, fresh, leaving },
  reference,
  onRetry,
  onLostFocus,
}: {
  presence: Presence;
  reference: string;
  onRetry: () => void;
  onLostFocus: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  const titleId = useId();
  const age = ageWords(t, job.since, reference);

  // Una riga uscita che aveva il fuoco lo passa al titolo della sezione.
  const lostFocus = useRef(onLostFocus);
  lostFocus.current = onLostFocus;
  useLayoutEffect(() => {
    const row = ref.current;
    return () => {
      if (row?.contains(document.activeElement)) lostFocus.current();
    };
  }, []);

  const code = job.code ?? job.projectCode;
  const correction = job.kind === "correction" && job.state !== "running";
  return (
    <li
      ref={ref}
      data-job-row={job.id}
      data-job-state={job.state}
      data-fresh={fresh || undefined}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`flex min-h-[52px] outline-none focus-visible:bg-ink/4 flex-col justify-center gap-1 border-b border-rule px-1 py-2 transition-[background-color,opacity] ease-out motion-reduce:transition-none ${fresh ? "bg-ink/6 duration-[var(--duration-base)]" : "duration-[var(--duration-fast)]"} ${leaving ? "pointer-events-none opacity-0" : ""}`}
    >
      <div className="flex min-w-0 items-baseline gap-2.5 text-md">
        <span id={titleId} className="flex min-w-0 flex-1 items-baseline gap-2.5">
          {job.href ? (
            <Link
              {...linkTo(job.href)}
              className="num shrink-0 rounded-sm text-xs font-semibold tracking-[0.02em] text-ink underline-offset-4 hover:underline"
            >
              {code}
            </Link>
          ) : (
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
              {code}
            </span>
          )}
          <span className="shrink-0 text-ink">{t(`admin.status.work.kinds.${job.kind}`)}</span>
          <span title={job.title} className="min-w-0 truncate text-ink-muted">
            {job.title}
          </span>
        </span>
        <span className="num hidden shrink-0 text-xs text-ink-faint @min-[680px]:inline">
          {age}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 @min-[680px]:flex-row @min-[680px]:items-center @min-[680px]:gap-3">
        <p className="min-w-0 flex-1 text-sm text-pretty">
          <StateWords job={job} reference={reference} />
          <span className="num float-right ml-3 text-xs text-ink-faint @min-[680px]:hidden">
            {age}
          </span>
        </p>
        {job.state === "failed" && job.retry !== "unavailable" && (
          <button
            type="button"
            disabled={job.retry !== "allowed"}
            aria-label={t("admin.status.work.retryOf", { code })}
            title={
              job.retryNeeds
                ? t(`admin.status.work.retryNeeds.${job.retryNeeds}`, { code: job.projectCode })
                : undefined
            }
            onClick={onRetry}
            className={`${secondaryButton} h-7 self-start px-2.5 disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {t("admin.status.work.retry")}
          </button>
        )}
      </div>
      {job.retryNeeds && (
        <p className="text-xs text-pretty text-ink-muted">
          {t(`admin.status.work.retryNeeds.${job.retryNeeds}`, { code: job.projectCode })}{" "}
          <WhoCanLink
            action={job.retryNeeds}
            projectId={job.retryNeeds === "startRun" ? job.projectId : null}
            projectCode={job.retryNeeds === "startRun" ? job.projectCode : null}
          />
        </p>
      )}
      {job.superseded && (
        <p className="text-xs text-pretty text-ink-muted">
          {t("admin.status.work.superseded", { code })}
        </p>
      )}
      {correction && (
        <p className="text-xs text-pretty text-ink-muted">
          {t("admin.status.work.correctionNote")}{" "}
          {job.href && (
            <Link {...linkTo(job.href)} className="text-ink underline-offset-4 hover:underline">
              {t("admin.status.work.openTask")}
            </Link>
          )}
        </p>
      )}
    </li>
  );
}

function RetryDialog({
  job,
  queuePaused,
  onClose,
  onDone,
}: {
  job: Job;
  queuePaused: boolean;
  onClose: () => void;
  /** Dopo la conferma riuscita (il fuoco torna alla riga). */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const router = useRouter();
  const retry = useRetryJob();
  const [error, setError] = useState<string | null>(null);
  const code = job.code ?? job.projectCode;

  async function submit() {
    setError(null);
    const result = await retry.mutateAsync(job.id).catch(() => null);
    const words = refusalWords(t, result, code);
    if (words) return setError(words);
    onClose();
    onDone();
    const href = job.href;
    toast.show(t("admin.status.work.retryDialog.done", { code }), {
      action: href
        ? {
            label: t("admin.status.work.openTask"),
            run: () => router.history.push(href.replace(/^#/, "")),
          }
        : undefined,
    });
  }

  return (
    <Dialog
      title={t("admin.status.work.retryDialog.title", { code })}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" data-autofocus onClick={onClose} className={secondaryButton}>
            {t("admin.status.cancel")}
          </button>
          <button
            type="button"
            disabled={retry.isPending}
            onClick={() => void submit()}
            className={`${primaryButton} disabled:opacity-60`}
          >
            {t("admin.status.work.retryDialog.confirm")}
          </button>
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-2 pl-5 text-md text-pretty text-ink marker:text-ink-faint">
        <li>{t("admin.status.work.retryDialog.again")}</li>
        {job.retryStopsAtPlan && (
          <li>{t("admin.status.work.retryDialog.plan", { project: job.projectCode })}</li>
        )}
        {queuePaused && (
          <li>{t("admin.status.work.retryDialog.paused", { project: job.projectCode })}</li>
        )}
      </ul>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

// --- colonna laterale --------------------------------------------------------------

function Workers({ view }: { view: View }) {
  const { t } = useTranslation();
  return (
    <Part title={t("admin.status.workers.heading")}>
      <ul className="border-t border-rule">
        {view.workers.map((w, i) => {
          const job = w.jobId ? view.jobs.find((j) => j.id === w.jobId) : undefined;
          return (
            <li
              key={w.id}
              className="flex min-h-11 flex-col justify-center border-b border-rule py-1.5 text-sm"
            >
              <span className="font-medium text-ink">
                {t("admin.status.workers.name", { n: i + 1 })}
              </span>
              <span className="min-w-0 text-ink-muted">
                {job ? (
                  <>
                    <span className="num text-xs font-semibold tracking-[0.02em] text-ink">
                      {job.code ?? job.projectCode}
                    </span>{" "}
                    {t(`admin.status.work.kinds.${job.kind}`)}
                    <span className="text-ink-faint"> · </span>
                    <span className="num">{ageWords(t, job.since, view.refreshedAt)}</span>
                  </>
                ) : w.hidden ? (
                  t("admin.status.workers.hidden")
                ) : (
                  t("admin.status.workers.idle")
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-ink-faint">{t("admin.status.workers.prototype")}</p>
    </Part>
  );
}

function Accounts({ view }: { view: View }) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const opensProviders = aiTabsFor(viewer).includes("providers");
  return (
    <Part title={t("admin.status.accounts.heading")}>
      {view.quota.length === 0 ? (
        <p className="border-t border-rule py-3 text-sm text-ink-muted">
          {t("admin.status.accounts.empty")}
        </p>
      ) : (
        <ul className="border-t border-rule">
          {view.quota.map((a) => (
            <li
              key={a.providerId}
              className="flex min-h-11 items-center gap-3 border-b border-rule py-1.5 text-sm"
            >
              <span title={a.name} className="min-w-0 flex-1 truncate text-ink">
                {a.name}
              </span>
              <span className="shrink-0 text-right">
                {!a.enabled ? (
                  <span className="text-ink-faint">{t("admin.status.accounts.off")}</span>
                ) : !a.quota ? (
                  <span className="text-ink-muted">{t("admin.status.accounts.apiKey")}</span>
                ) : a.quota.band === "near" ? (
                  <span className="inline-flex items-center gap-1 font-medium text-warning">
                    <TriangleGlyph size={12} />
                    <span className="num">
                      {t("admin.status.accounts.near", { pct: a.quota.weeklyPct })}
                    </span>
                  </span>
                ) : a.quota.band === "limited" && a.quota.limitedUntil ? (
                  <span className="inline-flex items-center gap-1.5 font-medium text-critical">
                    <span aria-hidden="true" className="size-2 rounded-full bg-critical" />
                    <span className="num">
                      {t("admin.status.accounts.limited", {
                        when: untilWords(a.quota.limitedUntil, view.refreshedAt, i18n.language),
                      })}
                    </span>
                  </span>
                ) : (
                  <span className="num text-ink-muted">
                    {t("admin.status.accounts.week", { pct: a.quota.weeklyPct })}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {opensProviders && (
        <Link
          to="/admin/$section"
          params={{ section: "ai" }}
          search={{ tab: "providers" }}
          className="mt-2 self-start rounded-sm text-sm text-ink underline-offset-4 hover:underline"
        >
          {t("admin.status.accounts.open")}
        </Link>
      )}
    </Part>
  );
}

function RecentErrors({ view }: { view: View }) {
  const { t, i18n } = useTranslation();
  return (
    <Part title={t("admin.status.errors.heading")}>
      {view.errors.length === 0 ? (
        <p className="border-t border-rule py-3 text-sm text-ink-muted">
          {t("admin.status.errors.empty")}
        </p>
      ) : (
        <ul className="border-t border-rule">
          {view.errors.map((e) => {
            const job = view.jobs.find((j) => j.id === e.jobId);
            const code = job?.code ?? job?.projectCode ?? "";
            const run = job?.kind === "automation";
            const open = t(run ? "admin.status.work.openRun" : "admin.status.work.openTask");
            return (
              <li key={e.jobId} className="flex flex-col gap-1 border-b border-rule py-2.5 text-sm">
                <span className="flex items-baseline gap-2">
                  <span className="num text-xs text-ink-faint">
                    {whenWords(t, e.at, view.refreshedAt, i18n.language)}
                  </span>
                  <span className="num text-xs font-semibold tracking-[0.02em] text-ink">
                    {code}
                  </span>
                </span>
                <span className="line-clamp-2 text-pretty text-ink-muted">
                  {failureWords(t, e.summary, e.startFailed)}
                </span>
                {e.href && (
                  <Link
                    {...linkTo(e.href)}
                    aria-label={`${open} ${code}`}
                    className="self-start rounded-sm text-sm text-ink underline-offset-4 hover:underline"
                  >
                    {open}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Part>
  );
}

function Nightly({ view }: { view: View }) {
  const { t } = useTranslation();
  return (
    <Part title={t("admin.status.nightly.heading")}>
      {view.nightly.length === 0 ? (
        <p className="border-t border-rule py-3 text-sm text-ink-muted">
          {t("admin.status.nightly.empty")}
        </p>
      ) : (
        <ul className="border-t border-rule">
          {view.nightly.map((r) => (
            <li key={r.id} className="flex flex-col gap-0.5 border-b border-rule py-2 text-sm">
              <span className="flex flex-wrap items-center gap-x-1.5">
                <span className="font-medium text-ink">{r.repositoryName}</span>
                <span className="text-ink-faint">·</span>
                <span className="text-ink-muted">
                  {t(`admin.status.nightly.phases.${r.phase}`)}
                </span>
                <span className="text-ink-faint">·</span>
                <span
                  className={`inline-flex items-center gap-1 ${r.state === "failed" ? "font-medium text-critical" : "text-ink"}`}
                >
                  <StateGlyph state={r.state} />
                  {t(`admin.status.nightly.states.${r.state}`)}
                </span>
              </span>
              {r.summary && <span className="text-pretty text-ink-muted">{r.summary}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-pretty text-ink-faint">{t("admin.status.nightly.note")}</p>
    </Part>
  );
}
