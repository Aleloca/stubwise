import { describe, expect, it } from "vitest";
import { stepAt, visitSteps } from "../../../domain/automations/fields";
import type { AutomationFlow, Step } from "../../../data/types";
import {
  brokenBy,
  duplicateAt,
  fits,
  heightOf,
  insertAt,
  laneDepth,
  moveByOne,
  moveTo,
  newStep,
  stepNumbers,
} from "./tree";

// Le operazioni del costruttore sull'albero: numerazione 1…N, spostamenti
// una posizione alla volta entrando e uscendo dalle corsie, limite dei 5
// livelli, copie con id nuovi, dati che si perdono spostando o eliminando.

const task = (id: string, title = id): Step => ({
  ...(newStep("createTask", id, false) as Extract<Step, { kind: "createTask" }>),
  title,
});
const cond = (id: string, then: Step[] = [], otherwise: Step[] = []): Step => ({
  id,
  kind: "condition",
  when: { all: [{}] },
  then,
  else: otherwise,
});
const ids = (steps: Step[]) => {
  const out: string[] = [];
  visitSteps(steps, (s) => out.push(s.id));
  return out;
};

/** Un blocco annidato `levels` volte, col passo `leaf` in fondo. */
function nested(levels: number, leaf: Step): Step {
  let s: Step = leaf;
  for (let i = levels; i >= 1; i--) s = cond(`c${i}`, [s]);
  return s;
}

describe("numerazione", () => {
  it("1…N nell'ordine di lettura, rami compresi", () => {
    const steps = [task("a"), cond("b", [task("c")], [task("d")]), task("e")];
    expect([...stepNumbers(steps).entries()]).toEqual([
      ["0", 1],
      ["1", 2],
      ["1/then/0", 3],
      ["1/else/0", 4],
      ["2", 5],
    ]);
  });
});

describe("spostare di uno", () => {
  const steps = [task("a"), cond("b", [task("c")]), task("e")];

  it("giù: dentro la corsia del blocco che segue, una posizione alla volta, poi fuori", () => {
    let r = moveByOne(steps, "0", 1)!;
    expect(r.path).toBe("0/then/0");
    expect(ids(r.steps)).toEqual(["b", "a", "c", "e"]);
    r = moveByOne(r.steps, r.path, 1)!;
    expect(r.path).toBe("0/then/1");
    r = moveByOne(r.steps, r.path, 1)!;
    expect(r.path).toBe("0/else/0");
    r = moveByOne(r.steps, r.path, 1)!;
    expect(r.path).toBe("1");
    expect(ids(r.steps)).toEqual(["b", "c", "a", "e"]);
  });

  it("su dal primo posto: niente", () => {
    expect(moveByOne(steps, "0", -1)).toBeNull();
    expect(moveByOne(steps, "2", 1)).toBeNull();
  });

  it("un blocco si sposta coi suoi rami", () => {
    const r = moveByOne(steps, "1", -1)!;
    expect(r.path).toBe("0");
    expect(ids(r.steps)).toEqual(["b", "c", "a", "e"]);
  });

  it("le posizioni oltre il quinto livello si saltano", () => {
    const deep = [nested(5, task("x")), cond("blk", [task("y")])];
    // Ci sono corsie di quinto livello; `blk` ha un livello di rami: si ferma al quarto.
    expect(fits(deep[1]!, 4)).toBe(true);
    expect(fits(deep[1]!, 5)).toBe(false);
    let r = moveByOne(deep, "1", -1)!;
    const depths: number[] = [];
    while (r) {
      depths.push(laneDepth(r.path.split("/").slice(0, -1).join("/")));
      const next = moveByOne(r.steps, r.path, -1);
      if (!next) break;
      r = next;
    }
    expect(Math.max(...depths)).toBe(4);
  });
});

describe("spostare in un punto", () => {
  it("prima, dopo, dentro una corsia; mai dentro sé stesso", () => {
    const steps = [task("a"), cond("b", [task("c")]), task("e")];
    expect(ids(moveTo(steps, "2", { before: "a" })!.steps)).toEqual(["e", "a", "b", "c"]);
    expect(moveTo(steps, "0", { after: "c" })!.path).toBe("0/then/1");
    expect(moveTo(steps, "0", { block: "b", seg: "else" })!.path).toBe("0/else/0");
    expect(moveTo(steps, "1", { after: "c" })).toBeNull();
    expect(moveTo(steps, "1", { block: "b", seg: "then" })).toBeNull();
  });

  it("un blocco non scende oltre il quinto livello", () => {
    const steps = [nested(5, task("x")), cond("blk")];
    expect(heightOf(steps[0]!)).toBe(5);
    expect(moveTo(steps, "1", { after: "x" })).toBeNull();
    expect(moveTo(steps, "1", { before: "c5" })).not.toBeNull();
  });
});

describe("copie e passi nuovi", () => {
  it("«(copy)», id nuovi e riferimenti interni alla copia", () => {
    const steps: Step[] = [
      {
        id: "blk",
        kind: "condition",
        when: { all: [{}] },
        then: [
          {
            ...(newStep("createMilestone", "m", false) as Extract<
              Step,
              { kind: "createMilestone" }
            >),
            name: "M",
          },
          { ...(task("t") as Extract<Step, { kind: "createTask" }>), milestoneRef: "m" },
        ],
        else: [],
      },
    ];
    const r = duplicateAt(steps, "0", "(copy)");
    expect(r.path).toBe("1");
    const copy = stepAt(r.steps, "1") as Extract<Step, { kind: "condition" }>;
    expect(copy.id).not.toBe("blk");
    const [m, t] = copy.then as [
      Extract<Step, { kind: "createMilestone" }>,
      Extract<Step, { kind: "createTask" }>,
    ];
    expect(m.name).toBe("M");
    expect(t.milestoneRef).toBe(m.id);
    expect(new Set(ids(r.steps)).size).toBe(ids(r.steps).length);
    const single = duplicateAt([task("a", "Call")], "0", "(copy)");
    expect((stepAt(single.steps, "1") as { title: string }).title).toBe("Call (copy)");
  });

  it("l'email nasce chiedendo al proprietario, il resto parte da solo; «Where» secondo il tipo d'automazione", () => {
    expect(newStep("sendEmail", "x", false)).toMatchObject({
      approval: { mode: "ask", who: { owner: true } },
    });
    expect(newStep("createTask", "x", false)).toMatchObject({
      approval: { mode: "auto" },
      project: { mode: "own" },
    });
    expect(newStep("createTask", "x", true)).toMatchObject({ project: { mode: "from_client" } });
    expect(newStep("repeatUntil", "x", false)).toMatchObject({ max: 3 });
  });

  it("insertAt in un'uscita di Claude che non ha ancora passi", () => {
    const claude: Step = {
      id: "cl",
      kind: "claude",
      instruction: "x",
      inputs: [],
      outcomes: ["ok"],
      fields: [],
      branches: {},
    };
    const out = insertAt([claude], "0/ok", 0, task("a"));
    expect(stepAt(out, "0/ok/0")?.id).toBe("a");
  });
});

describe("dati persi", () => {
  it("spostare prima di Claude il passo che ne usa i campi lo rompe; eliminare l'email attesa anche", () => {
    const flow: AutomationFlow = {
      trigger: { kind: "manual" },
      titleTemplate: "x",
      steps: [
        {
          id: "cl",
          kind: "claude",
          instruction: "x",
          inputs: [],
          outcomes: [],
          fields: [{ key: "esito.testo", label: "Esito", type: "text" }],
          branches: {},
        },
        task("uses", "Fare {{esito.testo}}"),
        { ...(newStep("sendEmail", "mail", false) as Extract<Step, { kind: "sendEmail" }>) },
        { id: "w", kind: "wait", for: { replyTo: "mail", maxDays: 3 } },
      ],
    };
    const moved = { ...flow, steps: moveTo(flow.steps, "1", { before: "cl" })!.steps };
    expect(brokenBy(flow, moved)).toEqual(["uses"]);
    const removed = { ...flow, steps: flow.steps.filter((s) => s.id !== "mail") };
    expect(brokenBy(flow, removed)).toEqual(["w"]);
  });
});
