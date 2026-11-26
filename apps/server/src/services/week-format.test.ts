import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fix della review della fetta 2: le date della settimana escono dal DB in
 * UN formato, `to_char(…, 'YYYY-MM-DD')`, mai con `::text` (che dipende dal
 * DateStyle della connessione). Controllo sul sorgente: un test di
 * comportamento non lo isolerebbe, perché con un DateStyle non ISO l'app non
 * legge già i timestamp (li parsa il driver).
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("formato delle date della settimana", () => {
  it("nessuna funzione della settimana esce con ::text", () => {
    const offenders = sources(SRC).filter((file) =>
      /stubwise_(effective_week|current_monday|slip_reference)\([^`]*?\)\s*::text/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
