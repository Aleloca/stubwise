import { join } from "node:path";
import { type TestCommand, fileExists } from "./test-command.js";

/**
 * Risolve QUALE comando di install lanciare nel worktree, prima del loop di
 * self-repair: serve a popolare `node_modules` così che il comando di test possa
 * partire. Speculare a `resolveTestCommand`, ma più semplice — qui basta la
 * presenza del package.json, non si legge nessuno script. Due strade, in
 * ordine di precedenza:
 *
 * 1. OVERRIDE — se `project.installCommand` è valorizzato (non null, non vuoto
 *    dopo trim), vince sempre, anche se nel worktree non c'è un package.json.
 *    Parsing volutamente SEMPLICE: split sugli spazi (uno o più), primo token
 *    = `cmd`, resto = `args`. NIENTE shell-quoting/pipe/redirect/variabili:
 *    "pnpm install --frozen-lockfile" → { cmd:"pnpm", args:["install","--frozen-lockfile"] }.
 *
 * 2. AUTO-DETECT — niente override: se NON c'è `<worktreeDir>/package.json` non
 *    c'è nulla da installare e si ritorna `null` (a differenza del test, qui
 *    NON serve leggere `scripts`: la sola esistenza del package.json basta).
 *    Con package.json presente, si sceglie il package manager dal lockfile,
 *    con precedenza pnpm > yarn > npm:
 *      - pnpm-lock.yaml    → pnpm install --frozen-lockfile
 *      - yarn.lock         → yarn install --frozen-lockfile
 *      - package-lock.json → npm ci          (install riproducibile da lockfile)
 *      - nessun lockfile   → npm install     (niente lockfile da rispettare)
 *    `--frozen-lockfile` / `npm ci` falliscono se il lockfile è out-of-sync:
 *    install deterministico, coerente con quanto committato.
 *
 * Ritorna `null` solo quando non c'è override e manca il package.json.
 */
export async function resolveInstallCommand(
  project: { installCommand: string | null },
  worktreeDir: string,
): Promise<TestCommand | null> {
  // 1. Override esplicito: vince sempre, indipendente dal worktree.
  const override = project.installCommand?.trim();
  if (override) {
    const [cmd, ...args] = override.split(/\s+/);
    // `cmd` è sempre definito qui: override non vuoto ⇒ almeno un token.
    return { cmd: cmd as string, args };
  }

  // 2. Senza package.json non c'è nulla da installare.
  if (!(await fileExists(join(worktreeDir, "package.json")))) {
    return null;
  }

  // Package manager dal lockfile presente (pnpm > yarn > npm).
  if (await fileExists(join(worktreeDir, "pnpm-lock.yaml"))) {
    return { cmd: "pnpm", args: ["install", "--frozen-lockfile"] };
  }
  if (await fileExists(join(worktreeDir, "yarn.lock"))) {
    return { cmd: "yarn", args: ["install", "--frozen-lockfile"] };
  }
  if (await fileExists(join(worktreeDir, "package-lock.json"))) {
    return { cmd: "npm", args: ["ci"] };
  }
  return { cmd: "npm", args: ["install"] };
}
