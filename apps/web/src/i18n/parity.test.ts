import { describe, expect, it as test } from "vitest";
import en from "./locales/en.json";
import it from "./locales/it.json";

/**
 * Parità chiavi en/it: gli stessi namespace e le stesse chiavi in ogni
 * namespace, così una traduzione non resta orfana in una sola lingua (gemello
 * del test di parità di `@stubwise/i18n`).
 */
type Catalog = Record<string, Record<string, string>>;

const enCat = en as Catalog;
const itCat = it as Catalog;

describe("parità delle chiavi en/it", () => {
  test("stessi namespace top-level", () => {
    expect(Object.keys(itCat).sort()).toEqual(Object.keys(enCat).sort());
  });

  test("ogni namespace ha le stesse chiavi in en e it", () => {
    for (const ns of Object.keys(enCat)) {
      expect(Object.keys(itCat[ns] ?? {}).sort()).toEqual(Object.keys(enCat[ns]!).sort());
    }
  });
});
