import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useProject, useRequests } from "../../data/queries";
import type { ProjectRequest, RequestStatus } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { OPEN_REQUEST_STATUSES } from "../../domain/requests";
import { inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { Avatar } from "../../tasks-ui/PersonChip";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { RequestStatusLabel, UrgencyMark } from "./marks";

/** L'ordine dei gruppi dell'elenco: prima ciò su cui si lavora ancora. */
export const REQUEST_STATUSES: readonly RequestStatus[] = [
  "new",
  "refining",
  "ready",
  "converted",
  "archived",
];

type StatusFilter = "open" | "all" | RequestStatus;
// Nel menu: prima «Open» e «All», poi i singoli stati.
const STATUS_FILTER_GROUPS: readonly (readonly StatusFilter[])[] = [["open", "all"], REQUEST_STATUSES];

function matchesStatus(request: ProjectRequest, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return OPEN_REQUEST_STATUSES.includes(request.status);
  return request.status === filter;
}

function matchesText(request: ProjectRequest, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return `${request.title}\n${request.description}`.toLowerCase().includes(q);
}

/**
 * «Requests» di un progetto (il backlog di prima, rinominato): le idee e i
 * bisogni che chiunque nel progetto può mandare, e che il team trasforma in
 * task. Testata come Tasks (h1 col conteggio, sotto una riga che spiega a
 * cosa serve la pagina), riga dei comandi (stato, ricerca, «New request»
 * con `backlog.create`), poi l'elenco raggruppato per stato. Clic su una
 * richiesta → `?request=<id>`: il pannello lo monta il layout.
 */
export function RequestsPage({ projectCode }: { projectCode: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { request?: string };
  const project = useProject(projectCode).data ?? undefined;
  const query = useRequests(project?.id ?? "");
  const requests = project ? query.data : undefined;
  const [status, setStatus] = useState<StatusFilter>("open");
  const [text, setText] = useState("");
  const searchId = useId();

  const canCreate = !!project && can(viewer, "backlog.create", project.id);
  const filtered = useMemo(
    () =>
      (requests ?? []).filter((r) => matchesStatus(r, status) && matchesText(r, text)),
    [requests, status, text],
  );
  const byId = useMemo(() => new Map((requests ?? []).map((r) => [r.id, r])), [requests]);

  const setSearch = (patch: Record<string, unknown>) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
    } as never);
  const open = (r: ProjectRequest) => setSearch({ request: r.id, task: undefined });
  const newRequest = () => setSearch({ newRequest: projectCode });
  const clear = () => {
    setStatus("all");
    setText("");
  };

  let body;
  if (query.isError) {
    body = <PageError message={t("requests.states.error")} onRetry={() => void query.refetch()} />;
  } else if (!requests) {
    body = <PageSkeleton rows={6} />;
  } else if (requests.length === 0) {
    body = (
      <PageEmpty
        title={t("requests.states.emptyTitle")}
        body={
          canCreate
            ? t("requests.states.emptyBody", { project: project?.name })
            : t("requests.states.emptyWho", { project: project?.name })
        }
        action={
          canCreate ? (
            <button type="button" className={primaryButton} onClick={newRequest}>
              {t("requests.new")}
            </button>
          ) : undefined
        }
      />
    );
  } else if (filtered.length === 0) {
    body = (
      <PageEmpty
        title={t("requests.states.noMatchTitle")}
        body={t("requests.states.noMatchBody")}
        action={
          <button type="button" className={secondaryButton} onClick={clear}>
            {t("requests.states.clear")}
          </button>
        }
      />
    );
  } else {
    body = REQUEST_STATUSES.map((s) => {
      const rows = filtered
        .filter((r) => r.status === s)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (rows.length === 0) return null;
      const label = t(`requests.status.${s}`);
      return (
        <section key={s} aria-labelledby={`requests-${s}`}>
          <h2 id={`requests-${s}`} className="heading-group flex h-9 items-end gap-2 pb-2 pl-4">
            <span className="min-w-0 truncate">{label}</span>
            <span className="num font-normal tracking-normal text-ink-faint">{rows.length}</span>
          </h2>
          <div role="list" aria-label={label}>
            {rows.map((r) => (
              <RequestRow
                key={r.id}
                request={r}
                related={byId.get(r.mergedIntoId ?? r.similarToId ?? "")}
                current={search.request === r.id}
                onOpen={open}
              />
            ))}
          </div>
        </section>
      );
    });
  }

  const title = t("project.sections.requests");
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-col gap-3 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="min-w-0 truncate text-2xl font-semibold text-ink">{title}</h1>
            {requests && (
              <span className="num text-lg text-ink-faint">
                <span aria-hidden="true">{filtered.length}</span>
                <span className="sr-only">{t("requests.count", { count: filtered.length })}</span>
              </span>
            )}
          </div>
          {project && (
            <p className="max-w-[72ch] text-sm text-ink-muted">
              {t("requests.intro", { project: project.name })}
            </p>
          )}
        </div>
        <div
          role="toolbar"
          aria-label={t("requests.commands")}
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
        >
          <label htmlFor={searchId} className="sr-only">
            {t("requests.filter.search")}
          </label>
          <span className="flex w-60 min-w-0">
            <input
              id={searchId}
              type="search"
              value={text}
              placeholder={t("requests.filter.search")}
              onChange={(e) => setText(e.target.value)}
              className={`${inputClass} h-8 py-0 text-sm`}
            />
          </span>
          <MenuButton
            menuLabel={t("requests.filter.label")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
            label={
              <>
                <span>{t("requests.filter.label")}:</span>
                <span className="font-medium text-ink">{filterName(t, status)}</span>
                <Chevron />
              </>
            }
          >
            {(close) =>
              STATUS_FILTER_GROUPS.map((group) => (
                <MenuGroup key={group[0]}>
                  {group.map((f) => (
                    <RadioItem
                      key={f}
                      checked={f === status}
                      onSelect={() => {
                        close();
                        setStatus(f);
                      }}
                    >
                      {filterName(t, f)}
                    </RadioItem>
                  ))}
                </MenuGroup>
              ))
            }
          </MenuButton>
          {canCreate && (
            <button type="button" className={`${primaryButton} ml-auto`} onClick={newRequest}>
              {t("requests.new")}
            </button>
          )}
        </div>
      </header>
      <div data-requests-body className="min-h-0 flex-1 overflow-auto border-t border-rule">
        {body}
      </div>
    </section>
  );
}

function filterName(t: (key: string) => string, f: StatusFilter): string {
  return f === "open" || f === "all" ? t(`requests.filter.${f}`) : t(`requests.status.${f}`);
}

/**
 * Una richiesta nell'elenco, colonne fisse a destra come `TaskRow`: titolo
 * (con «Similar to …» o «Merged into …» accanto, se c'è) · chi l'ha chiesta
 * · stato · urgenza · task nate. Stretta, la riga lascia prima il conteggio
 * delle task, poi i nomi (restano le iniziali e i segni).
 */
function RequestRow({
  request,
  related,
  current,
  onOpen,
}: {
  request: ProjectRequest;
  related: ProjectRequest | undefined;
  current: boolean;
  onOpen: (r: ProjectRequest) => void;
}) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const requesters = request.requesterIds.map((id) => people?.find((p) => p.id === id));
  const times = request.requesterIds.length;
  const names = requesters.map((p) => p?.name ?? "").filter(Boolean);
  const who =
    times > 1 ? t("requests.requestedTimes", { count: times }) : (requesters[0]?.name ?? "");
  const note = related
    ? request.mergedIntoId
      ? t("requests.mergedInto", { title: related.title })
      : t("requests.similarTo", { title: related.title })
    : null;
  const tasks = request.taskIds.length;
  return (
    <div
      role="listitem"
      data-request-row={request.id}
      onClick={(e) => {
        if (!(e.target as Element).closest("button, a")) onOpen(request);
      }}
      className={`@container relative cursor-default border-b border-rule transition-colors duration-[var(--duration-fast)] ease-out has-[[data-row-open]:focus-visible]:outline-2 has-[[data-row-open]:focus-visible]:-outline-offset-2 has-[[data-row-open]:focus-visible]:outline-focus ${current ? "bg-ink/10" : "hover:bg-ink/4"}`}
    >
      <div className="flex h-9 items-center gap-3 pr-3 pl-4">
        <button
          type="button"
          data-row-open
          aria-current={current ? "true" : undefined}
          title={request.title}
          onClick={() => onOpen(request)}
          className="flex min-w-0 flex-1 items-baseline gap-2.5 text-left outline-none after:absolute after:inset-0"
        >
          <span className="min-w-0 truncate text-md text-ink">{request.title}</span>
          {note && (
            <span
              data-request-note
              title={note}
              className="min-w-16 shrink-[3] truncate text-sm text-ink-faint"
            >
              {note}
            </span>
          )}
        </button>
        <span
          title={t("requests.requestedBy", { names: names.join(", ") })}
          className="relative flex w-[168px] shrink-0 items-center gap-2 @max-[700px]:w-auto"
        >
          {/* Una persona sola per riga: i dischi sovrapposti si confondono; tutti i nomi sono nel `title` e nel pannello. */}
          <Avatar person={requesters[0]} />
          <span className="min-w-0 truncate text-sm text-ink-muted @max-[700px]:sr-only">{who}</span>
          {times > 1 && (
            <span aria-hidden="true" className="num hidden text-xs text-ink-faint @max-[700px]:inline">
              +{times - 1}
            </span>
          )}
        </span>
        <span className="relative flex w-[132px] shrink-0 @max-[560px]:w-4">
          <RequestStatusLabel status={request.status} nameClassName="@max-[560px]:sr-only" />
        </span>
        <span className="relative flex w-[76px] shrink-0 @max-[560px]:w-3">
          <UrgencyMark urgency={request.urgency} nameClassName="@max-[560px]:sr-only" />
        </span>
        <span className="relative w-16 shrink-0 text-right text-sm text-ink-muted @max-[820px]:hidden">
          {tasks > 0 ? (
            <span className="num">{t("requests.tasks", { count: tasks })}</span>
          ) : (
            <span className="text-ink-faint" title={t("requests.noTasks")}>
              <span aria-hidden="true">—</span>
              <span className="sr-only">{t("requests.noTasks")}</span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
