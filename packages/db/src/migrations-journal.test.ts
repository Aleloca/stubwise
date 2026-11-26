import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Il journal delle migrazioni (`drizzle/meta/_journal.json`), lotto 6, voce 3.
 * Il migratore di drizzle-orm legge di ogni voce solo `tag`, `breakpoints` e
 * `when` (applica quelle con `when` > `created_at` dell'ultima applicata): `idx`
 * non lo legge. Lo legge `drizzle-kit generate`, che numera la prossima
 * migrazione `idx + 1` dell'ULTIMA voce e ne fa il prefisso del file. Per
 * questo `idx` deve restare UGUALE AL NUMERO DEL TAG (anche dove mancano dei
 * numeri: 0157 e 0171 non esistono), non alla posizione: «riallinearlo» alla
 * posizione farebbe generare a drizzle-kit un `0227_…` che esiste già.
 * Sulle istanze già migrate non cambia niente in nessun caso: il registro
 * `__drizzle_migrations` confronta `when`, non `idx`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const folder = join(here, "..", "drizzle");
const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
};

describe("il journal delle migrazioni", () => {
  it("`idx` è il numero del tag (la regola di drizzle-kit per la prossima), non la posizione", () => {
    const wrong = journal.entries.filter((e) => e.idx !== Number(e.tag.slice(0, 4))).map((e) => `${e.idx} ${e.tag}`);
    expect(wrong).toEqual([]);
  });

  it("`when` cresce strettamente (il migratore applica per `when`), e i tag sono unici e in ordine", () => {
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, i) => i === 0 || w > whens[i - 1]!)).toBe(true);
    const nums = journal.entries.map((e) => Number(e.tag.slice(0, 4)));
    expect(nums.every((n, i) => i === 0 || n > nums[i - 1]!)).toBe(true);
  });

  it("ogni voce ha il suo file, e ogni file .sql ha la sua voce", () => {
    expect(journal.entries.filter((e) => !existsSync(join(folder, `${e.tag}.sql`))).map((e) => e.tag)).toEqual([]);
    const tags = new Set(journal.entries.map((e) => e.tag));
    expect(readdirSync(folder).filter((f) => f.endsWith(".sql") && !tags.has(f.slice(0, -4)))).toEqual([]);
  });
});
