import { describe, expect, it } from "vitest";

// Revisione di sicurezza I-B2: dove passa la PRF (la cerimonia, la consegna
// al worker, la lista di transfer, la copia di una vista) nessun [[Set]] su
// un oggetto. Un'assegnazione a una proprietà (`a[i] = x`, `o.k = x`) cerca
// un setter sulla catena dei prototipi, e uno su `Array.prototype` o
// `Object.prototype` riceverebbe il valore. Una dichiarazione (`const x = …`)
// o l'assegnazione di una variabile locale non sono un [[Set]]; un letterale
// (`[prf]`, `{ prf }`) crea proprietà proprie senza [[Set]].

const SOURCES = import.meta.glob(["./webauthn.ts", "./client.ts", "./primitives.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Il corpo della funzione o della proprietà-funzione `name` (dalla sua prima graffa alla chiusa). */
export function bodyOf(source: string, name: string): string {
  const start = new RegExp(`(?:function\\s+${name}\\b|\\b${name}\\s*:\\s*(?:async\\s*)?\\()`).exec(source);
  if (!start) throw new Error(`${name} assente`);
  // La prima graffa del CORPO: dopo la chiusa della lista dei parametri.
  let depth = 0;
  let i = source.indexOf("(", start.index);
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")" && --depth === 0) break;
  }
  const open = source.indexOf("{", i);
  depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    if (source[j] === "}" && --depth === 0) return source.slice(open, j + 1);
  }
  throw new Error(`${name} non chiusa`);
}

const SETS: { re: RegExp; what: string }[] = [
  { re: /[\w$\])]\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?!=)/, what: "un'assegnazione a una proprietà" },
  { re: /\.\s*(push|unshift|splice)\s*\(/, what: "push/unshift/splice" },
  { re: /\bObject\s*\.\s*assign\s*\(/, what: "Object.assign" },
];

export function setsIn(code: string): string[] {
  return SETS.filter(({ re }) => re.test(code)).map(({ what }) => what);
}

describe("I-B2: nessun [[Set]] dove passa la PRF", () => {
  it("la cerimonia, la consegna al worker, la lista di transfer e la copia di una vista", () => {
    const places: [string, string][] = [
      ["webauthn.ts", codeOnly(SOURCES["./webauthn.ts"]!)],
      ["stashPrf", bodyOf(codeOnly(SOURCES["./client.ts"]!), "stashPrf")],
      ["transferList", bodyOf(codeOnly(SOURCES["./primitives.ts"]!), "transferList")],
      ["ownBuffer", bodyOf(codeOnly(SOURCES["./primitives.ts"]!), "ownBuffer")],
    ];
    const found = places.flatMap(([where, code]) => setsIn(code).map((w) => `${where}: ${w}`));
    expect(found).toEqual([]);
  });

  it("il controllo scatta su ciò che deve fermare, e lascia passare dichiarazioni e letterali", () => {
    expect(setsIn("copy[i] = items[i];")).toEqual(["un'assegnazione a una proprietà"]);
    expect(setsIn("out.prf = prf;")).toEqual(["un'assegnazione a una proprietà"]);
    expect(setsIn("box.n += 1;")).toEqual(["un'assegnazione a una proprietà"]);
    expect(setsIn("list.push(prf);")).toEqual(["push/unshift/splice"]);
    expect(setsIn("Object.assign(o, { prf });")).toEqual(["Object.assign"]);
    expect(setsIn("const prf = primitives.ownBuffer(x); let out; out = f(prf); if (a === b) {} const l = [prf];")).toEqual([]);
    expect(setsIn("return { done: false, value: items[i++] };")).toEqual([]);
  });

  it("trova i corpi che deve guardare", () => {
    expect(bodyOf("function stashPrf(prf: ArrayBuffer): void { a(); }", "stashPrf")).toBe("{ a(); }");
    expect(bodyOf("const p = { ownBuffer: (v: unknown): X => { b(); }, };", "ownBuffer")).toBe("{ b(); }");
  });
});
