#!/usr/bin/env node
/**
 * Release, passo «Cosa c'è da fare»: decide se il giro ha lavoro.
 *
 *   node .github/scripts/release-plan.mjs
 *
 * Senza `GITHUB_OUTPUT` stampa il risultato (prova in locale).
 *
 * Due domande, indipendenti:
 *   - `changesets`: quanti changeset pendenti (`.changeset/*.md` tranne il
 *     README). Se ce n'è almeno uno il giro versiona, pubblica e pusha il
 *     commit di versione.
 *   - `unpublished`: quali pacchetti pubblici hanno nel repository una
 *     versione che su npm non c'è. Senza changeset è l'unico motivo per
 *     lanciare `changeset publish`: un giro precedente che ha versionato ma
 *     non ha pubblicato tutto. `changeset publish` è idempotente (salta, con
 *     un avviso, ogni versione già sul registro), quindi lanciarlo per
 *     sbaglio non fa danni: questo controllo serve a non buildare e
 *     autenticarsi a ogni merge per niente.
 *
 * Un errore di `npm view` (rete, registro giù, pacchetto mai pubblicato)
 * conta come «non pubblicato»: decide poi `changeset publish`, che chiede di
 * nuovo al registro. Meglio un giro in più che una versione mai uscita.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const changesets = readdirSync(".changeset").filter(
  (f) => f.endsWith(".md") && f !== "README.md",
);

const publicPackages = [];
for (const root of ["apps", "packages", "plugins"]) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (!json.private) publicPackages.push(`${json.name}@${json.version}`);
  }
}

const unpublished = publicPackages.filter((spec) => {
  try {
    const out = execFileSync("npm", ["view", spec, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length === 0;
  } catch {
    return true;
  }
});

console.log(`Changeset pendenti: ${changesets.join(", ") || "nessuno"}`);
console.log(`Pacchetti pubblici: ${publicPackages.join(", ")}`);
console.log(`Non ancora su npm: ${unpublished.join(", ") || "nessuno"}`);

const outputs =
  `changesets=${changesets.length}\n` +
  `unpublished=${unpublished.join(" ")}\n` +
  `work=${changesets.length > 0 || unpublished.length > 0}\n`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, outputs);
} else {
  process.stdout.write(outputs);
}
