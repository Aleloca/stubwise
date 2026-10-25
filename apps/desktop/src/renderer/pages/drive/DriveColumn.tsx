import { useLinkProps, useRouterState } from "@tanstack/react-router";
import { useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDriveFiles, usePinnedProjects, useProjects, useSessionPersonId } from "../../data/queries";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import type { DriveSearch } from "./driveFilters";

// La colonna della destinazione «Drive» (A3): All files, Added by me, Google,
// poi PROJECTS — i progetti fissati e quelli con file, col conteggio — come
// scorciatoie dei filtri dell'elenco (stessa ricerca nell'indirizzo). Il
// nome della destinazione è l'h1: qui non si ripete.

type Scope = Pick<DriveSearch, "addedBy" | "source" | "prj">;

function ScopeLink({
  search,
  current,
  count,
  children,
}: {
  search: Scope;
  current: boolean;
  count?: number;
  children: ReactNode;
}) {
  const props = useLinkProps({ to: "/drive", search: search as never });
  return (
    <a {...props} aria-current={current ? "page" : undefined} style={{ whiteSpace: "nowrap" }} className={columnItemClass}>
      <span style={ONE_LINE} className="min-w-0 flex-1">
        {children}
      </span>
      {count !== undefined && <span className="num shrink-0 text-xs text-ink-faint">{count}</span>}
    </a>
  );
}

export function DriveColumn() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const search = useRouterState({ select: (s) => s.location.search as DriveSearch });
  const files = useDriveFiles({ sort: "name" }).data;
  const projects = useProjects().data;
  const pinned = usePinnedProjects().data;
  const projectsId = useId();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files ?? []) m.set(f.projectId, (m.get(f.projectId) ?? 0) + 1);
    return m;
  }, [files]);
  // I fissati per primi (nel loro ordine), poi gli altri con file, per codice.
  const listed = useMemo(() => {
    const pinnedIds = (pinned ?? []).map((p) => p.id);
    const others = (projects ?? [])
      .filter((p) => counts.has(p.id) && !pinnedIds.includes(p.id))
      .sort((a, b) => a.code.localeCompare(b.code));
    return [...(pinned ?? []), ...others];
  }, [pinned, projects, counts]);

  const onlyFilter = (key: keyof Scope) =>
    (["addedBy", "source", "prj"] as const).every((k) => (k === key ? !!search[k] : !search[k]));
  const none = !search.addedBy && !search.source && !search.prj;

  return (
    <nav
      aria-label={t("drive.column.label")}
      className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2"
    >
      <ul className="flex flex-col gap-px">
        <li>
          <ScopeLink search={{}} current={none} count={files?.length}>
            {t("drive.column.all")}
          </ScopeLink>
        </li>
        <li>
          <ScopeLink search={{ addedBy: me }} current={onlyFilter("addedBy") && search.addedBy === me}>
            {t("drive.column.mine")}
          </ScopeLink>
        </li>
        <li>
          <ScopeLink search={{ source: "google" }} current={onlyFilter("source") && search.source === "google"}>
            {t("drive.column.google")}
          </ScopeLink>
        </li>
      </ul>
      {listed.length > 0 && (
        <div className="mt-3 border-t border-rule pt-3">
          <p id={projectsId} className="heading-group px-2.5 pb-1.5">
            {t("drive.column.projects")}
          </p>
          <ul aria-labelledby={projectsId} className="flex flex-col gap-px">
            {listed.map((p) => (
              <li key={p.id}>
                <ScopeLink
                  search={{ prj: p.code }}
                  current={onlyFilter("prj") && search.prj === p.code}
                  count={counts.get(p.id) ?? 0}
                >
                  <span className="num mr-1.5 inline-block w-9 text-xs font-semibold tracking-[0.02em] text-ink">{p.code}</span>
                  {p.name}
                </ScopeLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
