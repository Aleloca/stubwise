import { useLinkProps, useRouterState } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useProjects, useWorkspaces } from "../../../data/queries";
import { ONE_LINE, columnItemClass } from "../../../layout/ProjectColumn";
import { NewWorkspaceDialog } from "./dialogs";

// La colonna di «All projects» (shape `workspaces.md`, «La colonna di All
// projects»): All projects in testa, poi WORKSPACES — una voce per
// workspace, col numero dei progetti VISIBILI (R-G5, D5) —, poi «No
// workspace» se c'è almeno un progetto fuori. Ogni voce è un filtro della
// pagina (`?workspace=<slug>`, `none`). Il «+» (New workspace) solo con
// `workspaces.manage`.

type Search = { workspace?: string };

function ScopeLink({
  workspace,
  current,
  count,
  children,
}: {
  workspace: string | undefined;
  current: boolean;
  count?: number;
  children: ReactNode;
}) {
  const props = useLinkProps({ to: "/projects", search: (workspace ? { workspace } : {}) as never });
  return (
    <a
      {...props}
      aria-current={current ? "page" : undefined}
      data-workspace={workspace ?? "all"}
      className={columnItemClass}
    >
      <span style={ONE_LINE} className="min-w-0 flex-1">
        {children}
      </span>
      {count !== undefined && <span className="num shrink-0 text-xs text-ink-faint">{count}</span>}
    </a>
  );
}

export function ProjectsColumn() {
  const { t } = useTranslation();
  const search = useRouterState({ select: (s) => s.location.search as Search });
  const list = useWorkspaces();
  const projects = useProjects().data;
  const [creating, setCreating] = useState(false);
  const headingId = useId();
  const data = list.data;
  const current = search.workspace;

  return (
    <nav aria-label={t("workspaces.column.label")} className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2">
      <ul className="flex flex-col gap-px">
        <li>
          <ScopeLink workspace={undefined} current={!current} count={projects?.length}>
            {t("workspaces.column.all")}
          </ScopeLink>
        </li>
      </ul>
      {list.isError ? (
        <p role="alert" className="mt-4 px-2 text-sm text-ink-muted">
          {t("workspaces.column.error")}{" "}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            {t("workspaces.column.retry")}
          </button>
        </p>
      ) : !data ? (
        <div aria-hidden="true" className="mt-4 flex flex-col gap-2 px-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 rounded bg-ink/6" />
          ))}
        </div>
      ) : data.workspaces.length === 0 ? (
        data.canManage && (
          <div className="mt-4 flex flex-col items-start gap-2 px-2">
            <p className="text-sm text-ink-muted">{t("workspaces.column.empty")}</p>
            <button type="button" className="text-sm font-semibold text-ink underline" onClick={() => setCreating(true)}>
              {t("workspaces.new")}
            </button>
          </div>
        )
      ) : (
        <>
          <div className="mt-4 flex h-7 items-center justify-between pr-1 pl-2">
            <h2 id={headingId} className="heading-group">
              {t("workspaces.column.heading")}
            </h2>
            {data.canManage && (
              <button
                type="button"
                aria-label={t("workspaces.new")}
                title={t("workspaces.new")}
                onClick={() => setCreating(true)}
                className="inline-flex size-6 items-center justify-center rounded text-ink-muted hover:bg-ink/6 hover:text-ink"
              >
                <span aria-hidden="true">+</span>
              </button>
            )}
          </div>
          <ul aria-labelledby={headingId} className="flex flex-col gap-px">
            {data.workspaces.map((w) => (
              <li key={w.id}>
                <ScopeLink workspace={w.slug} current={current === w.slug} count={w.projectCount}>
                  {w.name}
                </ScopeLink>
              </li>
            ))}
            {data.noWorkspaceCount > 0 && (
              <li>
                <ScopeLink workspace="none" current={current === "none"} count={data.noWorkspaceCount}>
                  {t("workspaces.none")}
                </ScopeLink>
              </li>
            )}
          </ul>
        </>
      )}
      {creating && <NewWorkspaceDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}
