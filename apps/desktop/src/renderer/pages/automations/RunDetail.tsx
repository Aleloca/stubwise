import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomationRun,
  useAutomations,
  useAutomationSources,
  useRetryAutomationStep,
} from "../../data/queries";
import type { AutomationRunDetail } from "../../data/types";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton, quietButton, secondaryButton } from "../tasks/controls";
import { TurnOnDialog } from "./AutomationDialogs";
import { DetailSkeleton } from "./AutomationDetail";
import {
  clientOf,
  clock,
  fieldLabels,
  runTitle,
  shortDate,
  startedByWords,
  type Names,
} from "./format";
import { MoreGlyph } from "./glyphs";
import type { LogCtx } from "./LogEntryText";
import { RunLog } from "./RunLog";
import { RunStatusWord, codeClass, textLink, useNames } from "./shared";
import { criticalSecondary, NowBox } from "./RunNow";
import { PassTime } from "./PassTime";
import { CancelRunDialog, SkipStepDialog } from "./RunDialogs";

// Il dettaglio di un'esecuzione (shape automations.md §6): testata, il
// riquadro «Now» (l'unico fondo della pagina: è l'unica cosa che può chiedere
// un'azione), «Pass time» del prototipo, il registro. Un'approvazione blocca
// davvero: nessun bottone la scavalca, e il riquadro del prototipo lo dice.

/** «Started Oct 23 at 09:12 by a deal won on Audin · version 3 · Matteo Conti's automation». */
function StartedLine({
  run,
  names,
  ownerId,
}: {
  run: AutomationRunDetail;
  names: Names;
  ownerId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const date = shortDate(run.startedAt, i18n.language);
  const time = clock(run.startedAt, i18n.language);
  const client = clientOf(run.event);
  const trigger = startedByWords(run.flow.trigger, names, t);
  const by =
    run.origin === "automation" && run.parent
      ? null
      : run.origin === "manual"
        ? t("automations.startedBy.manual")
        : client
          ? `${trigger} · ${client}`
          : trigger;
  return (
    <p className="text-md text-ink-muted">
      {t("automations.run.started", { date, time })}{" "}
      {by ?? (
        <>
          {t("automations.run.byRun")}{" "}
          <Link
            to="/automations/$code/runs/$n"
            params={{ code: run.parent!.code.split(" #")[0]!, n: run.parent!.code.split(" #")[1]! }}
            className={textLink}
          >
            {run.parent!.code}
          </Link>
        </>
      )}
      {" · "}
      {t("automations.version.long", { n: run.version })}
      {ownerId && ` · ${t("automations.run.ownersAutomation", { owner: names.person(ownerId) })}`}
    </p>
  );
}

export function RunDetail({ runId, entry }: { runId: string; entry?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const names = useNames();
  const query = useAutomationRun(runId);
  const automations = useAutomations().data ?? [];
  const sources = useAutomationSources().data ?? [];
  const retry = useRetryAutomationStep();
  const [dialog, setDialog] = useState<"cancel" | "skip" | "on" | null>(null);
  const nowTitle = useRef<HTMLParagraphElement>(null);
  // Dopo Approva, Scegli, Riprova, Salta o Annulla il bottone premuto può
  // sparire: il fuoco va alla frase nuova di «Now» (dopo la chiusura del dialogo).
  const focusNow = () => requestAnimationFrame(() => nowTitle.current?.focus());
  const run = query.data;
  const labels = useMemo(() => (run ? fieldLabels(run.flow, sources) : new Map()), [run, sources]);
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-8 py-10">
        <p className="text-md text-ink">{t("automations.errors.loadRun")}</p>
        <button type="button" className={secondaryButton} onClick={() => void query.refetch()}>
          {t("automations.actions.retry")}
        </button>
      </div>
    );
  }
  if (!run) return <DetailSkeleton />;
  const automation = automations.find((a) => a.id === run.automationId);
  // Il proprietario arriva con l'esecuzione: anche chi decide senza vedere l'automazione lo sa.
  const ownerId = run.ownerId;
  const open = run.status !== "done" && run.status !== "cancelled" && run.status !== "failed";
  const ctx: LogCtx = {
    run,
    names,
    labels,
    automationCode: (id) => automations.find((a) => a.id === id)?.code ?? null,
  };
  const projects =
    run.projectIds.length > 0
      ? run.projectIds
      : run.automationProjectId
        ? [run.automationProjectId]
        : [];
  const doRetry = () =>
    retry.mutate(run.id, {
      onSuccess: () => {
        toast.show(t("automations.toast.retried", { code: run.code }));
        focusNow();
      },
      onError: () => toast.error(t("automations.toast.decisionError", { code: run.code })),
    });
  // Anche ferma per un blocco d'istanza ([EF 6]): «Pass time» c'è e dice che non la muove.
  const passTime =
    run.permissions.manage &&
    (run.status === "waiting_event" || run.status === "waiting_approval" || !!run.aiWaiting);

  return (
    <article className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[960px] flex-col gap-5 pr-8">
        <header className="page-header flex shrink-0 flex-col gap-2 [--page-header-pr:32px] [--page-header-pt:32px]">
          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            {automation ? (
              <Link
                to="/automations/$code"
                params={{ code: run.automationCode }}
                className={textLink}
              >
                <span className={codeClass}>{run.code}</span> · {run.automationName}
              </Link>
            ) : (
              <span>
                <span className={codeClass}>{run.code}</span> · {run.automationName}
              </span>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {projects.length === 0
                ? t("automations.general")
                : projects
                    .map((id) => names.project(id))
                    .filter((p): p is { code: string; name: string } => p !== null)
                    .map((p) => `${p.code} · ${p.name}`)
                    .join(", ")}
            </span>
          </p>
          <div className="flex items-start gap-4">
            <h1 className="min-w-0 flex-1 text-2xl font-semibold text-ink [overflow-wrap:anywhere]">
              {runTitle(run, t)}
            </h1>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <RunStatusWord
                status={run.status}
                mine={run.permissions.approve || run.permissions.chooseProject}
              />
              {run.permissions.manage && open && (
                <button
                  type="button"
                  className={criticalSecondary}
                  onClick={() => setDialog("cancel")}
                >
                  {t("automations.actions.cancelRun")}
                </button>
              )}
              <MenuButton
                menuLabel={t("automations.detail.more")}
                ariaLabel={t("automations.detail.more")}
                align="right"
                className={`${quietButton} w-8 justify-center px-0`}
                label={<MoreGlyph />}
              >
                {(close) => (
                  <MenuGroup>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        void navigator.clipboard
                          ?.writeText(`#/automations/${run.automationCode}/runs/${run.n}`)
                          .catch(() => {});
                        toast.show(t("automations.toast.linkCopied"));
                      }}
                    >
                      {t("automations.actions.copyLink")}
                    </button>
                  </MenuGroup>
                )}
              </MenuButton>
            </div>
          </div>
          <StartedLine run={run} names={names} ownerId={ownerId} />
          {run.children.length > 0 && (
            <p className="text-sm text-ink-muted">
              {t("automations.run.startedRuns")}{" "}
              {run.children.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ", "}
                  <Link
                    to="/automations/$code/runs/$n"
                    params={{ code: c.code.split(" #")[0]!, n: c.code.split(" #")[1]! }}
                    className={textLink}
                  >
                    {c.code}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </header>
        <NowBox
          run={run}
          names={names}
          ownerId={ownerId}
          onTurnOn={() => setDialog("on")}
          onCancel={() => setDialog("cancel")}
          onSkip={() => setDialog("skip")}
          onRetry={doRetry}
          onDone={focusNow}
          titleRef={nowTitle}
        />
        {passTime && <PassTime run={run} />}
        <RunLog
          ctx={ctx}
          entry={entry}
          actionsFor={(e) =>
            run.status === "failed" &&
            run.permissions.manage &&
            e.outcome === "failed" &&
            e === [...run.log].reverse().find((x) => x.outcome === "failed") ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className={`${quietButton} h-7`}
                  onClick={() => setDialog("skip")}
                >
                  {t("automations.actions.skip")}
                </button>
                <button type="button" className={`${secondaryButton} h-7`} onClick={doRetry}>
                  {t("automations.actions.retry")}
                </button>
              </span>
            ) : null
          }
        />
      </div>
      {dialog === "cancel" && (
        <CancelRunDialog run={run} onClose={() => setDialog(null)} onDone={focusNow} />
      )}
      {dialog === "skip" && (
        <SkipStepDialog run={run} onClose={() => setDialog(null)} onDone={focusNow} />
      )}
      {dialog === "on" && (
        <TurnOnDialog automationId={run.automationId} onClose={() => setDialog(null)} />
      )}
    </article>
  );
}
