import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConversations, useProjects } from "../../data/queries";
import type { ClaudeScope } from "../../data/routes";
import type { ConversationKind, ConversationRow, Outcome } from "../../data/types";
import { relativeTime } from "../../notifications/time";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { Chevron, MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { StateSign, activityText, rowStateLabel, rowStateOf, useKindWord } from "./marks";

/** I tipi che si filtrano, per elenco: le sessioni di brief e report nascono già concluse. */
const KINDS: Record<"live" | "finished", readonly ConversationKind[]> = {
  live: ["task_run", "refine", "pr_review", "docs", "mail_classify", "intake", "server_analysis"],
  finished: [
    "task_run",
    "refine",
    "pr_review",
    "docs",
    "brief",
    "daily_report",
    "mail_classify",
    "intake",
    "server_analysis",
  ],
};
const OUTCOMES: readonly Outcome[] = ["ok", "failed", "timed_out", "stopped"];

const chipClass =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8";

interface Filters {
  projectId: string | null;
  kind: ConversationKind | null;
  outcome: Outcome | null;
}
const NO_FILTERS: Filters = { projectId: null, kind: null, outcome: null };

/** Si sta scrivendo: la lettera va al campo, non alla pagina. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * Un elenco della destinazione «Claude» (`?scope=`): h1 col nome e il
 * conteggio, la frase che dice cosa raccoglie, la barra dei filtri
 * (Project, Type nelle sessioni, Outcome nelle concluse; in Mine attive o
 * archiviate), poi le righe. In «Working now» due righe da 56 px con
 * l'attività sotto il titolo, e in testa chi aspetta chi guarda; altrove
 * una riga da 44 px. J/K fra le righe, Invio apre.
 */
export function ConversationList({ scope }: { scope: ClaudeScope }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [archived, setArchived] = useState(false);
  const [includeOlder, setIncludeOlder] = useState(false);
  const query = useConversations({
    scope,
    ...(scope === "mine" && archived ? { archived: true } : {}),
    ...(scope === "finished" && includeOlder ? { includeOlder: true } : {}),
  });
  const projects = useProjects().data;
  const listRef = useRef<HTMLDivElement>(null);
  const kindWord = useKindWord();

  const all = useMemo(() => query.data ?? [], [query.data]);
  const projectOf = (row: ConversationRow) => row.projectId ?? row.contextProjectId;
  const rows = useMemo(() => {
    const kept = all.filter(
      (r) =>
        (!filters.projectId || (r.projectId ?? r.contextProjectId) === filters.projectId) &&
        (!filters.kind || r.kind === filters.kind) &&
        (!filters.outcome || r.outcome === filters.outcome),
    );
    // Chi aspetta chi guarda va in testa (il momento focale di «Working now»).
    return scope === "live"
      ? [...kept].sort((a, b) => Number(b.waitsOnViewer) - Number(a.waitsOnViewer))
      : kept;
  }, [all, filters, scope]);
  // Le scelte del filtro progetto: i progetti che compaiono nell'elenco.
  const projectOptions = useMemo(() => {
    const ids = new Set(all.map((r) => r.projectId ?? r.contextProjectId).filter(Boolean));
    return (projects ?? []).filter((p) => ids.has(p.id));
  }, [all, projects]);
  const projectFor = (id: string | null) => projects?.find((p) => p.id === id) ?? null;
  const codeOf = (id: string | null) => projectFor(id)?.code ?? null;
  const filtering = filters.projectId !== null || filters.kind !== null || filters.outcome !== null;

  // J/K fra le righe; Invio la apre (è un link). Niente scrivendo, né con
  // un dialogo o un menu aperti.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (typing(e.target) || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const key = e.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      const links = [
        ...(listRef.current?.querySelectorAll<HTMLElement>("[data-conversation-link]") ?? []),
      ];
      const at = links.indexOf(document.activeElement as HTMLElement);
      const next = at === -1 ? links[0] : links[key === "j" ? at + 1 : at - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const title = t(`claude.destination.scopes.${scope}`);
  const newConversation = () => void navigate({ to: "/claude", search: {} });

  let body;
  if (query.isError) {
    body = (
      <PageError
        message={t("claude.destination.states.error")}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (query.isPending) {
    body = <ListSkeleton live={scope === "live"} />;
  } else if (all.length === 0) {
    body = <EmptyScope scope={scope} archived={archived} onNew={newConversation} />;
  } else if (rows.length === 0) {
    body = (
      <PageEmpty
        title={t("claude.destination.states.noMatch")}
        action={
          <button type="button" className={secondaryButton} onClick={() => setFilters(NO_FILTERS)}>
            {t("claude.destination.states.clear")}
          </button>
        }
      />
    );
  } else {
    // In Mine e Public sono tutte conversazioni: il tipo non distingue nulla.
    const showKind = scope === "live" || scope === "finished";
    body = (
      <>
        <ColumnHeader showKind={showKind} />
        <div role="list" aria-label={title} data-scope={scope}>
          {rows.map((row) => (
            <ConversationListRow
              key={row.id}
              row={row}
              live={scope === "live"}
              showKind={showKind}
              project={projectFor(projectOf(row))}
              kind={kindWord(row.kind)}
              when={relativeTime(row.updatedAt, t, i18n.language)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-col gap-3 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="min-w-0 truncate text-2xl font-semibold text-ink">{title}</h1>
            {query.data && (
              <span className="num text-lg text-ink-faint">
                <span aria-hidden="true">{rows.length}</span>
                <span className="sr-only">
                  {t("claude.destination.list.count", { count: rows.length })}
                </span>
              </span>
            )}
          </div>
          <p className="max-w-[72ch] text-sm text-ink-muted">
            {t(`claude.destination.intro.${scope}`)}
          </p>
        </div>
        <div
          role="toolbar"
          aria-label={t("claude.destination.filters.label")}
          className="flex flex-wrap items-center gap-x-1 gap-y-2"
        >
          {scope === "mine" && (
            <MenuButton
              menuLabel={t("claude.destination.filters.show")}
              className={chipClass}
              label={
                <>
                  <span>{t("claude.destination.filters.show")}:</span>
                  <span className="font-medium text-ink">
                    {t(`claude.destination.filters.${archived ? "archived" : "active"}`)}
                  </span>
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <MenuGroup>
                  {(["active", "archived"] as const).map((v) => (
                    <RadioItem
                      key={v}
                      checked={archived === (v === "archived")}
                      onSelect={() => {
                        setArchived(v === "archived");
                        close();
                      }}
                    >
                      {t(`claude.destination.filters.${v}`)}
                    </RadioItem>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
          )}
          <FilterMenu
            label={t("claude.destination.filters.project")}
            value={filters.projectId}
            options={projectOptions.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
            valueLabel={(v) => codeOf(v) ?? ""}
            onChange={(projectId) => setFilters((f) => ({ ...f, projectId }))}
          />
          {(scope === "live" || scope === "finished") && (
            <FilterMenu
              label={t("claude.destination.filters.type")}
              value={filters.kind}
              options={KINDS[scope].map((k) => ({ value: k, label: kindWord(k) }))}
              valueLabel={(v) => kindWord(v)}
              onChange={(kind) => setFilters((f) => ({ ...f, kind }))}
            />
          )}
          {scope === "finished" && (
            <FilterMenu
              label={t("claude.destination.filters.outcome")}
              value={filters.outcome}
              options={OUTCOMES.map((o) => ({
                value: o,
                label: t(`claude.destination.outcomes.${o}`),
              }))}
              valueLabel={(v) => t(`claude.destination.outcomes.${v}`)}
              onChange={(outcome) => setFilters((f) => ({ ...f, outcome }))}
            />
          )}
          {filtering && rows.length > 0 && (
            <button type="button" className={quietButton} onClick={() => setFilters(NO_FILTERS)}>
              {t("claude.destination.states.clear")}
            </button>
          )}
        </div>
      </header>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-8">
        {body}
        {scope === "finished" && query.data && !includeOlder && (
          <div className="px-4 pt-3">
            <button type="button" className={quietButton} onClick={() => setIncludeOlder(true)}>
              {t("claude.destination.filters.showOlder")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Un menu a scelta singola della barra dei filtri, con «Any» per toglierlo. */
function FilterMenu<V extends string>({
  label,
  value,
  options,
  valueLabel,
  onChange,
}: {
  label: string;
  value: V | null;
  options: { value: V; label: string }[];
  valueLabel: (value: V) => string;
  onChange: (value: V | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <MenuButton
      menuLabel={label}
      className={chipClass}
      label={
        <>
          <span>{label}:</span>
          <span className="font-medium text-ink">
            {value === null ? t("claude.destination.filters.any") : valueLabel(value)}
          </span>
          <Chevron />
        </>
      }
    >
      {(close) => (
        <MenuGroup>
          <RadioItem
            checked={value === null}
            onSelect={() => {
              onChange(null);
              close();
            }}
          >
            {t("claude.destination.filters.any")}
          </RadioItem>
          {options.map((o) => (
            <RadioItem
              key={o.value}
              checked={value === o.value}
              onSelect={() => {
                onChange(o.value);
                close();
              }}
            >
              {o.label}
            </RadioItem>
          ))}
        </MenuGroup>
      )}
    </MenuButton>
  );
}

/**
 * Una riga: segno e parola dello stato · tipo · codice e titolo · progetto ·
 * attività o esito · tempo. Tutta la riga è il link alla conversazione.
 * Sotto 1280 px il tipo cade nel `title` e il tempo si accorcia.
 */
/**
 * Le testate delle colonne, come negli altri elenchi del catalogo: dicono
 * cosa c'è in ogni colonna, non ordinano. Stesse larghezze e stessi punti di
 * rottura delle righe; ferme in alto mentre l'elenco scorre.
 */
function ColumnHeader({ showKind }: { showKind: boolean }) {
  const { t } = useTranslation();
  const cell = "shrink-0 truncate text-xs font-medium text-ink-faint";
  const h = (key: string) => t(`claude.destination.list.headers.${key}`);
  return (
    <div
      aria-hidden="true"
      data-list-header
      className="sticky top-0 z-10 flex h-8 items-center gap-3 border-b border-rule bg-ground pr-4 pl-4"
    >
      <span className="w-3 shrink-0" />
      {showKind && <span className={`${cell} hidden w-[104px] min-[1280px]:block`}>{h("type")}</span>}
      <span className={`${cell} min-w-0 flex-1`}>{h("title")}</span>
      <span className={`${cell} ${PROJECT_COLUMN}`}>{h("project")}</span>
      <span className={`${cell} hidden w-[200px] min-[1100px]:block`}>{h("status")}</span>
      <span className={`${cell} w-[72px] text-right`}>{h("when")}</span>
    </div>
  );
}

/** La colonna del progetto: codice e nome, come ovunque si cita un progetto. */
const PROJECT_COLUMN = "w-[132px] min-[1280px]:w-[168px]";

function ConversationListRow({
  row,
  live,
  showKind,
  project,
  kind,
  when,
}: {
  row: ConversationRow;
  live: boolean;
  showKind: boolean;
  project: { code: string; name: string } | null;
  kind: string;
  when: string;
}) {
  const { t } = useTranslation();
  const state = rowStateOf(row);
  const stateLabel = state ? rowStateLabel(state, t) : null;
  const activity = activityText(row, t);
  const title = row.title || t("claude.destination.page.untitled");
  // A destra: in «Working now» lo stato (l'attività sta sotto il titolo);
  // altrove l'attività se Claude lavora, se no lo stato o l'esito. «Public» lo
  // dice la parola nella colonna dello stato: un segno solo, niente globo davanti.
  const right = live ? stateLabel : (activity ?? stateLabel);
  const tone =
    state === "failed"
      ? "text-critical"
      : state === "timed_out"
        ? "text-warning"
        : state === "waitingOnYou"
          ? "font-semibold text-ink"
          : "text-ink-muted";

  return (
    <div role="listitem" data-conversation-row={row.id} data-state={state ?? undefined}>
      <Link
        to="/claude/$id"
        params={{ id: row.id }}
        data-conversation-link
        title={[kind, title, stateLabel].filter(Boolean).join(" · ")}
        className={`group relative flex min-w-0 border-b border-rule pr-4 pl-4 outline-offset-[-2px] transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:bg-ink/6 ${live ? "h-14 flex-col justify-center gap-0.5" : "h-11 items-center"}`}
      >
        <span className="flex w-full min-w-0 items-center gap-3">
          <span className="grid w-3 shrink-0 place-items-center">
            <StateSign state={state === "public" ? null : state} />
          </span>
          {/* Sotto 1100 px la colonna dello stato non c'è: la parola resta qui. */}
          {stateLabel && !live && (
            <span className="sr-only min-[1100px]:hidden">
              {stateLabel}
            </span>
          )}
          {showKind && (
            <span className="hidden w-[104px] shrink-0 truncate text-sm text-ink-muted min-[1280px]:block">
              {kind}
            </span>
          )}
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            {row.objectCode && (
              <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                {row.objectCode}
              </span>
            )}
            <span className="min-w-0 truncate text-md text-ink">{title}</span>
          </span>
          <span
            data-row-project
            title={project ? `${project.code} · ${project.name}` : undefined}
            className={`flex min-w-0 shrink-0 items-baseline gap-1.5 ${PROJECT_COLUMN}`}
          >
            {project && (
              <>
                <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
                  {project.code}
                </span>
                <span className="min-w-0 truncate text-sm text-ink-muted">{project.name}</span>
              </>
            )}
          </span>
          {right && (
            <span
              className={`hidden w-[200px] shrink-0 truncate text-sm min-[1100px]:block ${live ? tone : activity ? "text-ink-muted" : tone}`}
            >
              {right}
            </span>
          )}
          {!right && <span className="hidden w-[200px] shrink-0 min-[1100px]:block" />}
          <span className="num w-[72px] shrink-0 truncate text-right text-sm text-ink-faint">
            {when}
          </span>
        </span>
        {live && (
          <span className="flex min-h-[18px] w-full min-w-0 items-center gap-3 pl-6">
            <span className="hidden w-[104px] shrink-0 min-[1280px]:block" aria-hidden="true" />
            <span className="min-w-0 truncate text-sm text-ink-muted">
              {activity ?? (
                // Senza un'attività lo stato basta, ed è già nella sua colonna.
                <span className={`${tone} min-[1100px]:hidden`}>{stateLabel}</span>
              )}
            </span>
            {/* Sotto 1100 px lo stato non ha colonna: resta qui, in parola. */}
            {stateLabel && activity && (
              <span className={`shrink-0 text-sm min-[1100px]:hidden ${tone}`}>
                · {stateLabel}
              </span>
            )}
          </span>
        )}
      </Link>
    </div>
  );
}

/** Otto righe finte con la forma dell'elenco; in «Working now» da 56 px. */
function ListSkeleton({ live }: { live: boolean }) {
  const { t } = useTranslation();
  const widths = ["58%", "44%", "66%", "38%", "52%", "61%", "47%", "55%"];
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {widths.map((w, i) => (
        <div
          key={i}
          data-skeleton-row
          className={`flex items-center gap-3 border-b border-rule px-4 ${live ? "h-14" : "h-11"}`}
        >
          <span className="size-3 shrink-0 rounded-full bg-ink/8" />
          <span className="h-2.5 w-20 shrink-0 rounded-sm bg-ink/8" />
          <span className="min-w-0 flex-1">
            <span className="block h-2.5 rounded-sm bg-ink/8" style={{ width: w }} />
          </span>
          <span className="h-2.5 w-16 shrink-0 rounded-sm bg-ink/8" />
        </div>
      ))}
    </div>
  );
}

function EmptyScope({
  scope,
  archived,
  onNew,
}: {
  scope: ClaudeScope;
  archived: boolean;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  if (scope === "mine") {
    if (archived) return <PageEmpty title={t("claude.destination.states.emptyArchived")} />;
    return (
      <PageEmpty
        title={t("claude.destination.states.emptyMine")}
        body={t("claude.destination.states.emptyMineBody")}
        action={
          <button type="button" className={primaryButton} onClick={onNew}>
            {t("claude.destination.column.new")}
          </button>
        }
      />
    );
  }
  if (scope === "live") {
    return (
      <PageEmpty
        title={t("claude.destination.states.emptyLive")}
        body={t("claude.destination.states.emptyLiveBody")}
      />
    );
  }
  if (scope === "public") return <PageEmpty title={t("claude.destination.states.emptyPublic")} />;
  return <PageEmpty title={t("claude.destination.states.emptyFinished")} />;
}
