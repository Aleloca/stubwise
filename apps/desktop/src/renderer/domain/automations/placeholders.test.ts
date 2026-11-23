import { describe, expect, it } from "vitest";
import type { AutomationFlow } from "../../data/types";
import { withoutPlaceholders } from "./placeholders";

// R.1414 (revisione del lotto 2-3): il costruttore non rimanda mai un
// segnaposto; il posto torna vuoto e il livello dati tiene la persona di prima.

const flow = (): AutomationFlow =>
  ({
    trigger: { kind: "manual" },
    titleTemplate: "",
    steps: [
      {
        id: "a",
        kind: "notify",
        who: { personId: "hidden-1" },
        text: "",
        approval: { mode: "auto" },
      },
      {
        id: "b",
        kind: "condition",
        when: {},
        then: [
          {
            id: "c",
            kind: "createMilestone",
            name: "",
            dueInDays: null,
            project: { mode: "own" },
            approval: { mode: "ask", who: { personId: "hidden-2" } },
          },
        ],
        else: [
          {
            id: "d",
            kind: "notify",
            who: { personId: "p-giulia" },
            text: "",
            approval: { mode: "auto" },
          },
        ],
      },
    ],
  }) as unknown as AutomationFlow;

describe("withoutPlaceholders", () => {
  it("toglie i segnaposto dai posti persona, anche annidati; le persone vere restano", () => {
    const out = withoutPlaceholders(flow()) as unknown as { steps: Record<string, unknown>[] };
    expect(out.steps[0]!.who).toEqual({});
    const branch = out.steps[1] as { then: { approval: unknown }[]; else: { who: unknown }[] };
    expect(branch.then[0]!.approval).toEqual({ mode: "ask", who: {} });
    expect(branch.else[0]!.who).toEqual({ personId: "p-giulia" });
  });

  it("non tocca il flusso di partenza", () => {
    const original = flow();
    withoutPlaceholders(original);
    expect((original.steps[0] as unknown as { who: unknown }).who).toEqual({
      personId: "hidden-1",
    });
  });
});
