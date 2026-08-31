import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Server MCP `stubwise_ask`: espone all'agente che pianifica un fix UN solo
 * tool, `ask_user`, con cui fermarsi e chiedere una scelta a un umano.
 *
 * BRIDGE SU FILE — il processo `claude` CLI riceve dal worker un ambiente in
 * allowlist con denylist assoluta su `DATABASE_URL` (vedi `agent/claude-cli.ts`):
 * questo server, che gira DENTRO quel processo figlio, non può e non deve
 * parlare col database. Scrive quindi la domanda come JSON in un file della
 * directory del run (`ASK_USER_FILE`); al ritorno del run è il worker — che il
 * DB ce l'ha — a leggerlo, RIVALIDARLO con zod (mai fidarsi del contenuto) e
 * parcheggiare il job in `awaiting_input`.
 *
 * INVARIANTE: stdout è il canale del protocollo MCP (JSON-RPC). Qui non si
 * scrive MAI su stdout: ogni diagnostica passa da `console.error` (stderr).
 */

/** Nome del tool esposto (dal lato CLI diventa `mcp__stubwise_ask__ask_user`). */
export const ASK_USER_TOOL_NAME = "ask_user";
/** Nome del server dichiarato nell'handshake MCP. */
export const ASK_USER_SERVER_NAME = "stubwise_ask";
/**
 * Versione dichiarata nell'handshake. Costante: il server non è pubblicato né
 * versionato a sé (vive nel dist del worker), quindi non c'è un package.json da
 * cui leggerla come fa `@stubwise/mcp`.
 */
export const ASK_USER_SERVER_VERSION = "1.0.0";

/** Round corrente di default quando `ASK_USER_ROUND` manca o non è valida. */
export const DEFAULT_ASK_USER_ROUND = 1;
/** Tetto di default quando `ASK_USER_MAX_ROUNDS` manca o non è valida. */
export const DEFAULT_ASK_USER_MAX_ROUNDS = 5;

/** Configurazione del server, tutta dall'ambiente del processo. */
export interface AskUserConfig {
  /** Path del file-bridge da scrivere (obbligatorio, da `ASK_USER_FILE`). */
  filePath: string;
  /** Round di domanda corrente, 1-based. */
  round: number;
  /** Numero massimo di round consentiti nello stesso job. */
  maxRounds: number;
}

/**
 * Risultato di un tool nella forma attesa dall'SDK MCP: blocchi di contenuto
 * (qui sempre testo) più il flag `isError`. L'handler NON lancia mai: un errore
 * di validazione torna come risultato `isError: true`, così il modello legge un
 * messaggio invece di vedere il tool crashare.
 */
export interface AskUserToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Risposta al modello quando la domanda è stata registrata: istruzione operativa. */
export const REGISTERED_MESSAGE =
  "Domanda registrata. Termina il turno ORA senza produrre il piano: riceverai la risposta in un turno successivo.";
/** Risposta al modello quando una domanda è già stata registrata in questo turno. */
export const ALREADY_ASKED_MESSAGE = "Hai già una domanda registrata: termina il turno.";

/** Risposta al modello quando il tetto di round è stato superato. */
export function cappedMessage(maxRounds: number): string {
  return `Tetto di domande raggiunto (${maxRounds}): scegli tu l'opzione più ragionevole e documenta la scelta nella sezione 'Decisioni e assunzioni' del piano.`;
}

/**
 * Legge un intero positivo da una env. Assente o vuota → default silenzioso
 * (le env sono opzionali per costruzione). Presente ma non intera positiva →
 * default con un avviso su stderr: un valore sballato non deve far crashare il
 * server (romperebbe l'intero run di pianificazione), ma deve essere
 * diagnosticabile nei log del CLI.
 */
function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`ask_user: ${name}='${trimmed}' non è un intero positivo, uso ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Costruisce la configurazione dall'ambiente. `ASK_USER_FILE` è OBBLIGATORIA e
 * la sua assenza è un errore di bootstrap (throw): senza file-bridge il tool
 * sarebbe una scatola vuota che accetta domande e le butta via, e il fallimento
 * si vedrebbe solo molto più tardi. Round e tetto invece degradano sui default.
 */
export function loadAskUserConfig(env: NodeJS.ProcessEnv): AskUserConfig {
  const filePath = env.ASK_USER_FILE?.trim();
  if (!filePath) {
    throw new Error("ASK_USER_FILE non impostata: il server MCP ask_user non ha dove scrivere");
  }
  return {
    filePath,
    round: readPositiveInt(env.ASK_USER_ROUND, DEFAULT_ASK_USER_ROUND, "ASK_USER_ROUND"),
    maxRounds: readPositiveInt(
      env.ASK_USER_MAX_ROUNDS,
      DEFAULT_ASK_USER_MAX_ROUNDS,
      "ASK_USER_MAX_ROUNDS",
    ),
  };
}

/** Una delle alternative proposte all'umano. */
const optionSchema = z.object({
  label: z.string().min(1).max(200).describe("Etichetta breve dell'opzione (diventa un bottone)."),
  consequence: z
    .string()
    .max(500)
    .optional()
    .describe("Cosa comporta scegliere questa opzione, in una riga."),
});

/**
 * Forma degli argomenti del tool (`ZodRawShape`): è quella che l'SDK usa sia per
 * validare gli argomenti sia per pubblicare lo schema JSON al client.
 */
export const askUserInputShape = {
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe("La domanda, autosufficiente: chi legge non ha il contesto della sessione."),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe("Da 2 a 4 alternative concrete e mutuamente esclusive."),
  recommendedIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Indice dell'opzione che consigli, se ne hai una. Segnalata, mai preselezionata."),
  allowFreeText: z
    .boolean()
    .default(true)
    .describe("Se true (default) l'umano può rispondere anche in testo libero."),
};

/**
 * Schema completo degli argomenti: la forma sopra più il vincolo che non si può
 * esprimere campo per campo (l'indice consigliato deve puntare a un'opzione che
 * esiste). Il `path` sul refine fa arrivare al modello un messaggio mirato.
 */
export const askUserSchema = z.object(askUserInputShape).refine(
  (value) => value.recommendedIndex === undefined || value.recommendedIndex < value.options.length,
  {
    path: ["recommendedIndex"],
    message: "recommendedIndex deve essere l'indice di una delle opzioni",
  },
);

/** Payload scritto nel file-bridge: i campi della domanda, niente altro. */
export type AskUserPayload = z.infer<typeof askUserSchema>;

/** Costruisce un risultato di tool con un unico blocco di testo. */
function textResult(text: string): AskUserToolResult {
  return { content: [{ type: "text", text }] };
}

/** Costruisce un risultato di tool d'errore (isError: true). */
function errorResult(text: string): AskUserToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Vero se il path esiste già (di qualunque tipo). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scrittura ATOMICA del file-bridge: prima un file temporaneo NELLA STESSA
 * directory di destinazione (un rename cross-filesystem fallirebbe), poi il
 * rename. Il worker che legge non può quindi mai incontrare un JSON troncato.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}-${Date.now()}.ask-user.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

/**
 * Handler del tool `ask_user`, senza SDK di mezzo (testabile direttamente).
 * Tre esiti, in quest'ordine:
 *  1. round oltre il tetto → istruzione a decidere da solo, NESSUNA scrittura;
 *  2. file già presente → il modello ha già chiesto in questo turno, la domanda
 *     registrata non si sovrascrive;
 *  3. argomenti validi → scrittura atomica e istruzione a chiudere il turno.
 */
export async function handleAskUser(
  args: Record<string, unknown>,
  config: AskUserConfig,
): Promise<AskUserToolResult> {
  if (config.round > config.maxRounds) {
    return textResult(cappedMessage(config.maxRounds));
  }

  const parsed = askUserSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(radice)"}: ${issue.message}`)
      .join("; ");
    return errorResult(`Argomenti non validi per ask_user: ${issues}`);
  }

  if (await exists(config.filePath)) {
    return textResult(ALREADY_ASKED_MESSAGE);
  }

  try {
    await writeAtomic(config.filePath, `${JSON.stringify(parsed.data, null, 2)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Impossibile registrare la domanda: ${message}`);
  }

  return textResult(REGISTERED_MESSAGE);
}

/**
 * Assembla il server MCP con il solo tool `ask_user`. Non tocca il transport:
 * il collegamento a stdio avviene nell'entry `index.ts`, così questa funzione
 * resta testabile senza I/O di processo.
 */
export function buildAskUserServer(config: AskUserConfig): McpServer {
  const server = new McpServer({
    name: ASK_USER_SERVER_NAME,
    version: ASK_USER_SERVER_VERSION,
  });

  server.registerTool(
    ASK_USER_TOOL_NAME,
    {
      description:
        "Fai UNA domanda a un umano quando la pianificazione arriva a un bivio che produce lavori materialmente diversi. Registra la domanda e termina subito il turno senza produrre il piano: la risposta arriverà in un turno successivo. Le scelte reversibili o minori NON si chiedono: si prendono da soli e si documentano nella sezione 'Decisioni e assunzioni' del piano.",
      inputSchema: askUserInputShape,
    },
    // Il nostro `AskUserToolResult` è strutturalmente un `CallToolResult` valido
    // ma non ne ha la index signature `[x: string]: unknown` (usata dall'SDK per
    // il passthrough di `_meta`): cast al boundary, l'handler resta tipizzato.
    ((args: Record<string, unknown>) => handleAskUser(args, config)) as Parameters<
      McpServer["registerTool"]
    >[2],
  );

  return server;
}
