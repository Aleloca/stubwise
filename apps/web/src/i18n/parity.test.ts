import { describe, expect, it as test } from "vitest";
import en from "./locales/en.json";
import it from "./locales/it.json";

/**
 * Parità chiavi en/it: gli stessi namespace e le stesse chiavi in ogni
 * namespace, così una traduzione non resta orfana in una sola lingua (gemello
 * del test di parità di `@stubwise/i18n`).
 */
// I valori di una chiave possono essere stringhe o sotto-oggetti annidati (es.
// `auth.login.title`): la parità si verifica sulle chiavi di ogni livello che
// il test attraversa, non sui tipi delle foglie.
type TranslationTree = { [key: string]: string | TranslationTree };
type Catalog = Record<string, TranslationTree>;

const enCat = en as Catalog;
const itCat = it as Catalog;

/** Appiattisce un albero in chiavi puntate (`login.title`), così la parità
 * vale anche per le chiavi annidate, non solo per quelle di primo livello. */
function flattenKeys(tree: TranslationTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flattenKeys(value, path);
  });
}

describe("parità delle chiavi en/it", () => {
  test("stessi namespace top-level", () => {
    expect(Object.keys(itCat).sort()).toEqual(Object.keys(enCat).sort());
  });

  test("ogni namespace ha le stesse chiavi (anche annidate) in en e it", () => {
    for (const ns of Object.keys(enCat)) {
      expect(flattenKeys(itCat[ns] ?? {}).sort()).toEqual(flattenKeys(enCat[ns]!).sort());
    }
  });
});
