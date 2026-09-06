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
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * L'unica dipendenza "bare" che l'entry pure può avere. È un ALLOWLIST e non un
 * denylist di proposito: così anche una dipendenza nuova e innocua richiede una
 * decisione esplicita (ogni bare specifier qui è peso e rischio nel bundle di
 * un'app mobile), e i builtin Node finiscono fuori senza doverli enumerare.
 */
const ALLOWED_BARE = ["@stubwise/i18n"];

/**
 * Valori puri tenuti FUORI da `./pure` di proposito (YAGNI): li si aggiunge
 * quando un client ne ha bisogno davvero, non "per completezza". `openUrl` e
 * `IN_FLIGHT_JOB_STATUSES` li usa oggi solo il server/worker via l'entry `.`;
 * `escapeSlackMrkdwn` è specifico di Slack e in un client non ha senso.
 * Questa lista è la decisione, scritta dove si può rivedere.
 */
const NOT_IN_PURE = ["IN_FLIGHT_JOB_STATUSES", "openUrl", "escapeSlackMrkdwn"];

/**
 * Ciò che non deve MAI entrare: il DB, il suo driver, i builtin di Node.
 * `isBuiltin` e non `startsWith("node:")` perché la forma senza prefisso
 * (`import ... from "fs"`) è altrettanto valida e altrettanto letale in un
 * bundle client: senza, sfuggirebbe al messaggio mirato e la fermerebbe solo
 * l'allowlist, che dice molto meno su cosa è andato storto.
 */
function isForbidden(specifier: string): boolean {
  return (
    isBuiltin(specifier) ||
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
    //
    // LIMITI NOTI del walker, per chi ci mette mano domani. (a) Non segue
    // `import.meta.resolve` né `new URL(..., import.meta.url)` — ma non sono
    // nemmeno bundlabili: Hermes non ha `import.meta`, quindi ciò che sfugge
    // qui si romperebbe comunque, e rumorosamente. (b) Risolve con la
    // condizione `default`: un workspace che un giorno dichiarasse una
    // condizione `react-native`/`browser` verso un file DIVERSO farebbe vedere
    // a questo test un grafo che non è quello dell'app. Oggi nessuno dei nostri
    // package lo fa.
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
    expect(
      forbidden,
      "Queste dipendenze sono arrivate a ./pure (magari in transitivo, da un modulo che format.ts o actions.ts importa). Un client non può bundlarle: il DB e i builtin di Node non entrano in un bundle React Native. Sposta il codice che le usa fuori dal grafo di pure.ts.",
    ).toEqual([]);
  });

  it("ha esattamente la superficie di dipendenze bare dichiarata (ALLOWED_BARE)", async () => {
    expect(
      await bareDepsOf("pure.ts"),
      "La superficie di dipendenze di ./pure è cambiata. Se la nuova è innocua e la vuoi davvero nel bundle mobile, aggiungila ad ALLOWED_BARE scrivendo NEL COMMENTO perché ce la porti: ogni bare specifier qui è peso che finisce sul telefono.",
    ).toEqual(ALLOWED_BARE);
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

  /**
   * ESAUSTIVITÀ della superficie. Il grafo qui sopra difende `./pure` da ciò
   * che vi entra di troppo; questo lo difende da ciò che NON vi entra. Senza,
   * chi aggiunge una funzione pura ad `actions.ts` non ha nulla che gli ricordi
   * di riesportarla, e la dimenticanza la scopre il primo consumatore mobile
   * che non la trova. Qui diventa un rosso col NOME della funzione.
   *
   * `NOT_IN_PURE` è l'altra metà del valore: rende la scelta YAGNI esplicita e
   * rivedibile invece di lasciarla implicita in ciò che capita di riesportare.
   */
  it("ogni valore puro è in ./pure o escluso di proposito", async () => {
    const [actions, format, pure] = await Promise.all([
      import("./actions.js"),
      import("./format.js"),
      import("./pure.js"),
    ]);
    const missing = [...new Set([...Object.keys(actions), ...Object.keys(format)])].filter(
      (name) => !(name in pure) && !NOT_IN_PURE.includes(name),
    );
    expect(
      missing,
      "Questi valori puri di format.ts/actions.ts non sono raggiungibili da ./pure. Riesportali in pure.ts, oppure — se un client non deve averli — aggiungili a NOT_IN_PURE spiegando perché.",
    ).toEqual([]);
  });
});
