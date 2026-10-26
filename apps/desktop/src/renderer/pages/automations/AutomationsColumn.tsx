import { useLinkProps, useRouterState } from "@tanstack/react-router";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAutomationRuns, useAutomations, useProjects } from "../../data/queries";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { CreateAutomationDialog } from "./CreateAutomationDialog";
import { isFinished } from "./format";
import { useAttention, useAutomationPerms } from "./shared";

// La colonna della destinazione Automations (shape automations.md §3): «New
// automation» (con il permesso), le viste — All automations, Runs in
// progress, Needs attention (col punto «ti aspetta»), Drafts — poi Sources
// (solo con `integrations.manage`) e i progetti come scorciatoie del filtro
// (General solo col permesso d'istanza). Il nome della destinazione è l'h1.

type Search = Record<string, string | undefined>;

function ColumnLink({
  to = "/automations",
  search,
  current,
  count,
  dot,
  children,
}: {
  to?: string;
  search: Search;
  current: boolean;
  count?: number;
  dot?: string;
  children: ReactNode;
}) {
  const props = useLinkProps({ to, search: search as never });
  return (
    <a
      {...props}
      aria-current={current ? "page" : undefined}
      style={{ whiteSpace: "nowrap" }}
      className={columnItemClass}
    >
      <span style={ONE_LINE} className="min-w-0 flex-1">
        {children}
      </span>
      {dot && (
        <>
          <span
            aria-hidden="true"
            data-waiting-dot
            className="size-2 shrink-0 rounded-full bg-ink"
          />
          <span className="sr-only">{dot}</span>
        </>
      )}
      {count !== undefined && count > 0 && (
        <span className="num shrink-0 text-xs text-ink-faint">{count}</span>
      )}
    </a>
  );
}

export function AutomationsColumn() {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  const location = useRouterState({ select: (s) => s.location });
  const search = location.search as Search;
  const onList = location.pathname === "/automations";
  const automations = useAutomations().data;
  const runs = useAutomationRuns().data;
  const projects = useProjects().data;
  const attention = useAttention();
  const projectsId = useId();
  const [creating, setCreating] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of automations ?? [])
      m.set(a.projectId ?? "", (m.get(a.projectId ?? "") ?? 0) + 1);
    return m;
  }, [automations]);
  const listed = (projects ?? [])
    .filter((p) => counts.has(p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
  const only = (keys: string[]) =>
    onList &&
    ["view", "status", "project", "general", "owner", "automation", "mine"].every((k) =>
      keys.includes(k) ? search[k] !== undefined : search[k] === undefined,
    );
  const running = (runs ?? []).filter((r) => !isFinished(r.status)).length;
  const drafts = (automations ?? []).filter((a) => a.status === "draft" && a.permissions.manage);

  return (
    <nav
      aria-label={t("automations.column.label")}
      className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2"
    >
      {perms.anywhere && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mb-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 active:opacity-80"
        >
          {t("automations.actions.new")}
        </button>
      )}
      <ul className="flex flex-col gap-px">
        <li>
          <ColumnLink search={{}} current={only([])} count={automations?.length}>
            {t("automations.column.all")}
          </ColumnLink>
        </li>
        <li>
          <ColumnLink
            search={{ view: "runs" }}
            current={only(["view"]) && search.view === "runs"}
            count={running}
          >
            {t("automations.column.runs")}
          </ColumnLink>
        </li>
        <li>
          <ColumnLink
            search={{ view: "attention" }}
            current={only(["view"]) && search.view === "attention"}
            count={attention.count}
            dot={attention.waitingMe.size > 0 ? t("automations.column.waitingYou") : undefined}
          >
            {t("automations.column.attention")}
          </ColumnLink>
        </li>
        {perms.anywhere && (
          <li>
            <ColumnLink
              search={{ status: "draft" }}
              current={only(["status"]) && search.status === "draft"}
              count={drafts.length}
            >
              {t("automations.column.drafts")}
            </ColumnLink>
          </li>
        )}
      </ul>
      {perms.integrations && (
        <ul className="mt-3 flex flex-col gap-px border-t border-rule pt-3">
          <li>
            <ColumnLink
              to="/automations/sources"
              search={{}}
              current={location.pathname === "/automations/sources"}
            >
              {t("automations.column.sources")}
            </ColumnLink>
          </li>
        </ul>
      )}
      {(listed.length > 0 || (perms.instance && counts.has(""))) && (
        <div className="mt-3 border-t border-rule pt-3">
          <p id={projectsId} className="heading-group px-2.5 pb-1.5">
            {t("automations.column.projects")}
          </p>
          <ul aria-labelledby={projectsId} className="flex flex-col gap-px">
            {perms.instance && counts.has("") && (
              <li>
                <ColumnLink
                  search={{ general: "1" }}
                  current={only(["general"])}
                  count={counts.get("")}
                >
                  {t("automations.general")}
                </ColumnLink>
              </li>
            )}
            {listed.map((p) => (
              <li key={p.id}>
                <ColumnLink
                  search={{ project: p.code }}
                  current={only(["project"]) && search.project === p.code}
                  count={counts.get(p.id)}
                >
                  <span className="num mr-1.5 inline-block w-9 text-xs font-semibold tracking-[0.02em] text-ink">
                    {p.code}
                  </span>
                  {p.name}
                </ColumnLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      {creating && <CreateAutomationDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}
