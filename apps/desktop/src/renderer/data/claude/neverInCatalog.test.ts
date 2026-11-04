import { describe, expect, it } from "vitest";
import { CLAUDE_CATALOG } from "./catalog";

// La classe D (area 10a, Task 4; Review Focus 3): ciò che è un gesto delle
// persone non passa MAI dal catalogo di Claude — né come azione, né come
// inverso, né da un intento. Il controllo è sul sorgente, come
// `decisions-never-ai.test.ts` del server, e cerca RIFERIMENTI DI CODICE
// (chiamate, import, accessi `api.<ns>.<nome>`), non parole: un commento,
// una stringa, una regex di riconoscimento o un link possono nominare
// «merge» o «recordDecision» (`refused.ts` deve riconoscerli, P11). Limiti
// accettati: un riferimento indiretto (un nome composto a runtime) sfugge, e
// il tokenizzatore non riconosce le regex letterali: una con `//` o un
// apostrofo dentro può nascondere il codice che la segue (minor T4 M6).

const SOURCES = import.meta.glob(
  [
    "./*.ts",
    "../../domain/claude/intents/*.ts",
    "!./*.test.ts",
    "!../../domain/claude/intents/*.test.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** La Global Constraint «Il catalogo non nomina mai». */
const NEVER = [
  "decidePlan",
  "preApprovePlan",
  "revokePlanApproval",
  "mergePr",
  "answerQuestion",
  "recordDecision",
  "activate",
  "publish",
  "createToken",
  "createClaudeCodeCommand",
  "createInvite",
  "createPasswordResetLink",
  "regenerateIngestionKey",
  "regenerateWebhookSecret",
  "importEnvFile",
  "setEnvVar",
  "createProvider",
  "sendDraft",
  "replyToCustomer",
];

/** Le scritture dei segreti del 9b: restano nel dialogo vero (maintainer, 2 nov 2026). */
const SECRET_WRITES = [
  "createProvider",
  "replaceProviderCredential",
  "deleteProvider",
  "createGitAccount",
  "replaceGitToken",
  "deleteGitAccount",
  "createGoogleApp",
  "replaceGoogleSecret",
  "deleteGoogleApp",
];

/**
 * Il codice senza commenti e senza il contenuto di stringhe e template (le
 * espressioni `${…}` restano: sono codice). Le regex restano come sono: un
 * riconoscimento come `/merge|publish/` non ha la forma di una chiamata.
 */
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
      // Dentro il testo di un template, fino alla fine o a `${`.
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

/** I riferimenti di codice a `name`: chiamata, import, accesso come proprietà. */
function references(code: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\b${n}\\s*\\(`).test(code) ||
    new RegExp(`\\bimport\\b[^;]*\\b${n}\\b[^;]*\\bfrom\\b`).test(code) ||
    new RegExp(`\\.\\s*${n}\\b`).test(code)
  );
}

/** Tutti i riferimenti vietati di un sorgente. */
function forbiddenIn(source: string): string[] {
  const code = codeOnly(source);
  const hits = [...NEVER, ...SECRET_WRITES].filter((name) => references(code, name));
  // `replace*` dei segreti (non `String.prototype.replace`/`replaceAll`).
  if (/\breplace(?!All\b)[A-Z]\w*\s*\(/.test(code)) hits.push("replace*");
  // Ogni funzione dei server (`api.servers.*`, il modulo `data/servers`).
  if (/\bservers\s*\.\s*\w+/.test(code) || /from\s+["'][^"']*\/servers\//.test(source))
    hits.push("servers.*");
  return [...new Set(hits)];
}

describe("il catalogo non nomina mai i gesti delle persone", () => {
  it("trova i sorgenti del catalogo e degli intenti", () => {
    const paths = Object.keys(SOURCES);
    expect(paths).toContain("./catalog.ts");
    expect(paths).toContain("./classes.ts");
    // Le voci del 10b (le bozze di automazione) stanno in un file a parte.
    expect(paths).toContain("./catalogMore.ts");
    expect(paths.some((p) => p.endsWith("intents/change.ts"))).toBe(true);
  });

  it("nessun riferimento di codice alle funzioni vietate", () => {
    const found = Object.entries(SOURCES).flatMap(([path, source]) =>
      forbiddenIn(source).map((name) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  it("il risolutore trova chiamate, import e accessi, e ignora commenti, stringhe e regex", () => {
    expect(forbiddenIn("const x = mergePr(pr);")).toEqual(["mergePr"]);
    expect(forbiddenIn('import { mergePr } from "../releases/writes";')).toEqual(["mergePr"]);
    expect(forbiddenIn("await api.decisions.recordDecision(input);")).toEqual(["recordDecision"]);
    expect(forbiddenIn("const fn = api.automations.publish;")).toEqual(["publish"]);
    expect(forbiddenIn("x.replaceGitToken(id, t);")).toContain("replaceGitToken");
    expect(forbiddenIn("void api.servers.restart(id);")).toEqual(["servers.*"]);
    // Le parole non contano.
    expect(forbiddenIn("// poi mergePr(pr) lo fa la persona")).toEqual([]);
    expect(forbiddenIn("/* recordDecision( */ const a = 1;")).toEqual([]);
    expect(forbiddenIn('const link = "#/p/ACQ/decisions?recordDecision(1)";')).toEqual([]);
    expect(forbiddenIn("const said = `Use publish(${x}) yourself`;")).toEqual([]);
    expect(forbiddenIn("const asks = /\\b(merge|publish|approve)\\b/i;")).toEqual([]);
    expect(forbiddenIn('const s = text.replace(/a/g, "").replaceAll("b", "");')).toEqual([]);
    // Un'espressione dentro un template resta codice.
    expect(forbiddenIn("const said = `${mergePr(pr)}`;")).toEqual(["mergePr"]);
  });

  it("CLAUDE_CATALOG non ha una voce per i gesti delle persone né per le scritture dei segreti", () => {
    const keys = new Set(Object.keys(CLAUDE_CATALOG));
    for (const name of [...NEVER, ...SECRET_WRITES, "chooseProject", "acknowledgeReminder"])
      expect(keys.has(name), name).toBe(false);
  });
});
