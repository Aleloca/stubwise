import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { StubwiseApiError, StubwiseClient } from "./client.js";
import { userConfigPath } from "./config.js";
import { claudeConfigDir } from "./notices.js";

/** Dipendenze iniettate di `runSetup`: nei test nessun accesso a disco e rete. */
export interface SetupDeps {
  fetch: typeof fetch;
  /** `mode` vale solo alla creazione del file (come `fs.writeFile`). */
  writeFile: (path: string, data: string, options?: { mode: number }) => Promise<void>;
  /** Lancia (con `code: "ENOENT"`) se il file non esiste. */
  readFile: (path: string) => Promise<string>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  chmod: (path: string, mode: number) => Promise<void>;
  /** Per riscrivere `settings.json` sul file vero (anche dietro un link) e in modo atomico. */
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ mode: number }>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  log: (message: string) => void;
  /** Dove scrivere il file; default `userConfigPath(process.env)`. */
  configPath?: string;
  /** Le impostazioni utente di Claude Code; default `claudeSettingsPath(process.env)`. */
  claudeSettingsPath?: string;
}

/**
 * `settings.json` delle impostazioni utente di Claude Code: dentro
 * `CLAUDE_CONFIG_DIR` se impostata, altrimenti in `~/.claude`. È lì che
 * `claude plugin marketplace add` registra il marketplace.
 */
export function claudeSettingsPath(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): string {
  return join(claudeConfigDir(env, home), "settings.json");
}

/** Dipendenze reali, per `index.ts`. stdout è libero: `setup` è un comando da terminale. */
export function realSetupDeps(env: Record<string, string | undefined>): SetupDeps {
  return {
    fetch,
    writeFile: (p, d, o) => writeFile(p, d, o),
    readFile: (p) => readFile(p, "utf8"),
    mkdir: (p, o) => mkdir(p, o),
    chmod,
    realpath: (p) => realpath(p),
    stat: (p) => stat(p),
    rename,
    unlink,
    log: (m) => console.log(m),
    configPath: userConfigPath(env),
    claudeSettingsPath: claudeSettingsPath(env),
  };
}

interface SetupArgs {
  url?: string;
  token?: string;
  autoUpdate: boolean;
}

function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { autoUpdate: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [key, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    // `trim`: incollando il comando dal browser arrivano spesso spazi o a capo.
    if (key === "--url") out.url = (inline ?? argv[++i])?.trim();
    else if (key === "--token") out.token = (inline ?? argv[++i])?.trim();
    else if (key === "--no-auto-update") out.autoUpdate = false;
  }
  return out;
}

/** Il nome del marketplace, come lo registra `claude plugin marketplace add Aleloca/stubwise`. */
const MARKETPLACE = "stubwise";

const MANUAL_AUTO_UPDATE =
  "Per accenderli a mano, in Claude Code: /plugin → Marketplaces → stubwise → Enable auto-update.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Riscrive `path` senza mai lasciarlo troncato: scrive `<file vero>.tmp` coi
 * permessi del file, poi lo rinomina sopra. Il «file vero» è il `realpath`:
 * se `settings.json` è un link (dotfile gestiti da un repo), si aggiorna il
 * file a cui punta e il link resta un link. Se qualcosa va storto il
 * temporaneo si toglie e l'errore risale.
 */
async function replaceFile(
  path: string,
  data: string,
  deps: Pick<SetupDeps, "writeFile" | "chmod" | "realpath" | "stat" | "rename" | "unlink">,
): Promise<void> {
  const real = await deps.realpath(path);
  const mode = (await deps.stat(real)).mode & 0o777;
  const tmp = `${real}.tmp`;
  try {
    await deps.writeFile(tmp, data, { mode });
    // `mode` di writeFile passa dalla umask: lo si fissa esplicitamente.
    await deps.chmod(tmp, mode);
    await deps.rename(tmp, real);
  } catch (err) {
    await deps.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Accende l'aggiornamento automatico del marketplace `stubwise` nelle
 * impostazioni utente di Claude Code (`autoUpdate: true` sulla sua voce in
 * `extraKnownMarketplaces`): per un marketplace di terze parti è spento di
 * default, e né `marketplace.json` né `plugin.json` possono accenderlo.
 *
 * Tocca SOLO una voce che esiste già: la scrive `claude plugin marketplace
 * add`, che per questo nel comando d'installazione gira prima di `setup`. Una
 * voce mancante non si inventa — la forma della `source` scritta da `--sparse`
 * non è documentata — e un file illeggibile o non JSON non si riscrive. In
 * nessun caso è un errore: il plugin funziona lo stesso, si aggiorna a mano.
 */
export async function enableAutoUpdate(
  path: string,
  deps: Pick<
    SetupDeps,
    "readFile" | "writeFile" | "chmod" | "realpath" | "stat" | "rename" | "unlink" | "log"
  >,
): Promise<void> {
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    deps.log(
      missing
        ? `Aggiornamenti automatici non accesi: non trovo ${path}, il marketplace «${MARKETPLACE}» non risulta aggiunto. ${MANUAL_AUTO_UPDATE}`
        : `Aggiornamenti automatici non accesi: non riesco a leggere ${path}. ${MANUAL_AUTO_UPDATE}`,
    );
    return;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    deps.log(
      `Aggiornamenti automatici non accesi: ${path} non è un JSON valido, non lo tocco. ${MANUAL_AUTO_UPDATE}`,
    );
    return;
  }

  const marketplaces = isRecord(settings) ? settings.extraKnownMarketplaces : undefined;
  const entry = isRecord(marketplaces) ? marketplaces[MARKETPLACE] : undefined;
  if (!isRecord(entry)) {
    deps.log(
      `Aggiornamenti automatici non accesi: il marketplace «${MARKETPLACE}» non risulta in ${path}. ${MANUAL_AUTO_UPDATE}`,
    );
    return;
  }

  if (entry.autoUpdate !== true) {
    entry.autoUpdate = true;
    try {
      await replaceFile(path, `${JSON.stringify(settings, null, 2)}\n`, deps);
    } catch (err) {
      deps.log(
        `Aggiornamenti automatici non accesi: non riesco a scrivere ${path} (${(err as Error).message}). ${MANUAL_AUTO_UPDATE}`,
      );
      return;
    }
  }
  deps.log(
    "Aggiornamenti automatici del plugin accesi: Claude Code scaricherà da solo le nuove versioni di Stubwise.",
  );
}

/**
 * `npx -y @stubwise/mcp setup --url <url> --token <token> [--no-auto-update]`:
 * verifica il token con `GET /api/auth/me`, scrive il file personale con
 * permessi 0600, poi accende l'aggiornamento automatico del plugin (vedi
 * `enableAutoUpdate`; `--no-auto-update` salta questo passo).
 * Restituisce l'exit code. Il token non compare MAI nei messaggi.
 */
export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const { url, token, autoUpdate } = parseArgs(argv);
  if (!url || !token) {
    deps.log("Uso: npx -y @stubwise/mcp setup --url <indirizzo di Stubwise> --token <token>");
    deps.log("Il comando completo è nelle impostazioni di Stubwise, sezione «Claude Code».");
    return 1;
  }

  let baseUrl: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("schema");
    baseUrl = url.replace(/\/+$/, "");
  } catch {
    deps.log(
      `L'indirizzo «${url}» non è valido: deve iniziare con https:// (o http://), per esempio https://stubwise.tuaazienda.it.`,
    );
    return 1;
  }

  let email: string;
  try {
    const me = await new StubwiseClient(
      { baseUrl, token, projectSlug: null },
      { fetch: deps.fetch },
    ).getMe();
    email = me.email;
  } catch (err) {
    if (err instanceof StubwiseApiError && (err.status === 401 || err.status === 403)) {
      deps.log(
        "Stubwise non riconosce questo token: potrebbe essere scaduto o copiato in modo incompleto. Generane uno nuovo nelle impostazioni, sezione «Claude Code».",
      );
    } else if (err instanceof StubwiseApiError && err.status > 0) {
      deps.log(
        `Stubwise su ${baseUrl} ha risposto con un errore (${err.status}). Riprova più tardi.`,
      );
    } else {
      deps.log(
        `Non riesco a raggiungere Stubwise su ${baseUrl}. Controlla l'indirizzo e la connessione e riprova.`,
      );
    }
    return 1;
  }

  const path = deps.configPath ?? userConfigPath(process.env);
  try {
    await deps.mkdir(dirname(path), { recursive: true });
    await deps.writeFile(path, `${JSON.stringify({ url: baseUrl, token }, null, 2)}\n`, {
      mode: 0o600,
    });
    // writeFile applica `mode` solo alla creazione: se il file esisteva, lo restringe qui.
    await deps.chmod(path, 0o600);
  } catch (err) {
    deps.log(`Non riesco a salvare la configurazione in ${path}: ${(err as Error).message}`);
    return 1;
  }

  deps.log(`Configurato come ${email} su ${baseUrl}`);
  if (autoUpdate) {
    await enableAutoUpdate(deps.claudeSettingsPath ?? claudeSettingsPath(process.env), deps);
  }
  return 0;
}
