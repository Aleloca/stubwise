import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Gli eventi delle Automations nascono SOLO dai trigger AFTER della 0169
 * (`docs/invariants/automations.md`): una scrittura che li aggira è un inizio
 * perso, in silenzio. Nessun codice di app, worker, package o migrazione
 * imposta `session_replication_role` né fa `DISABLE TRIGGER`; l'unico posto
 * in cui compare è il passo di rollback scritto nel deploy-log, a mano.
 * Test sul sorgente (area 7, F1, decisione di 46 sul punto (c)).
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const BYPASS = /session_replication_role|disable\s+trigger/i;
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

function filesUnder(dir: string, exts: RegExp): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(filesUnder(full, exts));
    else if (exts.test(name)) out.push(full);
  }
  return out;
}

function scanned(): string[] {
  const code = /\.(ts|tsx|mts|js|mjs|cjs|sql)$/;
  const roots = [join(ROOT, "apps/server/src"), join(ROOT, "apps/worker/src"), join(ROOT, "packages/db/drizzle")];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      /* un package senza src */
    }
  }
  return roots.flatMap((r) => filesUnder(r, code)).filter((f) => f !== SELF);
}

const bypassesIn = (files: readonly string[]): string[] =>
  files.filter((f) => BYPASS.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));

describe("nessuna scrittura aggira i trigger degli eventi delle Automations", () => {
  it("guarda davvero: i file letti comprendono la 0169 e l'esecutore", () => {
    const files = scanned().map((f) => relative(ROOT, f));
    expect(files).toContain("packages/db/drizzle/0169_automations.sql");
    expect(files).toContain("apps/worker/src/automations/executor.ts");
  });

  it("niente `session_replication_role` né `DISABLE TRIGGER` in app, worker, package e migrazioni", () => {
    expect(bypassesIn(scanned())).toEqual([]);
  });

  it("la regola riconosce le forme da cercare (anche su più righe e in minuscolo)", () => {
    for (const text of ["SET session_replication_role = replica", "alter table tickets\n  disable   trigger x", "ALTER TABLE t DISABLE TRIGGER ALL"]) expect(BYPASS.test(text)).toBe(true);
    expect(BYPASS.test("alter table t enable trigger x")).toBe(false);
  });
});

/**
 * Gli SCRITTORI DI MASSA noti (review F1, I1): ognuno apre la sua transazione
 * con la GUC che spegne la pubblicazione, o ogni task toccata diventerebbe un
 * evento. Chi aggiunge un'operazione di massa su task, richieste o traguardi
 * la aggiunge qui (oltre a metterci la GUC).
 */
const MASS_WRITERS = [
  // Togliere uno stato e traslocarne le task; cambiare la famiglia di uno stato.
  "apps/server/src/routes/project-statuses.ts",
];

describe("gli scrittori di massa spengono la pubblicazione degli eventi", () => {
  it.each(MASS_WRITERS)("%s apre con `set_config('stubwise.automation_events', 'off', true)`", (file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).toMatch(/set_config\('stubwise\.automation_events', 'off', true\)/);
  });
});

