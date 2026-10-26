import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../domain/automations/fields";
import {
  useApproveAutomationStep,
  useChooseAutomationProject,
  useMailThreadOfMessage,
  useProjects,
  useRejectAutomationStep,
} from "../../data/queries";
import type { AutomationRunDetail, RunLogEntry } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import {
  clientOf,
  createdSummary,
  displayNumber,
  errorWords,
  shortDate,
  type Names,
} from "./format";
import { CriticalGlyph } from "./glyphs";
import { textLink, useAutomationPerms } from "./shared";

// Il riquadro «Now» di un'esecuzione (shape automations.md §6): la frase di
// adesso e, se qualcuno può agire, le sue azioni — approvare (con le
// modifiche), scegliere il progetto, riprovare, saltare. Lo riusa «Decide»
// (Task 8).

/** «Cancel run»: l'azione resta secondaria, il testo dice che è distruttiva. */
export const criticalSecondary = secondaryButton.replace("text-ink", "text-critical");
export const criticalQuiet = quietButton
  .replace("text-ink-muted", "text-critical")
  .replace("hover:text-ink", "hover:text-critical");
export const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Le chiavi dell'anteprima che si correggono prima di approvare, per tipo di passo. */
export const EDITABLE: Record<string, string[]> = {
  sendEmail: ["to", "subject", "body"],
};

export function stepName(
  run: AutomationRunDetail,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  if (!run.cursor) return null;
  const step = stepAt(run.flow.steps, run.cursor.replace(/\[\d+\]/g, "[0]"));
  return step
    ? { number: displayNumber(run.cursor), name: t(`automations.kind.${step.kind}`) }
    : null;
}

/** L'anteprima intera di un passo da approvare: email (Da, A, Oggetto, corpo, allegati) o task. */
export function PreviewBlock({
  preview,
  names,
  from,
}: {
  preview: Record<string, unknown>;
  names: Names;
  from: string | null;
}) {
  const { t } = useTranslation();
  const rows: [string, string][] = [];
  if (from) rows.push([t("automations.preview.from"), from]);
  for (const [k, v] of Object.entries(preview)) {
    if (k === "body" || k === "descrizione") continue;
    if (k === "progetto") {
      const p = names.project(str(v));
      rows.push([
        t("automations.dataKeys.progetto"),
        p ? `${p.code} · ${p.name}` : t("automations.log.hiddenProject"),
      ]);
    } else if (k === "persona")
      rows.push([t("automations.dataKeys.persona"), names.person(str(v))]);
    else if (Array.isArray(v))
      rows.push([t(`automations.dataKeys.${k}`, { defaultValue: k }), v.join(", ")]);
    else rows.push([t(`automations.dataKeys.${k}`, { defaultValue: k }), String(v ?? "")]);
  }
  const body = str(preview.body) || str(preview.descrizione);
  if (rows.length === 0 && !body) return null;
  return (
    <div
      data-preview
      className="flex flex-col gap-2 rounded-md border border-rule bg-surface px-3 py-2.5"
    >
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-ink [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      {body && <p className="text-sm whitespace-pre-line text-ink">{body}</p>}
    </div>
  );
}

export function ApprovalActions({ run }: { run: AutomationRunDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const approve = useApproveAutomationStep();
  const reject = useRejectAutomationStep();
  const kind = [...run.log].reverse().find((e) => e.path === run.cursor)?.kind ?? "";
  const editable = EDITABLE[kind] ?? [];
  const preview = run.pending?.preview ?? {};
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map((k) => [k, str(preview[k])])),
  );
  const changed = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => v !== str(preview[k])),
  );
  const done = (key: string) => ({
    onSuccess: () => toast.show(t(key, { code: run.code })),
    onError: () => toast.error(t("automations.toast.decisionError", { code: run.code })),
  });
  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        {editable.map((k) => (
          <label key={k} className="flex flex-col gap-1 text-sm text-ink-muted">
            {t(`automations.dataKeys.${k}`)}
            {k === "body" ? (
              <textarea
                className={`${inputClass} min-h-32`}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            ) : (
              <input
                className={inputClass}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            )}
          </label>
        ))}
        <div className="flex items-center gap-2">
          <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate(
                { runId: run.id, edited: Object.keys(changed).length ? changed : undefined },
                done("automations.toast.approved"),
              )
            }
          >
            {t("automations.actions.approveChanges")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <div className="flex flex-col items-start gap-0.5">
        <button
          type="button"
          className={secondaryButton}
          disabled={reject.isPending}
          onClick={() => reject.mutate(run.id, done("automations.toast.rejected"))}
        >
          {t("automations.actions.reject")}
        </button>
        <span className="text-xs text-ink-muted">{t("automations.now.rejectStops")}</span>
      </div>
      {editable.length > 0 && (
        <button type="button" className={secondaryButton} onClick={() => setEditing(true)}>
          {t("automations.actions.edit")}
        </button>
      )}
      <button
        type="button"
        className={primaryButton}
        disabled={approve.isPending}
        onClick={() => approve.mutate({ runId: run.id }, done("automations.toast.approved"))}
      >
        {t("automations.actions.approve")}
      </button>
    </div>
  );
}

export function ChooseProject({ run, client }: { run: AutomationRunDetail; client: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const perms = useAutomationPerms();
  const projects = (useProjects().data ?? [])
    .filter((p) => perms.createTasks(p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
  const [projectId, setProjectId] = useState("");
  const choose = useChooseAutomationProject();
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label htmlFor={id} className="flex min-w-64 flex-col gap-1 text-sm text-ink-muted">
        {t("automations.now.whichProject", { client })}
        <select
          id={id}
          className={`${inputClass} h-8`}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">{t("automations.now.pickProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={`${primaryButton} disabled:opacity-40`}
        disabled={!projectId || choose.isPending}
        onClick={() =>
          choose.mutate(
            { runId: run.id, projectId },
            {
              onSuccess: () => toast.show(t("automations.toast.projectChosen", { code: run.code })),
              onError: () => toast.error(t("automations.toast.decisionError", { code: run.code })),
            },
          )
        }
      >
        {t("automations.actions.choose")}
      </button>
    </div>
  );
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
}: {
  run: AutomationRunDetail;
  names: Names;
  ownerId: string | null;
  onTurnOn: () => void;
  onCancel: () => void;
  onSkip: () => void;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const perms = useAutomationPerms();
  const step = stepName(run, t);
  const last = run.log.at(-1);
  const email = awaitedEmail(run);
  const thread = useMailThreadOfMessage(email?.effects[0]?.code || null).data;
  const client = str(run.pending?.preview.clientName) || clientOf(run.event) || "";
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
          <PreviewBlock
            preview={run.pending?.preview ?? {}}
            names={names}
            from={
              kind === "sendEmail" && ownerId
                ? t("automations.preview.fromOwner", { owner: names.person(ownerId) })
                : null
            }
          />
          {run.permissions.approve ? (
            <ApprovalActions run={run} />
          ) : (
            <p className="text-sm text-ink-muted">
              {t("automations.now.box.waitingSince", { date: shortDate(since, i18n.language) })}
            </p>
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
          {run.permissions.chooseProject && <ChooseProject run={run} client={client} />}
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
    case "running":
      title = step
        ? t("automations.now.box.working", { number: step.number, step: step.name })
        : t("automations.now.running");
      break;
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
          {failed?.reason && <p className="text-sm text-ink">{failed.reason}</p>}
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
      <p aria-live="polite" className="flex items-start gap-2 text-lg font-semibold text-ink">
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
