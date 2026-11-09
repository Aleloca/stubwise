import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Le pagine dello spazio Prodotto non ricalcolano le regole del livello dati
// (Global Constraints dell'area 11a, ruling P25): permessi, `deleteBlocked` e
// visibilità arrivano dalla vista. Niente `can(`, `viewerFor(` né
// `useViewer(` in `pages/productDocs/`; il rimontaggio al cambio di persona
// sta in `router.tsx`, con la `key`.

const ROOT = __dirname;
const FORBIDDEN = ["can(", "viewerFor(", "useViewer("] as const;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("pages/productDocs non ricalcola le regole del livello dati", () => {
  const files = sources(ROOT);

  it("ci sono file da controllare", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const word of FORBIDDEN) {
    it(`nessun «${word}»`, () => {
      // `\b` davanti: `useCan(` o `scan(` non sono `can(`.
      const pattern = new RegExp(`\\b${word.replace("(", "\\(")}`);
      const offenders = files.filter((f) => pattern.test(readFileSync(f, "utf8")));
      expect(offenders).toEqual([]);
    });
  }
});
