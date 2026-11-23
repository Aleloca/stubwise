import { ApiError } from "@stubwise/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asPrototypeError } from "./automationRefs";
import { relaunchWithInstructions, startRun } from "./claudeActions";
import { setAppClientForTests } from "./client";
import { installFakeServer, serverComment, TICKET_ID } from "./fakeServer";

// Lotto 4, D-7.1 (72, 42abe14be): a budget del mese finito il server
// rifiuta gli avvii a mano di chi non ha `plans.approve` con 409
// `budget_exhausted`; il prototipo dice lo stesso rifiuto come
// `invalid: monthly_budget`, con la sua frase.

const TICKET = TICKET_ID;
const budget = { status: 409, body: { code: "budget_exhausted", message: "x" } };
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il budget finito sugli avvii a mano", () => {
  it("«Start» e «Rilancia»: `invalid: monthly_budget`", async () => {
    installFakeServer({
      [`POST /api/tickets/${TICKET}/run-ai`]: budget,
      [`POST /api/tickets/${TICKET}/comments`]: { status: 201, body: serverComment("Go") },
    });
    expect(await errorOf(startRun(TICKET))).toBe("invalid: monthly_budget");
    expect(await errorOf(relaunchWithInstructions(TICKET, "Go"))).toBe("invalid: monthly_budget");
  });

  it("ovunque passino le parole del prototipo (la correzione di un server, l'analisi a mano)", () => {
    const e = asPrototypeError(new ApiError(409, "x", "budget_exhausted"));
    expect((e as Error).message).toBe("invalid: monthly_budget");
  });
});
