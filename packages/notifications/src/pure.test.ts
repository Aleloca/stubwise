/**
 * GUARDIA DI PUREZZA dell'entry `./pure`.
 *
 * `pure.ts` in sé sono quattro righe di re-export: il valore di questo file non
 * è verificare che quelle righe esistano, ma che l'entry resti *bundlabile da
 * un client* (React Native / Metro, e domani la SPA) nel tempo. Il giorno in
 * cui qualcuno aggiunge un `import { db } from "@stubwise/db"` a `format.ts`
 * — o a un modulo che `format.ts` importa — il bundle nativo si rompe, e senza
 * questo test lo si scopre solo al build dell'app mobile.
 *
 * PERCHÉ NON UN GREP SUI SORGENTI. Cercare la stringa `from "@stubwise/db"` in
 * `format.ts`/`actions.ts` vedrebbe solo gli import DIRETTI: un modulo pulito
 * che importa un modulo sporco passerebbe indenne. Qui invece si chiede a
 * esbuild di costruire il grafo VERO a partire dall'entry, esattamente come
 * farebbe il bundler dell'app, e si guarda l'insieme dei moduli "bare" (non
 * relativi) che restano ai bordi del grafo.
 *
 * Due dettagli che rendono il grafo quello giusto e non un'approssimazione:
 *  - l'entry è il SORGENTE `src/pure.ts`, non `dist/pure.js`: così il test dice
 *    la verità sul codice appena scritto anche se nessuno ha ancora ribuildato;
 *  - i workspace `@stubwise/*` NON sono marcati external, quindi il grafo entra
 *    dentro di loro (oggi `@stubwise/i18n`); tutto il resto è una foglia che
 *    registriamo e basta, perché non ci serve bundlare zod per sapere che si
 *    chiama zod. ⚠️ I workspace si risolvono via exports map, cioè al loro
 *    `dist/`: un import DB aggiunto ai sorgenti di `@stubwise/i18n` è visto solo
 *    dopo un `pnpm -r build` (in CI il build precede sempre i test).
 *
 * Nota sugli import di soli tipi: esbuild li elimina come farebbe `tsc`, quindi
 * non inquinano il risultato. È il motivo per cui `@stubwise/shared` non compare
 * pur essendo importato (come tipo) da `@stubwise/i18n`.
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { actionsFor, formatNotificationText, KINDS_WITH_OPTIONS, SNOOZE_OPTIONS } from "./pure.js";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * L'unica dipendenza "bare" che l'entry pure può avere. È un ALLOWLIST e non un
 * denylist di proposito: così anche una dipendenza nuova e innocua richiede una
 * decisione esplicita (ogni bare specifier qui è peso e rischio nel bundle di
 * un'app mobile), e i builtin Node finiscono fuori senza doverli enumerare.
 */
const ALLOWED_BARE = ["@stubwise/i18n"];

/** Ciò che non deve MAI entrare: il DB, il suo driver, l'I/O di Node. */
function isForbidden(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    ["@stubwise/db", "drizzle-orm", "postgres", "pg"].some(
      (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
    )
  );
}

/** Costruisce il grafo dall'entry e restituisce i bare specifier ai suoi bordi. */
async function bareDepsOf(entryFile: string): Promise<string[]> {
  const bare = new Set<string>();
  await esbuild.build({
    entryPoints: [`${srcDir}${entryFile}`],
    bundle: true,
    write: false,
    format: "esm",
    // "neutral": nessun ambiente dato per scontato, come in un bundle client.
    platform: "neutral",
    logLevel: "silent",
    plugins: [
      {
        name: "record-bare-imports",
        setup(build) {
          // Un bare specifier non inizia né con "." né con "/" (gli assoluti
          // che esbuild passa risolvendo i file interni).
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            bare.add(args.path);
            // Nei workspace entriamo SEMPRE, `@stubwise/db` compreso: la
            // purezza è transitiva o non è, e fermarsi al primo pacchetto
            // sporco nasconderebbe proprio ciò che si trascina dietro.
            if (args.path.startsWith("@stubwise/")) return undefined;
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  return [...bare].sort();
}

describe("entry pure", () => {
  it("non trascina il DB nel grafo delle dipendenze", async () => {
    const forbidden = (await bareDepsOf("pure.ts")).filter(isForbidden);
    expect(forbidden).toEqual([]);
  });

  it("ha esattamente la superficie di dipendenze bare dichiarata", async () => {
    expect(await bareDepsOf("pure.ts")).toEqual(ALLOWED_BARE);
  });

  /**
   * CONTROLLO NEGATIVO: se domani `bareDepsOf` smettesse di vedere le
   * dipendenze (un'opzione esbuild cambiata, il plugin che marca tutto
   * external), i due test qui sopra passerebbero sempre e in silenzio. Questo
   * ancora la guardia a un modulo che il DB ce l'ha DAVVERO. `dispatch.ts`
   * importa `@stubwise/db` direttamente, mentre il driver `postgres` lo vede
   * SOLO attraverso di esso: se il rilevatore trova anche quello, sta davvero
   * seguendo il grafo e non leggendo la prima riga di import.
   */
  it("il rilevatore vede il DB dove c'è, anche in transitivo (dispatch.ts)", async () => {
    const deps = await bareDepsOf("dispatch.ts");
    expect(deps).toContain("@stubwise/db");
    expect(deps).toContain("postgres");
    expect(deps.some((dep) => dep.startsWith("node:"))).toBe(true);
  });

  it("ri-esporta la logica di formattazione e il catalogo delle azioni", () => {
    expect(
      formatNotificationText({
        kind: "job.failed",
        ticketNumber: 1,
        ticketTitle: "T",
        projectName: "P",
        error: "boom",
        ticketUrl: "http://x",
      }),
    ).toContain("T");
    expect(typeof actionsFor).toBe("function");
    expect(SNOOZE_OPTIONS).toContain("1h");
    expect(KINDS_WITH_OPTIONS.size).toBeGreaterThan(0);
  });
});
