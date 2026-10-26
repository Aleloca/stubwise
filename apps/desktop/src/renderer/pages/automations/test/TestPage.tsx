import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../../domain/automations/fields";
import {
  useAutomation,
  useAutomations,
  useAutomationSources,
  useSessionPersonId,
} from "../../../data/queries";
import type { AutomationDetail, SimulationView } from "../../../data/types";
import { useViewer } from "../../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../../layout/useDetailPanel";
import { useMediaQuery } from "../../../layout/useMediaQuery";
import { PageError } from "../../../tasks-ui/PageStates";
import { TurnOnDialog } from "../AutomationDialogs";
import { fieldLabels, isUntested } from "../format";
import { NotVisible, useNames } from "../shared";
import { numbersById, stepNumbers } from "../numbering";
import { Blocked } from "./Blocked";
import { flowPathOf, TestContext, type TestState } from "./context";
import { ExampleDialog } from "./ExampleDialog";
import { defaultRound, indexLog } from "./marks";
import { currentPathOf, PreviewPanel } from "./PreviewPanel";
import { Summary } from "./Summary";
import { TestFlow } from "./TestFlow";
import { TestHeader } from "./TestHeader";
import { useTestRun } from "./useTestRun";

// La prova di un'automazione (shape automation-test.md, Task 7):
// `#/automations/<CODE>/test`, una modalità del costruttore ([A 1]). Si
// sceglie un evento d'esempio, la prova parte e si ferma subito sul primo
// passo (non corre da sola, [A 14]); «Next step» uno alla volta, «Run to
// next stop» fino alla prossima fermata. Usa SOLO `startSimulation` /
// `simulationStep` / `getSimulation` / `endSimulation`: non scrive mai nello
// store né chiama mutazioni vere. Uscire la butta senza conferma ([A 15]);
// cambiare persona rimonta la pagina (chiave) e la prova di prima sparisce.

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** `#/automations/<CODE>/test` */
export function TestRoutePage({ code }: { code: string }) {
  const { viewer } = useViewer();
  return <TestByCode key={`${viewer.personId}:${code}`} code={code} />;
}

function TestByCode({ code }: { code: string }) {
  const { t } = useTranslation();
  const list = useAutomations();
  const id = list.data?.find((x) => x.code === code)?.id ?? null;
  const detail = useAutomation(id);
  const sources = useAutomationSources();
  if (list.isError || detail.isError)
    return (
      <PageError
        message={t("automations.test.loadError")}
        onRetry={() => void (list.isError ? list.refetch() : detail.refetch())}
      />
    );
  if (list.data === undefined || (id !== null && (detail.data === undefined || !sources.data)))
    return <TestSkeleton />;
  if (id === null || !detail.data) return <NotVisible what="automation" />;
  // La prova è uno strumento di chi costruisce ([A 13]).
  if (!detail.data.automation.permissions.manage) return <CantTest code={code} />;
  return <Test detail={detail.data} />;
}

function TestSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe flex max-w-[760px] flex-col gap-3 p-8">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`h-3 w-28 ${bar}`} />
      <span className={`h-7 w-96 ${bar}`} />
      <span className={`h-3 w-72 ${bar}`} />
      <span className={`mt-4 h-9 w-full ${bar}`} />
    </div>
  );
}

function CantTest({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <section
      data-cant-test
      className="page-header flex flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]"
    >
      <h1 className="text-2xl font-semibold text-ink">{t("automations.test.cantTest.title")}</h1>
      <p className="text-md text-ink-muted">{t("automations.test.cantTest.body", { code })}</p>
      <Link
        to="/automations/$code"
        params={{ code }}
        className="text-md text-ink underline underline-offset-4"
      >
        ← {code}
      </Link>
    </section>
  );
}

function Test({ detail }: { detail: AutomationDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const names = useNames();
  const me = useSessionPersonId();
  const sources = useAutomationSources().data ?? [];
  const a = detail.automation;
  const latest = a.versions.at(-1)!;
  // La bozza se c'è; altrimenti la versione accesa ([A 12]: a fine prova niente «Turn on»).
  const draft = latest.publishedAt === null;
  const version = draft
    ? latest
    : ([...a.versions].reverse().find((v) => v.publishedAt !== null) ?? latest);
  const flow = version.flow;
  const versionKey: number | "draft" = draft ? "draft" : version.n;
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);

  const numbers = useMemo(() => stepNumbers(flow.steps), [flow.steps]);
  const byId = useMemo(() => numbersById(flow.steps), [flow.steps]);
  const labels = useMemo(() => fieldLabels(flow, sources), [flow, sources]);

  const [selected, setSelected] = useState<string | null>(null);
  const [rounds, setRounds] = useState<Record<string, number>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [dialog, setDialog] = useState<"turnOn" | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const run = useTestRun({
    automationId: a.id,
    versionKey,
    flow,
    numbers,
    ctxFor: (view) => ctxFor(view),
    onBegin: () => {
      setSelected(null);
      setRounds({});
    },
    onAdvance: () => setSelected(null),
  });
  const { sim, example, choosing, setChoosing, startError, configIssues, busy, stream } = run;
  const { begin, send, runToStop } = run;
  const ix = useMemo(() => (sim ? indexLog(sim) : null), [sim]);

  // Errori di configurazione: la prova non parte e dice dove ([A 5]).
  const knownIssues = draft ? detail.configErrors : detail.liveErrors;
  const blockedBy = configIssues ?? (knownIssues.length > 0 ? knownIssues : null);

  const canStep = !!sim && sim.status === "running" && !!sim.current && !busy && stream === null;
  const finished = sim !== null && TERMINAL.has(sim.status);
  const stopped = sim?.status.startsWith("waiting_") ?? false;

  // A una fermata il fuoco va al primo bottone della fermata; a 1024 il pannello si apre da solo.
  const stopKey = stopped ? `${sim!.status}:${sim!.cursor}:${sim!.log.length}` : null;
  // Sbloccata la fermata, il pannello sovrapposto si richiude: non copre i comandi della prova.
  const wasStopped = useRef(false);
  useEffect(() => {
    if (!stopKey) {
      if (wasStopped.current) setPanelOpen(false);
      wasStopped.current = false;
      return;
    }
    wasStopped.current = true;
    setPanelOpen(true);
    const id = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("[data-stop-primary]")?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [stopKey]);

  // Le scorciatoie: N ovunque, Invio dal flusso o dal pannello, Maiusc+Invio, Esc per uscire.
  const backStep = (() => {
    const p = selected && selected !== "trigger" ? selected : currentPathOf(sim);
    return p ? (stepAt(flow.steps, flowPathOf(p))?.id ?? null) : null;
  })();
  const exit = () =>
    void navigate({
      to: "/automations/$code/edit",
      params: { code: a.code },
      search: (backStep ? { step: backStep } : {}) as never,
    } as never);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest("input, textarea, select, [contenteditable='true']");
    if (typing) return;
    const inFlowOrPanel = !!target?.closest("[data-test-flow], [data-test-panel]");
    const onControl = !!target?.closest("button, a");
    if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (canStep) {
        e.preventDefault();
        void send({ kind: "next" });
      }
    } else if (e.key === "Enter" && e.shiftKey && (inFlowOrPanel || !onControl)) {
      if (canStep) {
        e.preventDefault();
        void runToStop();
      }
    } else if (e.key === "Enter" && inFlowOrPanel && !onControl) {
      if (canStep) {
        e.preventDefault();
        void send({ kind: "next" });
      }
    } else if (e.key === "Escape" && !docked && !panelOpen) {
      e.preventDefault();
      exit();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- il contesto -----------------------------------------------------------------

  function ctxFor(view: SimulationView | null): TestState {
    return {
      automation: a,
      flow,
      names,
      labels,
      numbers,
      numberOf: (id) => byId.get(id),
      me,
      sim: view,
      ix: view ? indexLog(view) : null,
      selected,
      select: (path) => {
        setSelected(path);
        if (path !== null) setPanelOpen(true);
      },
      roundOf: (blockPath) => {
        if (rounds[blockPath] !== undefined) return rounds[blockPath]!;
        if (!view) return 0;
        const block = stepAt(flow.steps, flowPathOf(blockPath));
        return defaultRound(
          indexLog(view),
          blockPath,
          block?.kind === "repeatUntil" ? "repeat" : "forEach",
        );
      },
      setRound: (blockPath, round) => setRounds((r) => ({ ...r, [blockPath]: round })),
      send,
      busy,
      stream,
    };
  }
  const ctx: TestState = { ...ctxFor(sim), ix };

  // --- la pagina -------------------------------------------------------------------

  const versionLine = t(
    draft
      ? "automations.test.meta.draft"
      : a.status === "paused"
        ? "automations.test.meta.paused"
        : "automations.test.meta.active",
    { n: version.n },
  );
  const exampleLine = example
    ? t("automations.test.meta.example", {
        label: example.label ?? t("automations.test.meta.written"),
      })
    : null;
  const goodEnd = sim?.status === "done";
  const header = (
    <TestHeader
      versionLine={versionLine}
      exampleLine={exampleLine}
      backStep={backStep}
      onChangeExample={blockedBy ? null : () => setChoosing(true)}
      commands={
        sim && !finished
          ? {
              canStep,
              onNext: () => void send({ kind: "next" }),
              onRun: () => void runToStop(),
              onRestart: () => example && void begin(example),
            }
          : null
      }
      onTestAgain={finished && example ? () => void begin(example) : null}
      busy={busy || stream !== null}
      // «Turn on» solo dopo una prova finita bene, mai da sé ([A 12]); una versione accesa no.
      finish={
        goodEnd && draft
          ? {
              label:
                a.status === "draft"
                  ? t("automations.test.turnOn")
                  : t("automations.test.publish", { n: version.n }),
              onClick: () => setDialog("turnOn"),
            }
          : null
      }
    />
  );

  return (
    <TestContext.Provider value={ctx}>
      <div className="flex h-full min-h-0">
        <div data-test-page className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {header}
          {blockedBy ? (
            <Blocked issues={blockedBy} />
          ) : (
            <div className="flex w-full max-w-[760px] min-w-[520px] flex-col gap-4 px-6 pt-4 pb-24">
              {!sim && !choosing && (
                <button
                  type="button"
                  className="self-start text-md text-ink underline underline-offset-4"
                  onClick={() => setChoosing(true)}
                >
                  {t("automations.test.example.title")}
                </button>
              )}
              <TestFlow treeRef={treeRef} />
              <Summary />
            </div>
          )}
        </div>
        {!blockedBy && sim && (docked || panelOpen) && (
          <DetailPanel
            mode={docked ? "docked" : "overlay"}
            label={t("automations.test.summary.label")}
            defaultWidth={480}
            // Affiancato, Esc torna al costruttore; sovrapposto, chiude il pannello.
            onClose={() => (docked ? exit() : setPanelOpen(false))}
          >
            <div data-test-panel>
              <PreviewPanel bodyRef={panelRef} />
            </div>
          </DetailPanel>
        )}
      </div>
      <p role="status" aria-live="polite" data-test-live className="sr-only">
        {run.polite}
      </p>
      <p role="alert" aria-live="assertive" data-test-alert className="sr-only">
        {run.assertive}
      </p>
      {choosing && !blockedBy && (
        <ExampleDialog
          automationId={a.id}
          version={versionKey}
          flow={flow}
          sources={sources}
          error={startError}
          onStart={(ex) => void begin(ex)}
          onClose={() => setChoosing(false)}
        />
      )}
      {dialog === "turnOn" && (
        <TurnOnDialog
          automationId={a.id}
          publish={a.status !== "draft"}
          untested={isUntested(latest)}
          onDone={() =>
            void navigate({ to: "/automations/$code", params: { code: a.code } } as never)
          }
          onClose={() => setDialog(null)}
        />
      )}
    </TestContext.Provider>
  );
}
