import { JOURNALCTL_WRITE_FLAGS, READ_PLAIN_COMMANDS, READ_SUDO_COMMANDS } from "./installScript";
import { COMMAND_OUTPUT_MAX_LINES } from "./limits";

/**
 * I comandi che l'analisi può lanciare con l'accesso di lettura: gli stessi
 * delle regole `sudo` dello script (preceduti da `sudo`) più quelli che non
 * lo chiedono. Sono prefissi: gli argomenti dopo sono ammessi.
 */
export const READ_COMMANDS: readonly string[] = [
  ...READ_PLAIN_COMMANDS,
  ...READ_SUDO_COMMANDS.map((cmd) => `sudo ${cmd}`),
];

// Niente composizione: un comando ammesso seguito da `;`, `|`, `&&`, una
// redirezione o una sostituzione diventerebbe un altro comando.
const SHELL_META = /[;|&<>`\n\r]|\$\(/;

/**
 * Se `cmd` è un comando di lettura ammesso all'analisi: un solo comando, che
 * comincia con uno di `READ_COMMANDS` (intero, non `psql` per `ps`), e per
 * `journalctl` senza le opzioni che ruotano o cancellano i log.
 */
export function isReadCommand(cmd: string): boolean {
  if (SHELL_META.test(cmd)) return false;
  const normalized = cmd.trim().replace(/\s+/g, " ");
  if (normalized === "") return false;
  const allowed = READ_COMMANDS.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
  if (!allowed) return false;
  if (normalized.startsWith("sudo journalctl")) {
    return !JOURNALCTL_WRITE_FLAGS.some((flag) => normalized.includes(flag));
  }
  return true;
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
