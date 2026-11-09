import { describe, expect, it } from "vitest";

// Claude non scrive mai nel registro decisioni partendo dalla doc (11b,
// anti-obiettivo della spec): il registro è FATTO, la doc di prodotto è
// narrativa che Claude può riscrivere, e il giorno in cui una riga della
// doc finisse nel registro, il registro smetterebbe di poter essere citato
// senza riverificarlo. Come `neverInCatalog.test.ts`, il controllo è sul
// SORGENTE e cerca riferimenti di CODICE — chiamate e scritture —, non
// parole: un commento o una stringa possono nominare `recordDecision` (lo
// fa questo file). Limite accettato: un nome composto a runtime sfugge.

const SOURCES = import.meta.glob(
  ["./*.ts", "../../domain/productDocs/*.ts", "!./*.test.ts", "!../../domain/productDocs/*.test.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Il codice senza commenti e senza il contenuto di stringhe e template (le espressioni `${…}` restano). */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  const templates: number[] = [];
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n")
        i += source[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    if (c === "`" || (c === "}" && templates.length > 0 && templates.at(-1) === 0)) {
      if (c === "}") templates.pop();
      i++;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") i += 2;
        else if (source[i] === "$" && source[i + 1] === "{") break;
        else i++;
      }
      if (source[i] === "$") {
        templates.push(0);
        i += 2;
        out += "`${";
      } else {
        i++;
        out += "``";
      }
      continue;
    }
    if (templates.length > 0) {
      if (c === "{") templates[templates.length - 1]! += 1;
      if (c === "}") templates[templates.length - 1]! -= 1;
    }
    out += c;
    i++;
  }
  return out;
}

/** I riferimenti vietati: `recordDecision*` (anche `recordDecisionAs`), `decisionLog.push`, `state.decisionLog =`. */
function forbiddenIn(source: string): string[] {
  const code = codeOnly(source);
  const hits: string[] = [];
  if (/\brecordDecision\w*/.test(code)) hits.push("recordDecision");
  if (/\bdecisionLog\s*\.\s*push\b/.test(code)) hits.push("decisionLog.push");
  if (/\bdecisionLog\s*=(?!=)/.test(code)) hits.push("decisionLog =");
  return hits;
}

describe("la doc di prodotto non scrive mai nel registro decisioni", () => {
  it("il controllo guarda i file giusti (data/ e domain/ di productDocs)", () => {
    const names = Object.keys(SOURCES);
    expect(names.some((n) => n.startsWith("./") && n.endsWith("sources.ts"))).toBe(true);
    expect(names.some((n) => n.includes("domain/productDocs/claudeRule.ts"))).toBe(true);
    expect(names.length).toBeGreaterThan(10);
  });

  it("nessun file nomina `recordDecision`, `decisionLog.push` o `state.decisionLog =` nel codice", () => {
    const hits = Object.entries(SOURCES).flatMap(([file, source]) =>
      forbiddenIn(source).map((h) => `${file}: ${h}`),
    );
    expect(hits).toEqual([]);
  });

  it("il controllo vede i tre riferimenti e non si fa ingannare da commenti e stringhe", () => {
    expect(forbiddenIn("await recordDecisionAs(me, d);")).toEqual(["recordDecision"]);
    expect(forbiddenIn("state.decisionLog.push(row);")).toEqual(["decisionLog.push"]);
    expect(forbiddenIn("state.decisionLog = [];")).toEqual(["decisionLog ="]);
    expect(forbiddenIn("// recordDecision\n/* decisionLog.push */ const s = 'state.decisionLog = x';")).toEqual([]);
    expect(forbiddenIn("const d = state.decisionLog.find((x) => x.id === id);")).toEqual([]);
  });
});
