import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Ogni schema si carica DA SOLO.
 *
 * Un import circolare fra gli schemi (in D6: `ticket.ts` → `pr-correction.ts`
 * → `project.ts`/`docs.ts` → `ticket.ts`) il typecheck non lo vede, ma al
 * caricamento ESM uno dei moduli del giro legge una costante di un altro
 * prima che sia inizializzata: `ReferenceError: Cannot access 'X' before
 * initialization`, e il package intero non si carica. Quale modulo esploda
 * dipende da quale si importa per PRIMO, quindi ognuno si importa come se
 * fosse l'unico punto d'ingresso.
 *
 * L'elenco viene dal filesystem, non da una lista scritta a mano: uno schema
 * nuovo è coperto senza toccare questo file.
 *
 * Due livelli, e non sono ridondanti:
 *  1. dentro vitest (`vi.resetModules()` + `import`): veloce e sui sorgenti, ma
 *     vitest trasforma i moduli e un binding non ancora inizializzato lì vale
 *     `undefined` invece di lanciare. Il ciclo si vede solo se il modulo lo
 *     DEREFERENZIA al caricamento (`x.nullable()` → `TypeError`); un valore
 *     passato così com'è (es. dentro una forma di `z.object`) passerebbe;
 *  2. in un processo `node` figlio sul `dist/`: è il caricatore ESM VERO, lo
 *     stesso di server e worker, e dà l'errore vero (`ReferenceError`).
 *     ⚠️ PREREQUISITO: il `dist/` ricostruito (`pnpm --filter
 *     "@stubwise/shared..." build`; in CI `pnpm -r build` gira prima dei
 *     test). Un `dist/` assente o più vecchio del sorgente fa fallire il test
 *     con un messaggio che lo dice, invece di provare il codice sbagliato.
 */
const schemasDir = fileURLToPath(new URL(".", import.meta.url));
const distSchemasDir = fileURLToPath(new URL("../../dist/schemas/", import.meta.url));
const files = readdirSync(schemasDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .sort();

describe("schemi: caricamento isolato", () => {
  it("l'elenco dal filesystem non è vuoto (altrimenti il test non proverebbe niente)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("ticket.ts");
    expect(files).toContain("pr-correction.ts");
  });

  it.each(files)("%s si carica da solo (vitest, sorgenti)", async (file) => {
    vi.resetModules();
    const load = import(`./${file.replace(/\.ts$/, ".js")}`) as Promise<Record<string, unknown>>;
    await expect(load).resolves.toBeTypeOf("object");
  });

  it.each(files)("%s si carica da solo (node, dist)", (file) => {
    const src = `${schemasDir}${file}`;
    const dist = `${distSchemasDir}${file.replace(/\.ts$/, ".js")}`;
    const rebuild = 'ricostruisci con `pnpm --filter "@stubwise/shared..." build`';
    expect(existsSync(dist), `${dist} assente: ${rebuild}`).toBe(true);
    expect(
      statSync(dist).mtimeMs >= statSync(src).mtimeMs,
      `${dist} più vecchio di ${src} (dist stantio): ${rebuild}`,
    ).toBe(true);

    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(dist).href)});`],
      { encoding: "utf8" },
    );

    // Lo stderr nel messaggio: dice QUALE binding era ancora da inizializzare.
    expect(run.status, run.stderr).toBe(0);
  });
});
