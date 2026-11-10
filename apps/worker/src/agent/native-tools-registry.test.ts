import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ogni run del worker DICHIARA i suoi tool nativi (`builtinTools`, vedi
 * `native-tools.ts`; 10 nov 2026, CLI 2.1.322). Il runner è già fail-closed
 * (senza elenco: `--tools ""`), ma un run che dimentica l'elenco fallirebbe
 * in silenzio nel modo opposto: un fix senza Write. Qui si legge il sorgente:
 * ogni chiamata `.run({ … })` (e `runProductAgent(deps, { … })`) deve nominare
 * `builtinTools`, o lo spread che lo porta (`graphAllowedTools(…)`), anche
 * negli scenari golden (`scripts/golden/`). Un file nuovo è coperto senza
 * toccare il test.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** I file che passano le opzioni di un altro (decoratori): non costruiscono un run. */
const WRAPPERS = new Set(["agent/tracking-runner.ts", "pipeline/cancel.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Il letterale oggetto che parte da `start` (la sua `{`), con le graffe bilanciate. */
function literalAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

describe("ogni run del worker dichiara i suoi tool nativi", () => {
  it("nessuna chiamata .run({ … }) senza builtinTools", () => {
    const missing: string[] = [];
    let seen = 0;
    // Anche gli scenari golden: costruiscono le opzioni a mano, e un elenco
    // dimenticato lì è un golden che prova un run diverso dalla produzione.
    for (const path of [...sources(SRC), ...sources(join(SRC, "..", "scripts", "golden"))]) {
      const file = relative(SRC, path);
      if (WRAPPERS.has(file)) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/(?:\.run|runProductAgent)\((?:deps, )?\{/g)) {
        // Un commento che cita la forma non è un run.
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        if (/^\s*(\*|\/\/)/.test(text.slice(lineStart, match.index))) continue;
        seen++;
        const literal = literalAt(text, match.index + match[0].length - 1);
        // Un passa-opzioni (`{ ...opts, provider }`) porta l'elenco di chi l'ha costruito.
        if (/^\{\s*\.\.\.opts\b/.test(literal)) continue;
        if (!/builtinTools|graphAllowedTools\(/.test(literal)) {
          missing.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    // Il test guarda davvero i run: ce ne sono decine.
    expect(seen).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
