#!/usr/bin/env node
/**
 * Gli import CON NOME da pacchetti esterni, verificati con l'ESM VERO di
 * node sul JS compilato (`dist/`), senza eseguire i nostri moduli.
 *
 * Perché esiste (15 nov 2026): `import { utils } from "ssh2"` passava
 * typecheck e test (vitest interopera coi CommonJS in modo più largo), ma
 * `node dist/...` falliva al link con «Named export 'utils' not found»: il
 * server non partiva. Un pacchetto CommonJS espone come nomi solo quelli
 * che `cjs-module-lexer` riconosce, e lo si sa solo quando lo carica node.
 *
 *   node scripts/check-esm-named-imports.mjs [<dir dist> ...]
 *
 * Senza dir: tutti i pacchetti node del monorepo (`defaultDirs`). Gira dopo
 * il build: `pnpm build` della radice e il passo dedicato della CI.
 *
 * Per ogni dir: i pacchetti si caricano da un modulo temporaneo scritto
 * nella dir PADRE (la radice del package), così si risolvono dalle stesse
 * `node_modules` del suo `dist/` e con le condizioni di `import`. Si
 * caricano solo i pacchetti esterni, mai i nostri file. I `*.test.js`
 * compilati si saltano (li carica vitest, non node).
 *
 * Exit 0 tutto risolto, 1 un nome mancante (elencati su stderr), 2 uso.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Gli import con nome di un sorgente ESM compilato: `[{ spec, names }]`. */
export function namedImports(source) {
  const out = [];
  const re = /(?:^|[;\n])\s*import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    const names = m[1]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0].trim());
    if (names.length > 0) out.push({ spec: m[2], names });
  }
  return out;
}

/** Un pacchetto ESTERNO (non relativo, non assoluto, non `node:`). */
export const isExternal = (spec) => !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:");

function* jsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (path.endsWith(".js") && !path.endsWith(".test.js")) yield path;
  }
}

/** Gli export con nome di ogni pacchetto, caricati con node vero da `root`. */
function exportsFrom(root, specs) {
  const probe = join(root, `.check-esm-${randomUUID()}.mjs`);
  writeFileSync(
    probe,
    `const out = {};\nfor (const spec of ${JSON.stringify(specs)}) {\n  try { out[spec] = Object.keys(await import(spec)); }\n  catch (e) { out[spec] = { error: String(e && e.message || e).split("\\n")[0] }; }\n}\nprocess.stdout.write(JSON.stringify(out));\n`,
  );
  try {
    return JSON.parse(execFileSync(process.execPath, [probe], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } finally {
    rmSync(probe, { force: true });
  }
}

export function check(dirs) {
  const problems = [];
  for (const dir of dirs) {
    const abs = resolve(dir);
    const uses = [];
    for (const file of jsFiles(abs)) {
      for (const imp of namedImports(readFileSync(file, "utf8"))) if (isExternal(imp.spec)) uses.push({ file, ...imp });
    }
    const specs = [...new Set(uses.map((u) => u.spec))];
    if (specs.length === 0) continue;
    const exported = exportsFrom(dirname(abs), specs);
    for (const { file, spec, names } of uses) {
      const e = exported[spec];
      if (!Array.isArray(e)) {
        problems.push(`${file}: "${spec}" non si carica (${e?.error ?? "?"})`);
        continue;
      }
      for (const name of names) if (!e.includes(name)) problems.push(`${file}: { ${name} } da "${spec}" non è un export con nome in ESM vero`);
    }
  }
  return problems;
}

/**
 * Senza argomenti: i `dist/` dei pacchetti che girano sotto node (server,
 * worker, push-relay e i `packages/*`). Le SPA (web, desktop, docs, mobile)
 * no: le impacchetta un bundler, e i loro `dist/` non li carica node.
 */
export function defaultDirs(root) {
  const candidates = ["apps/server", "apps/worker", "apps/push-relay", ...readdirSync(join(root, "packages")).map((p) => `packages/${p}`)];
  return candidates.map((c) => join(root, c, "dist")).filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : defaultDirs(resolve(dirname(new URL(import.meta.url).pathname), ".."));
  if (dirs.length === 0) {
    console.error("check-esm-named-imports: nessun dist/ (manca il build?)");
    process.exit(2);
  }
  const problems = check(dirs);
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.error(`check-esm-named-imports: ok (${dirs.length} dist/)`);
}
