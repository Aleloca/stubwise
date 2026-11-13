import { describe, expect, it } from "vitest";

import { AUTOMATION_F1_AVAILABILITY, CHAIN_MAX, chainAllows } from "./availability.js";
import type { AutomationFlow, Step } from "./types.js";
import { validateFlow, type ValidateContext } from "./validate.js";

// Area 7, fetta 1 (piano, task 0): nella build app un flusso coi passi o gli
// inizi delle fette dopo non si pubblica (`not_available`), e la catena degli
// avvii ha la regola del prototipo (`chainAllows`, CHAIN_MAX = 3).

const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
  sources: [],
  canApprove: () => true,
  ...over,
});
const createTask = (id: string): Step =>
  ({
    id,
    kind: "createTask",
    title: "Kick-off",
    description: "",
    assignee: null,
    dueInDays: null,
    project: { mode: "own" },
    milestoneRef: null,
    approval: { mode: "auto" },
  }) as Step;
const sendEmail = (id: string): Step => ({
  id,
  kind: "sendEmail",
  to: "a@b.test",
  subject: "Ciao",
  body: "Testo",
  attachRefs: [],
  approval: { mode: "auto" },
});
const flow = (over: Partial<AutomationFlow>): AutomationFlow =>
  ({
    trigger: { kind: "stubwise", event: "task_created" },
    steps: [createTask("s1")],
    titleTemplate: "x",
    ...over,
  }) as AutomationFlow;
const notAvailable = (f: AutomationFlow, c = ctx({ available: AUTOMATION_F1_AVAILABILITY })) =>
  validateFlow(f, c).filter((i) => i.code === "not_available").map((i) => i.path);

describe("not_available: i passi e gli inizi fuori dalla fetta", () => {
  it("un flusso della F1 non ha problemi di disponibilità", () => {
    expect(notAvailable(flow({}))).toEqual([]);
    expect(notAvailable(flow({ trigger: { kind: "manual" } }))).toEqual([]);
  });

  it("un passo «manda email» (F2) è not_available, anche dentro una condizione", () => {
    expect(notAvailable(flow({ steps: [createTask("s1"), sendEmail("s2")] }))).toEqual(["1"]);
    const nested = {
      id: "c",
      kind: "condition",
      when: { all: [] },
      then: [sendEmail("s3")],
      else: [],
    } as unknown as Step;
    expect(notAvailable(flow({ steps: [nested] }))).toEqual(["0/then/0"]);
  });

  it("un inizio a orario (F2), da una sorgente (F4) o «email in arrivo» (F2) è not_available", () => {
    expect(notAvailable(flow({ trigger: { kind: "schedule", rule: "FREQ=DAILY" } }))).toEqual(["trigger"]);
    expect(notAvailable(flow({ trigger: { kind: "source", sourceId: "s", event: "webhook" } }))).toEqual(["trigger"]);
    expect(notAvailable(flow({ trigger: { kind: "stubwise", event: "mail_received" } }))).toEqual(["trigger"]);
  });

  it("senza `available` nel contesto (il prototipo) nessun controllo: il comportamento di prima", () => {
    expect(notAvailable(flow({ steps: [sendEmail("s1")] }), ctx())).toEqual([]);
  });
});

describe("chainAllows: la catena degli avvii (la regola del prototipo)", () => {
  const run = (automationId: string) => ({ automationId });

  it("CHAIN_MAX è 3", () => {
    expect(CHAIN_MAX).toBe(3);
  });

  it("un evento senza esecuzione d'origine non ha catena", () => {
    expect(chainAllows([], "a")).toBe(true);
  });

  it("un'automazione già nella catena non riparte (nessun ciclo)", () => {
    expect(chainAllows([run("a")], "a")).toBe(false);
    expect(chainAllows([run("b"), run("a")], "a")).toBe(false);
  });

  it("la catena si ferma a 3, anche con un'automazione nuova", () => {
    expect(chainAllows([run("a"), run("b")], "c")).toBe(true);
    expect(chainAllows([run("a"), run("b"), run("c")], "d")).toBe(false);
  });
});
