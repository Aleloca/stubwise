import { Link } from "@tanstack/react-router";
import { type Ref } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../domain/automations/fields";
import { usePauserName } from "../../components/InstanceBlock";
import { WhoCanLink } from "../../components/WhoCanLink";
import { useMailThreadOfMessage, useProjects } from "../../data/queries";
import type { AutomationRunDetail, RunLogEntry } from "../../data/types";
import { usePendingAnswers } from "../home/pendingAnswers";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import {
  clientOf,
  createdSummary,
  displayNumber,
  errorWords,
  reasonWords,
  shortDate,
  type Names,
} from "./format";
import { CriticalGlyph } from "./glyphs";
import { ApprovalBox, ChooseProject, str } from "./RunDecisions";
import { textLink, useAutomationPerms } from "./shared";

// Il riquadro «Now» di un'esecuzione (shape automations.md §6): la frase di
// adesso e, se qualcuno può agire, le sue azioni — approvare (con le
// modifiche), scegliere il progetto, riprovare, saltare. Approvare e
// scegliere sono le stesse di «Decide» (`RunDecisions.tsx`), con l'«Undo».

/** «Cancel run»: l'azione resta secondaria, il testo dice che è distruttiva. */
export const criticalSecondary = secondaryButton.replace("text-ink", "text-critical");
export const criticalQuiet = quietButton
  .replace("text-ink-muted", "text-critical")
  .replace("hover:text-ink", "hover:text-critical");
export function stepName(
  run: AutomationRunDetail,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  if (!run.cursor) return null;
  const step = stepAt(run.flow.steps, run.cursor.replace(/\[\d+\]/g, "[0]"));
  return step
    ? {
        number: displayNumber(run.flow.steps, run.cursor),
        name: t(`automations.kind.${step.kind}`),
      }
    : null;
}

/** L'email a cui l'esecuzione aspetta risposta: la riga che l'ha mandata. */
export function awaitedEmail(run: AutomationRunDetail): RunLogEntry | undefined {
  const wait = [...run.log].reverse().find((e) => e.path === run.cursor && e.kind === "wait");
  const replyTo = (wait?.input as { replyTo?: string } | undefined)?.replyTo;
  if (!replyTo) return undefined;
  return [...run.log]
    .reverse()
    .find((e) => e.stepId === replyTo && e.kind === "sendEmail" && e.outcome === "ok");
}

export function NowBox({
  run,
  names,
  ownerId,
  onTurnOn,
  onCancel,
  onSkip,
  onRetry,
  onDone,
  titleRef,
}: {
  run: AutomationRunDetail;
  names: Names;
  ownerId: string | null;
  onTurnOn: () => void;
  onCancel: () => void;
  onSkip: () => void;
  onRetry: () => void;
  /** Dopo una decisione presa qui (approva, scegli): il fuoco torna alla frase. */
  onDone?: () => void;
  /** La frase di «Now», focalizzabile: ci torna il fuoco dopo un'azione. */
  titleRef?: Ref<HTMLParagraphElement>;
}) {
  const { t, i18n } = useTranslation();
  const perms = useAutomationPerms();
  const step = stepName(run, t);
  const last = run.log.at(-1);
  const email = awaitedEmail(run);
  const thread = useMailThreadOfMessage(email?.effects[0]?.code || null).data;
  const client = str(run.pending?.preview.clientName) || clientOf(run.event) || "";
  // Una decisione presa qui (o in «Decide») e ancora nella finestra dell'«Undo».
  const answering = usePendingAnswers().has(run.id);
  // Chi ha messo la pausa, con «(deactivated)» se è stato disattivato.
  const pauserName = usePauserName(run.aiWaiting ?? null);
  // Il progetto in cui il passo aspetta la coda (la frase della pausa lo nomina).
  const projectCode =
    useProjects().data?.find((p) => p.id === (run.automationProjectId ?? run.projectIds[0]))
      ?.code ?? "";
  let title = "";
  let body: React.ReactNode = null;
  switch (run.status) {
    case "waiting_event": {
      const since =
        [...run.log].reverse().find((e) => e.path === run.cursor && e.outcome === "waiting")?.at ??
        run.startedAt;
      const subject = str(email?.input.subject);
      title = subject
        ? client
          ? t("automations.now.box.waitingReplyFrom", { client, subject })
          : t("automations.now.box.waitingReply", { subject })
        : t("automations.now.box.waiting");
      body = (
        <>
          <p className="text-sm text-ink-muted">
            {t("automations.now.box.since", { date: shortDate(since, i18n.language) })}
            {run.waitingUntil &&
              ` · ${t("automations.now.box.givesUp", { date: shortDate(run.waitingUntil, i18n.language) })}`}
          </p>
          {thread && (
            <Link
              to="/mail/$threadId"
              params={{ threadId: thread }}
              className={`${textLink} self-start text-sm underline`}
            >
              {t("automations.log.openEmail")}
            </Link>
          )}
        </>
      );
      break;
    }
    case "waiting_approval": {
      const who = run.deciders.map((id) => names.person(id)).join(", ");
      const kind = [...run.log].reverse().find((e) => e.path === run.cursor)?.kind ?? "other";
      const what = t(`automations.approvalOf.${kind}`, {
        defaultValue: t("automations.approvalOf.other"),
      });
      title = who
        ? t("automations.now.box.mustApprove", { who, what })
        : t("automations.now.box.approval", { what });
      const since =
        [...run.log].reverse().find((e) => e.outcome === "waiting")?.at ?? run.startedAt;
      body = (
        <>
          <ApprovalBox
            key={`${run.id}:${run.cursor}`}
            runId={run.id}
            cursor={run.cursor ?? ""}
            code={run.code}
            stepKind={kind}
            preview={run.pending?.preview ?? {}}
            effect={run.pendingEffect}
            names={names}
            projectId={run.automationProjectId ?? run.projectIds[0] ?? null}
            from={
              kind === "sendEmail" && ownerId
                ? t("automations.preview.fromOwner", { owner: names.person(ownerId) })
                : null
            }
            canDecide={run.permissions.approve && !answering}
            onDone={onDone}
          />
          {answering ? (
            <p className="text-sm text-ink-muted">{t("automations.decide.answering")}</p>
          ) : (
            !run.permissions.approve && (
              <p className="text-sm text-ink-muted">
                {t("automations.now.box.waitingSince", { date: shortDate(since, i18n.language) })}
              </p>
            )
          )}
        </>
      );
      break;
    }
    case "waiting_project":
      title = t("automations.now.box.mustChoose", { who: names.person(ownerId), client });
      body = (
        <>
          <p className="text-sm text-ink-muted">{t("automations.now.box.noLink")}</p>
          {answering ? (
            <p className="text-sm text-ink-muted">{t("automations.decide.answering")}</p>
          ) : (
            run.permissions.chooseProject && (
              <ChooseProject
                key={`${run.id}:${run.cursor}`}
                runId={run.id}
                cursor={run.cursor ?? ""}
                code={run.code}
                client={client}
                onDone={onDone}
              />
            )
          )}
          {perms.integrations && (
            <Link to="/automations/sources" className={`${textLink} self-start text-sm underline`}>
              {t("automations.now.box.linkClient", { client })}
            </Link>
          )}
        </>
      );
      break;
    case "suspended":
      title = t("automations.now.suspended", { code: run.automationCode });
      body = (
        <>
          {step && (
            <p className="text-sm text-ink-muted">
              {t("automations.now.box.resumesFrom", { number: step.number, step: step.name })}
            </p>
          )}
          {run.permissions.manage && (
            <button type="button" className={`${primaryButton} self-start`} onClick={onTurnOn}>
              {t("automations.actions.turnOn")}
            </button>
          )}
        </>
      );
      break;
    case "running": {
      // Ferma al confine di un passo di Claude per un blocco d'istanza (area 9b,
      // [EF 6]): resta in corso, riparte da sola quando il blocco cade.
      const block = run.aiWaiting;
      if (block) {
        const budget = block.reason === "monthly_budget";
        title = budget
          ? t("instanceEffects.budget.waiting")
          : t("instanceEffects.queue.runWaiting", { code: projectCode, name: pauserName });
        body = (
          <p className="text-sm text-ink-muted">
            {step &&
              t(budget ? "instanceEffects.budget.runDetail" : "instanceEffects.queue.runDetail", {
                number: step.number,
                step: step.name,
              })}
            {budget && (
              <>
                {" "}
                <WhoCanLink action="manageSettings" projectId={null} />
              </>
            )}
          </p>
        );
        break;
      }
      title = step
        ? t("automations.now.box.working", { number: step.number, step: step.name })
        : t("automations.now.running");
      break;
    }
    case "failed": {
      const failed = [...run.log].reverse().find((e) => e.outcome === "failed");
      title = step
        ? t("automations.now.box.failedAt", {
            number: step.number,
            step: step.name,
            error: errorWords(run.error, t),
          })
        : t("automations.now.failed", { error: errorWords(run.error, t) });
      body = (
        <>
          {failed?.why && <p className="text-sm text-ink">{reasonWords(failed.why, t)}</p>}
          {run.permissions.manage && (
            <div className="flex items-center gap-2">
              <button type="button" className={criticalQuiet} onClick={onCancel}>
                {t("automations.actions.cancelRun")}
              </button>
              <button type="button" className={secondaryButton} onClick={onSkip}>
                {t("automations.actions.skipStep")}
              </button>
              <button type="button" className={primaryButton} onClick={onRetry}>
                {t("automations.actions.retry")}
              </button>
            </div>
          )}
        </>
      );
      break;
    }
    case "done": {
      const created = createdSummary(run.log, t);
      title = created
        ? t("automations.now.box.doneWith", {
            date: shortDate(run.endedAt ?? run.startedAt, i18n.language),
            created,
          })
        : t("automations.now.box.done", {
            date: shortDate(run.endedAt ?? run.startedAt, i18n.language),
          });
      break;
    }
    case "cancelled": {
      const by = [...run.log]
        .reverse()
        .find((e) => e.outcome === "cancelled" || e.outcome === "rejected");
      const date = shortDate(run.endedAt ?? last?.at ?? run.startedAt, i18n.language);
      title =
        run.error === "rejected"
          ? t("automations.now.box.rejected", { who: names.person(by?.byId), date })
          : by?.byId
            ? t("automations.now.box.cancelledBy", { who: names.person(by.byId), date })
            : t("automations.now.cancelled");
      body = <p className="text-sm text-ink-muted">{t("automations.now.box.stays")}</p>;
      break;
    }
  }
  return (
    <section
      aria-label={t("automations.now.label")}
      data-now-box={run.status}
      className="flex flex-col gap-2.5 rounded-lg border border-rule bg-ink/4 px-4 py-3.5"
    >
      <p
        ref={titleRef}
        tabIndex={-1}
        aria-live="polite"
        data-now-title
        className="flex items-start gap-2 rounded-sm text-lg font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {run.status === "failed" && (
          <span className="pt-1">
            <CriticalGlyph />
          </span>
        )}
        {title}
      </p>
      {body}
    </section>
  );
}
