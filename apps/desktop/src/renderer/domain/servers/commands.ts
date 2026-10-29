import { READ_PLAIN_COMMANDS, READ_SUDO_COMMANDS } from "./installScript";
import { COMMAND_OUTPUT_MAX_LINES } from "./limits";

/**
 * I comandi che l'analisi può lanciare con l'accesso di lettura: quelli
 * senza `sudo` più `sudo <cmd>` per ogni regola `sudo` dello script. Sono
 * prefissi; gli argomenti dopo li decide `isReadCommand`.
 */
export const READ_COMMANDS: readonly string[] = [
  ...READ_PLAIN_COMMANDS,
  ...READ_SUDO_COMMANDS.map((cmd) => `sudo ${cmd}`),
];

// Gli argomenti ammessi, per comando: un elenco POSITIVO (R-L5). Un'opzione
// che non c'è è rifiutata, comprese le abbreviazioni di `getopt_long`
// (`--rot` per `--rotate`): si confronta il nome intero, mai un prefisso.
// `value` = l'opzione prende un valore (`--opt v` o `--opt=v`), e il valore
// deve rispettare l'espressione.

type Grammar = {
  /** Opzioni senza valore (`-a`, `--no-pager`); le corte si possono unire (`-tl`). */
  flags?: readonly string[];
  /** Opzioni con valore. */
  values?: Readonly<Record<string, RegExp>>;
  /** Gli argomenti posizionali ammessi, e quanti (di base almeno 0). */
  positional?: { pattern: RegExp; max: number; min?: number };
};

const WORD = /^[\w@.:+-]+$/;
const NUMBER = /^\d{1,6}$/;
const NAME = /^[\w][\w@.:-]*$/;
const PATH = /^\/[\w./-]*$/;
// Le graffe servono ai template Go di docker (`{{.Name}}`), ma bash le
// espande DOPO il controllo se dentro c'è una virgola o un `..`
// (`{pid,eww}`, `{1..3}`): un template non ha né l'una né l'altro.
const TEMPLATE = /^(?!.*\.\.)[\w{}.:% -]+$/;
/** I campi di `ps -o`: virgole sì, graffe no. */
const PS_FIELDS = /^[\w,%-]+$/;

const JOURNAL_OUTPUT =
  /^(short|short-iso|short-iso-precise|short-precise|short-full|short-monotonic|short-unix|cat|json|json-pretty|verbose|with-unit)$/;

const GRAMMARS: Record<string, Grammar> = {
  uptime: { flags: ["-p", "-s"] },
  free: { flags: ["-b", "-k", "-m", "-g", "-h", "-w", "-t", "--human", "--wide", "--total"] },
  df: {
    flags: [
      "-h",
      "-H",
      "-T",
      "-i",
      "-k",
      "-l",
      "-P",
      "--human-readable",
      "--print-type",
      "--inodes",
    ],
    values: { "-x": WORD, "-t": WORD },
    positional: { pattern: PATH, max: 4 },
  },
  ps: {
    flags: ["-e", "-f", "-A", "-F", "-l", "-w", "-H", "--forest"],
    values: { "-o": PS_FIELDS, "--format": PS_FIELDS, "--sort": /^[-+]?[%\w,]+$/, "-p": NUMBER },
    positional: { pattern: /^(aux|auxww|ax|axu)$/, max: 1 },
  },
  // `ss` solo così: `-K` chiude dei socket, `-D` scrive un file.
  "ss -tlnp": {},
  journalctl: {
    flags: [
      "--no-pager",
      "-r",
      "--reverse",
      "-k",
      "--dmesg",
      "-b",
      "-x",
      "--no-hostname",
      "-q",
      "--quiet",
    ],
    values: {
      "-u": NAME,
      "--unit": NAME,
      "--since": WORD,
      "--until": WORD,
      "-n": NUMBER,
      "--lines": NUMBER,
      "-p": /^(emerg|alert|crit|err|warning|notice|info|debug|[0-7])(\.\.[a-z0-7]+)?$/,
      "--priority": /^(emerg|alert|crit|err|warning|notice|info|debug|[0-7])(\.\.[a-z0-7]+)?$/,
      "-o": JOURNAL_OUTPUT,
      "--output": JOURNAL_OUTPUT,
      "--boot": /^-?\d{1,3}$/,
      "-g": WORD,
      "--grep": WORD,
    },
  },
  // Niente `-H`/`--host` né `-M`: aprirebbero una connessione verso un altro host.
  "systemctl status": {
    flags: ["--no-pager", "-l", "--full"],
    values: { "-n": NUMBER, "--lines": NUMBER, "-o": JOURNAL_OUTPUT, "--output": JOURNAL_OUTPUT },
    positional: { pattern: NAME, max: 8 },
  },
  "sudo docker ps": {
    flags: ["-a", "--all", "-q", "--quiet", "--no-trunc", "-s", "--size", "-l", "--latest"],
    values: {
      "--format": TEMPLATE,
      "-f": /^[\w.-]+=[\w.:/-]+$/,
      "--filter": /^[\w.-]+=[\w.:/-]+$/,
      "-n": NUMBER,
      "--last": NUMBER,
    },
  },
  // Niente `-f`/`--follow`: non finirebbe mai.
  "sudo docker logs": {
    flags: ["-t", "--timestamps", "--details"],
    values: {
      "--tail": /^(\d{1,6}|all)$/,
      "-n": /^(\d{1,6}|all)$/,
      "--since": WORD,
      "--until": WORD,
    },
    positional: { pattern: NAME, max: 1, min: 1 },
  },
  "sudo docker stats --no-stream": {
    flags: ["-a", "--all", "--no-trunc"],
    values: { "--format": TEMPLATE },
    positional: { pattern: NAME, max: 16 },
  },
};

// Niente composizione né virgolette: un comando ammesso seguito da `;`,
// `|`, `&&`, una redirezione o una sostituzione diventerebbe un altro
// comando, e le virgolette cambierebbero come si dividono gli argomenti.
const SHELL_META = /[;|&<>`\n\r'"\\]|\$/;

function argsFit(args: string[], g: Grammar): boolean {
  const flags = g.flags ?? [];
  const values = g.values ?? {};
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (eq === -1 && flags.includes(name)) continue;
      const pattern = values[name];
      if (!pattern) return false;
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined || !pattern.test(value)) return false;
    } else if (arg.startsWith("-") && arg.length > 1) {
      const pattern = values[arg];
      if (pattern) {
        const value = args[++i];
        if (value === undefined || !pattern.test(value)) return false;
        continue;
      }
      // Corte unite (`-tl`): ognuna dev'essere un'opzione senza valore.
      if (![...arg.slice(1)].every((c) => flags.includes(`-${c}`))) return false;
    } else {
      if (!g.positional || !g.positional.pattern.test(arg)) return false;
      if (++positional > g.positional.max) return false;
    }
  }
  return positional >= (g.positional?.min ?? 0);
}

/**
 * Se `cmd` è un comando di lettura ammesso all'analisi: un solo comando,
 * che comincia con uno di `READ_COMMANDS` (parole intere: non `psql` per
 * `ps`) e i cui argomenti stanno tutti nell'elenco di quel comando.
 */
export function isReadCommand(cmd: string): boolean {
  if (SHELL_META.test(cmd)) return false;
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // Il prefisso più lungo che combacia (`sudo docker stats --no-stream`).
  let best: string[] | null = null;
  for (const prefix of READ_COMMANDS) {
    const words = prefix.split(" ");
    const fits = words.every((w, i) => tokens[i] === w);
    if (fits && (best === null || words.length > best.length)) best = words;
  }
  if (best === null) return false;
  const grammar = GRAMMARS[best.join(" ")];
  return grammar !== undefined && argsFit(tokens.slice(best.length), grammar);
}

/**
 * L'uscita di un comando come si mostra di base: le ultime
 * `COMMAND_OUTPUT_MAX_LINES` righe (l'errore sta in fondo). Un a capo finale
 * non conta come riga.
 */
export function truncateOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= COMMAND_OUTPUT_MAX_LINES) return { text, truncated: false };
  return { text: lines.slice(-COMMAND_OUTPUT_MAX_LINES).join("\n"), truncated: true };
}
