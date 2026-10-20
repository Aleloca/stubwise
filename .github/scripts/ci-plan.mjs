#!/usr/bin/env node
/**
 * CI, job «plan»: decide UNA volta quali gruppi di test girano, e su quali
 * pacchetti. Gli altri job lo leggono come matrice.
 *
 *   EVENT=pull_request BASE_SHA=<sha> node .github/scripts/ci-plan.mjs
 *
 * Senza `GITHUB_OUTPUT` stampa il risultato (prova in locale).
 *
 * Le due reti di sicurezza (24 set 2026), da NON togliere:
 *   1. un file cambiato FUORI da `apps/`, `packages/` e `plugins/` (lockfile,
 *      config di radice, la CI stessa) può toccare tutti senza appartenere a
 *      nessuno: lì si testa tutto. Esclusi la documentazione (`docs/`, `*.md`)
 *      e il grafo generato (`graphify-out/`), che non cambiano nessun test;
 *   2. fuori dalle PR (il push su main dopo il merge) si testa SEMPRE tutto:
 *      il filtro guarda le dipendenze DICHIARATE, e un pacchetto che ne usa
 *      un altro senza dichiararlo sfuggirebbe sulla PR.
 *
 * Sulla PR, altrimenti, i pacchetti toccati e chi ne dipende (transitivo):
 * è la stessa regola del filtro `...[base]` di pnpm, rifatta qui perché pnpm
 * senza `node_modules` non elenca nulla, e installare solo per sapere cosa
 * testare costerebbe un minuto a ogni PR. Regge perché TUTTE le dipendenze
 * interne usano il protocollo `workspace:` — che è l'unico che pnpm 10 lega
 * al workspace —; una dipendenza interna scritta con una semver nuda va
 * contata come esterna da entrambi.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Gruppi con una macchina a sé; tutto il resto con test va in «resto». */
const OWN_GROUPS = ["server", "worker", "web", "mobile"];
const OUTSIDE_PACKAGES = /^(apps|packages|plugins)\//;
const IGNORED_OUTSIDE = /^(docs|graphify-out)\/|\.md$/;

function workspacePackages() {
  // pnpm-workspace.yaml elenca solo glob `dir/*`: basta leggerli.
  const yaml = readFileSync("pnpm-workspace.yaml", "utf8");
  const roots = [...yaml.matchAll(/^\s*-\s*["']?([^"'\s*]+)\/\*["']?\s*$/gm)].map((m) => m[1]);
  const pkgs = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = join(root, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, "utf8"));
      const deps = {
        ...json.dependencies,
        ...json.devDependencies,
        ...json.optionalDependencies,
        ...json.peerDependencies,
      };
      pkgs.push({
        name: json.name,
        dir: `${root}/${entry.name}/`,
        hasTest: Boolean(json.scripts?.test),
        internalDeps: Object.entries(deps)
          .filter(([, spec]) => String(spec).startsWith("workspace:"))
          .map(([dep]) => dep),
      });
    }
  }
  return pkgs;
}

/** I pacchetti toccati dai file cambiati, più chi ne dipende (transitivo). */
function affected(pkgs, changedFiles) {
  const selected = new Set(
    pkgs.filter((p) => changedFiles.some((f) => f.startsWith(p.dir))).map((p) => p.name),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pkgs) {
      if (!selected.has(p.name) && p.internalDeps.some((d) => selected.has(d))) {
        selected.add(p.name);
        grew = true;
      }
    }
  }
  return selected;
}

function plan() {
  const pkgs = workspacePackages();
  const event = process.env.EVENT ?? "";
  let selected;
  let reason;
  if (event !== "pull_request") {
    reason = `Evento «${event}» (non una PR): tutti i test.`;
  } else {
    const base = process.env.BASE_SHA;
    if (!base) throw new Error("BASE_SHA mancante su una pull_request");
    const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    console.log(`File cambiati rispetto alla base:\n${changed.join("\n")}`);
    const outside = changed.filter((f) => !OUTSIDE_PACKAGES.test(f) && !IGNORED_OUTSIDE.test(f));
    if (outside.length > 0) {
      reason = `Cambiati file fuori dai pacchetti: tutti i test.\n${outside.join("\n")}`;
    } else {
      selected = affected(pkgs, changed);
      reason = "Solo i pacchetti toccati e chi ne dipende.";
    }
  }

  const testable = pkgs.filter((p) => p.hasTest && (!selected || selected.has(p.name)));
  const include = [];
  for (const group of OWN_GROUPS) {
    const name = `@stubwise/${group}`;
    if (testable.some((p) => p.name === name)) {
      // Le app si testano sui sorgenti: servono solo le dist delle dipendenze.
      include.push({ group, packages: name, build: "deps" });
    }
  }
  const rest = testable
    .map((p) => p.name)
    .filter((n) => !OWN_GROUPS.includes(n.replace("@stubwise/", "")))
    .sort();
  if (rest.length > 0) {
    // Il pacchetto stesso compreso: alcuni test leggono la PROPRIA dist
    // (es. `load-isolated.test.ts` di @stubwise/shared).
    include.push({ group: "resto", packages: rest.join(" "), build: "self" });
  }
  return { reason, include };
}

const { reason, include } = plan();
console.log(reason);
console.log(`Gruppi: ${include.map((g) => `${g.group} (${g.packages})`).join(", ") || "nessuno"}`);
const outputs = `matrix=${JSON.stringify({ include })}\nany=${include.length > 0}\n`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, outputs);
} else {
  process.stdout.write(outputs);
}
