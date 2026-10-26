import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../../domain/automations/fields";
import type { FlowIssue } from "../../../domain/automations/validate";
import {
  simulationConfigIssues,
  useAutomation,
  useAutomations,
  useAutomationSimulation,
  useAutomationSimulationStep,
  useAutomationSources,
  useEndAutomationSimulation,
  useSessionPersonId,
  useStartAutomationSimulation,
  type SimulationInput,
} from "../../../data/queries";
import type { AutomationDetail, SimulationView } from "../../../data/types";
import { useViewer } from "../../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../../layout/useDetailPanel";
import { prefersReducedMotion, useMediaQuery } from "../../../layout/useMediaQuery";
import { PageError } from "../../../tasks-ui/PageStates";
import { useToast } from "../../../tasks-ui/Toast";
import { TurnOnDialog } from "../AutomationDialogs";
import { fieldLabels } from "../format";
import { CriticalGlyph } from "../glyphs";
import { NotVisible, useNames } from "../shared";
import { startProblems, stepProblems } from "../builder/issues";
import { numbersById, stepNumbers } from "../numbering";
import { flowPathOf, TestContext, useTest, type TestState } from "./context";
import { ExampleDialog, type ChosenExample } from "./ExampleDialog";
import { defaultRound, indexLog, markAt } from "./marks";
import { currentPathOf, PreviewPanel } from "./PreviewPanel";
import { Summary } from "./Summary";
import { TestFlow } from "./TestFlow";
import { TestHeader } from "./TestHeader";
import { rowOutcome } from "./words";

// La prova di un'automazione (shape automation-test.md, Task 7):
// `#/automations/<CODE>/test`, una modalità del costruttore ([A 1]). Si
// sceglie un evento d'esempio, la prova parte e si ferma subito sul primo
// passo (non corre da sola, [A 14]); «Next step» uno alla volta, «Run to
// next stop» fino alla prossima fermata. Usa SOLO `startSimulation` /
// `simulationStep` / `getSimulation` / `endSimulation`: non scrive mai nello
// store né chiama mutazioni vere. Uscire la butta senza conferma ([A 15]);
// cambiare persona rimonta la pagina (chiave) e la prova di prima sparisce.

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Il ritmo di «Run to next stop»: ogni passo si accende per un momento. */
const PACE_MS = 250;

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
  const toast = useToast();
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

  const [example, setExample] = useState<ChosenExample | null>(null);
  const [choosing, setChoosing] = useState(true);
  const [simId, setSimId] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
  const [configIssues, setConfigIssues] = useState<FlowIssue[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rounds, setRounds] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<{ path: string; text: string } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dialog, setDialog] = useState<"turnOn" | null>(null);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const treeRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<string | null>(null);
  simRef.current = simId;

  const start = useStartAutomationSimulation();
  const step = useAutomationSimulationStep();
  const end = useEndAutomationSimulation();
  const sim = useAutomationSimulation(simId).data ?? null;
  const ix = useMemo(() => (sim ? indexLog(sim) : null), [sim]);

  // Uscire butta la prova, senza conferma: non c'è niente di vero da perdere.
  const endRef = useRef(end.mutate);
  endRef.current = end.mutate;
  useEffect(
    () => () => {
      if (simRef.current) endRef.current(simRef.current);
    },
    [],
  );

  // Errori di configurazione: la prova non parte e dice dove ([A 5]).
  const knownIssues = draft ? detail.configErrors : detail.liveErrors;
  const blockedBy = configIssues ?? (knownIssues.length > 0 ? knownIssues : null);

  const begin = async (ex: ChosenExample) => {
    setStartError(false);
    const old = simRef.current;
    if (old) {
      setSimId(null);
      end.mutate(old);
    }
    try {
      const id = await start.mutateAsync({
        automationId: a.id,
        version: versionKey,
        event: ex.event,
      });
      setExample(ex);
      setChoosing(false);
      setSelected(null);
      setRounds({});
      setStream(null);
      setSimId(id);
      setAssertive(t("automations.test.announce.started"));
    } catch (e) {
      const issues = simulationConfigIssues(e);
      if (issues) {
        setConfigIssues(issues);
        setChoosing(false);
      } else setStartError(true);
    }
  };

  // --- l'avanzamento ---------------------------------------------------------------

  /** Gli annunci: «polite» per un passo fatto, «assertive» per le fermate e la fine. */
  const announce = (before: SimulationView | null, after: SimulationView) => {
    const nOf = (p: string) => numbers.get(flowPathOf(p)) ?? 0;
    const ixAfter = indexLog(after);
    if (after.status === "done") return setAssertive(t("automations.test.announce.finished"));
    if (after.status === "failed" || after.status === "cancelled")
      return setAssertive(
        t("automations.test.announce.failed", {
          n: nOf(after.cursor ?? after.log.at(-1)?.path ?? ""),
        }),
      );
    if (after.status.startsWith("waiting_") && after.cursor) {
      const s = stepAt(flow.steps, flowPathOf(after.cursor));
      const what = s ? rowOutcome(ctxFor(after), s, after.cursor, "stopped", t) : "";
      return setAssertive(t("automations.test.announce.stopped", { n: nOf(after.cursor), what }));
    }
    const prev = currentPathOf(before);
    if (prev) {
      const s = stepAt(flow.steps, flowPathOf(prev));
      const what = s ? rowOutcome(ctxFor(after), s, prev, markAt(ixAfter, prev), t) : "";
      setPolite(t("automations.test.announce.stepDone", { n: nOf(prev), what }));
    }
  };

  /** La motivazione di Claude in streaming; risolve quando è arrivata tutta. */
  const streamClaude = (path: string, text: string) =>
    new Promise<void>((resolve) => {
      if (prefersReducedMotion() || text.length === 0) return resolve();
      let shown = 0;
      setStream({ path, text: "" });
      const timer = window.setInterval(() => {
        shown = Math.min(text.length, shown + 18);
        setStream({ path, text: text.slice(0, shown) });
        if (shown >= text.length) {
          window.clearInterval(timer);
          setStream(null);
          resolve();
        }
      }, 30);
    });

  const sendOnce = async (input: SimulationInput): Promise<SimulationView | null> => {
    if (!simRef.current) return null;
    const before = sim;
    try {
      const after = await step.mutateAsync({ id: simRef.current, input });
      announce(before, after);
      const claudeBefore = before?.preview.claude.length ?? 0;
      const fresh = after.preview.claude.slice(claudeBefore);
      for (const c of fresh) await streamClaude(c.path, c.reason);
      return after;
    } catch {
      toast.error(t("automations.test.stop.error"));
      return null;
    }
  };

  const send = async (input: SimulationInput) => {
    if (busy) return;
    setBusy(true);
    setSelected(null);
    try {
      await sendOnce(input);
    } finally {
      setBusy(false);
    }
  };

  /** «Run to next stop»: un passo alla volta, con un piccolo ritmo visibile; nulla con movimento ridotto. */
  const runToStop = async () => {
    if (busy || !sim) return;
    setBusy(true);
    setSelected(null);
    try {
      if (prefersReducedMotion()) {
        await sendOnce({ kind: "run" });
        return;
      }
      let cur: SimulationView | null = sim;
      while (cur && cur.status === "running" && cur.current) {
        cur = await sendOnce({ kind: "next" });
        if (cur && cur.status === "running" && cur.current)
          await new Promise((r) => window.setTimeout(r, PACE_MS));
      }
    } finally {
      setBusy(false);
    }
  };

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
        {polite}
      </p>
      <p role="alert" aria-live="assertive" data-test-alert className="sr-only">
        {assertive}
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
          onDone={() =>
            void navigate({ to: "/automations/$code", params: { code: a.code } } as never)
          }
          onClose={() => setDialog(null)}
        />
      )}
    </TestContext.Provider>
  );
}

/** La bozza ha problemi: nessuna prova parte; ogni riga porta al passo nel costruttore ([A 5]). */
function Blocked({ issues }: { issues: FlowIssue[] }) {
  const { t } = useTranslation();
  const names = useNames();
  const ctx = useTestFlowWords();
  // I problemi in parole, come nel costruttore: per passo (tutti i suoi campi), senza doppioni.
  const lines: { text: string; step: string | null }[] = [];
  const seen = new Set<string>();
  const push = (text: string, step: string | null) => {
    if (seen.has(text)) return;
    seen.add(text);
    lines.push({ text, step });
  };
  const byPath = new Map<string, FlowIssue[]>();
  for (const i of issues) byPath.set(i.path, [...(byPath.get(i.path) ?? []), i]);
  for (const [path, group] of byPath) {
    if (path === "trigger" || path === "") {
      for (const problem of startProblems(group, ctx.flow, names, t))
        push(
          t("automations.test.blocked.start", { problem }),
          path === "trigger" ? "trigger" : null,
        );
      continue;
    }
    const fp = flowPathOf(path);
    const s = stepAt(ctx.flow.steps, fp);
    const n = ctx.numbers.get(fp) ?? 0;
    const texts = s
      ? stepProblems(group, ctx.flow, fp, s, ctx.problemCtx, t).map((p) => p.text)
      : [];
    if (texts.length === 0) texts.push(t(`automations.builder.short.${group[0]!.code}`));
    for (const problem of texts)
      push(t("automations.test.blocked.step", { n, problem }), s?.id ?? null);
  }
  return (
    <section
      data-test-blocked
      aria-labelledby="test-blocked"
      className="flex max-w-[760px] flex-col gap-3 px-8 pt-6 pb-24"
    >
      <h2 id="test-blocked" className="flex items-center gap-2 text-xl font-semibold text-ink">
        <CriticalGlyph />
        {t("automations.test.blocked.title")}
      </h2>
      <p className="text-md text-ink-muted">{t("automations.test.blocked.body")}</p>
      <ul className="flex flex-col">
        {lines.map((l, k) => (
          <li key={k}>
            <Link
              to="/automations/$code/edit"
              params={{ code: ctx.automation.code }}
              search={(l.step ? { step: l.step } : {}) as never}
              data-blocked-problem
              className="flex min-h-9 items-center gap-2 rounded-md px-2 text-md text-ink hover:bg-ink/6"
            >
              <CriticalGlyph />
              {l.text}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Ciò che serve a dire i problemi in parole, dal contesto della prova. */
function useTestFlowWords() {
  const ctx = useTest();
  const sources = useAutomationSources().data ?? [];
  return {
    ...ctx,
    problemCtx: {
      general: ctx.automation.projectId === null,
      names: ctx.names,
      ownerId: ctx.automation.ownerId,
      projectCode: ctx.names.project(ctx.automation.projectId)?.code ?? null,
      sources,
      labels: ctx.labels,
    },
  };
}
