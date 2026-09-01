import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Plugin BASE di Stubwise: bundlato nell'immagine del worker (non nel registro
 * dei plugin d'istanza), passato per primo a ogni run che usa `--plugin-dir` e
 * mai filtrato dalle abilitazioni per progetto.
 *
 * Porta due cose: l'hook SessionStart col "contratto della run" (worktree,
 * branch, commit e PR li fa la pipeline; le domande passano da `ask_user`; le
 * skill di terze parti che creano branch o dispatchano subagent qui non si
 * applicano) e la skill `stubwise-conventions`.
 */

/** Nome in `plugin.json`: è il namespace delle sue skill (`stubwise-base:...`). */
export const BASE_PLUGIN_NAME = "stubwise-base";

/** Directory di questo modulo: `dist/plugins` in produzione, `src/plugins` nei test. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Path della directory del plugin base, o `null` se non è accanto al modulo.
 *
 * Risolto RELATIVAMENTE a questo modulo, come `askUserServerPath`, non da una
 * cwd o da una env: `tsc` riproduce sotto `dist/` l'albero di `src/`, quindi
 * `<pkg>/dist/plugins/base.js` ha sempre `<pkg>/plugins/stubwise-base` due
 * livelli sopra. Nell'immagine del worker (`WORKDIR /app`, dist da `pnpm
 * deploy`, `COPY apps/worker/plugins /app/plugins`) diventa
 * `/app/plugins/stubwise-base`; in sviluppo e nei test, dove `src/plugins` sta
 * anch'esso due livelli sotto la radice del package, punta alla stessa dir del
 * repo. Il plugin è solo dati (JSON, sh, markdown): non ha bisogno di build.
 *
 * Il controllo di esistenza è sul MANIFEST, non sulla dir: un'immagine
 * buildata a metà (COPY dimenticata) deve degradare a `null` — i run partono
 * senza plugin base, con una riga di log — invece di far fallire il CLI con un
 * `--plugin-dir` che punta a una directory inesistente o incompleta.
 */
export function basePluginPath(): string | null {
  const dir = join(moduleDir, "..", "..", "plugins", BASE_PLUGIN_NAME);
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}
