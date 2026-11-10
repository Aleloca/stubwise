import { describe, expect, it } from "vitest";
import { cliToolsArg, initToolsViolation, NATIVE_TOOLS, nativeToolsWith } from "./native-tools.js";

/**
 * I tool NATIVI del CLI ammessi per tipo di run (CLI 2.1.322, 10 nov 2026):
 * un elenco esplicito passato con `--tools`, mai la sola lista dei negati. Il
 * CLI 2.1.322 espone tool nativi nuovi (CronCreate, RemoteTrigger,
 * SendMessage, PushNotification, ToolSearch, ListAgents…) che in `-p` partono
 * SENZA permesso: una lista dei negati resterebbe sempre indietro.
 */
describe("NATIVE_TOOLS", () => {
  it("nessun elenco contiene i tool che agiscono fuori dal worktree o dalla macchina", () => {
    const forbidden = [
      "CronCreate",
      "CronDelete",
      "CronList",
      "RemoteTrigger",
      "SendMessage",
      "PushNotification",
      "ListAgents",
      "ToolSearch",
      "Workflow",
      "ScheduleWakeup",
      "Monitor",
      "TaskStop",
      "EnterWorktree",
      "ExitWorktree",
      "DesignSync",
      "ReportFindings",
      "WebFetch",
      "WebSearch",
    ];
    for (const [kind, tools] of Object.entries(NATIVE_TOOLS)) {
      for (const tool of tools) expect(forbidden, `${kind}: ${tool}`).not.toContain(tool);
    }
  });

  it("solo fix ed esecuzione scrivono; il refinement legge e usa le skill; i run di testo non hanno niente", () => {
    expect(NATIVE_TOOLS.text).toEqual([]);
    expect(NATIVE_TOOLS.refine).toEqual(["Read", "Grep", "Glob", "Skill"]);
    expect(NATIVE_TOOLS.fileRead).toEqual(["Read", "Grep"]);
    expect(NATIVE_TOOLS.readOnly).toEqual(["Read", "Grep", "Glob"]);
    const writers = Object.entries(NATIVE_TOOLS)
      .filter(([, tools]) => tools.some((t) => t === "Write" || t === "Edit"))
      .map(([kind]) => kind);
    expect(writers).toEqual(["fixExecute"]);
  });
});

describe("nativeToolsWith", () => {
  it("aggiunge Bash solo se un pattern Bash(...) è negli allowedTools (i comandi del grafo)", () => {
    expect(nativeToolsWith(NATIVE_TOOLS.readOnly, ["Bash(graphify query:*)"])).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(nativeToolsWith(NATIVE_TOOLS.readOnly, ["Read(//x/**)", "mcp__stubwise__ask_user"])).toEqual(["Read", "Grep", "Glob"]);
    expect(nativeToolsWith(NATIVE_TOOLS.readOnly, undefined)).toEqual(["Read", "Grep", "Glob"]);
    // Già presente: non si ripete.
    expect(nativeToolsWith(NATIVE_TOOLS.fixExecute, ["Bash(npm test:*)"]).filter((t) => t === "Bash")).toHaveLength(1);
  });
});

describe("cliToolsArg", () => {
  it("un elenco diventa la lista con le virgole; vuoto, assente o \"\" spengono tutto", () => {
    expect(cliToolsArg(["Read", "Grep"])).toBe("Read,Grep");
    expect(cliToolsArg([])).toBe("");
    expect(cliToolsArg("")).toBe("");
    // Fail-closed: un run che non dichiara niente non ha nativi.
    expect(cliToolsArg(undefined)).toBe("");
  });
});

describe("initToolsViolation", () => {
  it("l'init che espone solo i nativi ammessi e i tool dei server MCP del run va bene", () => {
    expect(
      initToolsViolation(["Read", "Grep", "mcp__stubwise__ask_user"], { builtinTools: ["Read", "Grep"], mcpServers: ["stubwise"] }),
    ).toBeNull();
  });

  it("un nativo fuori elenco, o un MCP di un server non del run (un connettore dell'account), è una violazione", () => {
    expect(initToolsViolation(["Read", "CronCreate"], { builtinTools: ["Read"], mcpServers: [] })).toEqual(["CronCreate"]);
    expect(
      initToolsViolation(["mcp__claude_ai_Gmail__send", "mcp__stubwise__x"], { builtinTools: [], mcpServers: ["stubwise"] }),
    ).toEqual(["mcp__claude_ai_Gmail__send"]);
    // Un nome di server che è il prefisso di un altro non basta.
    expect(initToolsViolation(["mcp__stubwise2__x"], { builtinTools: [], mcpServers: ["stubwise"] })).toEqual(["mcp__stubwise2__x"]);
  });

  it("l'alias Agent del sottoagente vale come Task", () => {
    expect(initToolsViolation(["Agent"], { builtinTools: ["Task"], mcpServers: [] })).toBeNull();
    expect(initToolsViolation(["Agent"], { builtinTools: ["Read"], mcpServers: [] })).toEqual(["Agent"]);
  });
});
