import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStatuses, useProjects, useRequest, useTask } from "../../data/queries";
import type { ConversationDetail } from "../../data/types";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { SizeMark } from "../../tasks-ui/SizeMark";
import { StatusLabel } from "../../tasks-ui/StatusLabel";
import { RequestStatusLabel, UrgencyMark } from "../requests/marks";
import { secondaryButton } from "../tasks/controls";

/** Una sessione legata a un oggetto (task o richiesta): ha il lato. */
export function hasObject(detail: ConversationDetail): boolean {
  return detail.taskId !== null || detail.requestId !== null;
}

/**
 * Il lato oggetto di una sessione di lavoro: la task o la richiesta in breve
 * (codice e titolo, stato, persona, taglia) e il link per aprirla. Si legge
 * con i permessi di chi guarda: un oggetto che non vede dice solo che non
 * si apre.
 */
export function ObjectSide({ detail, onClose }: { detail: ConversationDetail; onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="complementary"
      aria-label={t("claude.destination.page.objectLabel")}
      className="flex min-w-0 flex-col gap-5 px-5 pt-6 pb-6"
    >
      {detail.taskId !== null ? (
        <TaskBrief code={detail.objectCode ?? ""} projectId={detail.projectId} />
      ) : (
        <RequestBrief id={detail.requestId ?? ""} refine={detail.kind === "refine"} />
      )}
      {onClose && (
        <button type="button" className={`${secondaryButton} self-start`} onClick={onClose}>
          {t("claude.destination.page.closeObject")}
        </button>
      )}
    </div>
  );
}

function Heading({ code, title }: { code: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="num text-xs font-semibold tracking-[0.02em] text-ink">{code}</span>
      <p className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">{title}</p>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="flex min-w-0 items-center">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Missing() {
  const { t } = useTranslation();
  return <p className="text-sm text-ink-muted">{t("claude.destination.page.objectMissing")}</p>;
}

/**
 * `projectId`: il progetto della sessione, così gli stati si leggono insieme
 * alla task e non dopo (la riga «Status» restava vuota finché la seconda
 * lettura non arrivava). Uno stato che non si sa nominare (stati non letti,
 * o non più del progetto) toglie la riga: mai un'etichetta senza valore.
 */
function TaskBrief({ code, projectId }: { code: string; projectId: string | null }) {
  const { t } = useTranslation();
  const task = useTask(code);
  const statuses = useProjectStatuses(projectId ?? task.data?.projectId ?? "");
  const projectCode = useProjects().data?.find((p) => p.id === task.data?.projectId)?.code;
  if (task.isPending) return <SideSkeleton />;
  if (!task.data) return <Missing />;
  const status = statuses.data?.find((s) => s.id === task.data!.statusId);
  const statusRow: [string, ReactNode][] = statuses.isPending
    ? [[t("claude.destination.page.status"), <ValueSkeleton key="s" />]]
    : status
      ? [[t("claude.destination.page.status"), <StatusLabel key="s" status={status} />]]
      : [];
  return (
    <>
      <Heading code={task.data.code} title={task.data.title} />
      <Facts
        rows={[
          ...statusRow,
          [
            t("claude.destination.page.assignee"),
            <PersonChip key="a" personId={task.data.assigneeId} />,
          ],
          [t("claude.destination.page.size"), <SizeMark key="z" size={task.data.size} />],
        ]}
      />
      {projectCode && (
        <Link
          to="/p/$code/$section"
          params={{ code: projectCode, section: "tasks" }}
          search={{ task: task.data.code }}
          className={`${secondaryButton} self-start`}
        >
          {t("claude.destination.page.openTask")}
        </Link>
      )}
    </>
  );
}

/** `refine`: la sessione è il refine della richiesta, che si apre nella sua vista (`?refine=1`). */
function RequestBrief({ id, refine }: { id: string; refine: boolean }) {
  const { t } = useTranslation();
  const request = useRequest(id);
  const projectCode = useProjects().data?.find((p) => p.id === request.data?.projectId)?.code;
  if (request.isPending) return <SideSkeleton />;
  if (!request.data) return <Missing />;
  const r = request.data;
  return (
    <>
      <Heading code={r.code} title={r.title} />
      <Facts
        rows={[
          [t("claude.destination.page.status"), <RequestStatusLabel key="s" status={r.status} />],
          [
            t("claude.destination.page.requestedBy"),
            <PersonChip key="p" personId={r.requesterIds[0] ?? null} />,
          ],
          [t("claude.destination.page.urgency"), <UrgencyMark key="u" urgency={r.urgency} />],
          [t("claude.destination.page.size"), <SizeMark key="z" size={r.size ?? null} />],
        ]}
      />
      {projectCode && (
        <Link
          to="/p/$code/$section"
          params={{ code: projectCode, section: "requests" }}
          search={refine ? { request: r.id, refine: "1" } : { request: r.id }}
          className={`${secondaryButton} self-start`}
        >
          {t("claude.destination.page.openRequest")}
        </Link>
      )}
    </>
  );
}

/** Il valore di una riga che sta arrivando: una barra che respira, non uno spazio vuoto. */
function ValueSkeleton() {
  const { t } = useTranslation();
  return (
    <span aria-busy="true" className="skeleton-breathe flex items-center">
      <span className="sr-only">{t("taskUi.states.loading")}</span>
      <span className="h-2.5 w-20 rounded-sm bg-ink/8" />
    </span>
  );
}

function SideSkeleton() {
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-3">
      <span className="h-2.5 w-14 rounded-sm bg-ink/8" />
      <span className="h-4 w-4/5 rounded-sm bg-ink/8" />
      <span className="h-2.5 w-2/3 rounded-sm bg-ink/8" />
      <span className="h-2.5 w-1/2 rounded-sm bg-ink/8" />
    </div>
  );
}
