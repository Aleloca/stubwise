import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// La pagina A SÉ della cassaforte (revisione della fase 2, I-2): nel suo
// documento non entra codice dell'app (chat, posta, riquadro di Claude, il
// livello dati, il router, l'intelaiatura). Gli import ammessi sono un elenco
// chiuso; il bundle lo controlla poi `check-vault-target.mjs … vault`.

const DIR = join(process.cwd(), "src/renderer/vaultPage");
const ALLOWED = [
  /^react$/,
  /^react-dom\/client$/,
  /^react-i18next$/,
  /^i18next$/,
  /^@stubwise\/shared$/,
  /^\.\/[\w.]+$/,
  /^\.\.\/data\/backend\/real\/vaultBrowser\/(boot|client|setup|unlock|webauthn)$/,
  /^\.\.\/csp-init$/,
  /^\.\.\/i18n\/locales\/(en|it)\.json$/,
  /^\.\.\/i18n\/storageKey$/,
  /^\.\.\/styles\/index\.css$/,
];

/**
 * Gli specificatori di un sorgente: `import … from`, `import "…"`, ma anche
 * `export … from` e `import("…")` (m-3, seconda revisione: una
 * ri-esportazione o un import dinamico tirerebbero dentro lo stesso codice).
 */
export function specifiersOf(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of code.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.push(m[1]!);
  // Un `import(` con un'espressione non si può controllare: vale come vietato.
  for (const m of code.matchAll(/\bimport\s*\(\s*(?!["'`])([^)]*)\)/g)) out.push(`<dinamico: ${m[1]!.trim()}>`);
  return out;
}

const sources = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));

describe("la pagina a sé importa solo ciò che le serve", () => {
  it.each(sources)("%s", (file) => {
    const code = readFileSync(join(DIR, file), "utf8");
    expect(specifiersOf(code).filter((s) => !ALLOWED.some((re) => re.test(s)))).toEqual([]);
  });

  it("m-3: l'estrattore vede anche le ri-esportazioni e gli import dinamici", () => {
    const code = [
      'import { a } from "./ui";',
      'export { b } from "../data/queries";',
      'export * from "../router";',
      'const c = await import("../layout/AppLayout");',
      "const d = await import(name);",
    ].join("\n");
    expect(specifiersOf(code)).toEqual(["./ui", "../data/queries", "../router", "../layout/AppLayout", "<dinamico: name>"]);
  });

  it("le pagine ci sono tutte (il test non passa su una cartella vuota)", () => {
    expect(sources).toEqual(expect.arrayContaining(["App.tsx", "api.ts", "main.tsx", "SetupPage.tsx", "RecoverPage.tsx", "PairPage.tsx", "PasskeysPage.tsx"]));
  });
});
