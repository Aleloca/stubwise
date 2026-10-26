import { describe, expect, it } from "vitest";
import type { AutomationFlow } from "../../data/model";
import { AUTOMATION_SOURCES, AUTOMATIONS } from "../../data/seed/automations";
import { availableFields, listAt, stepAt } from "./fields";

const flowOf = (code: string): AutomationFlow =>
  AUTOMATIONS.find((a) => a.code === code)!.versions.at(-1)!.flow;
const keys = (flow: AutomationFlow, path: string) =>
  availableFields(flow, path, AUTOMATION_SOURCES).map((f) => f.key);

describe("percorsi (R-J5)", () => {
  const flow = flowOf("AUD-A1");
  it("stepAt e listAt seguono la grammatica", () => {
    expect(stepAt(flow.steps, "0")?.id).toBe("cd-ask");
    expect(stepAt(flow.steps, "2/repeat[1]/1")?.id).toBe("cd-remind-wait");
    expect(stepAt(flow.steps, "2/onLimit/0")?.id).toBe("cd-call");
    expect(stepAt(flow.steps, "3/then/0/mancano informazioni/2/tutto presente/0")?.id).toBe(
      "cd-activate-2",
    );
    expect(stepAt(flow.steps, "3/then/0/uscita inventata/0")).toBeNull();
    expect(stepAt(flow.steps, "9")).toBeNull();
    expect(stepAt(flow.steps, "3/then")).toBeNull();
    expect(listAt(flow.steps, "")).toBe(flow.steps);
    expect(listAt(flow.steps, "3/else")).toEqual([]);
    expect(listAt(flow.steps, "0")).toBeNull();
  });
});

describe("availableFields", () => {
  it("all'inizio del flusso: solo i dati dell'inizio", () => {
    expect(keys(flowOf("AUT-1"), "0")).toEqual([
      "trattativa.id",
      "trattativa.titolo",
      "trattativa.importo",
      "trattativa.chiusaIl",
      "trattativa.commerciale",
      "trattativa.prodotti",
      "trattativa.contratto",
      "cliente.nome",
      "cliente.email",
      "cliente.dominio",
    ]);
  });

  it("dentro un forEach: i campi di Claude dei passi precedenti e la variabile col prefisso `as` (R-J3)", () => {
    const fields = availableFields(
      flowOf("AUT-1"),
      "2/forEach[0]/0/else/0/then/0",
      AUTOMATION_SOURCES,
    );
    const byKey = new Map(fields.map((f) => [f.key, f]));
    expect(byKey.get("analisi.prodotto")?.type).toBe("text");
    expect(byKey.get("analisi.task")?.type).toBe("list");
    expect(byKey.get("task.titolo")?.type).toBe("text");
    expect(byKey.get("task.reparto")?.type).toBe("text");
    // Fuori dal forEach la variabile non c'è.
    expect(keys(flowOf("AUT-1"), "3")).not.toContain("task.titolo");
  });

  it("dopo un wait con replyTo: risposta.arrivata (booleano, R-J6) e risposta.testo (R-J2)", () => {
    const flow = flowOf("AUD-A1");
    expect(keys(flow, "1")).not.toContain("risposta.testo");
    const after = availableFields(flow, "2", AUTOMATION_SOURCES);
    expect(after.find((f) => f.key === "risposta.arrivata")?.type).toBe("boolean");
    expect(after.find((f) => f.key === "risposta.testo")?.type).toBe("text");
  });

  it("nei rami di Claude ci sono i suoi campi, non in un ramo fratello prima di lui", () => {
    const flow = flowOf("AUD-A1");
    expect(keys(flow, "3/then/0/mancano informazioni/0")).toContain("verifica.mancanti");
    expect(keys(flow, "3/then/0")).not.toContain("verifica.mancanti");
  });

  it("inizi interni e a orario prendono i campi da triggerFields", () => {
    expect(keys(flowOf("STW-A1"), "0")).toContain("richiesta.titolo");
    expect(keys(flowOf("BTG-A1"), "0")).toEqual(["avvio.data"]);
  });

  it("un campo ridichiarato compare una volta, col tipo più recente (R-J3)", () => {
    const flow: AutomationFlow = {
      trigger: { kind: "manual" },
      titleTemplate: "x",
      steps: [
        {
          id: "a",
          kind: "claude",
          instruction: "i",
          inputs: [],
          outcomes: [],
          fields: [{ key: "x.v", label: "", type: "text" }],
          branches: {},
        },
        {
          id: "b",
          kind: "claude",
          instruction: "i",
          inputs: [],
          outcomes: [],
          fields: [{ key: "x.v", label: "", type: "number" }],
          branches: {},
        },
        { id: "c", kind: "wait", for: { days: 1 } },
      ],
    };
    const fields = availableFields(flow, "2");
    expect(fields.filter((f) => f.key === "x.v")).toEqual([
      { key: "x.v", label: "", type: "number" },
    ]);
  });
});
