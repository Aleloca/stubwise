// Il controllo dei Dockerfile, senza Docker (CI): due regole che, rotte, hanno
// fermato il deploy tre volte (#140, #142, #154) senza che nessun test se ne
// accorgesse.
//
//  1. Ogni `COPY` dal contesto (senza `--from`) punta a un percorso che esiste
//     nel repo. Un pacchetto cancellato o rinominato lascia un `COPY` che fa
//     fallire il build (#154: `apps/web/package.json` dopo il ritiro del web).
//  2. Ogni pacchetto del workspace che uno stage COMPILA (`pnpm --filter …
//     build|deploy`, con le sue dipendenze del workspace se il filtro ha `...`)
//     ha il suo `package.json` copiato in quello stage: è il layer
//     dell'install, che senza il manifest non installa le sue dipendenze.
//
// Uso: node scripts/dockerfiles.mjs [repo]  (esce 1 con l'elenco dei problemi).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const DOCKERFILES = ["apps/server/Dockerfile", "apps/worker/Dockerfile", "Dockerfile.caddy", "Dockerfile.agent", "Dockerfile.push-relay", "Dockerfile.graphify"];

/** Le istruzioni di un Dockerfile, con le righe continuate (`\`) unite e i commenti tolti. */
export function instructions(text) {
  const out = [];
  let cur = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!cur && /^\s*#/.test(line)) continue;
    if (line.endsWith("\\")) {
      cur += line.slice(0, -1) + " ";
      continue;
    }
    cur += line;
    if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
    cur = "";
  }
  return out;
}

/** Gli stage, ognuno con le sue istruzioni (un `FROM` apre uno stage). */
export function stages(text) {
  const out = [];
  for (const ins of instructions(text)) {
    if (/^FROM\s/i.test(ins)) out.push({ from: ins, body: [] });
    else if (out.length > 0) out.at(-1).body.push(ins);
  }
  return out;
}

/** Le sorgenti di un `COPY`/`ADD` dal contesto; null se copia da uno stage (`--from`). */
export function copySources(ins) {
  const m = /^(COPY|ADD)\s+(.*)$/i.exec(ins);
  if (!m) return null;
  const words = m[2].split(/\s+/);
  if (words.some((w) => /^--from=/i.test(w))) return null;
  const args = words.filter((w) => !w.startsWith("--"));
  return args.slice(0, -1);
}

/** I pacchetti del workspace: nome → { dir, deps del workspace }. */
export function workspacePackages(repo) {
  const out = new Map();
  for (const top of ["apps", "packages", "plugins"]) {
    const base = join(repo, top);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pj = join(base, d.name, "package.json");
      if (!existsSync(pj)) continue;
      const json = JSON.parse(readFileSync(pj, "utf8"));
      if (!json.name) continue;
      const deps = new Set();
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, spec] of Object.entries(json[field] ?? {})) if (String(spec).startsWith("workspace:")) deps.add(name);
      }
      out.set(json.name, { dir: `${top}/${d.name}`, deps });
    }
  }
  return out;
}

/**
 * I pacchetti selezionati dai `--filter` di un `pnpm … build|deploy`: `x`, `x...`
 * (x e le sue dipendenze), `x^...` (le sole dipendenze), `!x` (escluso).
 */
export function selected(ins, pkgs) {
  if (!/\bpnpm\b/.test(ins)) return [];
  const out = new Set();
  // Un `RUN` può avere più comandi in fila (`&&`): si guarda ciascuno.
  for (const cmd of ins.replace(/^RUN\s+/i, "").split(/&&|;/)) {
    if (!/\bpnpm\b/.test(cmd) || !/\s(build|deploy)\b/.test(cmd)) continue;
    const filters = [...cmd.matchAll(/--filter\s+("([^"]+)"|'([^']+)'|(\S+))/g)].map((m) => m[2] ?? m[3] ?? m[4]);
    const picked = new Set();
    const excluded = new Set();
    for (const f of filters) {
      if (f.startsWith("!")) {
        excluded.add(f.slice(1));
        continue;
      }
      const deps = f.endsWith("...");
      const onlyDeps = f.endsWith("^...");
      const name = f.replace(/\^?\.\.\.$/, "");
      if (!pkgs.has(name)) continue;
      if (!onlyDeps) picked.add(name);
      if (deps) {
        const seen = new Set();
        const walk = (n) => {
          for (const d of pkgs.get(n)?.deps ?? []) {
            if (seen.has(d) || !pkgs.has(d)) continue;
            seen.add(d);
            picked.add(d);
            walk(d);
          }
        };
        walk(name);
      }
    }
    for (const n of picked) if (!excluded.has(n)) out.add(n);
  }
  return [...out];
}

/** I problemi dei Dockerfile del repo: un elenco vuoto è il verde. */
export function problems(repo) {
  const out = [];
  const pkgs = workspacePackages(repo);
  for (const file of DOCKERFILES) {
    const path = join(repo, file);
    if (!existsSync(path)) {
      out.push(`${file}: il Dockerfile non esiste (aggiorna l'elenco in scripts/dockerfiles.mjs)`);
      continue;
    }
    for (const stage of stages(readFileSync(path, "utf8"))) {
      // I manifest copiati PRIMA del primo `pnpm install` dello stage: il
      // layer dell'install. Un `COPY packages packages` dopo l'install porta i
      // sorgenti, ma le dipendenze di un manifest arrivato lì non si installano.
      const manifests = new Set();
      let installed = false;
      for (const ins of stage.body) {
        const srcs = copySources(ins);
        if (srcs) {
          for (const src of srcs) {
            if (!installed && src.endsWith("package.json")) manifests.add(src);
            if (!existsSync(join(repo, src))) out.push(`${file}: COPY ${src} — il percorso non esiste nel repo`);
          }
          continue;
        }
        if (!/^RUN\s/i.test(ins)) continue;
        if (/\bpnpm\s+install\b/.test(ins)) installed = true;
        for (const name of selected(ins, pkgs)) {
          const dir = pkgs.get(name).dir;
          if (!manifests.has(`${dir}/package.json`))
            out.push(`${file}: ${name} si compila (\`${ins.slice(0, 80)}\`) ma ${dir}/package.json non è copiato prima dell'install, in questo stage`);
        }
      }
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const repo = process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const found = problems(repo);
  if (found.length > 0) {
    console.error(`Dockerfile:\n- ${found.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Dockerfile: ${DOCKERFILES.length} file, ogni COPY esiste e ogni pacchetto compilato ha il suo manifest (${relative(process.cwd(), repo) || "."})`);
}
