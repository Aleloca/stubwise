import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "./index.js";
import {
  isUnknown,
  readerNodeKinds,
  readerSchema,
  UNKNOWN,
  unsupportedNodeKinds,
  type Reader,
} from "./reader.js";

/** Tutti gli schemi Zod esportati dal pacchetto, per nome. */
function exportedSchemas(): [string, z.ZodType][] {
  // `Object.entries` su un modulo dà l'unione di TUTTI i tipi esportati
  // (schemi, funzioni, costanti): si passa da `unknown` e si filtra a runtime.
  const entries = Object.entries(shared) as [string, unknown][];
  return entries.filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType);
}

/** Ogni insieme di valori d'enum raggiungibile dagli schemi esportati. */
function allEnumValues(): { name: string; values: string[] }[] {
  const found: { name: string; values: string[] }[] = [];
  const seen = new Set<unknown>();
  const walk = (schema: unknown, name: string): void => {
    if (!(schema instanceof z.ZodType) || seen.has(schema)) return;
    seen.add(schema);
    if (schema instanceof z.ZodEnum) found.push({ name, values: schema.options.map(String) });
    const def = schema.def as unknown as Record<string, unknown>;
    if (def.shape) for (const [k, v] of Object.entries(def.shape)) walk(v, `${name}.${k}`);
    for (const key of ["element", "innerType", "valueType", "keyType"]) walk(def[key], name);
    if (Array.isArray(def.options)) for (const o of def.options) walk(o, name);
  };
  for (const [name, schema] of exportedSchemas()) walk(schema, name);
  return found;
}

describe("UNKNOWN", () => {
  it("non collide con NESSUN valore d'enum del pacchetto, e deve continuare a non farlo", () => {
    // Se un enum contenesse davvero questa stringa, il segnaposto diventerebbe
    // indistinguibile da un dato legittimo: la UI direbbe "aggiorna l'app"
    // sopra una card validissima. Il test vale su TUTTI gli enum esportati, non
    // solo su quelli che il mobile legge oggi.
    const colliding = allEnumValues().filter((e) => e.values.includes(UNKNOWN));
    expect(colliding).toEqual([]);
    // Rete di sicurezza sul test stesso: se la raccolta smettesse di trovare
    // enum, la riga sopra passerebbe per il motivo sbagliato.
    expect(allEnumValues().length).toBeGreaterThan(20);
  });

  it("isUnknown riconosce il segnaposto e nient'altro", () => {
    expect(isUnknown(UNKNOWN)).toBe(true);
    expect(isUnknown("job.plan_review")).toBe(false);
    expect(isUnknown(undefined)).toBe(false);
  });
});

describe("readerSchema", () => {
  it("accetta i valori noti e sostituisce gli ignoti col segnaposto", () => {
    const reader = readerSchema(z.enum(["a", "b"]));
    expect(reader.parse("a")).toBe("a");
    expect(reader.parse("kind.nuovo.di.un.server.piu.recente")).toBe(UNKNOWN);
  });

  it("apre gli enum ANNIDATI: in oggetti, array, optional, nullable e union", () => {
    const schema = z.object({
      kind: z.enum(["x"]),
      list: z.array(z.enum(["x"])),
      maybe: z.enum(["x"]).optional(),
      nullable: z.enum(["x"]).nullable(),
      deep: z.object({ inner: z.array(z.object({ k: z.enum(["x"]) })) }),
      union: z.union([z.enum(["x"]), z.number()]),
    });
    const parsed = readerSchema(schema).parse({
      kind: "nuovo",
      list: ["x", "nuovo"],
      maybe: "nuovo",
      nullable: null,
      deep: { inner: [{ k: "nuovo" }] },
      union: "nuovo",
    });
    expect(parsed).toEqual({
      kind: UNKNOWN,
      list: ["x", UNKNOWN],
      maybe: UNKNOWN,
      nullable: null,
      deep: { inner: [{ k: UNKNOWN }] },
      union: UNKNOWN,
    });
  });

  it("apre i literal di STRINGA ma lascia stare quelli che stringhe non sono", () => {
    expect(readerSchema(z.literal("code")).parse("docs")).toBe(UNKNOWN);
    // `z.literal(true)` non ha un segnaposto sensato: resta rigido, e `Reader<T>`
    // non tocca i booleani — tipo e runtime restano d'accordo.
    expect(() => readerSchema(z.literal(true)).parse(false)).toThrow();
  });

  it("NON allenta nient'altro: un campo mancante o di tipo sbagliato resta un errore", () => {
    // È il limite dichiarato della soluzione: apre i VALORI d'enum, non la
    // forma. Un campo rimosso dal server rompe il parse come prima.
    const reader = readerSchema(z.object({ id: z.string(), kind: z.enum(["a"]) }));
    expect(() => reader.parse({ kind: "a" })).toThrow();
    expect(() => reader.parse({ id: 1, kind: "a" })).toThrow();
  });

  it("un campo AGGIUNTO dal server passa senza rumore (i cambi additivi sono sicuri)", () => {
    const reader = readerSchema(z.object({ id: z.string() }));
    expect(reader.parse({ id: "x", campoNuovo: 1 })).toEqual({ id: "x" });
  });

  it("il tipo dichiara l'apertura che il runtime applica", () => {
    const reader = readerSchema(z.object({ kind: z.enum(["a", "b"]) }));
    const value = reader.parse({ kind: "sconosciuto" });
    // Se `Reader<T>` non allargasse il tipo, questo confronto non compilerebbe:
    // è il test che tiene insieme il cast interno di `readerSchema` e la realtà.
    const kind: "a" | "b" | typeof UNKNOWN = value.kind;
    expect(kind).toBe(UNKNOWN);
    // …e non allarga ciò che non deve: `string` nudo resta `string`.
    const free: Reader<{ s: string }> = { s: "qualsiasi" };
    expect(free.s).toBe("qualsiasi");
  });

  it("memoizza: due derivazioni dello stesso schema sono lo stesso oggetto", () => {
    const schema = z.object({ k: z.enum(["a"]) });
    expect(readerSchema(schema)).toBe(readerSchema(schema));
  });

  it("segnala i nodi che non sa attraversare invece di aprirli a metà", () => {
    // Un `record` passa invariato — comportamento sicuro — ma l'enum che
    // contiene resterebbe CHIUSO: è esattamente il buco silenzioso che il
    // guardiano sui tipi di nodo deve far emergere.
    const schema = z.object({ mappa: z.record(z.string(), z.enum(["a"])) });
    expect(unsupportedNodeKinds(schema)).toEqual(["record"]);
    expect(() => readerSchema(schema).parse({ mappa: { k: "ignoto" } })).toThrow();
  });

  it("segnala un oggetto con catchall, che la ricostruzione appiattirebbe", () => {
    expect(unsupportedNodeKinds(z.looseObject({ a: z.string() }))).toEqual(["object(catchall)"]);
  });

  it("readerNodeKinds descrive lo stesso cammino che apre gli enum", () => {
    expect([...readerNodeKinds(z.object({ a: z.array(z.enum(["x"])) }))].sort()).toEqual([
      "array",
      "enum",
      "object",
    ]);
  });
});
