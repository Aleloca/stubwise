import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stepAt } from "@stubwise/shared";
import type { FlowIssue } from "@stubwise/shared";
import {
  simulationConfigIssues,
  useAutomationSimulation,
  useAutomationSimulationStep,
  useEndAutomationSimulation,
  useStartAutomationSimulation,
  type SimulationInput,
} from "../../../data/queries";
import type { AutomationFlow, SimulationView } from "../../../data/types";
import { prefersReducedMotion } from "../../../layout/useMediaQuery";
import { useToast } from "../../../tasks-ui/Toast";
import { flowPathOf, type TestState } from "./context";
import type { ChosenExample } from "./ExampleDialog";
import { indexLog, markAt } from "./marks";
import { currentPathOf } from "./PreviewPanel";
import { rowOutcome } from "./words";

// La vita di una prova nella pagina: avvio sull'esempio scelto (e problemi
// di configurazione che la fermano), «Next step», «Run to next stop» col suo
// ritmo, lo streaming della motivazione di Claude, gli annunci. Uscire la
// butta (`endSimulation` allo smontaggio). Solo le quattro letture/scritture
// della prova: nessuna mutazione vera.

/** Il ritmo di «Run to next stop»: ogni passo si accende per un momento. */
const PACE_MS = 250;

export function useTestRun({
  automationId,
  versionKey,
  flow,
  numbers,
  ctxFor,
  onBegin,
  onAdvance,
  adoptSimId = null,
}: {
  /**
   * Area 10b (D2): la prova di Claude da adottare (`?sim=`). Se è di chi
   * guarda e della versione aperta, la pagina la mostra finita invece del
   * dialogo degli esempi; altrimenti il dialogo come sempre, senza messaggi.
   */
  adoptSimId?: string | null;
  automationId: string;
  versionKey: number | "draft";
  flow: AutomationFlow;
  numbers: Map<string, number>;
  /** Il contesto della prova per una vista (le parole degli annunci). */
  ctxFor: (view: SimulationView | null) => TestState;
  /** Una prova nuova: la vista riparte (selezione, giri). */
  onBegin: () => void;
  /** Un input inviato: la selezione torna al passo corrente. */
  onAdvance: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [example, setExample] = useState<ChosenExample | null>(null);
  const [choosing, setChoosing] = useState(adoptSimId === null);
  const [simId, setSimId] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
  const [configIssues, setConfigIssues] = useState<FlowIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<{ path: string; text: string } | null>(null);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const simRef = useRef<string | null>(null);
  simRef.current = simId;

  const start = useStartAutomationSimulation();
  const step = useAutomationSimulationStep();
  const end = useEndAutomationSimulation();
  const sim = useAutomationSimulation(simId).data ?? null;

  // La prova di Claude (D2): si adotta una volta, solo se `getSimulation` la
  // dà a chi guarda (di un altro o buttata: `null`) e prova questa versione.
  // Adottata, resta di Claude: uscire o rifarla non la butta (la riga della
  // conversazione la rilegge per i suoi dati).
  const adopted = useRef<string | null>(null);
  const adoptTried = useRef(false);
  const adopt = useAutomationSimulation(adoptSimId);
  useEffect(() => {
    if (adoptSimId === null || adoptTried.current || adopt.isPending) return;
    adoptTried.current = true;
    const view = adopt.data ?? null;
    const sameVersion =
      view !== null &&
      view.automationId === automationId &&
      (versionKey === "draft" ? view.draft : !view.draft && view.version === versionKey);
    if (!view || !sameVersion) {
      setChoosing(true);
      return;
    }
    adopted.current = view.id;
    // La riga dell'esempio la dice la prova stessa (`claudeExample`, m7).
    const chosen = view.claudeExample;
    const label =
      chosen && !chosen.written && (chosen.code || chosen.title)
        ? [chosen.code, chosen.title].filter(Boolean).join(" ")
        : null;
    setExample({ event: view.event, label, byClaude: true });
    setChoosing(false);
    onBegin();
    setSimId(view.id);
  }, [adoptSimId, adopt.isPending, adopt.data]);

  // Uscire butta la prova, senza conferma: non c'è niente di vero da perdere.
  // Smontata la pagina, «Run to next stop» si ferma e lo streaming smette.
  const endRef = useRef(end.mutate);
  endRef.current = end.mutate;
  const mounted = useRef(true);
  const streamTimer = useRef<{ id: number; done: () => void } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (streamTimer.current) {
        window.clearInterval(streamTimer.current.id);
        streamTimer.current.done();
        streamTimer.current = null;
      }
      if (simRef.current && simRef.current !== adopted.current) endRef.current(simRef.current);
    };
  }, []);

  const begin = async (ex: ChosenExample) => {
    setStartError(false);
    const old = simRef.current;
    if (old) {
      setSimId(null);
      if (old !== adopted.current) end.mutate(old);
    }
    try {
      const id = await start.mutateAsync({ automationId, version: versionKey, event: ex.event });
      setExample(ex);
      setChoosing(false);
      onBegin();
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
      if (!mounted.current || prefersReducedMotion() || text.length === 0) return resolve();
      let shown = 0;
      setStream({ path, text: "" });
      const id = window.setInterval(() => {
        shown = Math.min(text.length, shown + 18);
        setStream({ path, text: text.slice(0, shown) });
        if (shown >= text.length) {
          window.clearInterval(id);
          streamTimer.current = null;
          setStream(null);
          resolve();
        }
      }, 30);
      streamTimer.current = { id, done: resolve };
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

  const send = async (input: SimulationInput): Promise<SimulationView | null> => {
    if (busy) return null;
    setBusy(true);
    onAdvance();
    try {
      return await sendOnce(input);
    } finally {
      setBusy(false);
    }
  };

  /** «Run to next stop»: un passo alla volta, con un piccolo ritmo visibile; nulla con movimento ridotto. */
  const runToStop = async () => {
    if (busy || !sim) return;
    setBusy(true);
    onAdvance();
    try {
      if (prefersReducedMotion()) {
        await sendOnce({ kind: "run" });
        return;
      }
      // Il giro si ferma se la prova cambia (Restart, un altro esempio) o la pagina se ne va.
      const id = simRef.current;
      const same = () => mounted.current && simRef.current === id;
      let cur: SimulationView | null = sim;
      while (cur && cur.status === "running" && cur.current && same()) {
        cur = await sendOnce({ kind: "next" });
        if (cur && cur.status === "running" && cur.current)
          await new Promise((r) => window.setTimeout(r, PACE_MS));
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    sim,
    /** La prova adottata da `?sim=` (D2): la pagina non le prende il fuoco. */
    adoptedId: adopted.current,
    example,
    choosing,
    setChoosing,
    startError,
    configIssues,
    busy,
    stream,
    polite,
    assertive,
    begin,
    send,
    runToStop,
  };
}
