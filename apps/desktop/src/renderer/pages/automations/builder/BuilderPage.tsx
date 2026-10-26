import { Link, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt, visitSteps } from "../../../domain/automations/fields";
import type { FlowIssue } from "../../../domain/automations/validate";
import {
  useAutomation,
  useAutomationDraftIssues,
  useAutomations,
  useAutomationSimulation,
  useAutomationSources,
  useDeleteAutomationDraft,
  useSaveAutomationDraft,
} from "../../../data/queries";
import type { AutomationDetail, AutomationFlow, Step } from "../../../data/types";
import { useViewer } from "../../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../../layout/useDetailPanel";
import { useMediaQuery } from "../../../layout/useMediaQuery";
import { Dialog, DialogField, inputClass } from "../../../tasks-ui/Dialog";
import { MenuGroup, itemClass } from "../../../tasks-ui/Menu";
import { PageError } from "../../../tasks-ui/PageStates";
import { useToast } from "../../../tasks-ui/Toast";
import {
  MenuButton,
  dangerSolidButton,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../../tasks/controls";
import { TurnOnDialog } from "../AutomationDialogs";
import { fieldLabels } from "../format";
import { CriticalGlyph, MoreGlyph } from "../glyphs";
import { NotVisible, codeClass, useNames } from "../shared";
import { AddStepMenu } from "./AddStepMenu";
import { DeleteStepDialog, MoveToDialog } from "./BuilderDialogs";
import { BuilderContext, selectedStep, useBuilder, type BuilderState } from "./context";
import { FlowTree } from "./FlowTree";
import { StartPanel } from "./StartPanel";
import { StepPanel } from "./StepPanel";
import {
  brokenBy,
  duplicateAt,
  freshId,
  innerCount,
  insertAt,
  laneDepth,
  moveByOne,
  moveTo,
  newStep,
  pathsById,
  placeOf,
  removeAt,
  stepNumbers,
  type DropTarget,
} from "./tree";

// Il costruttore (shape builder, Task 6): `#/automations/<CODE>/edit`. Il
// flusso si legge come una procedura numerata a sinistra, il passo
// selezionato si modifica nel pannello a destra. La bozza si salva da sola
// a ogni modifica e non cambia mai ciò che gira ([A 8]): le esecuzioni in
// corso finiscono con la loro versione. Gli errori vengono da
// `validateFlow` (via `checkDraft`), i dati da `availableFields`: la pagina
// non decide da sola né cosa è disponibile né cosa è un errore.

/** Quanto aspetta il salvataggio dopo l'ultima modifica. */
const SAVE_DELAY_MS = 400;

type SaveStatus = "saved" | "saving" | "error" | "stale";

/** `#/automations/<CODE>/edit` */
export function BuilderRoutePage({ code }: { code: string }) {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { step?: string };
  return <BuilderByCode key={`${viewer.personId}:${code}`} code={code} step={search.step} />;
}

function BuilderByCode({ code, step }: { code: string; step?: string }) {
  const { t } = useTranslation();
  const list = useAutomations();
  const id = list.data?.find((x) => x.code === code)?.id ?? null;
  const detail = useAutomation(id);
  const sources = useAutomationSources();
  const [generation, setGeneration] = useState(0);
  if (list.isError || detail.isError)
    return (
      <PageError
        message={t("automations.builder.loadError")}
        onRetry={() => void (list.isError ? list.refetch() : detail.refetch())}
      />
    );
  if (
    list.data === undefined ||
    (id !== null && (detail.data === undefined || sources.data === undefined))
  )
    return <BuilderSkeleton />;
  if (id === null || !detail.data) return <NotVisible what="automation" />;
  return (
    <Builder
      key={`${detail.data.automation.id}:${generation}`}
      detail={detail.data}
      initialStep={step}
      reload={async () => {
        await detail.refetch();
        setGeneration((g) => g + 1);
      }}
    />
  );
}

function BuilderSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div
      aria-busy="true"
      className="skeleton-breathe flex max-w-[760px] flex-col gap-3 py-8 pr-8 pl-8"
    >
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`h-3 w-24 ${bar}`} />
      <span className={`h-7 w-96 ${bar}`} />
      <span className={`h-3 w-80 ${bar}`} />
      <div className="mt-6 flex flex-col gap-2">
        {[58, 72, 44, 66, 51, 38].map((w) => (
          <span key={w} className="flex h-12 items-center gap-3">
            <span className={`h-2.5 w-5 ${bar}`} />
            <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** La bozza che si salva da sola: in coda, una alla volta, con la revisione letta ([A 12]). */
function useAutosave(automationId: string, initialRev: number | null) {
  const save = useSaveAutomationDraft();
  // La mutazione cambia identità a ogni render: il salvataggio la legge da qui.
  const mutate = useRef(save.mutateAsync);
  mutate.current = save.mutateAsync;
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [saved, setSaved] = useState(false);
  const rev = useRef(initialRev);
  const pending = useRef<AutomationFlow | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stopped = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    if (inFlight.current) return inFlight.current.then(run);
    const flow = pending.current;
    if (!flow || stopped.current) return;
    pending.current = null;
    setStatus("saving");
    let failed = false;
    const job = (async () => {
      try {
        const a = await mutate.current({ id: automationId, flow, expected: rev.current });
        rev.current = a.versions.at(-1)!.rev ?? null;
        setSaved(true);
        setStatus(pending.current ? "saving" : "saved");
      } catch (e) {
        if ((e as Error).message === "invalid: stale") {
          stopped.current = true;
          setStatus("stale");
        } else {
          // Resta da salvare: riparte con «Retry» o con la prossima modifica, mai in un giro da solo.
          pending.current ??= flow;
          failed = true;
          setStatus("error");
        }
      }
    })();
    inFlight.current = job;
    await job;
    inFlight.current = null;
    if (pending.current && !stopped.current && !failed) {
      setStatus("saving");
      timer.current = window.setTimeout(() => void run(), SAVE_DELAY_MS);
    }
  }, [automationId]);

  const schedule = useCallback(
    (flow: AutomationFlow) => {
      if (stopped.current) return;
      pending.current = flow;
      setStatus("saving");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void run(), SAVE_DELAY_MS);
    },
    [run],
  );

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    await run();
    if (inFlight.current) await inFlight.current;
  }, [run]);

  // Uscendo con una modifica ancora in attesa, si salva lo stesso.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current && !stopped.current) void run();
    },
    [run],
  );

  return { status, saved, schedule, flush, retry: () => void run() };
}

function Builder({
  detail,
  initialStep,
  reload,
}: {
  detail: AutomationDetail;
  initialStep?: string;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const names = useNames();
  const a = detail.automation;
  const sources = useAutomationSources().data ?? [];
  const others = useAutomations().data ?? [];
  const latest = a.versions.at(-1)!;
  const live = [...a.versions].reverse().find((v) => v.publishedAt !== null) ?? null;
  const readOnly = !a.permissions.manage;
  const [flow, setFlow] = useState<AutomationFlow>(() => structuredClone(latest.flow));
  const autosave = useAutosave(a.id, latest.publishedAt === null ? (latest.rev ?? null) : null);
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const treeRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<HTMLElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const [adding, setAdding] = useState<{
    lane: string;
    index: number;
    anchor: HTMLElement | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    id: string;
    after: AutomationFlow;
    inside: number;
    broken: number[];
  } | null>(null);
  const [movingTo, setMovingTo] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"turnOn" | "rename" | "discard" | "deleteDraft" | null>(
    null,
  );
  // Sovrapposto (sotto i 1200 px) il pannello si apre scegliendo un passo, non da solo.
  const [panelOpen, setPanelOpen] = useState(initialStep !== undefined);
  const general = a.projectId === null;

  const collapseKey = `stubwise.builder.collapsed.${a.id}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem(collapseKey) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const writeCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(collapseKey, JSON.stringify([...next]));
    } catch {
      // niente storage: vale per questa vista
    }
  };

  const paths = useMemo(() => pathsById(flow.steps), [flow.steps]);
  const numbers = useMemo(() => stepNumbers(flow.steps), [flow.steps]);
  const labels = useMemo(() => fieldLabels(flow, sources), [flow, sources]);

  const [selected, setSelected] = useState<string | null>(() => {
    if (initialStep === "trigger" || flow.steps.length === 0) return "trigger";
    if (initialStep) return stepAt(flow.steps, initialStep.replace(/\[\d+\]/g, "[0]"))?.id ?? null;
    return null;
  });

  // Gli errori: quelli del flusso di adesso (o i precedenti, legati ai passi per id, finché arrivano).
  const check = useAutomationDraftIssues(a.id, flow);
  const issues = useMemo(() => {
    const data = check.data ?? { flow: latest.flow, issues: detail.configErrors };
    const byStep = new Map<string, FlowIssue[]>();
    const start: FlowIssue[] = [];
    const whole: FlowIssue[] = [];
    for (const i of data.issues) {
      if (i.path === "trigger") start.push(i);
      else if (i.path === "") whole.push(i);
      else {
        const s = stepAt(data.flow.steps, i.path.replace(/\[\d+\]/g, "[0]"));
        if (!s || !paths.has(s.id)) continue;
        byStep.set(s.id, [...(byStep.get(s.id) ?? []), i]);
      }
    }
    let total = start.length + whole.length;
    for (const v of byStep.values()) total += v.length;
    return { byStep, start, flow: whole, total };
  }, [check.data, latest.flow, detail.configErrors, paths]);

  // Il contatore annuncia solo il passaggio da zero a qualcosa e viceversa.
  const hadProblems = useRef(issues.total > 0);
  useEffect(() => {
    const has = issues.total > 0;
    if (has !== hadProblems.current) {
      hadProblems.current = has;
      setAnnouncement(
        has
          ? t("automations.builder.problemsCount", { count: issues.total })
          : t("automations.builder.noProblems"),
      );
    }
  }, [issues.total, t]);

  const update = useCallback(
    (next: (f: AutomationFlow) => AutomationFlow) => {
      if (readOnly) return;
      setFlow((f) => {
        const out = next(f);
        if (out !== f) autosave.schedule(out);
        return out;
      });
    },
    [readOnly, autosave],
  );

  const focusPanel = () =>
    requestAnimationFrame(() =>
      panelRef.current
        ?.querySelector<HTMLElement>(
          "input, select, textarea, [contenteditable='true'], button[role='radio']",
        )
        ?.focus(),
    );

  const reveal = useCallback(
    (id: string) => {
      const path = paths.get(id);
      if (!path) return;
      // Apre i blocchi che contengono il passo.
      const opened = new Set(collapsed);
      let changed = false;
      for (const [other, p] of paths) {
        if (path.startsWith(`${p}/`) && opened.delete(other)) changed = true;
      }
      if (changed) writeCollapsed(opened);
      requestAnimationFrame(() => {
        const row = treeRef.current?.querySelector<HTMLElement>(`[data-tree-row="${id}"]`);
        row?.scrollIntoView?.({ block: "nearest" });
        row?.focus();
      });
    },
    [paths, collapsed],
  );

  const select = useCallback((id: string | null, opts: { focusPanel?: boolean } = {}) => {
    setSelected(id);
    setPanelOpen(true);
    if (opts.focusPanel) {
      if (id === "trigger") requestAnimationFrame(() => dataRef.current?.focus());
      else focusPanel();
    }
  }, []);

  const move = (id: string, dir: -1 | 1) => {
    const path = paths.get(id);
    if (path === undefined) return;
    const r = moveByOne(flow.steps, path, dir);
    if (!r) {
      setAnnouncement(
        t(dir < 0 ? "automations.builder.move.atTop" : "automations.builder.move.atBottom"),
      );
      return;
    }
    update((f) => ({ ...f, steps: r.steps }));
    const { lane, index } = placeOf(r.path);
    const blockPath = lane.split("/").slice(0, -1).join("/");
    setAnnouncement(
      lane === ""
        ? t("automations.builder.move.movedMain", { position: index + 1 })
        : t("automations.builder.move.movedLane", {
            position: index + 1,
            n: stepNumbers(r.steps).get(blockPath),
          }),
    );
  };

  const applyDelete = (id: string, after: AutomationFlow) => {
    const before = flow;
    const n = numbers.get(paths.get(id) ?? "");
    update(() => after);
    setSelected(null);
    setAnnouncement(t("automations.builder.deleted", { n }));
    toast.show(t("automations.builder.deleted", { n }), {
      action: {
        label: t("automations.builder.undo"),
        run: () => {
          update(() => before);
          setAnnouncement(t("automations.builder.restored", { n }));
        },
      },
    });
  };

  const requestDelete = (id: string) => {
    const path = paths.get(id);
    if (path === undefined) return;
    const { steps, removed } = removeAt(flow.steps, path);
    const after = { ...flow, steps };
    const afterNumbers = stepNumbers(steps);
    const afterPaths = pathsById(steps);
    const broken = brokenBy(flow, after, sources).map((x) => afterNumbers.get(afterPaths.get(x)!)!);
    const inside = innerCount(removed);
    if (inside > 0 || broken.length > 0) setDeleting({ id, after, inside, broken });
    else applyDelete(id, after);
  };

  const duplicate = (id: string) => {
    const path = paths.get(id);
    if (path === undefined) return;
    const r = duplicateAt(flow.steps, path, t("automations.builder.copySuffix"));
    const copy = stepAt(r.steps, r.path)!;
    update((f) => ({ ...f, steps: r.steps }));
    setSelected(copy.id);
    setAnnouncement(t("automations.builder.duplicated", { n: stepNumbers(r.steps).get(r.path) }));
    requestAnimationFrame(() =>
      treeRef.current?.querySelector<HTMLElement>(`[data-tree-row="${copy.id}"]`)?.focus(),
    );
  };

  const addStep = (kind: Step["kind"]) => {
    if (!adding) return;
    const id = freshId(flow.steps);
    const step = newStep(kind, id, general);
    const steps = insertAt(flow.steps, adding.lane, adding.index, step);
    update((f) => ({ ...f, steps }));
    setAdding(null);
    setSelected(id);
    setPanelOpen(true);
    setAnnouncement(
      t("automations.builder.added", {
        n: stepNumbers(steps).get(`${adding.lane ? `${adding.lane}/` : ""}${adding.index}`),
        kind: t(`automations.builder.kind.${kind}`),
      }),
    );
    focusPanel();
  };

  // Il prossimo problema (contatore, F8 / Maiusc+F8, [A 10]): nell'ordine di lettura.
  const problemTargets = useMemo(() => {
    const out: string[] = [];
    if (issues.start.length > 0) out.push("trigger");
    visitSteps(flow.steps, (s) => {
      if (issues.byStep.has(s.id)) out.push(s.id);
    });
    return out;
  }, [issues, flow.steps]);
  const goProblem = (dir: 1 | -1) => {
    if (problemTargets.length === 0) return;
    const at = selected ? problemTargets.indexOf(selected) : -1;
    const next =
      problemTargets[
        at < 0
          ? dir > 0
            ? 0
            : problemTargets.length - 1
          : (at + dir + problemTargets.length) % problemTargets.length
      ]!;
    select(next);
    if (next === "trigger")
      requestAnimationFrame(() =>
        treeRef.current?.querySelector<HTMLElement>('[data-tree-row="trigger"]')?.focus(),
      );
    else reveal(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F8") {
        e.preventDefault();
        goProblem(e.shiftKey ? -1 : 1);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void autosave.flush().then(() => setAnnouncement(t("automations.builder.save.saved")));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Uscire con un salvataggio fallito chiede conferma.
  const unsaved = autosave.status === "error" || autosave.status === "stale";
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  const blocker = useBlocker({
    shouldBlockFn: () => unsavedRef.current,
    enableBeforeUnload: false,
    withResolver: true,
  });

  const ctx: BuilderState = {
    automation: a,
    flow,
    update,
    readOnly,
    names,
    sources,
    otherAutomations: others,
    labels,
    numbers,
    paths,
    issues,
    selected,
    select,
    collapsed,
    toggleCollapsed: (id, open) => {
      const next = new Set(collapsed);
      const isOpen = !next.has(id);
      if (open === undefined ? isOpen : !open) next.add(id);
      else next.delete(id);
      writeCollapsed(next);
    },
    requestAdd: (lane, index, anchor) => !readOnly && setAdding({ lane, index, anchor }),
    requestDelete,
    duplicate,
    requestMoveTo: setMovingTo,
    move,
    announce: setAnnouncement,
  };

  const current = selectedStep(ctx);
  const draftExists = a.hasDraft || autosave.saved;
  const editingN = a.hasDraft ? latest.n : (live?.n ?? 0) + 1;
  const tested = useAutomationSimulation(readOnly ? null : a.id).data;
  const untested = !(tested && tested.draft && tested.version === editingN);
  const projectWords = general
    ? t("automations.builder.meta.general")
    : (() => {
        const p = names.project(a.projectId);
        return p ? `${p.code} ${p.name}` : "";
      })();
  const actionLabel =
    a.status === "draft"
      ? t("automations.actions.turnOn")
      : t("automations.builder.publishN", { n: editingN });
  const blocked = issues.total > 0;
  const nothingToPublish = a.status !== "draft" && !draftExists;
  const why = blocked
    ? t(
        a.status === "draft"
          ? "automations.builder.fixToTurnOn"
          : "automations.builder.fixToPublish",
        { count: issues.total },
      )
    : nothingToPublish
      ? t("automations.builder.noChanges")
      : null;

  const panel =
    current !== null ? (
      <StepPanel key={current.step.id} step={current.step} path={current.path} />
    ) : (
      <StartPanel dataRef={dataRef} />
    );

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="flex h-full min-h-0">
        <div data-builder className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-rule bg-ground pt-6 pr-8 pb-4 pl-8">
            <Link
              to="/automations/$code"
              params={{ code: a.code }}
              className="w-fit text-sm text-ink-muted hover:text-ink"
            >
              ← <span className={codeClass}>{a.code}</span> {a.name}
            </Link>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <h1 className="min-w-0 flex-1 basis-80 text-2xl font-semibold break-words text-ink">
                {a.name}{" "}
                <span className="num align-middle text-sm font-semibold text-ink-faint">
                  {a.code}
                </span>
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                {issues.total > 0 && (
                  <button
                    type="button"
                    data-problem-count
                    onClick={() => goProblem(1)}
                    title={t("automations.builder.nextProblem")}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-critical hover:bg-critical/8"
                  >
                    <CriticalGlyph />
                    {t("automations.builder.problemsCount", { count: issues.total })}
                  </button>
                )}
                <HeaderMenu
                  onRename={() => setDialog("rename")}
                  onDiscard={
                    draftExists && a.status !== "draft" ? () => setDialog("discard") : undefined
                  }
                  onDeleteDraft={
                    a.status === "draft" && !readOnly ? () => setDialog("deleteDraft") : undefined
                  }
                  onExpandAll={() => writeCollapsed(new Set())}
                  onCollapseAll={() => {
                    const all = new Set<string>();
                    visitSteps(flow.steps, (s) => {
                      if (["condition", "claude", "forEach", "repeatUntil"].includes(s.kind))
                        all.add(s.id);
                    });
                    writeCollapsed(all);
                  }}
                  readOnly={readOnly}
                  code={a.code}
                />
                {!readOnly && (
                  <>
                    {blocked ? (
                      <button
                        type="button"
                        disabled
                        title={why ?? undefined}
                        className={`${secondaryButton} opacity-40`}
                      >
                        {t("automations.actions.test")}
                      </button>
                    ) : (
                      <Link
                        to="/automations/$code/test"
                        params={{ code: a.code }}
                        onClick={() => void autosave.flush()}
                        className={secondaryButton}
                      >
                        {t("automations.actions.test")}
                      </Link>
                    )}
                    <button
                      type="button"
                      data-primary-action
                      disabled={blocked || nothingToPublish}
                      title={why ?? undefined}
                      onClick={() => void autosave.flush().then(() => setDialog("turnOn"))}
                      className={`${primaryButton} disabled:opacity-40`}
                    >
                      {actionLabel}
                    </button>
                  </>
                )}
              </div>
            </div>
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
              <span>{projectWords}</span>
              <span aria-hidden="true">·</span>
              <span>{t(`automations.builder.meta.status.${a.status}`)}</span>
              {a.status !== "draft" && live && (
                <>
                  <span aria-hidden="true">·</span>
                  <span data-version-line>
                    {draftExists
                      ? t(`automations.builder.meta.editing.${a.status}`, {
                          n: editingN,
                          m: live.n,
                        })
                      : t(`automations.builder.meta.live.${a.status}`, { m: live.n })}
                  </span>
                </>
              )}
              {a.ownerId && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t("automations.builder.meta.actsAs", { name: names.person(a.ownerId) })}
                  </span>
                </>
              )}
              {!readOnly && (
                <>
                  <span aria-hidden="true">·</span>
                  <SaveStatus status={autosave.status} onRetry={autosave.retry} />
                </>
              )}
            </p>
            {why && !readOnly && <p className="text-sm text-ink-muted">{why}</p>}
            {readOnly && (
              <p data-read-only className="text-sm text-ink-muted">
                {t("automations.builder.readOnly", {
                  code: general
                    ? t("automations.general")
                    : (names.project(a.projectId)?.code ?? ""),
                })}
              </p>
            )}
            {!readOnly && a.status !== "draft" && draftExists && (
              <p data-draft-band className="text-sm text-ink">
                {t("automations.builder.band", { m: live?.n ?? 1 })}
              </p>
            )}
            {autosave.status === "stale" && (
              <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <CriticalGlyph />
                {t("automations.builder.stale", {
                  name: names.person(detail.automation.versions.at(-1)?.savedById ?? null),
                })}
                <button type="button" className={quietButton} onClick={() => void reload()}>
                  {t("automations.builder.reload")}
                </button>
              </p>
            )}
          </header>
          <div className="w-full max-w-[760px] min-w-[520px] px-6 pt-4 pb-24">
            <FlowTree treeRef={treeRef} />
          </div>
        </div>
        {(docked || panelOpen) && (
          <DetailPanel
            mode={docked ? "docked" : "overlay"}
            label={
              current
                ? t("automations.builder.stepN", { n: numbers.get(current.path) })
                : t("automations.builder.start.title")
            }
            defaultWidth={400}
            onClose={() => (docked ? setSelected(null) : setPanelOpen(false))}
          >
            <div ref={panelRef}>{panel}</div>
          </DetailPanel>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {adding && (
        <AddStepMenu
          anchor={adding.anchor}
          depth={laneDepth(adding.lane)}
          onPick={addStep}
          onClose={() => {
            const anchor = adding.anchor;
            setAdding(null);
            anchor?.focus();
          }}
        />
      )}
      {deleting && (
        <DeleteStepDialog
          step={stepAt(flow.steps, paths.get(deleting.id) ?? "")!}
          inside={deleting.inside}
          broken={deleting.broken}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            applyDelete(deleting.id, deleting.after);
            setDeleting(null);
          }}
        />
      )}
      {movingTo && paths.has(movingTo) && (
        <MoveToDialog
          step={stepAt(flow.steps, paths.get(movingTo)!)!}
          onClose={() => setMovingTo(null)}
          onMove={(target: DropTarget) => {
            const r = moveTo(flow.steps, paths.get(movingTo)!, target);
            if (r) {
              update((f) => ({ ...f, steps: r.steps }));
              setAnnouncement(
                t("automations.builder.move.moved", { n: stepNumbers(r.steps).get(r.path) }),
              );
              reveal(movingTo);
            }
            setMovingTo(null);
          }}
        />
      )}
      {dialog === "turnOn" && (
        <TurnOnDialog
          automationId={a.id}
          publish={a.status !== "draft"}
          untested={untested}
          onTestFirst={() => {
            setDialog(null);
            void navigate({ to: "/automations/$code/test", params: { code: a.code } } as never);
          }}
          onDone={() =>
            void navigate({ to: "/automations/$code", params: { code: a.code } } as never)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && <RenameDialog flow={flow} onClose={() => setDialog(null)} />}
      {dialog === "discard" && (
        <DiscardDialog
          flow={flow}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog === "deleteDraft" && <DeleteDraftDialog onClose={() => setDialog(null)} />}
      {blocker.status === "blocked" && (
        <Dialog
          title={t("automations.builder.leave.title")}
          width={440}
          onClose={() => blocker.reset?.()}
          footer={
            <>
              <button
                type="button"
                data-autofocus
                className={secondaryButton}
                onClick={() => blocker.reset?.()}
              >
                {t("automations.builder.leave.stay")}
              </button>
              <button
                type="button"
                className={dangerSolidButton}
                onClick={() => blocker.proceed?.()}
              >
                {t("automations.builder.leave.go")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">{t("automations.builder.leave.body")}</p>
        </Dialog>
      )}
    </BuilderContext.Provider>
  );
}

function SaveStatus({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const { t } = useTranslation();
  if (status === "error")
    return (
      <span data-save-status={status} className="inline-flex items-center gap-1.5 text-critical">
        <CriticalGlyph />
        {t("automations.builder.save.error")}
        <button
          type="button"
          className="font-medium text-ink underline-offset-4 hover:underline"
          onClick={onRetry}
        >
          {t("automations.builder.save.retry")}
        </button>
      </span>
    );
  return (
    <span data-save-status={status}>
      {status === "saving"
        ? t("automations.builder.save.saving")
        : status === "stale"
          ? t("automations.builder.save.stopped")
          : t("automations.builder.save.saved")}
    </span>
  );
}

function HeaderMenu({
  onRename,
  onDiscard,
  onDeleteDraft,
  onExpandAll,
  onCollapseAll,
  readOnly,
  code,
}: {
  onRename: () => void;
  onDiscard?: () => void;
  onDeleteDraft?: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  readOnly: boolean;
  code: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const item = (label: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${itemClass} ${danger ? "text-critical" : ""}`}
      onClick={run}
    >
      {label}
    </button>
  );
  return (
    <MenuButton
      ariaLabel={t("automations.builder.headerMenu")}
      menuLabel={t("automations.builder.headerMenu")}
      align="right"
      label={<MoreGlyph />}
      className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
    >
      {(close) => (
        <>
          <MenuGroup>
            {!readOnly && item(t("automations.builder.menu.rename"), () => (close(), onRename()))}
            {item(t("automations.builder.menu.expandAll"), () => (close(), onExpandAll()))}
            {item(t("automations.builder.menu.collapseAll"), () => (close(), onCollapseAll()))}
            {item(t("automations.actions.copyLink"), () => {
              close();
              void navigator.clipboard?.writeText(
                `${window.location.origin}${window.location.pathname}#/automations/${code}/edit`,
              );
              toast.show(t("automations.toast.linkCopied"));
            })}
          </MenuGroup>
          {(onDiscard || onDeleteDraft) && (
            <MenuGroup>
              {onDiscard &&
                item(t("automations.builder.menu.discard"), () => (close(), onDiscard()), true)}
              {onDeleteDraft &&
                item(t("automations.actions.deleteDraft"), () => (close(), onDeleteDraft()), true)}
            </MenuGroup>
          )}
        </>
      )}
    </MenuButton>
  );
}

function RenameDialog({ flow, onClose }: { flow: AutomationFlow; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const b = useBuilderAutomation();
  const save = useSaveAutomationDraft();
  const [name, setName] = useState(b.name);
  const [description, setDescription] = useState(b.description);
  const submit = () =>
    save.mutate(
      { id: b.id, flow, meta: { name, description } },
      { onSuccess: onClose, onError: () => toast.error(t("automations.builder.renameError")) },
    );
  return (
    <Dialog
      title={t("automations.builder.menu.rename")}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!name.trim() || save.isPending}
            onClick={submit}
          >
            {t("automations.builder.save.button")}
          </button>
        </>
      }
    >
      <DialogField label={t("automations.create.name")} htmlFor="builder-rename-name">
        <input
          id="builder-rename-name"
          data-autofocus
          className={inputClass}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </DialogField>
      <DialogField
        label={t("automations.builder.description")}
        htmlFor="builder-rename-description"
      >
        <textarea
          id="builder-rename-description"
          rows={4}
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </DialogField>
    </Dialog>
  );
}

/** I dialoghi vivono dentro il provider del costruttore. */
const useBuilderAutomation = () => useBuilder().automation;

function DiscardDialog({
  flow,
  onClose,
  onDone,
}: {
  flow: AutomationFlow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const a = useBuilderAutomation();
  const discard = useDeleteAutomationDraft();
  const save = useSaveAutomationDraft();
  const live = [...a.versions].reverse().find((v) => v.publishedAt !== null);
  return (
    <Dialog
      title={t("automations.builder.discard.title")}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            data-autofocus
            className={dangerSolidButton}
            disabled={discard.isPending}
            onClick={() =>
              discard.mutate(a.id, {
                onSuccess: () => {
                  onDone();
                  toast.show(t("automations.builder.discard.done"), {
                    action: {
                      label: t("automations.builder.undo"),
                      run: () => save.mutate({ id: a.id, flow }),
                    },
                  });
                },
                onError: () => toast.error(t("automations.builder.discard.error")),
              })
            }
          >
            {t("automations.builder.menu.discard")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">
        {t("automations.builder.discard.body", { m: live?.n ?? 1 })}
      </p>
    </Dialog>
  );
}

function DeleteDraftDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const a = useBuilderAutomation();
  const del = useDeleteAutomationDraft();
  return (
    <Dialog
      title={t("automations.dialogs.deleteTitle", { code: a.code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={del.isPending}
            onClick={() =>
              del.mutate(a.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.deleted", { code: a.code }));
                  void navigate({ to: "/automations" });
                },
                onError: () => toast.error(t("automations.toast.deleteError", { code: a.code })),
              })
            }
          >
            {t("automations.actions.delete")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.dialogs.deleteBody")}</p>
    </Dialog>
  );
}
