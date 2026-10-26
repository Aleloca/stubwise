import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../domain/automations/fields";
import { now } from "../../data/dates";
import {
  useAdvanceAutomationTime,
  useApproveAutomationStep,
  useAutomationRun,
  useAutomations,
  useAutomationSources,
  useCancelAutomationRun,
  useChooseAutomationProject,
  useMailThreadOfMessage,
  useProjects,
  useRejectAutomationStep,
  useRetryAutomationStep,
  useSimulateMailReply,
  useSkipAutomationStep,
} from "../../data/queries";
import type { AutomationRunDetail, RunLogEntry } from "../../data/types";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import {
  MenuButton,
  dangerSolidButton,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../tasks/controls";
import { TurnOnDialog } from "./AutomationDialogs";
import { DetailSkeleton } from "./AutomationDetail";
import {
  clientOf,
  clock,
  createdSummary,
  displayNumber,
  errorWords,
  fieldLabels,
  shortDate,
  startedByWords,
  type Names,
} from "./format";
import { CriticalGlyph, MoreGlyph } from "./glyphs";
import type { LogCtx } from "./LogEntryText";
import { RunLog } from "./RunLog";
import {
  PrototypeBox,
  RunStatusWord,
  codeClass,
  textLink,
  useAutomationPerms,
  useNames,
} from "./shared";

// Il dettaglio di un'esecuzione (shape automations.md §6): testata, il
// riquadro «Now» (l'unico fondo della pagina: è l'unica cosa che può chiedere
// un'azione), «Pass time» del prototipo, il registro. Un'approvazione blocca
// davvero: nessun bottone la scavalca, e il riquadro del prototipo lo dice.

const DAY = 86_400_000;

/** «Cancel run»: l'azione resta secondaria, il testo dice che è distruttiva. */
const criticalSecondary = secondaryButton.replace("text-ink", "text-critical");
const criticalQuiet = quietButton
  .replace("text-ink-muted", "text-critical")
  .replace("hover:text-ink", "hover:text-critical");
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Le chiavi dell'anteprima che si correggono prima di approvare, per tipo di passo. */
const EDITABLE: Record<string, string[]> = {
  sendEmail: ["to", "subject", "body"],
};

function stepName(run: AutomationRunDetail, t: (k: string, o?: Record<string, unknown>) => string) {
  if (!run.cursor) return null;
  const step = stepAt(run.flow.steps, run.cursor.replace(/\[\d+\]/g, "[0]"));
  return step
    ? { number: displayNumber(run.cursor), name: t(`automations.kind.${step.kind}`) }
    : null;
}

/** L'anteprima intera di un passo da approvare: email (Da, A, Oggetto, corpo, allegati) o task. */
function PreviewBlock({
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

function ApprovalActions({ run }: { run: AutomationRunDetail }) {
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

function ChooseProject({ run, client }: { run: AutomationRunDetail; client: string }) {
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
function awaitedEmail(run: AutomationRunDetail): RunLogEntry | undefined {
  const wait = [...run.log].reverse().find((e) => e.path === run.cursor && e.kind === "wait");
  const replyTo = (wait?.input as { replyTo?: string } | undefined)?.replyTo;
  if (!replyTo) return undefined;
  return [...run.log]
    .reverse()
    .find((e) => e.stepId === replyTo && e.kind === "sendEmail" && e.outcome === "ok");
}

function NowBox({
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

/** «Pass time» (solo prototipo, [A 15]/[A 16]): un'approvazione non scade, e lo si vede. */
function PassTime({ run }: { run: AutomationRunDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const advance = useAdvanceAutomationTime();
  const reply = useSimulateMailReply();
  const email = awaitedEmail(run);
  const thread = useMailThreadOfMessage(email?.effects[0]?.code || null).data;
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const blocked = run.status === "waiting_approval";
  const toDeadline = run.waitingUntil
    ? Math.min(30, Math.max(1, Math.ceil((Date.parse(run.waitingUntil) - Date.parse(now())) / DAY)))
    : null;
  const pass = (days: number) =>
    advance.mutate(
      { runId: run.id, days },
      { onError: () => toast.error(t("automations.toast.timeError")) },
    );
  return (
    <PrototypeBox label={t("automations.prototype.passTime")}>
      <p className="text-sm text-ink">
        {blocked
          ? t("automations.prototype.approvalsDontExpire")
          : t("automations.prototype.daysPass")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${secondaryButton} disabled:opacity-40`}
          disabled={blocked || advance.isPending}
          onClick={() => pass(1)}
        >
          {t("automations.prototype.plusDay")}
        </button>
        {(toDeadline !== null || blocked) && (
          <button
            type="button"
            className={`${secondaryButton} disabled:opacity-40`}
            disabled={blocked || toDeadline === null || advance.isPending}
            onClick={() => toDeadline !== null && pass(toDeadline)}
          >
            {run.waitingUntil
              ? t("automations.prototype.toDeadline", {
                  date: shortDate(run.waitingUntil, i18n.language),
                })
              : t("automations.prototype.toDeadlineNone")}
          </button>
        )}
        {!blocked && thread && !writing && (
          <button type="button" className={quietButton} onClick={() => setWriting(true)}>
            {t("automations.prototype.simulateReply")}
          </button>
        )}
      </div>
      {writing && thread && (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("automations.prototype.replyLabel")}
            className={`${inputClass} min-h-24`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={secondaryButton} onClick={() => setWriting(false)}>
              {t("automations.actions.cancel")}
            </button>
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={!text.trim() || reply.isPending}
              onClick={() =>
                reply.mutate(
                  { threadId: thread, text },
                  {
                    onSuccess: () => {
                      setWriting(false);
                      setText("");
                      toast.show(t("automations.toast.replySent"));
                    },
                    onError: () => toast.error(t("automations.toast.replyError")),
                  },
                )
              }
            >
              {t("automations.prototype.sendReply")}
            </button>
          </div>
        </div>
      )}
    </PrototypeBox>
  );
}

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
  const cancel = useCancelAutomationRun();
  const retry = useRetryAutomationStep();
  const skip = useSkipAutomationStep();
  const [dialog, setDialog] = useState<"cancel" | "skip" | "on" | null>(null);
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
  const ownerId = automation?.ownerId ?? null;
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
      onSuccess: () => toast.show(t("automations.toast.retried", { code: run.code })),
      onError: () => toast.error(t("automations.toast.decisionError", { code: run.code })),
    });
  const passTime =
    run.permissions.manage && (run.status === "waiting_event" || run.status === "waiting_approval");

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
              {run.title}
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
        <Dialog
          title={t("automations.dialogs.cancelTitle", { code: run.code })}
          width={400}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setDialog(null)}>
                {t("automations.actions.keep")}
              </button>
              <button
                type="button"
                className={dangerSolidButton}
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate(run.id, {
                    onSuccess: () => {
                      setDialog(null);
                      toast.show(t("automations.toast.cancelled", { code: run.code }));
                    },
                    onError: () =>
                      toast.error(t("automations.toast.decisionError", { code: run.code })),
                  })
                }
              >
                {t("automations.actions.cancelRun")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">{t("automations.dialogs.cancelBody")}</p>
        </Dialog>
      )}
      {dialog === "skip" && (
        <Dialog
          title={t("automations.dialogs.skipTitle", { number: stepName(run, t)?.number ?? "" })}
          width={400}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setDialog(null)}>
                {t("automations.actions.cancel")}
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={skip.isPending}
                onClick={() =>
                  skip.mutate(run.id, {
                    onSuccess: () => {
                      setDialog(null);
                      toast.show(t("automations.toast.skipped", { code: run.code }));
                    },
                    onError: () =>
                      toast.error(t("automations.toast.decisionError", { code: run.code })),
                  })
                }
              >
                {t("automations.actions.skip")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">{t("automations.dialogs.skipBody")}</p>
        </Dialog>
      )}
      {dialog === "on" && (
        <TurnOnDialog automationId={run.automationId} onClose={() => setDialog(null)} />
      )}
    </article>
  );
}
