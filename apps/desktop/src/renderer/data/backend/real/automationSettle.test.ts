import { describe, expect, it } from "vitest";
import { createSettle, SETTLE_MAX_MS, SETTLE_STEP_MS, type RunState } from "./automationSettle";

// Area 7, F1 (review, importante 2): il server mette in coda decisioni,
// annulla, riprova e salta, e il worker le applica dopo qualche secondo.
// Finché lo stato visto non cambia, l'input è «in coda»: l'esecuzione non
// torna in «Da decidere» e non si decide due volte; «idle» aspetta che
// cambi davvero (ogni secondo, al più 10).

function harness(states: Record<string, RunState | null>) {
  let clock = 0;
  const reads: string[] = [];
  const settle = createSettle({
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    read: async (runId) => {
      reads.push(runId);
      return states[runId] ?? null;
    },
  });
  return { settle, reads, states, tick: (ms: number) => (clock += ms) };
}

const seen: RunState = { status: "waiting_approval", cursor: "0", round: 2 };

describe("l'input in coda sul worker", () => {
  it("senza input in coda nessuno è in coda, e «idle» è una rilettura dopo un attimo", async () => {
    const h = harness({});
    expect(h.settle.queued("r1", seen)).toBe(false);
    await h.settle.idle();
    expect(h.reads).toEqual([]);
  });

  it("dopo la decisione è in coda finché stato, passo e giro restano quelli visti", () => {
    const h = harness({});
    h.settle.mark("r1", seen);
    expect(h.settle.queued("r1", { ...seen })).toBe(true);
    // Una lettura senza stato (le voci di «Da decidere») confronta passo e giro.
    expect(h.settle.queued("r1", { cursor: "0", round: 2 })).toBe(true);
    expect(h.settle.queued("r1", { ...seen, cursor: "1" })).toBe(false);
    // Applicato una volta, non torna in coda.
    expect(h.settle.queued("r1", { ...seen })).toBe(false);
  });

  it("lo stato o il giro cambiati vogliono dire applicato", () => {
    const h = harness({});
    h.settle.mark("r1", seen);
    expect(h.settle.queued("r1", { ...seen, status: "running" })).toBe(false);
    h.settle.mark("r2", seen);
    expect(h.settle.queued("r2", { ...seen, round: 3 })).toBe(false);
  });

  it("oltre il tetto (10 s) non è più in coda: la pagina torna a dire lo stato vero", () => {
    const h = harness({});
    h.settle.mark("r1", seen);
    h.tick(SETTLE_MAX_MS);
    expect(h.settle.queued("r1", seen)).toBe(false);
  });

  it("«idle» rilegge ogni secondo finché l'esecuzione cambia", async () => {
    const h = harness({ r1: seen });
    h.settle.mark("r1", seen);
    let done = false;
    const idle = h.settle.idle().then(() => (done = true));
    // Il finto `sleep` avanza da solo: qui si cambia lo stato alla terza lettura.
    while (h.reads.length < 3) await Promise.resolve();
    h.states.r1 = { ...seen, cursor: "1" };
    await idle;
    expect(done).toBe(true);
    expect(h.reads.length).toBeGreaterThanOrEqual(3);
    expect(h.settle.queued("r1", seen)).toBe(false);
  });

  it("«idle» si ferma al tetto anche se il worker non applica", async () => {
    const h = harness({ r1: seen });
    h.settle.mark("r1", seen);
    await h.settle.idle();
    expect(h.reads.length).toBeLessThanOrEqual(SETTLE_MAX_MS / SETTLE_STEP_MS);
  });

  it("un'esecuzione che non si vede più non resta in coda", async () => {
    const h = harness({ r1: null });
    h.settle.mark("r1", seen);
    await h.settle.idle();
    expect(h.reads).toEqual(["r1"]);
  });
});
