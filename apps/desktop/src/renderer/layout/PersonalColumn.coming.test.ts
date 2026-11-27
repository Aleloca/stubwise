import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../data/routes";
import en from "../i18n/locales/en.json";
import it_ from "../i18n/locales/it.json";

// La colonna di una destinazione senza colonna propria mostra
// `column.coming.<destinazione>` (`GenericColumn`). Una chiave che manca si
// legge in chiaro nella colonna, come è successo con «column.coming.vault»
// (27 nov 2026). Le destinazioni con una colonna propria si leggono dal
// sorgente di `PersonalColumn`, così una destinazione nuova è coperta senza
// toccare il test.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PersonalColumn.tsx"), "utf8");
const own = new Set([...source.matchAll(/destination === "([a-z]+)"\) return </g)].map((m) => m[1]!));
const generic = APP_ROUTES.filter((d) => !own.has(d));

type Coming = Record<string, string>;
const comingOf = (locale: unknown): Coming =>
  ((locale as { column: { coming: Coming } }).column.coming ?? {}) as Coming;

describe("column.coming: ogni destinazione col segnaposto ha la sua frase", () => {
  it("le destinazioni con una colonna propria si riconoscono dal sorgente", () => {
    expect(own.has("drive")).toBe(true);
    expect(generic.length).toBeGreaterThan(0);
  });

  it.each(generic)("%s ha la frase in en e in it", (destination) => {
    expect(comingOf(en)[destination], `en: column.coming.${destination}`).toBeTruthy();
    expect(comingOf(it_)[destination], `it: column.coming.${destination}`).toBeTruthy();
  });
});
