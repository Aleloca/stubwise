import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../../domain/automations/fields";
import { show } from "../../../domain/automations/preview";
import type { SimulationView, Step } from "../../../data/types";
import { quietButton } from "../../tasks/controls";
import { conditionWords, reasonWords, shortDate, stepSentence, templatePlain } from "../format";
import { flowPathOf, usePreviewProps, useTest } from "./context";
import { lastEntry, markAt, type Mark } from "./marks";
import {
  ClaudePreview,
  EffectPreview,
  EmailPreview,
  FailurePreview,
  TaskPreview,
} from "../previews/Previews";
import { ApprovalStop, EventStop, ProjectStop } from "./StopActions";

// Il pannello dell'anteprima (shape automation-test §3 e §5): al posto del
// pannello del passo del costruttore, cosa farebbe il passo selezionato (di
// default il corrente), sempre al condizionale; in fondo, quando la prova è
// ferma, le azioni della fermata. Selezionare una riga già fatta mostra la
// sua anteprima senza spostare la prova; «Back to current step» ci torna.

/** Il percorso del passo corrente: dove la prova è ferma o sta per fare qualcosa. */
export const currentPathOf = (sim: SimulationView | null) =>
  sim && !["done", "failed", "cancelled"].includes(sim.status)
    ? (sim.current?.path ?? sim.cursor)
    : null;

export function PreviewPanel({ bodyRef }: { bodyRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const sim = ctx.sim;
  const current = currentPathOf(sim);
  // Mentre la motivazione di Claude arriva, il pannello la mostra.
  const sel = ctx.selected ?? ctx.stream?.path ?? current;
  if (!sim || !ctx.ix) return null;
  if (sel === null)
    return (
      <p className="px-5 py-5 text-md text-ink-muted">{t("automations.test.panel.nothing")}</p>
    );
  const back =
    ctx.selected !== null && current !== null && ctx.selected !== current ? (
      <button type="button" className={`${quietButton} -ml-2.5`} onClick={() => ctx.select(null)}>
        ← {t("automations.test.panel.back")}
      </button>
    ) : null;
  if (sel === "trigger")
    return (
      <div ref={bodyRef} className="flex flex-col gap-4 px-5 py-5">
        {back}
        <h2 className="text-lg font-semibold text-ink">{t("automations.test.panel.start")}</h2>
        <EventData event={sim.event} />
      </div>
    );
  const step = stepAt(ctx.flow.steps, flowPathOf(sel));
  if (!step) return null;
  const n = ctx.numbers.get(flowPathOf(sel)) ?? 0;
  const notTaken = isInNotTakenLane(sel, ctx);
  const mark: Mark = notTaken ? "notTaken" : markAt(ctx.ix, sel);
  return (
    <div ref={bodyRef} data-preview-panel={sel} className="flex flex-col gap-4 px-5 py-5">
      {back}
      <header className="flex flex-col gap-0.5">
        <h2 className="text-lg font-semibold text-ink">
          {t("automations.test.panel.stepN", {
            n,
            kind: t(`automations.builder.kind.${step.kind}`),
          })}
        </h2>
        <p
          data-panel-state
          className={`text-sm ${mark === "failed" ? "text-critical" : "text-ink-muted"}`}
        >
          {stateWords(mark, sim, t)}
        </p>
      </header>
      <StepBody step={step} path={sel} mark={mark} />
    </div>
  );
}

function stateWords(mark: Mark, sim: SimulationView, t: (k: string) => string) {
  if (mark === "stopped") {
    const k = sim.waiting?.kind;
    return t(
      k === "approval"
        ? "automations.test.panel.state.waitingApproval"
        : k === "project"
          ? "automations.test.panel.state.project"
          : "automations.test.panel.state.waiting",
    );
  }
  if (mark === "current") return t("automations.test.panel.state.would");
  if (mark === "inside") return t("automations.test.mark.inside");
  return t(`automations.test.panel.state.${mark}`);
}

/** Una corsia fra gli antenati del percorso è un ramo non preso? */
function isInNotTakenLane(path: string, ctx: ReturnType<typeof useTest>): boolean {
  const segs = path.split("/");
  for (let k = 1; k < segs.length; k += 2) {
    const blockPath = segs.slice(0, k).join("/");
    const lane = segs[k]!;
    const last = lastEntry(ctx.ix!, blockPath);
    const block = stepAt(ctx.flow.steps, flowPathOf(blockPath));
    if (!block || !last) continue;
    if (block.kind === "condition" && last.output.ramo !== undefined && last.output.ramo !== lane)
      return true;
    if (
      block.kind === "claude" &&
      typeof last.output.uscita === "string" &&
      last.output.uscita !== lane
    )
      return true;
  }
  return false;
}

function StepBody({ step, path, mark }: { step: Step; path: string; mark: Mark }) {
  const { t, i18n } = useTranslation();
  const pp = usePreviewProps();
  const ctx = useTest();
  const sim = ctx.sim!;
  const ix = ctx.ix!;
  const last = lastEntry(ix, path);
  const sentence = () =>
    templatePlain(
      stepSentence(step, ctx.flow, ctx.names, ctx.labels, t, () => null).text,
      ctx.labels,
    );
  if (mark === "notTaken")
    return (
      <>
        <p className="text-md text-ink-muted">{t("automations.test.panel.notTaken")}</p>
        <p className="text-md text-ink-faint">{sentence()}</p>
      </>
    );
  if (mark === "pending")
    return (
      <p className="text-md text-ink-faint">
        {sentence() || t("automations.test.panel.notReached")}
      </p>
    );

  // Al cursore: cosa farebbe adesso, o la fermata.
  if (path === currentPathOf(sim)) {
    const cur = sim.current?.path === path ? sim.current : null;
    const w = sim.waiting;
    if (w?.kind === "approval" && w.path === path)
      return (
        <ApprovalStop
          key={path}
          waiting={w}
          preview={cur?.preview ?? null}
          failure={cur?.failure ?? null}
        />
      );
    if (w?.kind === "project" && w.path === path) return <ProjectStop waiting={w} />;
    if (w?.kind === "event" && w.path === path) {
      const wf = w.wait;
      const days = "days" in wf ? wf.days : wf.maxDays;
      return (
        <div className="flex flex-col gap-3">
          {"replyTo" in wf ? (
            <>
              <p className="max-w-[68ch] text-md text-ink">
                {t("automations.test.preview.waitReply", {
                  n: ctx.numberOf(wf.replyTo) ?? "",
                  count: days,
                })}
              </p>
              {w.email && <AwaitedEmail email={w.email} />}
              <p className="text-sm text-ink-muted">{t("automations.test.preview.realReply")}</p>
            </>
          ) : "taskClosed" in wf ? (
            <>
              <p className="max-w-[68ch] text-md text-ink">
                {t("automations.test.preview.waitTask", {
                  n: ctx.numberOf(wf.taskClosed) ?? "",
                  count: days,
                })}
              </p>
              {w.task && <TaskPreview p={w.task} words={pp.words} />}
              <p className="text-sm text-ink-muted">{t("automations.test.preview.realTask")}</p>
            </>
          ) : (
            <p className="text-md text-ink">
              {t("automations.test.preview.wait", {
                count: days,
                date: shortDate(w.until, i18n.language),
              })}
            </p>
          )}
          <EventStop key={path} waiting={w} />
        </div>
      );
    }
    if (cur?.failure)
      return (
        <FailurePreview
          reason={reasonWords(cur.failure.why, t, { would: true })}
          claude={step.kind === "claude"}
        />
      );
    if (cur?.preview)
      return (
        <div className="flex flex-col gap-3">
          <EffectPreview {...pp} p={cur.preview} />
          <p className="border-t border-rule pt-3 text-sm text-ink-muted">
            {t("automations.test.preview.wouldDo")}
          </p>
        </div>
      );
    if (step.kind === "claude") {
      const inputs = step.inputs.map((k) => ctx.labels.get(k)?.label ?? k);
      return (
        <p className="max-w-[68ch] text-md text-ink">
          {inputs.length > 0
            ? t("automations.test.preview.claudeNext", { inputs: inputs.join(", ") })
            : t("automations.test.preview.claudeNextNoInputs")}
        </p>
      );
    }
  }

  if (mark === "failed" || (mark === "done" && last?.outcome === "failed"))
    return (
      <FailurePreview
        reason={
          step.kind === "forEach" && typeof last?.output.elementi === "number"
            ? t("automations.test.preview.forEachOver", { count: last.output.elementi, max: 50 })
            : reasonWords(last?.why, t, { would: true })
        }
        claude={step.kind === "claude"}
      />
    );

  // Già fatto: l'anteprima di ciò che ha fatto, a quel percorso.
  const item = effectAt(sim, path);
  if (item) return <EffectPreview {...pp} p={item} />;
  switch (step.kind) {
    case "claude": {
      const p = sim.preview.claude.find((x) => x.path === path);
      if (!p) return null;
      const streaming = ctx.stream?.path === path ? ctx.stream.text : undefined;
      return <ClaudePreview p={p} words={pp.words} reason={streaming} />;
    }
    case "condition": {
      const values = Object.entries(last?.input ?? {});
      return (
        <div className="flex flex-col gap-3">
          <p className="text-md text-ink">
            {conditionWords(step.when, ctx.labels, t)}{" "}
            <strong className="font-semibold">
              {last?.output.ramo === "then"
                ? t("automations.test.row.if")
                : t("automations.test.row.otherwise")}
            </strong>
          </p>
          {values.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="heading-group">{t("automations.test.preview.condition")}</p>
              <dl className="grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                {values.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-muted">{ctx.labels.get(k)?.label ?? k}</dt>
                    <dd className="text-ink [overflow-wrap:anywhere]">
                      {show(v) || t("automations.test.panel.empty")}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      );
    }
    case "forEach": {
      const items = sim.loopItems[path] ?? [];
      return (
        <p className="text-md text-ink">
          {t("automations.test.preview.forEach", {
            list: ctx.labels.get(step.list)?.label ?? step.list,
            count: items.length,
          })}
        </p>
      );
    }
    case "repeatUntil": {
      const giri = Number(last?.output.giri ?? 0);
      const limit = (ix.byPath.get(path) ?? []).some((e) => e.outcome === "limit");
      return (
        <div className="flex flex-col gap-2">
          <p className="text-md text-ink">
            {t("automations.test.preview.repeat", {
              until: conditionWords(step.until, ctx.labels, t),
              max: step.max,
            })}
          </p>
          <p className="text-md text-ink-muted">
            {limit
              ? t("automations.test.row.limit", { count: giri })
              : last?.outcome === "skipped"
                ? t("automations.test.preview.repeatSkipped")
                : t("automations.test.preview.repeatDone", { count: giri })}
          </p>
        </div>
      );
    }
    case "wait": {
      const out = last?.output ?? {};
      const reply = out["risposta.testo"];
      return (
        <div className="flex flex-col gap-2">
          <p className="text-md text-ink">{sentence()}</p>
          {typeof reply === "string" && reply !== "" ? (
            <div className="flex flex-col gap-1">
              <p className="heading-group">{t("automations.test.preview.replyGot")}</p>
              <p className="max-w-[68ch] text-md whitespace-pre-line text-ink">{reply}</p>
            </div>
          ) : out["risposta.arrivata"] === false ? (
            <p className="text-md text-ink-muted">{t("automations.test.preview.noReplyGot")}</p>
          ) : null}
        </div>
      );
    }
    default:
      return <p className="text-md text-ink">{sentence()}</p>;
  }
}

/** L'anteprima di ciò che un passo ha fatto a quel percorso (giro compreso). */
function effectAt(sim: SimulationView, path: string) {
  const p = sim.preview;
  const find = <T extends { path: string }>(list: T[]) => list.find((x) => x.path === path);
  const task = find(p.tasks);
  if (task) return { kind: "task" as const, ...task };
  const ms = find(p.milestones);
  if (ms) return { kind: "milestone" as const, ...ms };
  const rq = find(p.requests);
  if (rq) return { kind: "request" as const, ...rq };
  const em = find(p.emails);
  if (em) return { kind: "email" as const, ...em };
  const nt = find(p.notifications);
  if (nt) return { kind: "notification" as const, ...nt };
  const st = find(p.starts);
  if (st) return { kind: "start" as const, ...st };
  return null;
}

/** L'email a cui si aspetta risposta, in una riga; «See» la apre. */
function AwaitedEmail({ email }: { email: SimulationView["preview"]["emails"][number] }) {
  const { t } = useTranslation();
  const pp = usePreviewProps();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="min-w-0 truncate font-medium text-ink">{email.subject}</span>
        <span className="text-ink-muted">{t("automations.test.summary.to", { to: email.to })}</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-sm text-ink underline-offset-4 hover:underline"
        >
          {open ? t("automations.test.preview.hide") : t("automations.test.preview.see")}
        </button>
      </p>
      {open && <EmailPreview {...pp} p={email} />}
    </div>
  );
}

/** I dati dell'esempio, etichetta · valore; le liste si aprono. */
function EventData({ event }: { event: Record<string, unknown> }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const rows: [string, unknown][] = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (ctx.labels.has(key) || Array.isArray(v) || v === null || typeof v !== "object")
        rows.push([key, v]);
      else walk(v as Record<string, unknown>, key);
    }
  };
  walk(event, "");
  return (
    <div className="flex flex-col gap-1">
      <p className="heading-group">{t("automations.test.panel.data")}</p>
      <dl className="grid grid-cols-[minmax(104px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{ctx.labels.get(k)?.label ?? k}</dt>
            <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">
              {Array.isArray(v) ? (
                <ListValue items={v} />
              ) : (
                show(v) || (
                  <span className="text-ink-faint">{t("automations.test.panel.empty")}</span>
                )
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ListValue({ items }: { items: unknown[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="self-start underline-offset-4 hover:underline"
      >
        {t("automations.test.panel.items", { count: items.length })}
      </button>
      {open && (
        <ol className="flex flex-col gap-0.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2">
              <span className="num w-5 shrink-0 text-right text-ink-faint">{i + 1}</span>
              <span>
                {it && typeof it === "object"
                  ? Object.values(it as Record<string, unknown>)
                      .map(show)
                      .filter(Boolean)
                      .join(" · ")
                  : show(it)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
