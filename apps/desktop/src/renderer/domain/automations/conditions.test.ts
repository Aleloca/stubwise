import { describe, expect, it } from "vitest";
import type { Condition } from "../../data/model";
import { conditionRefs, evaluate, lookup } from "./conditions";

const VARS = {
  "risposta.arrivata": true,
  "risposta.testo": "Ecco i dati",
  "analisi.task": [{ titolo: "Migrare", reparto: "Development" }],
  cliente: { nome: "Cantina Bellavista Srl", dominio: "cantinabellavista.example" },
  trattativa: { importo: 18400, chiusaIl: "2026-10-11", prodotti: ["CRM", "Centralino AI"] },
  vuoto: "  ",
};

const cmp = (ref: string, op: Condition["op"], value?: string | number | boolean | null) =>
  ({
    left: { ref },
    op,
    ...(value === undefined ? {} : { right: { value } }),
  }) satisfies Condition;

describe("lookup", () => {
  it("legge prima la chiave piatta, poi il percorso puntato nell'evento", () => {
    expect(lookup(VARS, "risposta.testo")).toBe("Ecco i dati");
    expect(lookup(VARS, "cliente.nome")).toBe("Cantina Bellavista Srl");
    expect(lookup(VARS, "cliente.manca")).toBeUndefined();
    expect(lookup(VARS, "nessuno.niente")).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("is / is_not: testo senza maiuscole e spazi, numeri, booleani (R-J6)", () => {
    expect(evaluate(cmp("cliente.nome", "is", " cantina bellavista srl "), VARS)).toBe(true);
    expect(evaluate(cmp("cliente.nome", "is_not", "Mix Cucine Srl"), VARS)).toBe(true);
    expect(evaluate(cmp("trattativa.importo", "is", 18400), VARS)).toBe(true);
    expect(evaluate(cmp("trattativa.importo", "is", "18400"), VARS)).toBe(true);
    expect(evaluate(cmp("risposta.arrivata", "is", true), VARS)).toBe(true);
    expect(evaluate(cmp("risposta.arrivata", "is", false), VARS)).toBe(false);
    expect(evaluate(cmp("risposta.arrivata", "is_not", true), VARS)).toBe(false);
    expect(evaluate(cmp("risposta.arrivata", "is", "true"), VARS)).toBe(true);
  });

  it("contains, empty, not_empty", () => {
    expect(evaluate(cmp("risposta.testo", "contains", "DATI"), VARS)).toBe(true);
    expect(evaluate(cmp("trattativa.prodotti", "contains", "crm"), VARS)).toBe(true);
    expect(evaluate(cmp("trattativa.prodotti", "contains", "Preventivi"), VARS)).toBe(false);
    expect(evaluate(cmp("vuoto", "empty"), VARS)).toBe(true);
    expect(evaluate(cmp("cliente.manca", "empty"), VARS)).toBe(true);
    expect(evaluate(cmp("analisi.task", "not_empty"), VARS)).toBe(true);
    expect(evaluate(cmp("risposta.testo", "empty"), VARS)).toBe(false);
  });

  it("gt / lt su numeri e date", () => {
    expect(evaluate(cmp("trattativa.importo", "gt", 10000), VARS)).toBe(true);
    expect(evaluate(cmp("trattativa.importo", "lt", 10000), VARS)).toBe(false);
    expect(evaluate(cmp("trattativa.chiusaIl", "gt", "2026-10-01"), VARS)).toBe(true);
    expect(evaluate(cmp("trattativa.chiusaIl", "lt", "2026-10-01"), VARS)).toBe(false);
    // Un dato assente non è mai maggiore né minore.
    expect(evaluate(cmp("cliente.manca", "gt", 0), VARS)).toBe(false);
    expect(evaluate(cmp("cliente.manca", "lt", 0), VARS)).toBe(false);
  });

  it("un riferimento a destra si confronta col dato", () => {
    const c: Condition = {
      left: { ref: "cliente.nome" },
      op: "is",
      right: { ref: "cliente.nome" },
    };
    expect(evaluate(c, VARS)).toBe(true);
  });

  it("gruppi all/any annidati", () => {
    const yes = cmp("risposta.arrivata", "is", true);
    const no = cmp("risposta.arrivata", "is", false);
    expect(evaluate({ all: [yes, { any: [no, yes] }] }, VARS)).toBe(true);
    expect(evaluate({ all: [yes, { any: [no, no] }] }, VARS)).toBe(false);
    expect(evaluate({ any: [no, { all: [yes, { any: [no, yes] }] }] }, VARS)).toBe(true);
    expect(evaluate({ any: [no, { all: [yes, { all: [no] }] }] }, VARS)).toBe(false);
    // all vuoto è vero, any vuoto è falso; i due insieme valgono entrambi.
    expect(evaluate({ all: [] }, VARS)).toBe(true);
    expect(evaluate({ any: [] }, VARS)).toBe(false);
    expect(evaluate({ all: [yes], any: [no] }, VARS)).toBe(false);
  });

  it("un confronto incompleto è falso", () => {
    expect(evaluate({ left: { ref: "risposta.testo" } }, VARS)).toBe(false);
    expect(evaluate({}, VARS)).toBe(false);
  });

  it("accetta un risolutore al posto delle variabili", () => {
    const get = (key: string) => (key === "task.reparto" ? "Support" : undefined);
    expect(evaluate(cmp("task.reparto", "is", "Support"), get)).toBe(true);
  });
});

describe("conditionRefs", () => {
  it("raccoglie i riferimenti di tutti i livelli, senza doppioni", () => {
    const c: Condition = {
      all: [
        cmp("risposta.testo", "not_empty"),
        {
          any: [
            cmp("cliente.nome", "is", "x"),
            { left: { ref: "a" }, op: "is", right: { ref: "risposta.testo" } },
          ],
        },
      ],
    };
    expect(conditionRefs(c)).toEqual(["risposta.testo", "cliente.nome", "a"]);
  });
});
