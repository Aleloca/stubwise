import { describe, expect, it } from "vitest";
import { requestNextStep, type NextStepInput } from "./requestNextStep";

const input = (over: Partial<NextStepInput>): NextStepInput => ({
  status: "converted",
  task: { closed: false, claude: "none" },
  phase: null,
  pr: null,
  ...over,
});

describe("requestNextStep", () => {
  it("prima della task: chiarire, poi pronta da trasformare; archiviata nessuna riga", () => {
    expect(requestNextStep(input({ status: "new", task: null }))).toBe("clarify");
    expect(requestNextStep(input({ status: "refining", task: null }))).toBe("clarify");
    expect(requestNextStep(input({ status: "ready", task: null }))).toBe("readyToConvert");
    expect(requestNextStep(input({ status: "archived", task: null }))).toBeNull();
  });

  it("trasformata ma la task non si vede: nessuna riga (non si afferma ciò che non si sa)", () => {
    expect(requestNextStep(input({ task: null }))).toBeNull();
  });

  it("task creata e nessun lavoro: si parte da lì", () => {
    expect(requestNextStep(input({}))).toBe("convertedNoRun");
  });

  it("Claude al lavoro: il piano nella fase di piano, altrimenti in corso", () => {
    const working = { closed: false, claude: "working" as const };
    expect(requestNextStep(input({ task: working, phase: "plan" }))).toBe("preparingPlan");
    expect(requestNextStep(input({ task: working, phase: "replanning" }))).toBe("preparingPlan");
    expect(requestNextStep(input({ task: working, phase: "execution" }))).toBe("executing");
    // Chi non vede la sessione non ne conosce la fase: «in corso», niente di più.
    expect(requestNextStep(input({ task: working, phase: null }))).toBe("executing");
  });

  it("piano da approvare; domanda aperta o lavoro fermo chiedono attenzione", () => {
    expect(requestNextStep(input({ task: { closed: false, claude: "awaiting_approval" } }))).toBe(
      "awaitingApproval",
    );
    expect(requestNextStep(input({ task: { closed: false, claude: "awaiting_answer" } }))).toBe(
      "needsAttention",
    );
    expect(requestNextStep(input({ task: { closed: false, claude: "stopped" } }))).toBe(
      "needsAttention",
    );
  });

  it("Claude ha finito: PR aperta pronta al merge, mergiata, chiusa senza merge; «fatto» solo a task chiusa", () => {
    const done = { closed: false, claude: "done" as const };
    expect(requestNextStep(input({ task: done, pr: "open" }))).toBe("prReady");
    expect(requestNextStep(input({ task: done, pr: "merged" }))).toBe("merged");
    expect(requestNextStep(input({ task: done, pr: "closed" }))).toBe("needsAttention");
    expect(requestNextStep(input({ task: done, pr: null }))).toBe("workFinished");
    // Una task chiusa è fatta, qualunque cosa dica il lavoro di Claude.
    expect(requestNextStep(input({ task: { closed: true, claude: "stopped" } }))).toBe("done");
  });
});
