import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMailThreadOfMessage, usePeople } from "../../data/queries";
import type { AutomationRunDetail, DataField, RunLogEntry, Step } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { quietButton } from "../tasks/controls";
import {
  clientOf,
  conditionWords,
  daysBetween,
  reasonWords,
  shortDate,
  startedByWords,
  type Names,
  roleWords,
} from "./format";
import { approvalWords } from "./FlowSummary";
import { wordDiff } from "./logTree";
import { textLink } from "./shared";

// Le frasi del registro (al passato, da template i18n e dai dati della riga),
// gli effetti come link ai codici, e «Show data» con le etichette dei campi.
// Un effetto in un progetto che chi guarda non vede arriva senza codice
// (R-J12) e si scrive «in a project you can't see» (shape [A 17]).

export interface LogCtx {
  run: AutomationRunDetail;
  names: Names;
  labels: Map<string, DataField>;
  /** Il codice di un'automazione visibile (per «Started AUT-1 #3»). */
  automationCode: (id: string) => string | null;
}

type T = (key: string, options?: Record<string, unknown>) => string;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Le righe scritte dai blocchi d'istanza (area 9b, `runner.ts`): attesa e ripartenza. */
const AI_WAIT_CODES = new Set([
  "aiBudget",
  "aiQueuePaused",
  "aiBudgetBack",
  "aiQueueBack",
  // Il blocco è cambiato ma il passo resta fermo (due blocchi, shape EF).
  "aiBudgetBackStillQueue",
  "aiQueueBackStillBudget",
]);

/** Il codice di una cosa creata, come link: la task nel pannello, l'esecuzione, la Posta. */
function EffectLink({
  kind,
  code,
  entry,
  ctx,
}: {
  kind: string;
  code: string;
  entry: RunLogEntry;
  ctx: LogCtx;
}) {
  const thread = useMailThreadOfMessage(kind === "email" ? code : null).data;
  const project = ctx.names.project(str(entry.input.progetto) || ctx.run.automationProjectId);
  const codeClass =
    "num font-semibold text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";
  if (kind === "task") {
    return (
      <Link
        to="."
        search={((prev: Record<string, unknown>) => ({ ...prev, task: code })) as never}
        className={codeClass}
      >
        {code}
      </Link>
    );
  }
  if (kind === "run") {
    const m = /^(.+) #(\d+)$/.exec(code);
    return m ? (
      <Link
        to="/automations/$code/runs/$n"
        params={{ code: m[1]!, n: m[2]! }}
        className={codeClass}
      >
        {code}
      </Link>
    ) : (
      <span className={codeClass}>{code}</span>
    );
  }
  if (kind === "request" && project) {
    return (
      <Link
        to="/p/$code/$section"
        params={{ code: project.code, section: "requests" }}
        className={codeClass}
      >
        {code}
      </Link>
    );
  }
  if (kind === "email" && thread) {
    return (
      <>
        {" · "}
        <Link to="/mail/$threadId" params={{ threadId: thread }} className={textLink}>
          <OpenMailText />
        </Link>
      </>
    );
  }
  return null;
}

function OpenMailText() {
  const { t } = useTranslation();
  return <>{t("automations.log.openEmail")}</>;
}

/** L'approvazione ha cambiato l'anteprima: l'effetto eseguito dopo non è quello chiesto prima. */
function changedAfter(log: RunLogEntry[], approved: RunLogEntry): boolean {
  const i = log.indexOf(approved);
  const asked = log
    .slice(0, i)
    .reverse()
    .find((e) => e.path === approved.path && e.outcome === "waiting");
  const done = log.slice(i + 1).find((e) => e.path === approved.path && e.outcome === "ok");
  if (!asked || !done) return false;
  return Object.keys(done.input).some(
    (k) => typeof done.input[k] === "string" && asked.input[k] !== done.input[k],
  );
}

/** Chi decide un passo da approvare, dal flusso (per «Asked … to approve»). */
const askedWho = (step: Step | null, ctx: LogCtx, t: T) =>
  step && "approval" in step ? approvalWords(step.approval, ctx.names, t, null) : null;

/** La frase di una riga del registro, coi link ai codici. */
export function EntrySentence({
  entry,
  step,
  ctx,
}: {
  entry: RunLogEntry;
  step: Step | null;
  ctx: LogCtx;
}) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const who = ctx.names.person(entry.byId);
  const input = entry.input;
  const hiddenEffect = entry.effects.some((e) => e.code === "");
  // Area 9b ([EF 6]): l'attesa di un blocco d'istanza e la ripartenza, nella
  // lingua di chi guarda («Waiting: monthly AI budget reached»).
  // Chi ha messo la pausa si legge per nome anche se poi è stato disattivato.
  if (entry.why && AI_WAIT_CODES.has(entry.why.code)) {
    const params = entry.why.params ?? {};
    const pauser = people?.find((p) => p.id === params.byId);
    const name =
      pauser?.deactivated === true
        ? t("instanceEffects.deactivated", { name: params.name })
        : params.name;
    return <>{reasonWords({ ...entry.why, params: { ...params, ...(name ? { name } : {}) } }, t)}</>;
  }
  switch (entry.outcome) {
    case "approved":
      if (entry.output.progetto !== undefined) {
        const p = ctx.names.project(str(entry.output.progetto));
        return (
          <>
            {t("automations.log.projectChosen", {
              who,
              project: p ? `${p.code} · ${p.name}` : t("automations.log.hiddenProject"),
            })}
          </>
        );
      }
      return (
        <>
          {t(
            changedAfter(ctx.run.log, entry)
              ? "automations.log.approvedChangesBy"
              : "automations.log.approvedBy",
            { who },
          )}
        </>
      );
    case "rejected":
      return <>{t("automations.log.rejectedBy", { who })}</>;
    case "suspended":
      return <>{t("automations.log.suspended")}</>;
    case "resumed":
      return <>{t("automations.log.resumedBy", { who })}</>;
    case "cancelled":
      return <>{t("automations.log.cancelledBy", { who })}</>;
    case "retried":
      return <>{t("automations.log.retriedBy", { who })}</>;
    case "skipped":
      if (entry.byId) return <>{t("automations.log.skippedBy", { who })}</>;
      break;
    default:
      break;
  }
  if (entry.kind === "trigger") {
    const by = startedByWords(ctx.run.flow.trigger, ctx.names, t);
    const client = clientOf(entry.output);
    return (
      <>
        {client
          ? t("automations.log.startedClient", { by, client })
          : t("automations.log.started", { by })}
      </>
    );
  }
  if (entry.outcome === "waiting") {
    if (entry.kind === "wait") {
      const f = step?.kind === "wait" ? step.for : null;
      return (
        <>
          {f && "days" in f
            ? t("automations.log.waitingDays", { count: f.days })
            : t("automations.log.waitingReply")}
        </>
      );
    }
    if (typeof input.clientName === "string") {
      return <>{t("automations.log.askedProject", { client: input.clientName })}</>;
    }
    const asked = askedWho(step, ctx, t);
    return (
      <>
        {asked
          ? t("automations.log.askedApproval", { who: asked })
          : t("automations.log.waitingApproval")}
      </>
    );
  }
  if (entry.outcome === "failed") {
    return <>{t("automations.log.failed", { step: t(`automations.kind.${entry.kind}`) })}</>;
  }
  if (entry.outcome === "limit") return <>{t("automations.log.limit")}</>;
  if (entry.outcome === "skipped")
    return <>{t("automations.log.skipped", { step: t(`automations.kind.${entry.kind}`) })}</>;
  // ok
  const effect = entry.effects[0];
  const link = (e: { kind: string; code: string }) =>
    e.code ? <EffectLink kind={e.kind} code={e.code} entry={entry} ctx={ctx} /> : null;
  switch (entry.kind) {
    case "createTask": {
      if (hiddenEffect) return <>{t("automations.log.hiddenTask")}</>;
      const dept =
        step?.kind === "createTask" && step.assignee && "departmentId" in step.assignee
          ? ctx.names.department(step.assignee.departmentId)
          : str(input.reparto);
      return (
        <>
          {t("automations.log.createdTask")} {effect && link(effect)} “{str(input.titolo)}”
          {dept && ` ${t("automations.log.forDepartment", { dept })}`}
        </>
      );
    }
    case "createMilestone":
      if (hiddenEffect) return <>{t("automations.log.hiddenMilestone")}</>;
      return <>{t("automations.log.createdMilestone", { name: str(input.nome) })}</>;
    case "createRequest":
      if (hiddenEffect) return <>{t("automations.log.hiddenRequest")}</>;
      return (
        <>
          {t("automations.log.createdRequest")} {effect && link(effect)} “{str(input.titolo)}”
        </>
      );
    case "sendEmail":
      return (
        <>
          {t("automations.log.sent", { subject: str(input.subject), to: str(input.to) })}
          {effect && link(effect)}
        </>
      );
    case "notify":
      return (
        <>
          {t("automations.log.notified", {
            who: input.ruolo
              ? roleWords(str(input.ruolo), ctx.run.automationProjectId, ctx.names, t)
              : ctx.names.person(str(input.persona)),
          })}
        </>
      );
    case "startAutomation":
      // Un'esecuzione avviata che chi guarda non vede: né codice né link (R-G5).
      if (hiddenEffect) return <>{t("automations.log.hiddenRun")}</>;
      return (
        <>
          {t("automations.log.startedRun")} {effect && link(effect)}
        </>
      );
    case "wait": {
      const out = entry.output;
      if (out["risposta.arrivata"] === true) {
        // «Reply from mario@rossi.it received on Oct 26»: il mittente è chi
        // aveva ricevuto l'email attesa; il testo lo vede solo il proprietario (R-J16).
        const sender = replySender(ctx.run.log, entry);
        const date = shortDate(entry.at, i18n.language);
        return (
          <>
            {sender
              ? t("automations.log.replyFrom", { sender, date })
              : t("automations.log.replyReceivedOn", { date })}
            {entry.replyHidden && (
              <span data-reply-hidden className="block text-sm text-ink-muted">
                {t("automations.log.replyInMailbox", { owner: ctx.names.person(ctx.run.ownerId) })}
              </span>
            )}
          </>
        );
      }
      if (out["risposta.arrivata"] === false) {
        const since = [...ctx.run.log]
          .reverse()
          .find((e) => e.path === entry.path && e.outcome === "waiting" && e.at <= entry.at);
        return (
          <>
            {t("automations.log.noReply", { count: since ? daysBetween(since.at, entry.at) : 0 })}
          </>
        );
      }
      return <>{t("automations.log.waited")}</>;
    }
    case "condition": {
      const when =
        step?.kind === "condition" ? conditionWords(step.when, ctx.labels, t as never) : "";
      return (
        <>
          {t(
            entry.output.ramo === "then"
              ? "automations.log.conditionYes"
              : "automations.log.conditionNo",
            { when },
          )}
        </>
      );
    }
    case "forEach":
      return <>{t("automations.log.forEachDone", { count: Number(entry.output.giri ?? 0) })}</>;
    case "repeatUntil":
      return <>{t("automations.log.repeatDone", { count: Number(entry.output.giri ?? 0) })}</>;
    case "claude":
      return <>{t("automations.log.claudeAnswered")}</>;
  }
  return null;
}

/** Chi doveva rispondere: il destinatario dell'email attesa da questa attesa. */
function replySender(log: RunLogEntry[], wait: RunLogEntry): string | null {
  const replyTo = (wait.input as { replyTo?: unknown }).replyTo;
  if (typeof replyTo !== "string") return null;
  const sent = log.filter((e) => e.stepId === replyTo && e.kind === "sendEmail" && e.at <= wait.at);
  const to = sent.at(-1)?.input.to;
  return typeof to === "string" && to ? to : null;
}

/** Il valore di un dato in parole: progetti e persone per nome, elenchi uniti. */
function valueWords(key: string, v: unknown, ctx: LogCtx, t: T): string {
  if (key === "progetto") {
    const p = ctx.names.project(str(v));
    return p ? `${p.code} · ${p.name}` : t("automations.log.hiddenProject");
  }
  if ((key === "persona" || key === "casella" || key === "proprietario") && typeof v === "string") {
    return ctx.names.person(v);
  }
  if (v === true) return t("automations.condition.true");
  if (v === false) return t("automations.condition.false");
  if (Array.isArray(v))
    return v
      .map((x) => (typeof x === "object" && x ? Object.values(x).join(" · ") : String(x)))
      .join("; ");
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v ?? "");
}

function labelOf(key: string, ctx: LogCtx, t: T) {
  return ctx.labels.get(key)?.label ?? t(`automations.dataKeys.${key}`, { defaultValue: key });
}

/** «Show data»: le coppie etichetta → valore in ingresso e in uscita, e «Copy as JSON». */
export function EntryData({ entry, ctx }: { entry: RunLogEntry; ctx: LogCtx }) {
  const { t } = useTranslation();
  const toast = useToast();
  const groups = [
    { title: t("automations.log.dataIn"), data: entry.input },
    { title: t("automations.log.dataOut"), data: entry.output },
  ].filter((g) => Object.keys(g.data).length > 0);
  if (groups.length === 0)
    return <p className="pb-1 text-xs text-ink-faint">{t("automations.log.noData")}</p>;
  return (
    <div data-entry-data className="flex flex-col gap-2 pb-2 text-sm">
      {entry.replyHidden && (
        <p className="text-xs text-ink-muted">
          {t("automations.log.replyInMailbox", { owner: ctx.names.person(ctx.run.ownerId) })}
        </p>
      )}
      {groups.map((g) => (
        <dl
          key={g.title}
          className="grid grid-cols-[minmax(120px,200px)_minmax(0,1fr)] gap-x-3 gap-y-1"
        >
          <dt className="col-span-2 text-xs font-semibold text-ink-muted">{g.title}</dt>
          {Object.entries(g.data).map(([k, v]) => (
            <Pair key={k} label={labelOf(k, ctx, t)} title={k} value={valueWords(k, v, ctx, t)} />
          ))}
        </dl>
      ))}
      <button
        type="button"
        className={`${quietButton} h-7 self-start px-1.5`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(JSON.stringify({ input: entry.input, output: entry.output }, null, 2))
            .catch(() => {});
          toast.show(t("automations.toast.jsonCopied"));
        }}
      >
        {t("automations.log.copyJson")}
      </button>
    </div>
  );
}

function Pair({ label, title, value }: { label: string; title: string; value: string }) {
  return (
    <>
      <dt title={title} className="truncate text-ink-muted">
        {label}
      </dt>
      <dd className="min-w-0 whitespace-pre-line text-ink [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
}

/** «Show changes»: il prima e il dopo di un'approvazione con modifiche, parola per parola. */
export function ApprovalChanges({
  before,
  after,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const keys = Object.keys(after).filter(
    (k) => typeof after[k] === "string" && before[k] !== after[k],
  );
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        className={`${quietButton} h-7 self-start px-1.5`}
        onClick={() => setOpen((v) => !v)}
      >
        {t("automations.log.showChanges")}
      </button>
      {open &&
        keys.map((k) => (
          <p key={k} data-diff={k} className="text-sm text-ink [overflow-wrap:anywhere]">
            <span className="text-ink-muted">
              {t(`automations.dataKeys.${k}`, { defaultValue: k })}:{" "}
            </span>
            {wordDiff(str(before[k]), str(after[k])).map(
              (w, i): ReactNode =>
                w.kind === "same" ? (
                  <span key={i}>{w.text}</span>
                ) : w.kind === "removed" ? (
                  <del key={i} className="text-ink-muted line-through">
                    {w.text}
                  </del>
                ) : (
                  <ins
                    key={i}
                    className="underline decoration-ink underline-offset-2 [text-decoration-thickness:1.5px]"
                  >
                    {w.text}
                  </ins>
                ),
            )}
          </p>
        ))}
    </div>
  );
}
