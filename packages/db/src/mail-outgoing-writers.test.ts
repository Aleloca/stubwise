import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * L'ELENCO CHIUSO DI CHI SCRIVE `mail_outgoing` (area 7, F2, S9; C-F2-3).
 * Una riga di `mail_outgoing` è un'email che PARTE: nasce dall'Invia di una
 * persona (con la sua bozza) O da un passo di un'automazione accesa da lei,
 * dalla sua casella (senza bozza, con `automation_run_id`). Nessun altro
 * percorso automatico ne scrive. Chi aggiunge un file a questo elenco sta
 * aggiungendo un modo nuovo di mandare posta: è una decisione, non un dettaglio
 * (`docs/invariants/automations.md`, l'eccezione al mittente).
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "build", "coverage"]);

function sources(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(sources(full));
    else if (/\.(ts|tsx|mts|js|mjs|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function scanned(): string[] {
  const roots = [join(ROOT, "apps/server/src"), join(ROOT, "apps/worker/src")];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      /* un package senza src */
    }
  }
  return roots.flatMap(sources).map((f) => relative(ROOT, f));
}

const matching = (re: RegExp) => scanned().filter((f) => re.test(readFileSync(join(ROOT, f), "utf8"))).sort();

describe("chi scrive mail_outgoing", () => {
  it("NASCE una riga solo dall'Invia di una persona e dall'esecutore delle automazioni", () => {
    expect(matching(/insert\(mailOutgoing\)|insert\s+into\s+"?mail_outgoing"?/i)).toEqual([
      "apps/server/src/services/mail-send.ts", // Invia (la bozza della persona), area 6, F3
      "apps/worker/src/automations/effects.ts", // il passo «Manda email», area 7, F2
    ]);
  });

  it("ne cambiano lo stato solo il mittente, la Posta (Annulla, Riprova, Elimina) e l'«Annulla» di un'esecuzione", () => {
    expect(matching(/update\(mailOutgoing\)|delete\(mailOutgoing\)|update\s+"?mail_outgoing"?|delete\s+from\s+"?mail_outgoing"?/i)).toEqual([
      "apps/server/src/services/mail-send.ts",
      "apps/worker/src/automations/executor.ts",
      "apps/worker/src/google/mail-sender.ts",
    ]);
  });
});
