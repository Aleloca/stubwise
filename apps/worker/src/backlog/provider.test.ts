import type { Db } from "@stubwise/db";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { fakeSelect } from "../providers/select-fake.js";
import { NoAccountAvailableError, runBacklogAgent } from "./provider.js";

/**
 * Unit test PURI dell'involucro dei run del backlog su runWithProviders: la
 * scelta è finta (fakeSelect), quindi il db non viene mai toccato. Le regole
 * della scelta le prova providers/select.test.ts; qui si prova come gli esiti
 * diventano valori o eccezioni per i chiamanti del backlog.
 */

const FIRST: ResolvedProvider = { id: "acc-1", kind: "account", secret: "tok-first" };
const SECOND: ResolvedProvider = { id: "acc-2", kind: "account", secret: "tok-second" };
const LIMIT: AgentRunResult = { output: "You've hit your session limit · resets 6pm (UTC)", exitCode: 1 };
const OK: AgentRunResult = { output: "{}", exitCode: 0 };

const db = {} as Db;

describe("runBacklogAgent", () => {
  it("primo account al limite → usato il secondo, nello stesso run", async () => {
    const markProviderLimitedFn = vi.fn(async () => undefined);
    const attempt = vi.fn(async (p: ResolvedProvider | undefined) => (p?.id === FIRST.id ? LIMIT : OK));

    const result = await runBacklogAgent(
      { select: fakeSelect(db, [FIRST, SECOND], { markProviderLimitedFn }) },
      "project-1",
      "estimate",
      attempt,
    );

    expect(result).toBe(OK);
    expect(attempt.mock.calls.map(([p]) => p?.id)).toEqual(["acc-1", "acc-2"]);
    expect(markProviderLimitedFn).toHaveBeenCalledWith(db, "acc-1", expect.any(Date));
  });

  it("la scelta riceve il progetto e la classe interactive", async () => {
    const selectProvidersFn = vi.fn(async () => ({ candidates: [FIRST], legacyAuth: false, emptyReason: null }));

    await runBacklogAgent(
      { select: fakeSelect(db, [FIRST], { selectProvidersFn }) },
      "project-1",
      "estimate",
      async () => OK,
    );

    expect(selectProvidersFn).toHaveBeenCalledWith(expect.anything(), {
      projectId: "project-1",
      workClass: "interactive",
    });
  });

  it("nessun account disponibile (tutti al limite) → NoAccountAvailableError, nessun run", async () => {
    const attempt = vi.fn(async () => OK);

    const err = await runBacklogAgent(
      { select: fakeSelect(db, { emptyReason: "all_limited" }) },
      "project-1",
      "estimate",
      attempt,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoAccountAvailableError);
    expect((err as NoAccountAvailableError).reason).toBe("all_limited");
    expect(attempt).not.toHaveBeenCalled();
  });

  it("tutti finiti al limite durante i tentativi → NoAccountAvailableError (all_limited_now)", async () => {
    const err = await runBacklogAgent(
      { select: fakeSelect(db, [FIRST, SECOND]) },
      "project-1",
      "intake",
      async () => LIMIT,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoAccountAvailableError);
    expect((err as NoAccountAvailableError).reason).toBe("all_limited_now");
  });

  it("motivo di configurazione → errore normale che nomina il motivo, con una riga di log", async () => {
    const log = vi.fn();

    const err = await runBacklogAgent(
      { select: fakeSelect(db, { emptyReason: "exclusive_unavailable" }, { log }) },
      "project-1",
      "deep dive",
      async () => OK,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoAccountAvailableError);
    expect((err as Error).message).toContain("provider AI del progetto non disponibile");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("exclusive_unavailable"));
  });

  it("auth storica al limite → errore col testo del limite, mai «exit N»", async () => {
    const err = await runBacklogAgent(
      { select: fakeSelect(db, "legacy") },
      "project-1",
      "intake",
      async () => LIMIT,
    ).catch((e: unknown) => e);

    expect((err as Error).message).toContain("hit your session limit");
    expect((err as Error).message).not.toMatch(/exit \d/);
  });

  it("auth storica senza limite → il run con provider undefined", async () => {
    const attempt = vi.fn(async () => OK);

    const result = await runBacklogAgent({ select: fakeSelect(db, "legacy") }, "project-1", "intake", attempt);

    expect(result).toBe(OK);
    expect(attempt).toHaveBeenCalledWith(undefined);
  });
});
