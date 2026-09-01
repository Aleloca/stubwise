import { pluginInventorySchema, type PluginHook, type PluginInventory } from "@stubwise/shared";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Inventario di un plugin materializzato: cosa contiene la sua directory
 * (skill, comandi, agenti, hook, `.mcp.json`), letto dal worker e salvato come
 * jsonb per la UI, che ci disegna sopra gli interruttori per progetto.
 *
 * PRINCIPIO DI ROBUSTEZZA: qui si legge codice di TERZE PARTI. Un plugin mal
 * formato non deve far fallire la materializzazione se il CLI lo caricherebbe
 * comunque — un inventario incompleto renderebbe invisibile (e quindi non
 * spegnibile) qualcosa che poi gira nei run. Perciò ogni anomalia degrada in
 * modo esplicito e documentato caso per caso, e l'UNICO errore fatale è il
 * manifest: senza `name` non esiste nemmeno il namespace delle skill, e
 * `claude plugin validate --strict` (che il poller esegue prima) lo avrebbe già
 * bocciato.
 */

/** Manifest assente, non parsabile o senza `name`: il plugin non è un plugin. */
export class InvalidPluginManifestError extends Error {
  constructor(pluginDir: string, reason: string) {
    super(`Manifest del plugin non valido in ${pluginDir}: ${reason}`);
    this.name = "InvalidPluginManifestError";
  }
}

// Cap dello schema condiviso (packages/shared/src/schemas/plugin.ts). I valori
// vengono TRONCATI, non rifiutati: un plugin con una descrizione fluviale è
// un'eccentricità, non un motivo per far fallire la materializzazione.
const MAX_NAME = 200;
const MAX_VERSION = 100;
const MAX_DESCRIPTION = 2000;
const MAX_MATCHER = 500;
const MAX_COMMAND = 4000;
/** Sotto MAX_NAME per lasciare spazio al suffisso `#<indice>` della chiave. */
const MAX_EVENT = 180;

/**
 * Chiave con cui un progetto spegne un gruppo di hook: `<Evento>#<indice>`,
 * dove l'indice è la POSIZIONE del gruppo nell'array dell'evento dentro
 * `hooks/hooks.json`. Esportata perché la copia filtrata per-run deve
 * ricostruire le stesse chiavi leggendo lo stesso file: se le due formule
 * divergessero, uno spegnimento salvato smetterebbe di applicarsi in silenzio.
 */
export function hookKey(event: string, index: number): string {
  return `${clamp(event, MAX_EVENT)}#${index}`;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Stringa non vuota (dopo trim) o `undefined`: i campi opzionali vuoti spariscono. */
function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : clamp(trimmed, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `true` se il path è un FILE REGOLARE (niente symlink, niente FIFO, niente
 * directory), controllato con `lstat` che NON segue i link.
 *
 * È il guard che rende sicuro leggere per nome i file a nome fisso di un plugin
 * (`.claude-plugin/plugin.json`, `hooks/hooks.json`, e in forma inline
 * `SKILL.md`): il contenuto della dir è codice di terze
 * parti, e un `SKILL.md` symlinkato a un file dell'host ne farebbe finire
 * `name`/`description`/`bytes` nell'inventario, cioè nel DB e nella UI. Un link
 * a una FIFO sarebbe peggio: `readFile` non ha timeout e appenderebbe il worker.
 *
 * NOTA: il guard AUTOREVOLE è il rifiuto dei symlink nell'albero materializzato
 * (poller di materializzazione), che protegge anche la copia per-run. Questo
 * qui non è ridondante: rende il modulo sicuro anche chiamato fuori da quel
 * flusso, come `assertNotOption` in `git.ts`.
 */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** `readdir` che restituisce `[]` invece di lanciare (dir assente o non dir). */
async function readDirSafe(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Ordinamento per nome: l'ordine di `readdir` dipende dal filesystem, e un
    // inventario che cambia ordine a ogni lettura produrrebbe finti "diff"
    // nella UI di aggiornamento del plugin.
    return entries
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  } catch {
    // Dir assente (il caso normale: non tutti i plugin hanno tutte le
    // sezioni), oppure un file al posto della directory: sezione vuota.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Parser YAML MINIMALE del frontmatter di una `SKILL.md`: servono solo `name` e
 * `description`, entrambi scalari. Nessuna dipendenza YAML nel worker per una
 * cosa così piccola, e un parser completo su file di terze parti sarebbe
 * superficie in più senza guadagno.
 *
 * Copre: scalari semplici, scalari fra virgolette, block scalar `|`/`>` (usati
 * spesso per le descrizioni lunghe delle skill). IGNORA (non fallisce) tutto il
 * resto — mappe annidate, liste, ancore: il valore delle chiavi che non capisce
 * non ci serve. Se manca il delimitatore di chiusura, il documento NON ha
 * frontmatter (un `---` in mezzo al markdown non deve diventare metadati).
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1 || text.slice(0, firstBreak).trim() !== "---") return {};

  const lines = text.slice(firstBreak + 1).split("\n");
  const fields: Record<string, string> = {};
  let closed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") {
      closed = true;
      break;
    }
    // Riga vuota, commento, oppure riga indentata (appartiene a una struttura
    // annidata di una chiave che non ci interessa): saltata.
    if (trimmed === "" || trimmed.startsWith("#") || /^\s/.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key === "") continue;
    const rawValue = line.slice(separator + 1).trim();

    // Block scalar: `|`, `>`, con eventuali indicatori di chomping/indent.
    const block = /^([|>])[0-9+-]*$/.exec(rawValue);
    if (block) {
      const folded = block[1] === ">";
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        const nextTrimmed = next.trim();
        if (nextTrimmed === "---" || nextTrimmed === "...") break;
        // Il blocco finisce alla prima riga non indentata e non vuota.
        if (nextTrimmed !== "" && !/^\s/.test(next)) break;
        collected.push(nextTrimmed);
        i++;
      }
      // `>` piega le righe in una sola (separatore spazio), `|` le conserva.
      fields[key] = (folded ? collected.join(" ") : collected.join("\n")).trim();
      continue;
    }

    fields[key] = unquote(rawValue);
  }

  return closed ? fields : {};
}

/** Toglie le virgolette di uno scalare YAML quotato (best effort). */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Sezioni
// ---------------------------------------------------------------------------

interface Manifest {
  name: string;
  version?: string;
  description?: string;
}

async function readManifest(pluginDir: string): Promise<Manifest> {
  const path = join(pluginDir, ".claude-plugin", "plugin.json");
  let raw: string;
  // Stesso guard di `SKILL.md` e `hooks.json`: il manifest è il terzo file a
  // nome fisso letto dentro una dir di terze parti. Un link porterebbe qui
  // dentro `name` da un file dell'host; una FIFO appenderebbe il worker.
  if (!(await isRegularFile(path))) {
    throw new InvalidPluginManifestError(
      pluginDir,
      ".claude-plugin/plugin.json assente o non è un file regolare",
    );
  }
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new InvalidPluginManifestError(pluginDir, ".claude-plugin/plugin.json non leggibile");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidPluginManifestError(pluginDir, ".claude-plugin/plugin.json non è JSON valido");
  }
  if (!isRecord(parsed)) {
    throw new InvalidPluginManifestError(pluginDir, ".claude-plugin/plugin.json non è un oggetto");
  }
  const name = optionalString(parsed.name, MAX_NAME);
  if (name === undefined) {
    throw new InvalidPluginManifestError(pluginDir, "campo `name` mancante o vuoto");
  }
  return {
    name,
    // `version`/`description` non stringa (es. `version: 42`): campo assente.
    // Sono decorativi, non vale far fallire il plugin per un tipo sbagliato.
    version: optionalString(parsed.version, MAX_VERSION),
    description: optionalString(parsed.description, MAX_DESCRIPTION),
  };
}

async function readSkills(pluginDir: string): Promise<PluginInventory["skills"]> {
  const skillsDir = join(pluginDir, "skills");
  const skills: PluginInventory["skills"] = [];
  for (const entry of await readDirSafe(skillsDir)) {
    // Solo directory reali: i symlink NON vengono seguiti, né qui né sul
    // SKILL.md (vedi `isRegularFile`), perché potrebbero puntare fuori dalla
    // dir del plugin.
    if (!entry.isDir) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    let buffer: Buffer | null = null;
    try {
      // `lstat` (che non segue i link) prima di leggere: un `SKILL.md`
      // symlinkato è trattato come NON leggibile, mai seguito.
      if ((await lstat(file)).isFile()) buffer = await readFile(file);
    } catch (error) {
      // Nessun SKILL.md: la sottocartella non è una skill (può essere una dir
      // di supporto), quindi si salta senza rumore.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Altro errore (permessi, lettura fallita a metà): degrada come sotto.
    }
    if (buffer === null) {
      // C'è qualcosa che non si legge (symlink, FIFO, directory, permessi): la
      // skill viene comunque ELENCATA col nome della directory e `bytes: 0`.
      // Il CLI potrebbe caricarla lo stesso, e una skill invisibile
      // nell'inventario è una skill che nessuno può spegnere.
      skills.push({ name: clamp(entry.name, MAX_NAME), bytes: 0 });
      continue;
    }
    const frontmatter = parseFrontmatter(buffer.toString("utf8"));
    skills.push({
      // `name` del frontmatter se c'è ed è non vuoto, altrimenti il nome della
      // directory: è comunque il nome con cui il CLI namespaca la skill.
      name: optionalString(frontmatter.name, MAX_NAME) ?? clamp(entry.name, MAX_NAME),
      description: optionalString(frontmatter.description, MAX_DESCRIPTION),
      // Dimensione reale del file: la UI la mostra come "costo" in KB.
      bytes: buffer.byteLength,
    });
  }
  return skills;
}

/** `commands/*.md` o `agents/*.md`: solo i file `.md` di primo livello. */
async function readMarkdownEntries(
  pluginDir: string,
  section: "commands" | "agents",
): Promise<Array<{ name: string }>> {
  const entries: Array<{ name: string }> = [];
  for (const entry of await readDirSafe(join(pluginDir, section))) {
    // Le sottodirectory (comandi con namespace annidato) non sono esplorate:
    // l'inventario elenca il primo livello, che è quanto serve alla UI.
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    entries.push({ name: clamp(entry.name.slice(0, -".md".length), MAX_NAME) });
  }
  return entries;
}

/**
 * Appiattisce `hooks/hooks.json` (`{hooks: {<Evento>: [{matcher?, hooks:[…]}]}}`)
 * nella lista dell'inventario, una voce per GRUPPO.
 */
async function readHooks(pluginDir: string): Promise<PluginHook[]> {
  const file = join(pluginDir, "hooks", "hooks.json");
  // Symlink (o FIFO, o directory) al posto del file: trattato come ASSENTE, il
  // link non viene mai seguito. Vedi `isRegularFile`.
  if (!(await isRegularFile(file))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // File illeggibile o JSON rotto: non elenchiamo hook perché nemmeno il CLI
    // potrebbe eseguirli — un file che non si parsa non definisce nulla.
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return [];

  const hooks: PluginHook[] = [];
  // I nomi di evento NON sono validati contro una lista: il CLI può supportare
  // eventi che noi non conosciamo, e un evento ignoto va elencato (e quindi
  // reso spegnibile), non nascosto. Si scarta solo ciò che non ha la forma
  // attesa — un valore che non è un array di gruppi non è interpretabile.
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      if (!isRecord(group)) return;
      const entries = Array.isArray(group.hooks) ? group.hooks : [];
      const commands = entries
        .filter(
          (entry): entry is Record<string, unknown> =>
            isRecord(entry) && entry.type === "command" && typeof entry.command === "string",
        )
        .map((entry) => (entry.command as string).trim())
        .filter((command) => command.length > 0);
      // Gruppo senza comandi eseguibili: niente da mostrare né da spegnere.
      // NOTA: l'indice NON viene rinumerato — è la posizione nel file, e la
      // copia filtrata per-run rimuove il gruppo proprio per posizione.
      if (commands.length === 0) return;
      hooks.push({
        key: hookKey(event, index),
        event: clamp(event, MAX_EVENT),
        matcher: optionalString(group.matcher, MAX_MATCHER),
        // Più comandi nello stesso gruppo: uno per riga in un'unica voce, dato
        // che la chiave (e quindi lo spegnimento) è del gruppo, non del comando.
        command: clamp(commands.join("\n"), MAX_COMMAND),
      });
    });
  }
  return hooks;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Legge l'inventario della directory di un plugin già materializzata.
 * Lancia `InvalidPluginManifestError` solo se il manifest è inutilizzabile.
 */
export async function readInventory(pluginDir: string): Promise<PluginInventory> {
  const manifest = await readManifest(pluginDir);
  const inventory: PluginInventory = {
    ...manifest,
    skills: await readSkills(pluginDir),
    commands: await readMarkdownEntries(pluginDir, "commands"),
    agents: await readMarkdownEntries(pluginDir, "agents"),
    hooks: await readHooks(pluginDir),
    // Il `.mcp.json` di un plugin è ignorato per costruzione (la copia
    // per-run lo esclude): il booleano serve a DIRLO nella UI, non a usarlo.
    hasMcp: existsSync(join(pluginDir, ".mcp.json")),
  };
  // Ultimo controllo del contratto prima del jsonb: i cap sono già applicati
  // sopra, quindi qui non dovrebbe mai fallire — se fallisce è un bug nostro,
  // e vale la pena vederlo come materializzazione fallita invece di scrivere
  // nel DB un inventario che server e SPA non sapranno rileggere.
  return pluginInventorySchema.parse(inventory);
}
