import { readFileSync } from "node:fs";
import path from "node:path";
import { designColors } from "@stubwise/shared";
import { describe, expect, it } from "vitest";

/**
 * Parità dei colori web/mobile (App M1, 11 set 2026): `apps/mobile` legge la
 * palette da `designColors` (`packages/shared/src/design-tokens.ts`) invece
 * di ricopiarla a mano — gemello di `i18n/parity.test.ts` per lo stesso
 * rischio: un valore che diverge in silenzio fra le due superfici. Il blocco
 * `@theme` di `styles.css` resta la fonte diretta per il sito; questo test
 * dice se il modulo condiviso — quindi l'app — è rimasto allineato.
 */
const stylesPath = path.join(import.meta.dirname, "styles.css");
const css = readFileSync(stylesPath, "utf-8");

/**
 * Isola il corpo del blocco `@theme { ... }` di primo livello, contando le
 * graffe (il blocco contiene un `@keyframes` annidato, che ha le sue). Fix di
 * review (App M1+M2, Task 4, 11 set 2026): prima la regex scansionava l'INTERO
 * file — un domani `--color-*` dentro un `@layer`/media query fuori da
 * `@theme` (non parte del tema esposto, quindi mai destinato a `designColors`)
 * avrebbe fatto fallire il test come un vero disallineamento.
 */
function extractThemeBlock(source: string): string {
  const start = source.indexOf("@theme");
  if (start === -1) throw new Error("Nessun blocco @theme trovato in styles.css");
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error("Blocco @theme non chiuso in styles.css");
}

/** Estrae `{ chiave: valore }` da ogni riga `--color-<chiave>: <#hex>;` del blocco `@theme`. */
function extractThemeColors(source: string): Record<string, string> {
  const colors: Record<string, string> = {};
  const themeBlock = extractThemeBlock(source);
  for (const match of themeBlock.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8});/g)) {
    colors[match[1]!] = match[2]!.toLowerCase();
  }
  return colors;
}

describe("parità dei token di colore web/mobile", () => {
  it("styles.css e designColors hanno esattamente le stesse chiavi", () => {
    const cssColors = extractThemeColors(css);
    expect(Object.keys(cssColors).sort()).toEqual(Object.keys(designColors).sort());
  });

  it("ogni colore del tema web ha lo stesso valore nel modulo condiviso", () => {
    const cssColors = extractThemeColors(css);
    for (const [key, value] of Object.entries(cssColors)) {
      expect(designColors[key as keyof typeof designColors]).toBe(value);
    }
  });
});
