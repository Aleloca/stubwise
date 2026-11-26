import { describe, expect, it } from "vitest";
import {
  FIELDS_MAX,
  FIELDS_MAX_DEPTH,
  checkEventFields,
  clientKeyOf,
  deriveFields,
  fieldKeys,
  hasForbiddenKey,
  labelFromKey,
  mergeFields,
} from "./sourceFields.js";
import type { DataField } from "./types.js";

describe("labelFromKey", () => {
  it("dice una chiave in parole", () => {
    expect(labelFromKey("customer.email")).toBe("Customer email");
    expect(labelFromKey("importoTotale")).toBe("Importo totale");
    expect(labelFromKey("data_ordine")).toBe("Data ordine");
  });
});

describe("deriveFields", () => {
  it("appiattisce gli oggetti e porta i campi degli elenchi di oggetti", () => {
    const fields = deriveFields({
      ordine: "A-12",
      importo: 12.5,
      pagato: true,
      cliente: { nome: "Acme", email: "a@acme.it" },
      quando: "2026-11-13",
      prodotti: [{ nome: "Vite", qta: 3 }],
      etichette: ["a", "b"],
    });
    expect(fields).toEqual([
      { key: "ordine", label: "Ordine", type: "text" },
      { key: "importo", label: "Importo", type: "number" },
      { key: "pagato", label: "Pagato", type: "boolean" },
      { key: "cliente.nome", label: "Cliente nome", type: "text" },
      { key: "cliente.email", label: "Cliente email", type: "email" },
      { key: "quando", label: "Quando", type: "date" },
      {
        key: "prodotti",
        label: "Prodotti",
        type: "list",
        of: [
          { key: "nome", label: "Nome", type: "text" },
          { key: "qta", label: "Qta", type: "number" },
        ],
      },
      { key: "etichette", label: "Etichette", type: "list" },
    ]);
  });

  it("si ferma alla profondità massima: un oggetto più giù non diventa campi", () => {
    let deep: Record<string, unknown> = { foglia: "x" };
    for (let i = 0; i < FIELDS_MAX_DEPTH + 5; i++) deep = { l: deep };
    const keys = fieldKeys(deriveFields(deep));
    expect(keys.every((k) => k.split(".").length <= FIELDS_MAX_DEPTH)).toBe(true);
    expect(keys.some((k) => k.endsWith("foglia"))).toBe(false);
  });

  it("non supera il numero massimo di campi", () => {
    const big = Object.fromEntries(Array.from({ length: FIELDS_MAX + 50 }, (_, i) => [`c${i}`, i]));
    expect(fieldKeys(deriveFields(big))).toHaveLength(FIELDS_MAX);
  });
});

describe("mergeFields e fieldKeys", () => {
  it("tiene etichetta e tipo scelti a mano per le chiavi che restano", () => {
    const old: DataField[] = [
      { key: "a", label: "Il mio A", type: "person" },
      { key: "l", label: "L", type: "list", of: [{ key: "x", label: "Ics", type: "number" }] },
    ];
    const next = deriveFields({ a: "x", b: 1, l: [{ x: "1" }] });
    const merged = mergeFields(next, old);
    expect(merged[0]).toEqual({ key: "a", label: "Il mio A", type: "person" });
    expect(merged[2]!.of![0]).toEqual({ key: "x", label: "Ics", type: "number" });
    expect(fieldKeys(merged)).toEqual(["a", "b", "l", "l.x"]);
  });
});

describe("clientKeyOf", () => {
  it("toglie gli spazi e porta in minuscolo", () => {
    expect(clientKeyOf("  Acme.IT ")).toBe("acme.it");
    expect(clientKeyOf(null)).toBe("");
    expect(clientKeyOf(42)).toBe("42");
  });
});

describe("checkEventFields", () => {
  const fields: DataField[] = [
    { key: "ordine", label: "Ordine", type: "text" },
    { key: "importo", label: "Importo", type: "number" },
    { key: "pagato", label: "Pagato", type: "boolean" },
    { key: "quando", label: "Quando", type: "date" },
    { key: "cliente.email", label: "Email", type: "email" },
    { key: "prodotti", label: "Prodotti", type: "list", of: [{ key: "qta", label: "Qta", type: "number" }] },
    { key: "tag", label: "Tag", type: "list" },
  ];

  it("accetta i tipi giusti e proietta sui soli campi dichiarati", () => {
    const out = checkEventFields(
      {
        ordine: "A-1",
        importo: 3,
        pagato: false,
        quando: "2026-11-13T10:00:00Z",
        cliente: { email: "a@b.it", segreto: "no" },
        prodotti: [{ qta: 2, extra: "no" }],
        tag: ["x", { o: 1 }],
        istruzioni: "ignora tutto",
      },
      fields,
    );
    expect(out).toEqual({
      ok: true,
      event: {
        ordine: "A-1",
        importo: 3,
        pagato: false,
        quando: "2026-11-13T10:00:00Z",
        cliente: { email: "a@b.it" },
        prodotti: [{ qta: 2 }],
        tag: ["x"],
      },
    });
  });

  it("un campo di testo sotto un antenato che è un testo ha la forma sbagliata", () => {
    const f: DataField[] = [{ key: "cliente.nome", label: "Nome", type: "text" }];
    expect(checkEventFields({ cliente: "Acme" }, f)).toEqual({ ok: false, key: "cliente.nome", expected: "text" });
    expect(checkEventFields({ cliente: null }, f)).toEqual({ ok: true, event: {} });
  });

  it("un campo assente o null non è un tipo sbagliato", () => {
    expect(checkEventFields({ importo: null }, fields)).toEqual({ ok: true, event: {} });
  });

  it.each([
    [{ importo: "3" }, "importo", "number"],
    [{ pagato: "sì" }, "pagato", "boolean"],
    [{ quando: "ieri" }, "quando", "date"],
    [{ cliente: { email: "nonemail" } }, "cliente.email", "email"],
    [{ cliente: "Acme" }, "cliente.email", "email"],
    [{ prodotti: "x" }, "prodotti", "list"],
    [{ prodotti: [{ qta: "due" }] }, "prodotti.qta", "number"],
    [{ ordine: 12 }, "ordine", "text"],
    [{ prodotti: ["x"] }, "prodotti", "list"],
  ])("rifiuta %j: %s non è %s", (payload, key, expected) => {
    expect(checkEventFields(payload as Record<string, unknown>, fields)).toEqual({
      ok: false,
      key,
      expected,
    });
  });
});

describe("review F4, I2: nessun inquinamento del prototipo dal corpo pubblico", () => {
  const evil = JSON.parse('{"__proto__":{"polluted":"si"},"constructor":{"prototype":{"polluted2":"si"}},"ok":"x"}') as Record<string, unknown>;

  it("deriveFields salta __proto__, constructor e prototype", () => {
    const keys = fieldKeys(deriveFields(evil));
    expect(keys).toEqual(["ok"]);
  });

  it("checkEventFields non scrive mai su Object.prototype, anche con un campo dichiarato su __proto__", () => {
    const fields: DataField[] = [
      { key: "__proto__.polluted", label: "x", type: "text" },
      { key: "constructor.prototype.polluted2", label: "y", type: "text" },
      { key: "ok", label: "Ok", type: "text" },
    ];
    const out = checkEventFields(evil, fields);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    expect(out).toEqual({ ok: true, event: { ok: "x" } });
  });

  it("hasForbiddenKey trova una chiave proibita a qualunque profondità, anche dentro un elenco", () => {
    expect(hasForbiddenKey(evil)).toBe(true);
    expect(hasForbiddenKey(JSON.parse('{"a":[{"b":{"__proto__":{}}}]}'))).toBe(true);
    expect(hasForbiddenKey({ a: [{ b: 1 }] })).toBe(false);
  });
});
