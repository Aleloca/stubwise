import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Comando di test risolto: eseguibile + argomenti, già pronti per lo spawn. */
export interface TestCommand {
  cmd: string;
  args: string[];
}

/**
 * Risolve QUALE comando di test lanciare nel worktree, per il loop di
 * self-repair (Task 5). Due strade, in ordine di precedenza:
 *
 * 1. OVERRIDE — se `project.testCommand` è valorizzato (non null, non vuoto
 *    dopo trim), vince sempre, anche se nel worktree non c'è un package.json.
 *    Parsing volutamente SEMPLICE: split sugli spazi (uno o più), primo token
 *    = `cmd`, resto = `args`. NIENTE shell-quoting, niente pipe/redirect,
 *    niente variabili: "pnpm run test:ci" → { cmd:"pnpm", args:["run","test:ci"] }.
 *    Un comando che richiede una shell (`a && b`, `FOO=1 cmd`, quoting) qui non
 *    è supportato — il primo token verrebbe trattato come eseguibile letterale.
 *
 * 2. AUTO-DETECT — niente override: si guarda `<worktreeDir>/package.json`.
 *    Se esiste, è JSON valido e ha `scripts.test` (stringa non vuota), si sceglie
 *    il package manager dai lockfile PRESENTI nel worktree:
 *      - pnpm-lock.yaml → pnpm test
 *      - yarn.lock      → yarn test
 *      - altrimenti (solo package-lock.json, o nessun lockfile) → npm test
 *    pnpm ha precedenza su yarn se per qualche motivo entrambi i lockfile sono
 *    presenti.
 *
 * Ritorna `null` quando non si risolve nulla: nessun override e
 * (no package.json | package.json malformato | senza `scripts.test`).
 */
export async function resolveTestCommand(
  project: { testCommand: string | null },
  worktreeDir: string,
): Promise<TestCommand | null> {
  // 1. Override esplicito: vince sempre, indipendente dal worktree.
  const override = project.testCommand?.trim();
  if (override) {
    const [cmd, ...args] = override.split(/\s+/);
    // `cmd` è sempre definito qui: override non vuoto ⇒ almeno un token.
    return { cmd: cmd as string, args };
  }

  // 2. Auto-detect dallo script `test` del package.json.
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(join(worktreeDir, "package.json"), "utf8");
  } catch {
    // package.json assente (o illeggibile): niente da auto-rilevare.
    return null;
  }

  let testScript: unknown;
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: { test?: unknown } };
    testScript = pkg?.scripts?.test;
  } catch {
    // package.json malformato: trattato come "nessuno script test".
    return null;
  }
  if (typeof testScript !== "string" || testScript.trim() === "") {
    return null;
  }

  // Package manager dai lockfile presenti (pnpm > yarn > npm di default).
  if (await fileExists(join(worktreeDir, "pnpm-lock.yaml"))) {
    return { cmd: "pnpm", args: ["test"] };
  }
  if (await fileExists(join(worktreeDir, "yarn.lock"))) {
    return { cmd: "yarn", args: ["test"] };
  }
  return { cmd: "npm", args: ["test"] };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
