import type { Db } from "@stubwise/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { buildApp } from "../app.js";
import { personMaskedRoutes } from "../services/people-known.js";

/**
 * Registro, A11 r.1414 (revisione del lotto 2, C1): ogni rotta che passa da
 * `registerPersonMask` deve poter SERIALIZZARE il segnaposto. Una chiave
 * mascherata il cui campo nello schema di risposta è rimasto `uuid` fa
 * lanciare il serializer di zod: 500 sull'intera risposta (una pagina di task
 * intera per un `manualStall.byId`). Il test legge gli schemi veri di tutte
 * le rotte mascherate e, per ogni campo con il nome di una chiave, vuole che
 * accetti `hidden-1` (o un elenco di segnaposto), e il nome accanto (`byId` →
 * `byName`) `null`; per una chiave-oggetto,
 * `id: "hidden-1"` e `name: null`. Chi aggiunge una chiave senza allargare lo
 * schema lo fa fallire qui.
 */
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  app = buildApp({ db: {} as Db, sessionSecret: "x".repeat(40) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

type Def = { type: string; [k: string]: unknown };
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;

/** I figli di uno schema da attraversare (oggetti, elenchi, involucri, unioni). */
function children(s: z.ZodType): z.ZodType[] {
  const def = defOf(s);
  switch (def.type) {
    case "object":
      return Object.values(def.shape as Record<string, z.ZodType>);
    case "array":
      return [def.element as z.ZodType];
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
    case "nonoptional":
      return [def.innerType as z.ZodType];
    case "union":
      return def.options as z.ZodType[];
    case "intersection":
      return [def.left as z.ZodType, def.right as z.ZodType];
    case "record":
      return [def.valueType as z.ZodType];
    case "pipe":
      return [def.in as z.ZodType, def.out as z.ZodType];
    case "lazy":
      return [(def.getter as () => z.ZodType)()];
    case "tuple":
      return [...(def.items as z.ZodType[]), ...(def.rest ? [def.rest as z.ZodType] : [])];
    default:
      return [];
  }
}

/** Gli oggetti di uno schema, a ogni profondità (una volta sola per schema). */
function objectsIn(root: z.ZodType): Record<string, z.ZodType>[] {
  const out: Record<string, z.ZodType>[] = [];
  const seen = new Set<unknown>();
  const walk = (s: z.ZodType) => {
    if (seen.has(s)) return;
    seen.add(s);
    if (defOf(s).type === "object") out.push(defOf(s).shape as Record<string, z.ZodType>);
    for (const c of children(s)) walk(c);
  };
  walk(root);
  return out;
}

const accepts = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

describe("le rotte mascherate serializzano il segnaposto", () => {
  it("ci sono le rotte mascherate (task, richieste, filtri, server, automazioni, doc di prodotto, decisioni, Drive, supporto, conversazioni e decisioni di Claude, rilasci)", () => {
    const urls = personMaskedRoutes().map((r) => r.url);
    for (const prefix of ["/tasks", "/requests", "/filters", "/servers", "/automations", "/product", "/decisions", "/drive", "/support", "/claude/conversations", "/claude-decisions", "/releases"]) {
      expect(urls.some((u) => u.includes(prefix)), prefix).toBe(true);
    }
  });

  it("ogni campo con il nome di una chiave accetta `hidden-1`; ogni chiave-oggetto `{ id: hidden-1, name: null }`", () => {
    const broken: string[] = [];
    for (const route of personMaskedRoutes()) {
      for (const [status, schema] of Object.entries(route.response)) {
        if (!schema || typeof schema !== "object" || !("_zod" in schema)) continue;
        for (const shape of objectsIn(schema as z.ZodType)) {
          for (const [key, field] of Object.entries(shape)) {
            const where = `${route.method} ${route.url} ${status} .${key}`;
            if (route.keys.has(key) && !accepts(field, "hidden-1") && !accepts(field, ["hidden-1"])) broken.push(where);
            // Il nome accanto a un id mascherato diventa null (`maskPeople`).
            const sibling = key.endsWith("Id") ? shape[`${key.slice(0, -2)}Name`] : undefined;
            if (route.keys.has(key) && sibling && !accepts(sibling, null)) broken.push(`${where} (${key.slice(0, -2)}Name)`);
            if (route.objectKeys.has(key)) {
              for (const inner of objectsIn(field).filter((o) => "id" in o)) {
                if (!accepts(inner.id!, "hidden-1")) broken.push(`${where}.id`);
                if (inner.name && !accepts(inner.name, null)) broken.push(`${where}.name`);
              }
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
