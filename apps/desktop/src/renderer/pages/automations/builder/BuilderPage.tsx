import { useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../../domain/automations/fields";
import type { FlowIssue } from "../../../domain/automations/validate";
import {
  useAutomation,
  useAutomationDraftIssues,
  useAutomations,
  useAutomationSimulation,
  useAutomationSources,
  useSaveAutomationDraft,
} from "../../../data/queries";
import type { AutomationDetail, AutomationFlow } from "../../../data/types";
import { useViewer } from "../../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../../layout/useDetailPanel";
import { useMediaQuery } from "../../../layout/useMediaQuery";
import { PageError } from "../../../tasks-ui/PageStates";
import { useToast } from "../../../tasks-ui/Toast";
import { TurnOnDialog } from "../AutomationDialogs";
import { fieldLabels } from "../format";
import { NotVisible, useNames } from "../shared";
import { AddStepMenu } from "./AddStepMenu";
import { DeleteStepDialog, MoveToDialog } from "./BuilderDialogs";
import { BuilderHeader } from "./BuilderHeader";
import { BuilderContext, selectedStep, type BuilderState } from "./context";
import { FlowTree } from "./FlowTree";
import { DeleteDraftDialog, DiscardDialog, LeaveDialog, RenameDialog } from "./HeaderDialogs";
import { StartPanel } from "./StartPanel";
import { StepPanel } from "./StepPanel";
import { laneDepth, pathsById, stepNumbers } from "./tree";
import { useAutosave } from "./useAutosave";
import { useBuilderActions } from "./useBuilderActions";

// Il costruttore (shape builder, Task 6): `#/automations/<CODE>/edit`. Il
// flusso si legge come una procedura numerata a sinistra, il passo
// selezionato si modifica nel pannello a destra. La bozza si salva da sola
// a ogni modifica e non cambia mai ciò che gira ([A 8]): le esecuzioni in
// corso finiscono con la loro versione. Gli errori vengono da
// `validateFlow` (via `checkDraft`), i dati da `availableFields`: la pagina
// non decide da sola né cosa è disponibile né cosa è un errore.

/** `#/automations/<CODE>/edit` */
export function BuilderRoutePage({ code }: { code: string }) {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { step?: string; from?: string };
  return (
    <BuilderByCode
      key={`${viewer.personId}:${code}`}
      code={code}
      step={search.step}
      fromList={search.from === "list"}
    />
  );
}

function BuilderByCode({
  code,
  step,
  fromList,
}: {
  code: string;
  step?: string;
  fromList: boolean;
}) {
  const { t } = useTranslation();
  const list = useAutomations();
  const id = list.data?.find((x) => x.code === code)?.id ?? null;
  const detail = useAutomation(id);
  const sources = useAutomationSources();
  const restore = useSaveAutomationDraft();
  const toast = useToast();
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
      fromList={fromList}
      reload={async () => {
        await detail.refetch();
        setGeneration((g) => g + 1);
      }}
      // «Undo» di «Discard this draft»: la bozza torna (non ce n'è un'altra:
      // `expected` null), poi il costruttore ricarica su di lei.
      restoreDraft={async (flow) => {
        try {
          await restore.mutateAsync({ id: id!, flow, expected: null });
        } catch {
          toast.error(t("automations.builder.discard.restoreError"));
        }
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

function Builder({
  detail,
  initialStep,
  reload,
  restoreDraft,
  fromList,
}: {
  detail: AutomationDetail;
  initialStep?: string;
  fromList: boolean;
  reload: () => Promise<void>;
  restoreDraft: (flow: AutomationFlow) => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
    if (!initialStep) return null;
    // Un id (da «Fix»: il passo della bozza per id) o un percorso.
    if (pathsById(flow.steps).has(initialStep)) return initialStep;
    return stepAt(flow.steps, initialStep.replace(/\[\d+\]/g, "[0]"))?.id ?? null;
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

  const actions = useBuilderActions({
    flow,
    update,
    paths,
    numbers,
    sources,
    general,
    issues,
    selected,
    setSelected,
    setPanelOpen,
    announce: setAnnouncement,
    collapsed,
    writeCollapsed,
    treeRef,
    panelRef,
    dataRef,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Con un dialogo aperto le scorciatoie della pagina tacciono.
      if (document.querySelector('[aria-modal="true"], [data-add-menu]')) return;
      if (e.key === "F8") {
        e.preventDefault();
        actions.goProblem(e.shiftKey ? -1 : 1);
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
    select: actions.select,
    collapsed,
    toggleCollapsed: (id, open) => {
      const next = new Set(collapsed);
      const isOpen = !next.has(id);
      if (open === undefined ? isOpen : !open) next.add(id);
      else next.delete(id);
      writeCollapsed(next);
    },
    requestAdd: (lane, index, anchor) => !readOnly && actions.setAdding({ lane, index, anchor }),
    requestDelete: actions.requestDelete,
    duplicate: actions.duplicate,
    requestMoveTo: actions.setMovingTo,
    move: actions.move,
    announce: setAnnouncement,
  };

  const current = selectedStep(ctx);
  const draftExists = a.hasDraft || autosave.saved;
  const editingN = a.hasDraft ? latest.n : (live?.n ?? 0) + 1;
  const tested = useAutomationSimulation(readOnly ? null : a.id).data;
  const untested = !(tested && tested.draft && tested.version === editingN);
  // Test e Turn on/Publish restano chiusi finché la bozza salvata non è quella
  // a schermo: un salvataggio fallito o fermato da un altro.
  const saveBlocked = autosave.status === "error" || autosave.status === "stale";
  const blocked = issues.total > 0 || saveBlocked;
  const nothingToPublish = a.status !== "draft" && !draftExists;
  const why =
    autosave.status === "stale"
      ? t("automations.builder.blockedStale")
      : autosave.status === "error"
        ? t("automations.builder.blockedError")
        : issues.total > 0
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
          <BuilderHeader
            status={autosave.status}
            onRetry={autosave.retry}
            draftExists={draftExists}
            editingN={editingN}
            live={live}
            why={why}
            blocked={blocked}
            nothingToPublish={nothingToPublish}
            staleBy={detail.automation.versions.at(-1)?.savedById ?? null}
            staleAt={detail.automation.versions.at(-1)?.savedAt ?? null}
            onProblem={() => actions.goProblem(1)}
            onTest={() => void autosave.flush()}
            onPrimary={() => void autosave.flush().then((ok) => ok && setDialog("turnOn"))}
            onReload={() => void reload()}
            onRename={() => setDialog("rename")}
            onDiscard={draftExists && a.status !== "draft" ? () => setDialog("discard") : undefined}
            onDeleteDraft={
              a.status === "draft" && !readOnly ? () => setDialog("deleteDraft") : undefined
            }
            onCollapse={writeCollapsed}
            fromList={fromList}
          />
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
      {actions.adding && (
        <AddStepMenu
          anchor={actions.adding.anchor}
          depth={laneDepth(actions.adding.lane)}
          onPick={actions.addStep}
          onClose={() => {
            const anchor = actions.adding?.anchor;
            actions.setAdding(null);
            anchor?.focus();
          }}
        />
      )}
      {actions.deleting && (
        <DeleteStepDialog
          step={stepAt(flow.steps, paths.get(actions.deleting.id) ?? "")!}
          inside={actions.deleting.inside}
          broken={actions.deleting.broken}
          onClose={() => actions.setDeleting(null)}
          onConfirm={() => {
            const id = actions.deleting!.id;
            actions.setDeleting(null);
            actions.applyDelete(id);
          }}
        />
      )}
      {actions.movingTo && paths.has(actions.movingTo) && (
        <MoveToDialog
          step={stepAt(flow.steps, paths.get(actions.movingTo)!)!}
          onClose={() => actions.setMovingTo(null)}
          onMove={(target) => actions.applyMoveTo(actions.movingTo!, target)}
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
      {dialog === "rename" && <RenameDialog onClose={() => setDialog(null)} />}
      {dialog === "discard" && (
        <DiscardDialog
          flow={flow}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
          onRestore={(f) => void restoreDraft(f)}
        />
      )}
      {dialog === "deleteDraft" && <DeleteDraftDialog onClose={() => setDialog(null)} />}
      {blocker.status === "blocked" && (
        <LeaveDialog onStay={() => blocker.reset?.()} onLeave={() => blocker.proceed?.()} />
      )}
    </BuilderContext.Provider>
  );
}
