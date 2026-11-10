import { serverDeletesClaudeWork } from "../../data/integration";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import { useDeleteTask, useTaskDeletion, useTasks, type TaskBusyReason } from "../../data/queries";
import type { Task } from "../../data/types";
import { linksOf } from "../../domain/links";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { ErrorLine } from "../entry/parts";
import { OpenCircleGlyph, TriangleGlyph } from "../preferences/glyphs";
import { WriteError } from "../preferences/parts";
import { CrossCircle } from "../projects/DeleteProjectDialog";
import { dangerSolidButton, secondaryButton } from "../tasks/controls";
import { rowAfter } from "./deleteFocus";
import { smallSecondary } from "./parts";

// «Delete MKX-31?» (area 10a, Task 10, shape task-delete.md): il dialogo
// aperto dalla voce del menu «⋯» della task. Nomina codice e titolo, dice
// prima cosa la occupa (`busy`, in parole e senza «Who?»: è una regola, non
// un permesso), cosa se ne va e cosa resta; poi Cancel e il bottone rosso.
// Niente codice da scrivere né riconferma (maintainer, [TD 1]). Tutto ciò che
// decide — se si può, cosa la occupa, le figlie — viene da `getTaskDeletion`.
//
// La scrittura ha la forma di `useSettingsWrite`: una alla volta (un doppio
// clic, anche su Retry, non ne fa due) e lo stesso seguito dopo un Retry.

/** Quante figlie si nominano prima di «and 3 more». */
const SHOWN = 5;

export function DeleteTaskDialog({
  task,
  projectCode,
  onClose,
  onDeleted,
  onGone,
}: {
  task: Task;
  projectCode: string;
  /** Cancel, Esc o il clic fuori: il fuoco torna dove era (il «⋯»). */
  onClose: () => void;
  /** Riuscita, dopo il toast: `next` è la riga che ne prende il posto, scelta prima. */
  onDeleted: (next: string | null) => void;
  /** Non c'è più (eliminata o invisibile nel frattempo): si chiude come dopo un'eliminazione. */
  onGone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const preview = useTaskDeletion(task.id);
  const remove = useDeleteTask();
  const tasks = useTasks().data;
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<"failed" | "forbidden" | null>(null);
  const inflight = useRef(false);
  const noteId = useId();
  const goesId = useId();
  const staysId = useId();
  const code = task.code;

  const data = preview.data ?? null;
  // La vista dice che la task non c'è (più): come un `not_found` della scrittura.
  const gone = preview.isSuccess && data === null;
  useEffect(() => {
    if (!gone) return;
    toast.error(t("task.delete.gone", { code }));
    onGone();
    // Una volta sola, quando la vista dice «non c'è»: il resto non la fa ripartire.
  }, [gone]);

  // Il blocco busy si annuncia solo se compare a dialogo già aperto.
  const busyAtOpen = useRef<boolean | null>(null);
  if (data && busyAtOpen.current === null) busyAtOpen.current = data.busy.length > 0;

  const busy = data?.busy ?? [];
  const ready = data !== null && data.canDelete && busy.length === 0;

  async function attempt() {
    if (inflight.current || !ready) return;
    inflight.current = true;
    setSending(true);
    setFailure(null);
    // La riga che prenderà il posto, scelta finché la task è ancora nella lista.
    const next = rowAfter(code);
    const result = await remove.mutateAsync(task.id).catch(() => undefined);
    inflight.current = false;
    setSending(false);
    if (!result) return setFailure("failed");
    if (result.ok) {
      toast.show(t("task.delete.done", { code }));
      onDeleted(next);
      return;
    }
    if (result.error === "not_found") {
      toast.error(t("task.delete.gone", { code }));
      onGone();
      return;
    }
    if (result.error === "forbidden") setFailure("forbidden");
    // `busy` arrivato nel frattempo: il dialogo passa alla vista busy.
    void preview.refetch();
  }

  const links =
    tasks !== undefined && linksOf(task, tasks).some((l) => l.kind !== "child");
  const busyNote = busy.length > 0 && data !== null;

  return (
    <Dialog
      title={t("task.delete.dialog.title", { code })}
      onClose={onClose}
      width={480}
      className="max-w-[calc(100vw-64px)]"
      footer={
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <button type="button" data-autofocus className={secondaryButton} onClick={onClose}>
              {t("task.delete.dialog.cancel")}
            </button>
            <button
              type="button"
              disabled={!ready}
              aria-busy={sending || undefined}
              aria-describedby={busyNote ? noteId : undefined}
              onClick={() => void attempt()}
              className={`${dangerSolidButton} disabled:cursor-not-allowed`}
            >
              {sending
                ? t("task.delete.dialog.deleting")
                : t("task.delete.dialog.submit", { code })}
            </button>
          </div>
          {busyNote && (
            <p id={noteId} className="max-w-[40ch] text-right text-xs text-pretty text-ink-muted">
              {t("task.delete.dialog.busyNote")}
            </p>
          )}
        </div>
      }
    >
      <p className="flex min-w-0 items-baseline gap-2 text-md text-ink">
        <span className="num shrink-0 font-semibold">{code}</span>{" "}
        <span className="min-w-0 truncate" title={task.title}>
          {t("task.delete.dialog.quoted", { title: task.title })}
        </span>
      </p>
      <p className="-mt-1 flex items-start gap-1.5 text-md font-semibold text-critical">
        <CrossCircle />
        <span>{t("task.delete.dialog.undone")}</span>
      </p>
      {preview.isError ? (
        <WriteError
          message={t("task.delete.dialog.loadError")}
          onRetry={() => void preview.refetch()}
        />
      ) : !data ? (
        <PreviewSkeleton />
      ) : (
        <>
          {busy.length > 0 && (
            <BusyBlock code={code} reasons={busy} announce={busyAtOpen.current === false} />
          )}
          <section aria-labelledby={goesId} className="flex flex-col gap-1.5">
            <h3 id={goesId} className="heading-group">
              {t("task.delete.dialog.goes")}
            </h3>
            <p className="text-md text-pretty text-ink">{t("task.delete.dialog.goesLine")}</p>
            {/* Sul server vero il lavoro di Claude se ne va con lei (maintainer, 10 nov 2026). */}
            {serverDeletesClaudeWork() && (
              <p className="text-md text-pretty text-ink">{t("task.delete.dialog.goesClaude")}</p>
            )}
          </section>
          <section aria-labelledby={staysId} className="flex flex-col gap-1.5">
            <h3 id={staysId} className="heading-group">
              {t("task.delete.dialog.stays")}
            </h3>
            <ul className="flex flex-col gap-1.5 text-sm text-pretty text-ink">
              {data.children.length > 0 && <Children items={data.children} />}
              {links && <Stays>{t("task.delete.dialog.links")}</Stays>}
              {task.requestId && <Stays>{t("task.delete.dialog.request")}</Stays>}
              <Stays>{t("task.delete.dialog.code", { code })}</Stays>
            </ul>
          </section>
        </>
      )}
      {failure === "failed" && (
        <ErrorLine
          action={
            <button type="button" className={`${smallSecondary} ml-1`} onClick={() => void attempt()}>
              {t("task.delete.dialog.retry")}
            </button>
          }
        >
          {t("task.delete.dialog.failed", { code })}
        </ErrorLine>
      )}
      {failure === "forbidden" && (
        <ErrorLine>
          {t("task.delete.dialog.forbidden", { code })}
          <span aria-hidden="true" className="text-ink-faint">
            {" · "}
          </span>
          <WhoCanLink
            action={data?.whoAction ?? "deleteTasks"}
            projectId={task.projectId}
            projectCode={projectCode}
          />
        </ErrorLine>
      )}
    </Dialog>
  );
}

/** Una riga di ciò che resta, col suo ○. */
function Stays({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-[3px] shrink-0 text-ink-muted">
        <OpenCircleGlyph size={12} />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

/** Le figlie che restano senza madre: una sola sulla stessa riga, di più una per riga (fino a 5). */
function Children({ items }: { items: { code: string; title: string }[] }) {
  const { t } = useTranslation();
  const line = (c: { code: string; title: string }) => (
    <>
      <span className="num font-semibold">{c.code}</span>{" "}
      <span title={c.title}>{t("task.delete.dialog.quoted", { title: c.title })}</span>
    </>
  );
  if (items.length === 1)
    return (
      <Stays>
        {t("task.delete.dialog.children", { count: 1 })} {line(items[0]!)}
      </Stays>
    );
  const rest = items.length - SHOWN;
  return (
    <Stays>
      <span>{t("task.delete.dialog.children", { count: items.length })}</span>
      <ul className="mt-1 flex flex-col gap-0.5">
        {items.slice(0, SHOWN).map((c) => (
          <li key={c.code} className="truncate">
            {line(c)}
          </li>
        ))}
        {rest > 0 && (
          <li className="text-ink-muted">{t("task.delete.dialog.more", { count: rest })}</li>
        )}
      </ul>
    </Stays>
  );
}

/** ▲ «MKX-31 can't be deleted yet»: una riga per ragione, poi cosa aspettare. */
function BusyBlock({
  code,
  reasons,
  announce,
}: {
  code: string;
  reasons: TaskBusyReason[];
  /** Comparso a dialogo già aperto: si annuncia (`role="status"`). */
  announce: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role={announce ? "status" : undefined}
      data-delete-busy
      className="flex items-start gap-2 rounded-lg border border-rule px-3 py-2.5"
    >
      <span className="mt-[3px] shrink-0 text-warning">
        <TriangleGlyph size={14} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-md font-semibold text-ink">{t("task.delete.busy.title", { code })}</p>
        <ul className="flex flex-col gap-0.5 text-sm text-pretty text-ink">
          {reasons.map((reason, i) => (
            <li key={i}>
              <BusyLine reason={reason} />
            </li>
          ))}
        </ul>
        <p className="text-sm text-pretty text-ink-muted">
          {t("task.delete.busy.wait", { count: reasons.length })}
        </p>
      </div>
    </div>
  );
}

function BusyLine({ reason }: { reason: TaskBusyReason }) {
  const { t } = useTranslation();
  const bold = { b: <strong className="num font-semibold" /> };
  switch (reason.kind) {
    case "claude_session":
      return (
        <>
          {t("task.delete.busy.claude")}
          {reason.conversationId && (
            <>
              {" "}
              <Link
                to="/claude/$id"
                params={{ id: reason.conversationId }}
                className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
              >
                {t("task.delete.busy.openSession")}
              </Link>
            </>
          )}
        </>
      );
    case "open_pr":
      return (
        <>
          {reason.number !== null && reason.repo !== null
            ? t("task.delete.busy.pr", { number: reason.number, repo: reason.repo })
            : t("task.delete.busy.prNoNumber")}
        </>
      );
    case "server_fix":
      return (
        <Trans i18nKey="task.delete.busy.server" values={{ code: reason.serverCode }} components={bold} />
      );
    case "release_fix":
      return (
        <Trans
          i18nKey="task.delete.busy.release"
          values={{ code: reason.releaseCode }}
          components={bold}
        />
      );
    case "open_correction":
      return <>{t("task.delete.busy.correction")}</>;
  }
}

/** Tre righe finte, nella forma di ciò che il dialogo dirà. */
function PreviewSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2.5 py-1">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[0.36, 0.62, 0.48].map((w) => (
        <span key={w} className="block h-3 rounded-sm bg-ink/8" style={{ width: `${w * 100}%` }} />
      ))}
    </div>
  );
}
