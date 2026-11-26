/**
 * I tool NATIVI del CLI `claude` ammessi per tipo di run (10 nov 2026, CLI
 * 2.1.322): un elenco ESPLICITO passato con `--tools <lista>`, per ogni run del
 * worker.
 *
 * Perché un elenco e non (solo) la lista dei negati: il 2.1.322 espone tool
 * nativi nuovi — CronCreate/CronDelete/CronList, RemoteTrigger, SendMessage,
 * PushNotification, ToolSearch, ListAgents, Workflow, ScheduleWakeup,
 * Monitor, Enter/ExitWorktree… — che in `-p` partono SENZA chiedere permesso:
 * provato a mano col profilo del refinement (`--permission-mode default` e
 * allowedTools ristretti), RemoteTrigger ha chiamato l'API remota con
 * l'account del CLI, SendMessage e CronCreate sono stati eseguiti, ListAgents
 * vedeva le sessioni della macchina. Una lista dei negati resta sempre
 * indietro di una versione; `--tools` toglie dal set tutto ciò che non nomina
 * (l'init lo conferma, e un sottoagente eredita lo stesso set).
 *
 * FAIL-CLOSED: un run che non dichiara `builtinTools` gira con `--tools ""`,
 * cioè senza nativi (`cliToolsArg`). I tool MCP del run (`--mcp-config`) non
 * sono toccati da `--tools`; i connettori dell'account li esclude
 * `--strict-mcp-config`, che ora c'è sempre.
 *
 * Il runner in streaming confronta poi l'init del CLI con quanto dichiarato
 * (`initToolsViolation`) e ferma il run se il CLI espone altro: è la rete per
 * una versione futura che ignorasse `--tools`, ed è anche il controllo degli
 * scenari golden, che usano lo stesso runner.
 */

/** I nativi che un run del worker può avere. Nessun altro entra in un elenco. */
export type NativeTool = "Read" | "Write" | "Edit" | "Glob" | "Grep" | "Bash" | "NotebookEdit" | "Skill" | "Task";

/**
 * Gli elenchi per tipo di run. Bash non sta negli elenchi di lettura: entra
 * solo con un pattern `Bash(...)` negli allowedTools (`nativeToolsWith`: i
 * comandi del grafo, quelli dei test del fix), che resta il cancello dei
 * comandi.
 */
export const NATIVE_TOOLS = {
  /**
   * Run di solo testo (riassunti, brief, report, note di rilascio, triage,
   * intake, stima, classificazione della posta, test delle credenziali,
   * sonda della quota): nessun nativo, il materiale è nel prompt.
   */
  text: [],
  /** Esplorazione in sola lettura del worktree (Docs ricorsivi, review della PR). */
  readOnly: ["Read", "Grep", "Glob"],
  /** Le pagine notturne: un'allowlist PER FILE di Read e Grep (`scopedFileReadTools`). */
  fileRead: ["Read", "Grep"],
  /** Turno di refinement del backlog: letture ristrette alla sua cartella e le skill dei plugin. */
  refine: ["Read", "Grep", "Glob", "Skill"],
  /** Smoke dei plugin: deve vedere le skill, nient'altro. */
  pluginSmoke: ["Skill"],
  /**
   * Piano del fix (plan mode): letture, skill dei plugin e i sottoagenti
   * (`Task`, che ereditano questo stesso set). `ask_user` è MCP.
   */
  fixPlan: ["Read", "Grep", "Glob", "Skill", "Task"],
  /**
   * Esecuzione, self-repair e correzione post-PR: i tool dei file e Bash (i
   * comandi li filtra `--allowedTools`, `acceptEdits` nega il resto in
   * headless), skill e sottoagenti.
   */
  fixExecute: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "Skill", "Task"],
} as const satisfies Record<string, readonly NativeTool[]>;

/** Un elenco con Bash aggiunto se un pattern `Bash(...)` è fra gli allowedTools. */
export function nativeToolsWith(base: readonly NativeTool[], allowedTools: readonly string[] | undefined): NativeTool[] {
  const list = [...base];
  const bash = (allowedTools ?? []).some((t) => t === "Bash" || t.startsWith("Bash("));
  if (bash && !list.includes("Bash")) list.push("Bash");
  return list;
}

/** Il valore di `--tools`: la lista con le virgole; assente, vuota o `""` → `""` (nessun nativo). */
export function cliToolsArg(tools: "" | readonly NativeTool[] | undefined): string {
  return tools === undefined || tools === "" ? "" : tools.join(",");
}

/** Il nome con cui l'init del CLI elenca un nativo, quando non coincide (`Task` → `Agent`). */
const INIT_ALIASES: Partial<Record<string, NativeTool>> = { Agent: "Task" };

/**
 * I tool dell'init (`system`/`init`, campo `tools`) che il run NON ha
 * dichiarato: i nativi fuori da `builtinTools` e i tool MCP di un server che
 * non è fra quelli di `--mcp-config`. `null` se non ce ne sono.
 */
export function initToolsViolation(
  initTools: readonly string[],
  declared: { builtinTools: "" | readonly NativeTool[] | undefined; mcpServers: readonly string[] },
): string[] | null {
  const natives = new Set<string>(declared.builtinTools === undefined || declared.builtinTools === "" ? [] : declared.builtinTools);
  const extra = initTools.filter((name) => {
    if (name.startsWith("mcp__")) return !declared.mcpServers.some((server) => name.startsWith(`mcp__${server}__`));
    return !natives.has(name) && !natives.has(INIT_ALIASES[name] ?? "");
  });
  return extra.length > 0 ? extra : null;
}
