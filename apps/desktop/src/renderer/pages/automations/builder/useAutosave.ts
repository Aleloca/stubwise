import { useCallback, useEffect, useRef, useState } from "react";
import { useSaveAutomationDraft } from "../../../data/queries";
import type { AutomationFlow } from "../../../data/types";

// La bozza che si salva da sola (shape builder [A 8], [A 12]): in coda, una
// alla volta, dicendo quale revisione si è letta. Un errore resta lì finché
// non si riprova (o arriva un'altra modifica); `stale` ferma tutto finché
// non si ricarica.

/** Quanto aspetta il salvataggio dopo l'ultima modifica. */
export const SAVE_DELAY_MS = 400;

export type SaveStatus = "saved" | "saving" | "error" | "stale";

export function useAutosave(automationId: string, initialRev: number | null) {
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
