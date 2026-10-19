import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { StubwiseApiError, StubwiseClient } from "./client.js";
import { userConfigPath } from "./config.js";

/** Dipendenze iniettate di `runSetup`: nei test nessun accesso a disco e rete. */
export interface SetupDeps {
  fetch: typeof fetch;
  writeFile: (path: string, data: string, options: { mode: number }) => Promise<void>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  chmod: (path: string, mode: number) => Promise<void>;
  log: (message: string) => void;
  /** Dove scrivere il file; default `userConfigPath(process.env)`. */
  configPath?: string;
}

/** Dipendenze reali, per `index.ts`. stdout è libero: `setup` è un comando da terminale. */
export function realSetupDeps(env: Record<string, string | undefined>): SetupDeps {
  return {
    fetch,
    writeFile: (p, d, o) => writeFile(p, d, o),
    mkdir: (p, o) => mkdir(p, o),
    chmod,
    log: (m) => console.log(m),
    configPath: userConfigPath(env),
  };
}

function parseArgs(argv: string[]): { url?: string; token?: string } {
  const out: { url?: string; token?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [key, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (key === "--url") out.url = inline ?? argv[++i];
    else if (key === "--token") out.token = inline ?? argv[++i];
  }
  return out;
}

/**
 * `npx -y @stubwise/mcp setup --url <url> --token <token>`: verifica il token
 * con `GET /api/auth/me`, poi scrive il file personale con permessi 0600.
 * Restituisce l'exit code. Il token non compare MAI nei messaggi.
 */
export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const { url, token } = parseArgs(argv);
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
  return 0;
}
