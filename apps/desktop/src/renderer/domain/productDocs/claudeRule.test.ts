import { describe, expect, it } from "vitest";
import type { ProductFact } from "../../data/model";
import { decideFact, recommendedOf, type FactContext } from "./claudeRule";
import { plain } from "./richText";

// La regola di Claude (11b, Task 1): UNA funzione pura che dice se un fatto
// entra da sé, diventa una domanda o non fa niente. Una riga di test per
// ogni riga della regola (Global Constraints, «Decisioni inventate»).

const fact = (over: Partial<ProductFact> = {}): ProductFact => ({
  id: "f1",
  pageId: "pg1",
  anchorId: "blk-1",
  change: { kind: "replace", text: plain("Login solo con Google.") },
  clarity: "clear",
  ...over,
});

const ctx = (over: Partial<FactContext> = {}): FactContext => ({
  lastWriterIsPerson: false,
  actorCanEdit: true,
  changedByPersonSinceArrival: false,
  anchorExists: true,
  ...over,
});

describe("decideFact", () => {
  it("un fatto chiaro, senza contrasto, col permesso entra da sé", () => {
    expect(decideFact(fact(), ctx())).toEqual({ kind: "edit" });
  });

  it("un fatto vago è una domanda anche col permesso e senza contrasto", () => {
    expect(decideFact(fact({ clarity: "vague" }), ctx())).toEqual({
      kind: "question",
      reason: "vague",
    });
  });

  it("un fatto chiaro che contraddice testo di Claude è una domanda `contradicts`", () => {
    expect(decideFact(fact({ contradicts: true }), ctx())).toEqual({
      kind: "question",
      reason: "contradicts",
    });
  });

  it("un fatto chiaro che contraddice un blocco scritto da una persona è `contradicts_person`", () => {
    expect(decideFact(fact({ contradicts: true }), ctx({ lastWriterIsPerson: true }))).toEqual({
      kind: "question",
      reason: "contradicts_person",
    });
  });

  it("un blocco che una persona ha riscritto DOPO l'arrivo contraddice senza il flag del seme", () => {
    expect(decideFact(fact(), ctx({ changedByPersonSinceArrival: true }))).toEqual({
      kind: "question",
      reason: "contradicts_person",
    });
  });

  it("un blocco scritto da una persona ma senza contrasto si modifica (non è il suo testo che cambia di senso)", () => {
    expect(decideFact(fact(), ctx({ lastWriterIsPerson: true }))).toEqual({ kind: "edit" });
  });

  it("un fatto chiaro senza il permesso del titolare è una domanda `no_permission`", () => {
    expect(decideFact(fact(), ctx({ actorCanEdit: false }))).toEqual({
      kind: "question",
      reason: "no_permission",
    });
  });

  it("`diverges` è sempre una domanda, anche chiaro e col permesso", () => {
    const f = fact({ change: { kind: "diverges", built: "Login anche con Apple" } });
    expect(decideFact(f, ctx())).toEqual({ kind: "question", reason: "diverges" });
  });

  it("`link_task`: il lavoro coincide, aggiunge il solo link", () => {
    const f = fact({ change: { kind: "link_task", taskCode: "ACQ-12" } });
    expect(decideFact(f, ctx())).toEqual({ kind: "edit" });
  });

  it("un `replace` su un'ancora che non c'è più non fa niente", () => {
    expect(decideFact(fact(), ctx({ anchorExists: false }))).toEqual({ kind: "none" });
  });

  it("un `insert_after` su un'ancora che non c'è più non fa niente; in cima alla pagina sì", () => {
    const insert = (anchorId: string | null) =>
      fact({
        anchorId,
        change: { kind: "insert_after", block: { id: "n1", type: "paragraph", content: plain("x") } },
      });
    expect(decideFact(insert("blk-9"), ctx({ anchorExists: false }))).toEqual({ kind: "none" });
    expect(decideFact(insert(null), ctx({ anchorExists: false }))).toEqual({ kind: "edit" });
  });

  it("Review Focus 1: due fatti della stessa email, il chiaro entra e il vago è una domanda", () => {
    const clear = fact({ id: "f-clear" });
    const vague = fact({
      id: "f-vague",
      clarity: "vague",
      change: { kind: "insert_after", block: { id: "n2", type: "paragraph", content: plain("Forse Apple") } },
    });
    expect(decideFact(clear, ctx()).kind).toBe("edit");
    expect(decideFact(vague, ctx())).toEqual({ kind: "question", reason: "vague" });
  });
});

describe("un fatto vago non entra mai da sé", () => {
  const changes: ProductFact["change"][] = [
    { kind: "replace", text: plain("x") },
    { kind: "insert_after", block: { id: "n1", type: "paragraph", content: plain("x") } },
    { kind: "link_task", taskCode: "ACQ-1" },
    { kind: "diverges", built: "x" },
  ];
  it("per ogni tipo di cambio e ognuna delle 16 combinazioni del contesto", () => {
    for (const change of changes) {
      for (let bits = 0; bits < 16; bits++) {
        const c: FactContext = {
          lastWriterIsPerson: !!(bits & 1),
          actorCanEdit: !!(bits & 2),
          changedByPersonSinceArrival: !!(bits & 4),
          anchorExists: !!(bits & 8),
        };
        for (const contradicts of [false, true])
          expect(decideFact(fact({ change, clarity: "vague", contradicts }), c).kind, `${change.kind} ${bits}`).not.toBe("edit");
      }
    }
  });
});

describe("recommendedOf (la risposta che Claude consiglia, preflight P30)", () => {
  const q = (reason: "vague" | "contradicts_person" | "contradicts" | "diverges" | "no_permission") =>
    ({ kind: "question", reason }) as const;

  it("vago → Leave it; contrasto con Claude → Update it; con una persona → Leave it", () => {
    expect(recommendedOf(fact(), q("vague"))).toBe("keep");
    expect(recommendedOf(fact(), q("contradicts"))).toBe("apply");
    expect(recommendedOf(fact(), q("contradicts_person"))).toBe("keep");
  });

  it("senza permesso il fatto è chiaro: Update it", () => {
    expect(recommendedOf(fact(), q("no_permission"))).toBe("apply");
  });

  it("`diverges` dice quello del seme, e il seme vince su ogni altro default", () => {
    const f = fact({ change: { kind: "diverges", built: "x" }, recommended: "request" });
    expect(recommendedOf(f, q("diverges"))).toBe("request");
    expect(recommendedOf(fact({ recommended: "keep" }), q("contradicts"))).toBe("keep");
  });
});
