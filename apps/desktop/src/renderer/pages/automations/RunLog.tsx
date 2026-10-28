import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { childLists } from "../../domain/automations/fields";
import type { RunLogEntry, Step } from "../../data/types";
import { quietButton } from "../tasks/controls";
import { typing } from "../tasks/useTaskKeys";
import { clock, reasonWords, shortDate } from "./format";
import { CriticalGlyph, Disclosure, StepGlyph } from "./glyphs";
import { ApprovalChanges, EntryData, EntrySentence, type LogCtx } from "./LogEntryText";
import {
  buildLogTree,
  containerEntries,
  countEntries,
  created,
  entriesUnder,
  groupsContaining,
  isProblem,
  roundOf,
  type LogNode,
  type LogTree,
} from "./logTree";
import { ClaudePreview } from "./previews/Previews";
import {
  Collapsible,
  INDENT,
  Indent,
  Indented,
  NotTaken,
  branchLabel,
  matches,
  roundTitle,
  type LogFilter,
  type View,
} from "./LogGroups";

// Il registro di un'esecuzione (shape automations.md §6, «Log», [A 17]–[A 20]):
// una lista ordinata che si legge come una storia — l'ora a sinistra in cifre
// tabellari, il glifo del passo, la frase al passato, l'esito non ordinario
// a destra in parola. I giri dei cicli sono gruppi chiusi (il contenuto resta
// nella pagina, `hidden="until-found"`: ⌘F lo trova e lo apre); i rami presi
// rientrano con la loro etichetta, quelli non presi sono una riga sbiadita.
// Barra agganciata in alto, «Jump to now» quando la riga di adesso è fuori vista.

function Row({
  entry,
  step,
  view,
  depth,
}: {
  entry: RunLogEntry;
  step: Step | null;
  view: View;
  depth: number;
}) {
  const { t, i18n } = useTranslation();
  const ctx = view.ctx;
  const now =
    ctx.run.cursor === entry.path &&
    !["done", "failed", "cancelled"].includes(ctx.run.status) &&
    view.isLast(entry);
  const word =
    entry.outcome === "skipped" ||
    entry.outcome === "failed" ||
    entry.outcome === "limit" ||
    entry.outcome === "rejected"
      ? t(`automations.log.outcome.${entry.outcome}`)
      : null;
  // Un'approvazione con modifiche: l'anteprima chiesta (riga «waiting») e quella eseguita.
  const asked =
    entry.outcome === "ok" ? approvalBefore(ctx.run.log, entry, view.indexOf(entry)) : undefined;
  const pad = { paddingLeft: 92 + depth * INDENT };
  return (
    <>
      {view.dayBreak(entry) && (
        <li
          aria-hidden="true"
          data-day-separator
          className="heading-group pt-3 pb-1 pl-[92px] max-[1100px]:pl-[76px]"
        >
          {shortDate(entry.at, i18n.language)}
        </li>
      )}
      <li
        data-entry-index={view.indexOf(entry)}
        data-entry-path={entry.path}
        data-outcome={entry.outcome}
        data-now={now ? "" : undefined}
        data-problem={isProblem(entry) ? "" : undefined}
        tabIndex={-1}
        className={`log-row flex flex-col rounded-md outline-none focus-visible:bg-ink/6 ${now ? "bg-ink/4" : ""}`}
      >
        <div className="flex min-h-9 items-start gap-3 py-1.5 pr-2">
          <span className="num w-16 shrink-0 pt-px text-right text-xs text-ink-faint max-[1100px]:w-12">
            {clock(entry.at, i18n.language)}
          </span>
          <Indent depth={depth} />
          <span className="pt-0.5">
            <StepGlyph kind={entry.kind} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-md text-ink [overflow-wrap:anywhere]">
              {now && (
                <span className="mr-2 text-xs font-semibold tracking-[0.02em] text-ink">
                  {t("automations.log.nowLabel")}
                </span>
              )}
              <EntrySentence entry={entry} step={step} ctx={ctx} />
            </p>
            {entry.why &&
              entry.kind !== "claude" &&
              (entry.outcome === "failed" ||
                entry.outcome === "skipped" ||
                entry.outcome === "limit") && (
                <p className="text-sm text-ink-muted">{reasonWords(entry.why, t)}</p>
              )}
          </div>
          {word && (
            <span className="flex shrink-0 items-center gap-1 pt-0.5 text-sm text-ink-muted">
              {entry.outcome === "failed" && <CriticalGlyph />}
              {word}
            </span>
          )}
          {view.actionsFor(entry)}
        </div>
        <div style={pad} className="flex flex-col">
          {entry.kind === "claude" && entry.outcome === "ok" && (
            <div className="mb-2 border-l border-rule pl-4">
              <ClaudePreview
                p={{
                  stepId: entry.stepId,
                  path: entry.path,
                  outcome: typeof entry.output.uscita === "string" ? entry.output.uscita : null,
                  fields: Object.fromEntries(
                    Object.entries(entry.output).filter(([k]) => k !== "uscita"),
                  ),
                  reason: entry.reason ?? "",
                  read: [],
                }}
                words={{ names: ctx.names, labels: ctx.labels, numberOf: () => undefined }}
                outcomes={step?.kind === "claude" ? step.outcomes : []}
              />
            </div>
          )}
          {entry.kind === "claude" && entry.outcome === "failed" && entry.why && (
            <p className="pb-2 text-sm text-ink">{reasonWords(entry.why, t)}</p>
          )}
          {asked && <ApprovalChanges before={asked.input} after={entry.input} />}
          {view.showData && <EntryData entry={entry} ctx={ctx} />}
        </div>
      </li>
    </>
  );
}

/** La riga «in attesa di approvazione» prima di un effetto eseguito, se fra le due c'è un «approvato». */
export function approvalBefore(
  log: RunLogEntry[],
  entry: RunLogEntry,
  i = log.indexOf(entry),
): RunLogEntry | undefined {
  const prior = log.slice(0, i).filter((e) => e.path === entry.path);
  const approved = prior.at(-1);
  const waiting = prior.at(-2);
  return approved?.outcome === "approved" && waiting?.outcome === "waiting" ? waiting : undefined;
}

function NodeView({ node, view, depth }: { node: LogNode; view: View; depth: number }) {
  const { t } = useTranslation();
  const all = entriesUnder(node);
  if (!matches(view.filter, all)) return null;
  const step = node.step;

  // `forEach`: una riga di gruppo che riassume, i giri chiusi uno a uno.
  if (step?.kind === "forEach") {
    const rounds = node.children.filter((c) => roundOf(c.seg) !== null);
    const total = Math.max(
      rounds.length,
      Number(node.entries.find((e) => e.outcome === "ok")?.output.giri ?? 0),
    );
    const failedRounds = rounds.filter((c) =>
      containerEntries(c).some((e) => e.outcome === "failed"),
    ).length;
    const doneRounds = rounds.length - failedRounds;
    const problemFirst = rounds.find((c) => containerEntries(c).some(isProblem));
    const opens =
      view.filter !== "all" || problemFirst !== undefined || node.entries.some(isProblem);
    const open = view.isOpen(node.path, opens);
    const items = view.ctx.run.loops?.[node.path] as unknown[] | undefined;
    const list = view.ctx.labels.get(step.list)?.label ?? step.list;
    const id = `log-group-${node.path}`;
    return (
      <li data-log-group={node.path} className="flex flex-col">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => view.toggle(node.path, opens)}
          className="flex min-h-9 items-center gap-3 rounded-md pr-2 text-left hover:bg-ink/6"
        >
          <span className="flex w-16 shrink-0 justify-end max-[1100px]:w-12">
            <Disclosure open={open} />
          </span>
          <Indent depth={depth} />
          <StepGlyph kind="forEach" />
          <span className="text-md text-ink">
            {t("automations.log.forEachGroup", {
              as: step.as || t("automations.builder.lane.item"),
              list,
              count: total,
            })}
            <span className="text-ink-muted">
              {" · "}
              {failedRounds > 0
                ? t("automations.log.roundsDoneFailed", { done: doneRounds, failed: failedRounds })
                : t("automations.log.roundsDone", { count: doneRounds })}
            </span>
          </span>
        </button>
        <Collapsible id={id} open={open} onFound={() => !open && view.toggle(node.path, false)}>
          {rounds.map((c) => {
            const i = roundOf(c.seg)!;
            const entries = containerEntries(c);
            if (!matches(view.filter, entries)) return null;
            const ropen = view.isOpen(c.path, view.filter !== "all" || c === problemFirst);
            const result = entries.find((e) => e.effects.length > 0 && e.outcome === "ok")
              ?.effects[0];
            const bad = entries.find(isProblem);
            const rid = `log-round-${c.path}`;
            return (
              <li key={c.path} data-log-round={c.path} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={ropen}
                  aria-controls={rid}
                  onClick={() => view.toggle(c.path, view.filter !== "all" || c === problemFirst)}
                  className="flex min-h-8 items-center gap-3 rounded-md pr-2 text-left hover:bg-ink/6"
                >
                  <span className="w-16 shrink-0 max-[1100px]:w-12" />
                  <Indent depth={depth + 1} />
                  <Disclosure open={ropen} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {t("automations.log.round", { n: i + 1, total })}
                    <span className="text-ink-muted"> · {roundTitle(c, items, i)}</span>
                  </span>
                  <span className="num shrink-0 text-xs text-ink-muted">
                    {bad
                      ? t(`automations.log.outcome.${bad.outcome}`)
                      : result
                        ? result.code || t("automations.log.hiddenShort")
                        : ""}
                  </span>
                </button>
                <Collapsible
                  id={rid}
                  open={ropen}
                  onFound={() => !ropen && view.toggle(c.path, false)}
                >
                  {c.nodes.map((n) => (
                    <NodeView key={n.path} node={n} view={view} depth={depth + 2} />
                  ))}
                </Collapsible>
              </li>
            );
          })}
          {node.entries.map((e, k) =>
            e.outcome === "ok" ? null : (
              <Row key={k} entry={e} step={step} view={view} depth={depth + 1} />
            ),
          )}
        </Collapsible>
      </li>
    );
  }

  // Gli altri passi: le loro righe, poi i contenitori (rami presi, giri di
  // `repeatUntil`, il ramo del limite) rientrati, poi i rami non presi.
  const taken = new Set(node.children.map((c) => c.seg));
  const skipped =
    step && (step.kind === "condition" || step.kind === "claude")
      ? childLists(step).filter(
          (c) =>
            !taken.has(c.seg) && c.steps.length > 0 && node.entries.some((e) => e.outcome === "ok"),
        )
      : [];
  return (
    <>
      {node.entries.map((e, k) =>
        view.filter === "all" || (view.filter === "problems" ? isProblem(e) : created(e)) ? (
          <Row key={`${node.path}:${k}`} entry={e} step={step} view={view} depth={depth} />
        ) : null,
      )}
      {node.children.map((c) => {
        if (!matches(view.filter, containerEntries(c))) return null;
        const round = roundOf(c.seg);
        const label =
          round !== null && step?.kind === "repeatUntil"
            ? t("automations.log.repeatRound", { n: round + 1, max: step.max })
            : branchLabel(step, c.seg, t);
        return (
          <Indented key={c.path} label={label} depth={depth + 1}>
            {c.nodes.map((n) => (
              <NodeView key={n.path} node={n} view={view} depth={depth + 1} />
            ))}
          </Indented>
        );
      })}
      {view.filter === "all" &&
        skipped.map((c) => (
          <NotTaken
            key={c.seg}
            keyPath={`nt:${node.path}/${c.seg}`}
            label={branchLabel(step, c.seg, t)}
            steps={c.steps}
            view={view}
            depth={depth + 1}
          />
        ))}
    </>
  );
}

/**
 * Le righe nell'ordine in cui la pagina le disegna (gruppi chiusi compresi:
 * sono nel DOM), col filtro: un separatore del giorno compare ogni volta che
 * il giorno cambia rispetto alla riga prima, anche dentro i gruppi.
 */
function readingOrder(tree: LogTree, filter: LogFilter): RunLogEntry[] {
  const rowOk = (e: RunLogEntry) =>
    filter === "all" || (filter === "problems" ? isProblem(e) : created(e));
  const out: RunLogEntry[] = tree.trigger.filter(
    (e) => filter === "all" || (filter === "created" && created(e)),
  );
  const visit = (node: LogNode) => {
    if (!matches(filter, entriesUnder(node))) return;
    if (node.step?.kind === "forEach") {
      for (const c of node.children) {
        if (roundOf(c.seg) === null || !matches(filter, containerEntries(c))) continue;
        c.nodes.forEach(visit);
      }
      out.push(...node.entries.filter((e) => e.outcome !== "ok"));
      return;
    }
    out.push(...node.entries.filter(rowOk));
    for (const c of node.children) if (matches(filter, containerEntries(c))) c.nodes.forEach(visit);
  };
  tree.nodes.forEach(visit);
  return out;
}

export function RunLog({
  ctx,
  entry: anchor,
  actionsFor,
}: {
  ctx: LogCtx;
  /** `?entry=`: la riga a cui portare (e i gruppi da aprire). */
  entry?: string;
  actionsFor: (entry: RunLogEntry) => ReactNode;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildLogTree(ctx.run.log, ctx.run.flow), [ctx.run.log, ctx.run.flow]);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [showData, setShowData] = useState(false);
  const [mode, setMode] = useState<"default" | "all" | "none">("default");
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() =>
    anchor ? Object.fromEntries(groupsContaining(anchor).map((k) => [k, true])) : {},
  );
  const list = useRef<HTMLOListElement>(null);
  const [nowOut, setNowOut] = useState(false);
  // La riga a cui `[`/`]` portano il fuoco, appena i suoi gruppi sono aperti.
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  const index = useMemo(() => new Map(ctx.run.log.map((e, i) => [e, i])), [ctx.run.log]);
  const last = useMemo(() => {
    const m = new Map<string, RunLogEntry>();
    for (const e of ctx.run.log) m.set(e.path, e);
    return m;
  }, [ctx.run.log]);
  const breaks = useMemo(() => {
    const out = new Set<RunLogEntry>();
    let day = "";
    for (const e of readingOrder(tree, filter)) {
      if (e.at.slice(0, 10) !== day) out.add(e);
      day = e.at.slice(0, 10);
    }
    return out;
  }, [tree, filter]);

  const isOpen = (key: string, fallback: boolean) =>
    overrides[key] ?? (mode === "all" ? true : mode === "none" ? false : fallback);
  const view: View = {
    ctx,
    filter,
    showData,
    isOpen,
    toggle: (key, fallback) =>
      setOverrides((o) => ({
        ...o,
        [key]: !(o[key] ?? (mode === "all" ? true : mode === "none" ? false : fallback)),
      })),
    actionsFor,
    indexOf: (e) => index.get(e) ?? -1,
    isLast: (e) => last.get(e.path) === e,
    dayBreak: (e) => breaks.has(e),
  };

  // `?entry=`: porta la riga in vista e le dà il fuoco.
  useEffect(() => {
    if (!anchor) return;
    // Per valore, non con un selettore: un percorso ha «/», «[» e spazi (le uscite di Claude).
    const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-entry-path]") ?? [])].find(
      (el) => el.dataset.entryPath === anchor,
    );
    row?.scrollIntoView?.({ block: "center" });
    row?.focus({ preventScroll: true });
  }, [anchor]);

  // «Jump to now»: compare quando la riga di adesso è fuori vista.
  useEffect(() => {
    const row = list.current?.querySelector("[data-now]");
    if (!row || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setNowOut(!e!.isIntersecting));
    io.observe(row);
    return () => io.disconnect();
  }, [tree, filter, mode, overrides]);

  // `[` e `]` in tutta la pagina dell'esecuzione: al problema precedente e
  // successivo (shape [A 27]), aprendo prima i gruppi che lo contengono.
  const problems = useMemo(
    () => ctx.run.log.map((e, i) => [e, i] as const).filter(([e]) => isProblem(e)),
    [ctx.run.log],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if ((e.key !== "[" && e.key !== "]") || problems.length === 0) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const active = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        "[data-entry-index]",
      );
      const current = active ? Number(active.dataset.entryIndex) : -1;
      const at = problems.findIndex(([, i]) => i === current);
      const next =
        e.key === "]" ? (at + 1) % problems.length : (at <= 0 ? problems.length : at) - 1;
      const [entry, i] = problems[next]!;
      e.preventDefault();
      setFilter((f) => (f === "created" ? "all" : f));
      setOverrides((o) => ({
        ...o,
        ...Object.fromEntries(groupsContaining(entry.path).map((k) => [k, true])),
      }));
      setPendingFocus(i);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [problems]);
  useEffect(() => {
    if (pendingFocus === null) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-entry-index="${pendingFocus}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "center" });
    setPendingFocus(null);
  }, [pendingFocus, overrides]);

  const segments: { value: LogFilter; label: string }[] = [
    { value: "all", label: t("automations.log.filter.all") },
    { value: "problems", label: t("automations.log.filter.problems") },
    { value: "created", label: t("automations.log.filter.created") },
  ];

  return (
    <section aria-labelledby="run-log" data-run-log className="border-t border-rule pt-5 pb-7">
      <h2 id="run-log" className="flex items-baseline gap-3 pb-2 text-xl font-semibold text-ink">
        {t("automations.log.title")}
        <span className="num text-md font-normal text-ink-faint">{countEntries(tree)}</span>
      </h2>
      <div
        role="toolbar"
        aria-label={t("automations.log.toolbar")}
        className="sticky top-0 z-10 flex min-h-9 flex-wrap items-center gap-2 border-b border-rule bg-ground py-1"
      >
        <div
          role="radiogroup"
          aria-label={t("automations.log.show")}
          className="flex items-center rounded-md border border-rule p-0.5"
        >
          {segments.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={filter === s.value}
              onClick={() => setFilter(s.value)}
              className="h-6 rounded-[4px] px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink aria-checked:bg-ink/10 aria-checked:text-ink"
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`${quietButton} h-7`}
          onClick={() => {
            setMode("all");
            setOverrides({});
          }}
        >
          {t("automations.log.expandAll")}
        </button>
        <button
          type="button"
          className={`${quietButton} h-7`}
          onClick={() => {
            setMode("none");
            setOverrides({});
          }}
        >
          {t("automations.log.collapseAll")}
        </button>
        <label className="ml-auto flex h-7 items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            className="accent-ink"
            checked={showData}
            onChange={(e) => setShowData(e.target.checked)}
          />
          {t("automations.log.showData")}
        </label>
      </div>
      <ol
        ref={list}
        aria-label={t("automations.log.title")}
        className="log-list flex flex-col pt-1"
      >
        {tree.trigger.map((e, k) =>
          filter === "all" || (filter === "created" && created(e)) ? (
            <Row key={`trigger-${k}`} entry={e} step={null} view={view} depth={0} />
          ) : null,
        )}
        {tree.nodes.map((n) => (
          <NodeView key={n.path} node={n} view={view} depth={0} />
        ))}
      </ol>
      {nowOut && (
        <button
          type="button"
          onClick={() => {
            const row = list.current?.querySelector<HTMLElement>("[data-now]");
            row?.scrollIntoView({ block: "center", behavior: "smooth" });
            row?.focus({ preventScroll: true });
          }}
          className="fixed right-8 bottom-6 z-20 inline-flex h-8 items-center gap-1.5 rounded-md border border-rule-strong bg-surface px-3 text-sm font-medium text-ink shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)] hover:bg-ink/6"
        >
          {t("automations.log.jumpToNow")}
        </button>
      )}
    </section>
  );
}
