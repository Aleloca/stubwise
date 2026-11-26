import { describe, expect, it } from "vitest";
import { productFactSchema, type ProductFact } from "../schemas/product-docs.js";
import { decideFact, recommendedOf, type FactContext } from "./claude-rule.js";

// Area 11, F5, Task 1: la regola di Claude. Una riga di test per ogni riga
// della regola, i casi di `claudeRule.test.ts` del prototipo uno per uno.

const PAGE = "1c9e4f70-5555-4666-8777-888899990061";
const plain = (text: string) => ({ text, marks: [] });
const fact = (over: Partial<ProductFact> = {}): ProductFact => ({
  id: "f1",
  pageId: PAGE,
  anchorId: "blk-1",
  change: { kind: "replace", text: plain("Login solo con Google.") },
  clarity: "clear",
  ...over,
});
const ctx = (over: Partial<FactContext> = {}): FactContext => ({ lastWriterIsPerson: false, actorCanEdit: true, changedByPersonSinceArrival: false, anchorExists: true, ...over });

describe("decideFact", () => {
  it("un fatto chiaro, senza contrasto, col permesso entra da sé", () => {
    expect(decideFact(fact(), ctx())).toEqual({ kind: "edit" });
  });

  it("un fatto vago è una domanda anche col permesso e senza contrasto", () => {
    expect(decideFact(fact({ clarity: "vague" }), ctx())).toEqual({ kind: "question", reason: "vague" });
  });

  it("un fatto chiaro che contraddice testo di Claude è `contradicts`; uno di una persona `contradicts_person`", () => {
    expect(decideFact(fact({ contradicts: true }), ctx())).toEqual({ kind: "question", reason: "contradicts" });
    expect(decideFact(fact({ contradicts: true }), ctx({ lastWriterIsPerson: true }))).toEqual({ kind: "question", reason: "contradicts_person" });
  });

  it("un blocco che una persona ha riscritto DOPO l'arrivo contraddice senza il flag", () => {
    expect(decideFact(fact(), ctx({ changedByPersonSinceArrival: true }))).toEqual({ kind: "question", reason: "contradicts_person" });
  });

  it("un blocco scritto da una persona ma senza contrasto si modifica", () => {
    expect(decideFact(fact(), ctx({ lastWriterIsPerson: true }))).toEqual({ kind: "edit" });
  });

  it("senza il permesso del titolare è una domanda `no_permission`", () => {
    expect(decideFact(fact(), ctx({ actorCanEdit: false }))).toEqual({ kind: "question", reason: "no_permission" });
  });

  it("`diverges` è sempre una domanda; `link_task` che coincide aggiunge il solo link", () => {
    expect(decideFact(fact({ change: { kind: "diverges", built: "Login anche con Apple" } }), ctx())).toEqual({ kind: "question", reason: "diverges" });
    expect(decideFact(fact({ change: { kind: "link_task", taskCode: "ACQ-12" } }), ctx())).toEqual({ kind: "edit" });
  });

  it("un `replace` su un'ancora sparita non fa niente; un `insert_after` sparito neanche, in cima alla pagina sì", () => {
    expect(decideFact(fact(), ctx({ anchorExists: false }))).toEqual({ kind: "none" });
    const insert = (anchorId: string | null) => fact({ anchorId, change: { kind: "insert_after", block: { id: "n1", type: "paragraph", content: plain("x") } } });
    expect(decideFact(insert("blk-9"), ctx({ anchorExists: false }))).toEqual({ kind: "none" });
    expect(decideFact(insert(null), ctx({ anchorExists: false }))).toEqual({ kind: "edit" });
  });

  it("due fatti della stessa fonte: il chiaro entra e il vago è una domanda", () => {
    const vague = fact({ id: "f-vague", clarity: "vague", change: { kind: "insert_after", block: { id: "n2", type: "paragraph", content: plain("Forse Apple") } } });
    expect(decideFact(fact(), ctx()).kind).toBe("edit");
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
    for (const change of changes)
      for (let bits = 0; bits < 16; bits++) {
        const c: FactContext = { lastWriterIsPerson: !!(bits & 1), actorCanEdit: !!(bits & 2), changedByPersonSinceArrival: !!(bits & 4), anchorExists: !!(bits & 8) };
        for (const contradicts of [false, true]) expect(decideFact(fact({ change, clarity: "vague", contradicts }), c).kind, `${change.kind} ${bits}`).not.toBe("edit");
      }
  });
});

describe("recommendedOf", () => {
  const q = (reason: "vague" | "contradicts_person" | "contradicts" | "diverges" | "no_permission") => ({ kind: "question", reason }) as const;
  it("vago → keep; contrasto con Claude → apply; con una persona → keep; senza permesso → apply", () => {
    expect(recommendedOf(fact(), q("vague"))).toBe("keep");
    expect(recommendedOf(fact(), q("contradicts"))).toBe("apply");
    expect(recommendedOf(fact(), q("contradicts_person"))).toBe("keep");
    expect(recommendedOf(fact(), q("no_permission"))).toBe("apply");
  });
  it("`diverges` → keep, e quello scritto nel fatto vince su ogni altro default", () => {
    expect(recommendedOf(fact({ change: { kind: "diverges", built: "x" } }), q("diverges"))).toBe("keep");
    expect(recommendedOf(fact({ change: { kind: "diverges", built: "x" }, recommended: "request" }), q("diverges"))).toBe("request");
    expect(recommendedOf(fact({ recommended: "keep" }), q("contradicts"))).toBe("keep");
  });
});

describe("productFactSchema: il modello restituisce FATTI, mai testo libero", () => {
  it("un fatto valido passa; uno fuori schema no (un campo in più, un tipo di cambio inventato, una pagina che non è un uuid)", () => {
    expect(productFactSchema.safeParse(fact()).success).toBe(true);
    expect(productFactSchema.safeParse({ ...fact(), extra: "testo libero" }).success).toBe(false);
    expect(productFactSchema.safeParse({ ...fact(), change: { kind: "delete_page" } }).success).toBe(false);
    expect(productFactSchema.safeParse({ ...fact(), pageId: "una-pagina" }).success).toBe(false);
    expect(productFactSchema.safeParse({ ...fact(), clarity: "sure" }).success).toBe(false);
  });
});
