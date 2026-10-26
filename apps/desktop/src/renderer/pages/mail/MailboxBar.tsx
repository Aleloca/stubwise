import { useLinkProps, useRouterState } from "@tanstack/react-router";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useGoogleAccount, useMailboxes, useMailThreads, useProjects } from "../../data/queries";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { NO_PROJECT, type MailSearch } from "./mailFilters";
import { SyncLine } from "./SyncStatus";

// La colonna della destinazione «Mail» (shape mail.md §3, A3): nessun
// titolo (il nome è l'h1). VIEWS — All mail, Important, No project; MAILBOXES
// — le mie caselle con lo stato di allineamento, «All mailboxes» in testa
// quando sono due o più; PROJECTS — i progetti delle mie email, dalla più
// recente, i primi 8 e «Show all N». In fondo «Google account». Sono
// scorciatoie dei filtri dell'elenco: stessa ricerca nell'indirizzo.

/** Quanti progetti stanno in colonna prima di «Show all». */
export const COLUMN_PROJECTS = 8;

type Scope = Pick<MailSearch, "mailbox" | "importance" | "project">;

function ScopeLink({
  search,
  current,
  count,
  countLabel,
  children,
  secondLine,
}: {
  search: Scope;
  current: boolean;
  count?: number | undefined;
  countLabel?: string | undefined;
  children: ReactNode;
  secondLine?: ReactNode;
}) {
  const props = useLinkProps({ to: "/mail", search: search as never });
  return (
    <a
      {...props}
      aria-current={current ? "page" : undefined}
      style={{ whiteSpace: "nowrap" }}
      className={`${columnItemClass} ${secondLine ? "h-auto min-h-8 py-1.5" : ""}`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span style={ONE_LINE} className="min-w-0">
          {children}
        </span>
        {secondLine}
      </span>
      {count !== undefined && count > 0 && (
        <span className="num shrink-0 text-xs text-ink-faint">
          <span aria-hidden="true">{count}</span>
          {countLabel && <span className="sr-only">{countLabel}</span>}
        </span>
      )}
    </a>
  );
}

export function MailboxBar() {
  const { t } = useTranslation();
  const search = useRouterState({ select: (s) => s.location.search as MailSearch });
  const account = useGoogleAccount();
  const connected = !!account.data;
  const boxes = useMailboxes().data ?? [];
  const rows = useMailThreads({}, { enabled: connected }).data;
  const projects = useProjects().data;
  const [allProjects, setAllProjects] = useState(false);
  const boxesId = useId();
  const projectsId = useId();

  const unread = rows?.filter((r) => r.unread > 0).length;
  const importantUnread = rows?.filter((r) => r.importance === "high" && r.unread > 0).length;
  // I progetti delle mie email, dalla conversazione più recente; i non letti accanto.
  const mailProjects = useMemo(() => {
    const seen = new Map<string, { last: string; unread: number }>();
    for (const r of rows ?? []) {
      for (const id of r.projectIds) {
        const s = seen.get(id) ?? { last: r.lastAt, unread: 0 };
        if (r.lastAt > s.last) s.last = r.lastAt;
        s.unread += r.unread > 0 ? 1 : 0;
        seen.set(id, s);
      }
    }
    return [...seen.entries()]
      .flatMap(([id, s]) => {
        const p = projects?.find((x) => x.id === id);
        return p ? [{ project: p, ...s }] : [];
      })
      .sort((a, b) => b.last.localeCompare(a.last) || a.project.code.localeCompare(b.project.code));
  }, [rows, projects]);
  const shownProjects = allProjects ? mailProjects : mailProjects.slice(0, COLUMN_PROJECTS);

  const only = (key: keyof Scope | null) =>
    (["mailbox", "importance", "project"] as const).every((k) => (k === key ? !!search[k] : !search[k]));
  const unreadLabel = (count: number | undefined) =>
    count ? t("mail.column.unread", { count }) : undefined;

  return (
    <nav
      aria-label={t("column.viewsOf", { name: t("nav.mail") })}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3 pb-2"
    >
      {connected && (
        <>
          <ul className="flex flex-col gap-px">
            <li>
              <ScopeLink search={{}} current={only(null)} count={unread} countLabel={unreadLabel(unread)}>
                {t("mail.column.all")}
              </ScopeLink>
            </li>
            <li>
              <ScopeLink
                search={{ importance: "high" }}
                current={only("importance") && search.importance === "high"}
                count={importantUnread}
                countLabel={unreadLabel(importantUnread)}
              >
                {t("mail.column.important")}
              </ScopeLink>
            </li>
            <li>
              <ScopeLink
                search={{ project: NO_PROJECT }}
                current={only("project") && search.project === NO_PROJECT}
              >
                {t("mail.column.noProject")}
              </ScopeLink>
            </li>
          </ul>
          {boxes.length > 0 && (
            <div className="mt-3 border-t border-rule pt-3">
              <p id={boxesId} className="heading-group px-2.5 pb-1.5">
                {t("mail.column.mailboxes")}
              </p>
              <ul aria-labelledby={boxesId} className="flex flex-col gap-px">
                {boxes.length > 1 && (
                  <li>
                    <ScopeLink search={{}} current={false}>
                      {t("mail.column.allMailboxes")}
                    </ScopeLink>
                  </li>
                )}
                {boxes.map((b) => (
                  <li key={b.email}>
                    <ScopeLink
                      search={{ mailbox: b.email }}
                      current={only("mailbox") && search.mailbox === b.email}
                      secondLine={<SyncLine box={b} />}
                    >
                      <span title={b.email}>{b.email}</span>
                    </ScopeLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {mailProjects.length > 0 && (
            <div className="mt-3 border-t border-rule pt-3">
              <p id={projectsId} className="heading-group px-2.5 pb-1.5">
                {t("mail.column.projects")}
              </p>
              <ul aria-labelledby={projectsId} className="flex flex-col gap-px">
                {shownProjects.map(({ project, unread: n }) => (
                  <li key={project.id}>
                    <ScopeLink
                      search={{ project: project.code }}
                      current={only("project") && search.project === project.code}
                      count={n}
                      countLabel={unreadLabel(n)}
                    >
                      <span className="num mr-1.5 inline-block w-9 text-xs font-semibold tracking-[0.02em] text-ink">
                        {project.code}
                      </span>
                      <span title={`${project.code} ${project.name}`}>{project.name}</span>
                    </ScopeLink>
                  </li>
                ))}
              </ul>
              {mailProjects.length > COLUMN_PROJECTS && (
                <button
                  type="button"
                  onClick={() => setAllProjects((v) => !v)}
                  className={`${columnItemClass} w-full text-ink-muted`}
                >
                  {allProjects
                    ? t("mail.column.showFewer")
                    : t("mail.column.showAll", { count: mailProjects.length })}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <div className={`${connected ? "mt-auto border-t border-rule pt-2" : ""}`}>
        <button
          type="button"
          onClick={() => openGoogleAccount()}
          className={`${columnItemClass} w-full`}
        >
          <span style={ONE_LINE} className="min-w-0 flex-1 text-left">
            {t("mail.column.googleAccount")}
          </span>
        </button>
      </div>
    </nav>
  );
}
