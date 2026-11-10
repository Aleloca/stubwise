import { describe, expect, it, vi } from "vitest";
import { AgentRunCancelledError, type AgentRunner } from "../agent/runner.js";
import { assertNotCancelled, createCancelRegistry, RunCancelRequestedError, startCancelWatch, withCancelSignal } from "./cancel.js";

/**
 * «Annulla il lavoro» in esecuzione (integrazione area 3, 3b.1-bis): il
 * registro dei job in corso col loro AbortController, il runner che passa il
 * segnale a ogni run, il controllo fra i passi. La sveglia (NOTIFY e il
 * controllo della colonna) la fa `startCancelWatch`, provata con un DB finto.
 */
describe("createCancelRegistry", () => {
  it("abort di un job registrato fa scattare il suo segnale, e solo il suo; dopo release non c'è più", () => {
    const registry = createCancelRegistry();
    const a = registry.register("job-a");
    const b = registry.register("job-b");
    expect(registry.ids()).toEqual(["job-a", "job-b"]);
    registry.abort("job-a");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    a.release();
    expect(registry.ids()).toEqual(["job-b"]);
    // Un abort di un job che non c'è non fa niente.
    expect(() => registry.abort("job-x")).not.toThrow();
  });
});

describe("withCancelSignal", () => {
  it("passa il segnale a ogni run; un annullamento del runner col segnale scattato diventa RunCancelRequestedError", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const inner: AgentRunner = {
      run: vi.fn(async (opts) => {
        seen.push(opts.signal);
        if (opts.signal?.aborted) throw new AgentRunCancelledError(null, "parziale", 0);
        return { output: "ok", exitCode: 0 };
      }),
      recordsSessions: true,
    };
    const runner = withCancelSignal(inner, controller.signal);
    expect(runner.recordsSessions).toBe(true);
    await runner.run({ prompt: "x", cwd: "/tmp" } as never);
    expect(seen[0]).toBe(controller.signal);
    controller.abort();
    const err = await runner.run({ prompt: "x", cwd: "/tmp" } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunCancelRequestedError);
    // Resta un AgentRunCancelledError: i catch di fix e correzione lo prendono già.
    expect(err).toBeInstanceOf(AgentRunCancelledError);
    expect((err as RunCancelRequestedError).partialOutput).toBe("parziale");
  });

  it("un annullamento per pausa scaduta (segnale NON scattato) resta com'era", async () => {
    const inner: AgentRunner = { run: async () => Promise.reject(new AgentRunCancelledError("u1", "", 600_000)) };
    const err = await withCancelSignal(inner, new AbortController().signal).run({} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunCancelledError);
    expect(err).not.toBeInstanceOf(RunCancelRequestedError);
  });
});

describe("assertNotCancelled", () => {
  it("lancia solo a segnale scattato; senza segnale niente", () => {
    const c = new AbortController();
    expect(() => assertNotCancelled(c.signal)).not.toThrow();
    expect(() => assertNotCancelled(undefined)).not.toThrow();
    c.abort();
    expect(() => assertNotCancelled(c.signal)).toThrow(RunCancelRequestedError);
  });
});

describe("startCancelWatch", () => {
  it("il NOTIFY sul canale fa scattare il job del payload; un payload illeggibile non rompe niente; un LISTEN che fallisce lascia il controllo periodico", async () => {
    const { AI_JOB_CANCEL_CHANNEL } = await import("@stubwise/shared");
    const registry = createCancelRegistry();
    const job = registry.register("job-1");
    let channel = "";
    let deliver: (payload: string) => void = () => {};
    const stop = await startCancelWatch({
      db: {} as never,
      registry,
      listen: async (ch, cb) => {
        channel = ch;
        deliver = cb;
      },
      pollMs: 60_000,
    });
    expect(channel).toBe(AI_JOB_CANCEL_CHANNEL);
    deliver("non json");
    expect(job.signal.aborted).toBe(false);
    deliver(JSON.stringify({ jobId: "job-1" }));
    expect(job.signal.aborted).toBe(true);
    stop();
    const lines: string[] = [];
    const stop2 = await startCancelWatch({
      db: {} as never,
      registry,
      listen: async () => Promise.reject(new Error("niente LISTEN")),
      pollMs: 60_000,
      log: (l) => lines.push(l),
    });
    expect(lines.join()).toContain("resta il controllo periodico");
    stop2();
  });
});
