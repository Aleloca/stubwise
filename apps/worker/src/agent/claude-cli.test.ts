import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliRunner } from "./claude-cli.js";
import { FakeAgentRunner } from "./fake.js";
import { AgentRunError, AgentTimeoutError, type AgentMcpConfig } from "./runner.js";

// I test usano un FINTO eseguibile `claude`: uno script shell scritto in una
// tmpdir. Col passaggio a `--output-format json`, in caso di successo il CLI
// reale emette UN SINGOLO oggetto JSON su stdout. Lo script finto fa lo
// stesso: incapsula argv, cwd e stdin nel campo `result` (così le asserzioni
// sul contratto di invocazione restano possibili) e aggiunge i campi di
// consumo (`modelUsage`, `total_cost_usd`). Niente rete, quota o binario
// claude installato.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-agent-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Lo script costruisce a mano un oggetto JSON. `result` contiene ARGS/CWD/STDIN
// su righe separate (le stesse sentinelle di prima, ora dentro al JSON) così i
// test possono ancora verificarle via result.output. `modelUsage` e
// `total_cost_usd` simulano i consumi riportati dal CLI reale. jq non è
// garantito nell'ambiente di test: si costruisce il JSON con printf, facendo
// l'escape minimo (le sentinelle non contengono caratteri JSON-pericolosi
// tranne le newline, codificate come \\n).
const ECHO_SCRIPT = `#!/bin/sh
STDIN="$(cat)"
RESULT="ARGS:$*
CWD:$(pwd -P)
STDIN:$STDIN"
# Escape per JSON: backslash, doppi apici, poi newline → \\n.
ESCAPED=$(printf '%s' "$RESULT" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | awk 'BEGIN{ORS=""} NR>1{print "\\\\n"} {print}')
printf '{"result":"%s","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20,"cache_creation_input_tokens":5},"modelUsage":{"claude-opus-4-8":{"inputTokens":80,"outputTokens":40,"cacheReadInputTokens":15,"cacheCreationInputTokens":4,"costUSD":0.0100},"claude-haiku-4-5":{"inputTokens":20,"outputTokens":10,"cacheReadInputTokens":5,"cacheCreationInputTokens":1,"costUSD":0.0023}},"num_turns":3,"duration_ms":1200,"is_error":false,"subtype":"success"}\\n' "$ESCAPED"
`;

/** Scrive uno script shell eseguibile che fa da finto binario `claude`. */
async function makeFakeClaude(root: string, body: string = ECHO_SCRIPT): Promise<string> {
  const path = join(root, "claude");
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function makeCwd(root: string): Promise<string> {
  const cwd = join(root, "workdir");
  await mkdir(cwd, { recursive: true });
  // realpath: su macOS tmpdir è un symlink (/var -> /private/var) e lo script
  // riporta la directory fisica con `pwd -P`.
  return realpath(cwd);
}

/** true se il path esiste ancora (usato per verificare il cleanup). */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directory temporanee di config MCP attualmente esistenti. Serve ai test in
 * cui NESSUNO può registrare il path della config (spawn fallito, scrittura
 * fallita): si confronta l'elenco prima e dopo il run per verificare che il
 * runner non abbia lasciato residui.
 */
async function listMcpTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.startsWith("stubwise-mcp-")).sort();
}

/**
 * Finto `claude` che ISPEZIONA il file passato a `--mcp-config`: registra il
 * path in `captured-path.txt` e ne copia il contenuto in `captured-mcp.json`
 * (entrambi accanto allo script, via `$0`, così il test li ritrova senza
 * passare env). `tail` è ciò che lo script fa dopo la cattura: emettere il
 * JSON, stallare (timeout) o uscire non-zero. Serve perché il runner CANCELLA
 * il file di config a fine run: l'unico modo di ispezionarlo è farlo dal
 * child, mentre il run è vivo.
 */
function mcpProbeScript(tail: string): string {
  return `#!/bin/sh
cat > /dev/null
CFG=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--mcp-config" ]; then CFG="$a"; fi
  PREV="$a"
done
printf '%s' "$CFG" > "$(dirname "$0")/captured-path.txt"
if [ -n "$CFG" ]; then cp "$CFG" "$(dirname "$0")/captured-mcp.json"; fi
${tail}
`;
}

/** Coda del probe che emette il JSON di successo con le sole sentinelle ARGS. */
const PROBE_TAIL_OK = `printf '{"result":"ARGS:%s"}\\n' "$*"`;

/**
 * Finto `claude` che REGISTRA l'argv esatto, UN ARGOMENTO PER RIGA, in
 * `captured-argv.txt` accanto allo script (via `$0`, come il probe MCP).
 * Serve dove la sentinella `ARGS:$*` non basta: `$*` unisce gli argomenti con
 * uno spazio, quindi un argomento STRINGA VUOTA — quello di
 * `--setting-sources ""`, il caso che conta in produzione — sarebbe
 * indistinguibile da un flag senza valore. Gli argomenti del runner non
 * contengono mai newline, quindi una riga per argomento è una codifica fedele.
 */
const ARGV_PROBE_SCRIPT = `#!/bin/sh
cat > /dev/null
printf '%s\\n' "$@" > "$(dirname "$0")/captured-argv.txt"
printf '{"result":"ok"}\\n'
`;

/** Argv esatto registrato da ARGV_PROBE_SCRIPT (vuoti inclusi). */
async function readCapturedArgv(root: string): Promise<string[]> {
  const raw = await readFile(join(root, "captured-argv.txt"), "utf8");
  const lines = raw.split("\n");
  // L'ultima riga è il residuo della newline finale di printf, non un argomento.
  lines.pop();
  return lines;
}

/**
 * Prefisso argv comune a ogni run: flag headless, il --permission-mode di
 * default (acceptEdits, nessun permissionMode esplicito) e --max-turns.
 */
function baseArgv(maxTurns: number): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--max-turns",
    String(maxTurns),
  ];
}

describe("ClaudeCliRunner", () => {
  it("invoca claude con i flag headless nell'ordine atteso e --model quando fornito", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "Analizza il ticket #42",
      model: "haiku",
      maxTurns: 7,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "ARGS:-p --output-format json --permission-mode acceptEdits --max-turns 7 --model haiku",
    );
  });

  it("usa --permission-mode acceptEdits di default (nessun permissionMode esplicito)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 3, timeoutMs: 10_000 });

    expect(result.output).toContain("--permission-mode acceptEdits");
    expect(result.output).not.toContain("--permission-mode plan");
  });

  it("mappa permissionMode 'plan' su --permission-mode plan (run di pianificazione)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "analizza",
      maxTurns: 40,
      timeoutMs: 10_000,
      permissionMode: "plan",
    });

    expect(result.output).toContain(
      "ARGS:-p --output-format json --permission-mode plan --max-turns 40",
    );
    expect(result.output).not.toContain("--permission-mode acceptEdits");
  });

  it("su exit 0 imposta output = result del JSON ed estrae usage da modelUsage", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 3, timeoutMs: 10_000 });

    // output è la STRINGA result del JSON, non l'intero blob: contiene le
    // sentinelle ARGS/CWD/STDIN ma NON le chiavi JSON di consumo.
    expect(result.output).toContain("ARGS:");
    expect(result.output).toContain("STDIN:ciao");
    expect(result.output).not.toContain("modelUsage");
    expect(result.output).not.toContain("total_cost_usd");

    // usage popolato da modelUsage (una voce per modello) + total_cost_usd.
    expect(result.usage).toBeDefined();
    expect(result.usage?.totalCostUsd).toBe(0.0123);
    expect(result.usage?.models).toEqual(
      expect.arrayContaining([
        {
          model: "claude-opus-4-8",
          inputTokens: 80,
          outputTokens: 40,
          cacheReadTokens: 15,
          costUsd: 0.01,
        },
        {
          model: "claude-haiku-4-5",
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 5,
          costUsd: 0.0023,
        },
      ]),
    );
    expect(result.usage?.models).toHaveLength(2);
  });

  it("se lo stdout non è JSON valido, output = stdout grezzo e usage undefined (non lancia)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "questo non e' JSON"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("questo non e' JSON");
    expect(result.usage).toBeUndefined();
  });

  it("se manca result nel JSON, output = stdout grezzo (fallback)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
printf '{"total_cost_usd":0.5,"modelUsage":{"m1":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":0,"costUSD":0.5}}}\\n'
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    // result mancante: fallback su stdout grezzo, ma usage comunque estratto.
    expect(result.output).toContain('"total_cost_usd":0.5');
    expect(result.usage?.totalCostUsd).toBe(0.5);
    expect(result.usage?.models).toEqual([
      { model: "m1", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, costUsd: 0.5 },
    ]);
  });

  it("aggiunge --resume <id> quando resumeSessionId è fornito, lo omette altrimenti", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const conResume = await runner.run({
      cwd,
      prompt: "domanda",
      maxTurns: 15,
      timeoutMs: 10_000,
      permissionMode: "plan",
      resumeSessionId: "sess-abc-123",
    });
    expect(conResume.output).toContain(
      "ARGS:-p --output-format json --permission-mode plan --max-turns 15 --resume sess-abc-123",
    );

    const senzaResume = await runner.run({ cwd, prompt: "x", maxTurns: 1, timeoutMs: 10_000 });
    expect(senzaResume.output).not.toContain("--resume");
  });

  it("estrae session_id dal JSON del CLI (parse difensivo), undefined se assente", async () => {
    const root = await makeRoot();
    // Script che emette un JSON col campo session_id (come il CLI reale).
    const withSession = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
printf '{"result":"risposta","session_id":"cli-sess-99"}\\n'
`,
    );
    const cwd = await makeCwd(root);
    const withRunner = new ClaudeCliRunner({ claudePath: withSession });
    const withResult = await withRunner.run({ cwd, prompt: "x", maxTurns: 1, timeoutMs: 10_000 });
    expect(withResult.output).toBe("risposta");
    expect(withResult.sessionId).toBe("cli-sess-99");

    // Senza session_id → undefined (fallback ri-priming del chiamante).
    const noSession = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
printf '{"result":"altra risposta"}\\n'
`,
    );
    const noRunner = new ClaudeCliRunner({ claudePath: noSession });
    const noResult = await noRunner.run({ cwd, prompt: "x", maxTurns: 1, timeoutMs: 10_000 });
    expect(noResult.sessionId).toBeUndefined();
  });

  it("omette --model quando non specificato", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 3, timeoutMs: 10_000 });

    expect(result.output).toContain(
      "ARGS:-p --output-format json --permission-mode acceptEdits --max-turns 3",
    );
    expect(result.output).not.toContain("--model");
  });

  it("aggiunge --allowedTools con tutti i pattern quando fornito", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 80,
      timeoutMs: 10_000,
      allowedTools: ["Bash(npm test:*)", "Bash(pnpm test:*)"],
    });

    expect(result.output).toContain(
      "ARGS:-p --output-format json --permission-mode acceptEdits --max-turns 80 --allowedTools Bash(npm test:*) Bash(pnpm test:*)",
    );
  });

  it("omette --allowedTools quando non specificato o vuoto", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const omesso = await runner.run({ cwd, prompt: "ciao", maxTurns: 3, timeoutMs: 10_000 });
    expect(omesso.output).not.toContain("--allowedTools");

    const vuoto = await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 3,
      timeoutMs: 10_000,
      allowedTools: [],
    });
    expect(vuoto.output).not.toContain("--allowedTools");
  });

  it("senza pluginDirs/disallowedTools/settingSources l'argv resta quello storico", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({ cwd, prompt: "ciao", maxTurns: 5, timeoutMs: 10_000 });

    // Nessun flag NUOVO: è l'invariante dei 27 call site che non passano le
    // opzioni dei plugin.
    expect(await readCapturedArgv(root)).toEqual(baseArgv(5));
  });

  it("ripete --plugin-dir per ogni directory, NELL'ORDINE dato", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 5,
      timeoutMs: 10_000,
      // L'ordine è significativo: il plugin base di Stubwise va per primo.
      pluginDirs: ["/plugins/stubwise-base", "/plugins/superpowers"],
    });

    expect(await readCapturedArgv(root)).toEqual([
      ...baseArgv(5),
      "--plugin-dir",
      "/plugins/stubwise-base",
      "--plugin-dir",
      "/plugins/superpowers",
    ]);
  });

  it("omette --plugin-dir con lista vuota", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 5,
      timeoutMs: 10_000,
      pluginDirs: [],
    });

    expect(await readCapturedArgv(root)).toEqual(baseArgv(5));
  });

  it("aggiunge --disallowedTools con tutti i pattern (stesso formato di --allowedTools)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 5,
      timeoutMs: 10_000,
      disallowedTools: ["Skill(superpowers:brainstorming)", "Skill(superpowers:writing-plans)"],
    });

    expect(await readCapturedArgv(root)).toEqual([
      ...baseArgv(5),
      "--disallowedTools",
      "Skill(superpowers:brainstorming)",
      "Skill(superpowers:writing-plans)",
    ]);
  });

  it("omette --disallowedTools quando non specificato o vuoto", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({ cwd, prompt: "ciao", maxTurns: 5, timeoutMs: 10_000 });
    expect(await readCapturedArgv(root)).toEqual(baseArgv(5));

    await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 5,
      timeoutMs: 10_000,
      disallowedTools: [],
    });
    expect(await readCapturedArgv(root)).toEqual(baseArgv(5));
  });

  it("settingSources '' passa la STRINGA VUOTA come argomento a sé", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 5,
      timeoutMs: 10_000,
      settingSources: "",
    });

    // Due elementi in argv: il flag e un argomento vuoto. È il caso di
    // produzione — e l'unico valore che il tipo ammette (nessuna sorgente di
    // settings → insieme di skill e hook deterministico).
    expect(await readCapturedArgv(root)).toEqual([...baseArgv(5), "--setting-sources", ""]);
  });

  it("le opzioni dei plugin convivono con allowedTools e mcpConfig senza interferire", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, ARGV_PROBE_SCRIPT);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 5,
      timeoutMs: 10_000,
      allowedTools: ["Bash(npm test:*)"],
      disallowedTools: ["Skill(superpowers:brainstorming)"],
      pluginDirs: ["/plugins/stubwise-base"],
      settingSources: "",
      mcpConfig: { servers: { ask_user: { command: "node", args: ["/app/ask-user.js"] } } },
    });

    const argv = await readCapturedArgv(root);
    // Il path della config MCP è una tmpdir effimera: si legge dall'argv e si
    // verifica la forma, così il confronto sotto resta ESATTO.
    const mcpPath = argv[argv.indexOf("--mcp-config") + 1];
    expect(mcpPath).toMatch(/stubwise-mcp-.*mcp-config\.json$/);
    expect(argv).toEqual([
      ...baseArgv(5),
      "--allowedTools",
      "Bash(npm test:*)",
      "--disallowedTools",
      "Skill(superpowers:brainstorming)",
      "--plugin-dir",
      "/plugins/stubwise-base",
      "--setting-sources",
      "",
      "--mcp-config",
      mcpPath,
      "--strict-mcp-config",
    ]);
  });

  it("con mcpConfig: aggiunge --mcp-config <path> e --strict-mcp-config, e il file contiene i server", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, mcpProbeScript(PROBE_TAIL_OK));
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "pianifica",
      maxTurns: 40,
      timeoutMs: 10_000,
      permissionMode: "plan",
      mcpConfig: {
        servers: {
          stubwise_ask: {
            command: "node",
            args: ["/app/dist/ask-user-mcp/index.js"],
            env: { ASK_USER_FILE: "/tmp/stubwise-plan-1/question.json", ASK_USER_ROUND: "1" },
          },
        },
      },
    });

    expect(result.output).toContain("--mcp-config");
    // Isolamento: senza --strict-mcp-config il CLI caricherebbe anche i server
    // MCP configurati nell'immagine/utente, che nei run del worker non esistono.
    expect(result.output).toContain("--strict-mcp-config");

    // Il file scritto ha la forma che il CLI si aspetta: { mcpServers: {...} }.
    const captured: unknown = JSON.parse(await readFile(join(root, "captured-mcp.json"), "utf8"));
    expect(captured).toEqual({
      mcpServers: {
        stubwise_ask: {
          command: "node",
          args: ["/app/dist/ask-user-mcp/index.js"],
          env: { ASK_USER_FILE: "/tmp/stubwise-plan-1/question.json", ASK_USER_ROUND: "1" },
        },
      },
    });

    const configPath = await readFile(join(root, "captured-path.txt"), "utf8");
    // Il file NON sta nella cwd del run (il worktree del repo target): là
    // finirebbe sotto gli occhi di git e del safeguard anti-leak.
    expect(configPath.startsWith(cwd)).toBe(false);
    // Cleanup: file e directory temporanea rimossi a fine run.
    expect(await exists(configPath)).toBe(false);
    expect(await exists(dirname(configPath))).toBe(false);
  });

  it("omette --mcp-config e --strict-mcp-config senza mcpConfig o con zero server", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const omesso = await runner.run({ cwd, prompt: "ciao", maxTurns: 3, timeoutMs: 10_000 });
    expect(omesso.output).not.toContain("--mcp-config");
    expect(omesso.output).not.toContain("--strict-mcp-config");

    const vuoto = await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 3,
      timeoutMs: 10_000,
      mcpConfig: { servers: {} },
    });
    expect(vuoto.output).not.toContain("--mcp-config");
    expect(vuoto.output).not.toContain("--strict-mcp-config");
  });

  it("rimuove il file di config MCP anche quando il run va in timeout", async () => {
    const root = await makeRoot();
    // `exec sleep`: come nel test del timeout, così il SIGTERM colpisce il
    // processo che tiene aperta la pipe.
    const claudePath = await makeFakeClaude(root, mcpProbeScript(`exec sleep 10`));
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    await expect(
      runner.run({
        cwd,
        prompt: "ciao",
        maxTurns: 1,
        timeoutMs: 500,
        mcpConfig: { servers: { s: { command: "node" } } },
      }),
    ).rejects.toThrow(AgentTimeoutError);

    const configPath = await readFile(join(root, "captured-path.txt"), "utf8");
    expect(configPath).not.toBe("");
    expect(await exists(configPath)).toBe(false);
    expect(await exists(dirname(configPath))).toBe(false);
  });

  it("rimuove il file di config MCP anche quando il run esce non-zero", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, mcpProbeScript(`exit 3`));
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 1,
      timeoutMs: 10_000,
      mcpConfig: { servers: { s: { command: "node" } } },
    });

    expect(result.exitCode).toBe(3);
    const configPath = await readFile(join(root, "captured-path.txt"), "utf8");
    expect(configPath).not.toBe("");
    expect(await exists(configPath)).toBe(false);
    expect(await exists(dirname(configPath))).toBe(false);
  });

  it("rimuove il file di config MCP anche quando lo spawn fallisce (binario inesistente)", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath: join(root, "non-esiste") });
    const before = await listMcpTempDirs();

    await expect(
      runner.run({
        cwd,
        prompt: "ciao",
        maxTurns: 1,
        timeoutMs: 10_000,
        mcpConfig: { servers: { s: { command: "node" } } },
      }),
    ).rejects.toThrow(AgentRunError);

    // Il binario non esiste: nessuno può registrare il path della config, ma la
    // directory temporanea non deve sopravvivere al run.
    expect(await listMcpTempDirs()).toEqual(before);
  });

  it("traduce un fallimento di scrittura della config MCP in AgentRunError, senza lasciare residui", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });
    const before = await listMcpTempDirs();

    // Config NON serializzabile: JSON.stringify lancia DOPO la mkdtemp, cioè
    // esattamente lo scenario in cui la directory resterebbe orfana.
    const circolare: Record<string, unknown> = { command: "node" };
    circolare["self"] = circolare;
    const mcpConfig = { servers: { s: circolare } } as unknown as AgentMcpConfig;

    const promise = runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000, mcpConfig });

    await expect(promise).rejects.toThrow(AgentRunError);
    await expect(promise).rejects.toThrow(/configurazione MCP/i);
    // La causa originale (l'errore di serializzazione) è conservata.
    const error = await promise.then(
      () => {
        throw new Error("atteso un AgentRunError, ma run() ha risolto");
      },
      (e: unknown) => e as AgentRunError,
    );
    expect(error.cause).toBeInstanceOf(Error);
    expect(await listMcpTempDirs()).toEqual(before);
  });

  it("mcpConfig NON allarga l'env del child: le env dei server MCP restano nel file di config", async () => {
    const root = await makeRoot();
    // Lo script emette l'env del child oltre a catturare la config: le var del
    // server MCP devono comparire SOLO nel file, mai nell'env del processo CLI.
    const claudePath = await makeFakeClaude(
      root,
      mcpProbeScript(`printf '{"result":"ENV:%s"}\\n' "$(env | tr '\\n' ';')"`),
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 1,
      timeoutMs: 10_000,
      mcpConfig: {
        servers: { s: { command: "node", env: { ASK_USER_FILE: "/tmp/q.json" } } },
      },
    });

    expect(result.output).not.toContain("ASK_USER_FILE");
    const captured: unknown = JSON.parse(await readFile(join(root, "captured-mcp.json"), "utf8"));
    expect(captured).toMatchObject({
      mcpServers: { s: { env: { ASK_USER_FILE: "/tmp/q.json" } } },
    });
  });

  it("passa il prompt via stdin, MAI in argv", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });
    const prompt = "Contenuto NON fidato del ticket\ncon più righe e 'quote' $(pericolose)";

    const result = await runner.run({ cwd, prompt, maxTurns: 1, timeoutMs: 10_000 });

    const argsLine = result.output.split("\n").find((l) => l.startsWith("ARGS:"));
    expect(argsLine).toBeDefined();
    expect(argsLine).not.toContain("Contenuto NON fidato");
    expect(result.output).toContain(`STDIN:${prompt}`);
  });

  it("esegue nel cwd richiesto", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.output).toContain(`CWD:${cwd}`);
  });

  it("propaga l'exit code non-zero come risultato (niente eccezione) con stdout+stderr combinati", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "report parziale"
echo "errore del modello" >&2
exit 3
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("report parziale");
    expect(result.output).toContain("errore del modello");
  });

  it("lancia AgentTimeoutError con l'output parziale quando il processo supera il timeout", async () => {
    const root = await makeRoot();
    // `exec sleep`: lo sleep RIMPIAZZA la shell, così il SIGTERM del timeout
    // colpisce il processo che tiene aperta la pipe di stdout (altrimenti sh
    // muore ma lo sleep orfano terrebbe lo stream aperto per 10s).
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "PARZIALE prima dello stallo"
exec sleep 10
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const promise = runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 500 });

    await expect(promise).rejects.toThrow(AgentTimeoutError);
    const error = await promise.then(
      () => {
        throw new Error("atteso un timeout, ma run() ha risolto");
      },
      (e: unknown) => e as AgentTimeoutError,
    );
    expect(error.partialOutput).toContain("PARZIALE prima dello stallo");
    expect(error.timeoutMs).toBe(500);
  });

  it("rifiuta maxTurns non positivo o non intero con AgentRunError, senza spawnare", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    // claudePath inesistente: se la validazione spawnasse, l'errore sarebbe diverso.
    const runner = new ClaudeCliRunner({ claudePath: join(root, "non-esiste") });

    for (const maxTurns of [0, -1, 1.5]) {
      // Regex sul messaggio (non solo sul tipo): se la validazione venisse
      // rimossa, lo spawn fallito lancerebbe comunque AgentRunError ma con
      // un messaggio diverso — il test deve distinguere i due casi.
      await expect(runner.run({ cwd, prompt: "ciao", maxTurns, timeoutMs: 1000 })).rejects.toThrow(
        /maxTurns non valido/,
      );
    }
  });

  it("rifiuta timeoutMs non positivo con AgentRunError", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath: join(root, "non-esiste") });

    for (const timeoutMs of [0, -100]) {
      await expect(runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs })).rejects.toThrow(
        /timeoutMs non valido/,
      );
    }
  });

  it("lancia AgentRunError se il binario claude non esiste (spawn failure)", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath: join(root, "non-esiste") });

    await expect(runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 1000 })).rejects.toThrow(
      AgentRunError,
    );
  });

  it("inoltra extraEnv al processo (in aggiunta all'env del worker)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "ENV:$STUBWISE_TEST_VAR"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath, extraEnv: { STUBWISE_TEST_VAR: "ciao-env" } });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.output).toContain("ENV:ciao-env");
  });

  it("NON inoltra all'agente i segreti del worker (ENCRYPTION_KEY/DATABASE_URL/SESSION_SECRET) ma sì PATH, USER/LOGNAME e le var di auth claude", async () => {
    // Sentinelle su process.env: i segreti del master NON devono raggiungere
    // il child (un ticket ostile che ottiene injection li esfiltrerebbe via un
    // comando di test). PATH, USER/LOGNAME e le var di auth claude invece SÌ:
    // senza, il CLI non si autentica e non trova i binari. USER in particolare
    // serve all'auth OAuth/MAX su macOS (lookup del Keychain del login).
    process.env.ENCRYPTION_KEY = "SENTINEL-ENCRYPTION-KEY";
    process.env.DATABASE_URL = "postgres://SENTINEL/db";
    process.env.SESSION_SECRET = "SENTINEL-SESSION-SECRET";
    process.env.ANTHROPIC_API_KEY = "sk-ant-sentinel";
    process.env.USER = "smoke-user";
    process.env.LOGNAME = "smoke-logname";
    cleanups.push(async () => {
      delete process.env.ENCRYPTION_KEY;
      delete process.env.DATABASE_URL;
      delete process.env.SESSION_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.USER;
      delete process.env.LOGNAME;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "ENCRYPTION_KEY:[\${ENCRYPTION_KEY:-MANCANTE}]"
echo "DATABASE_URL:[\${DATABASE_URL:-MANCANTE}]"
echo "SESSION_SECRET:[\${SESSION_SECRET:-MANCANTE}]"
echo "ANTHROPIC_API_KEY:[\${ANTHROPIC_API_KEY:-MANCANTE}]"
echo "USER:[\${USER:-MANCANTE}]"
echo "LOGNAME:[\${LOGNAME:-MANCANTE}]"
echo "PATH_PRESENT:[\${PATH:+SI}]"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    // I segreti del master NON raggiungono il child.
    expect(result.output).toContain("ENCRYPTION_KEY:[MANCANTE]");
    expect(result.output).toContain("DATABASE_URL:[MANCANTE]");
    expect(result.output).toContain("SESSION_SECRET:[MANCANTE]");
    // Le var di auth claude, USER/LOGNAME e PATH invece sì.
    expect(result.output).toContain("ANTHROPIC_API_KEY:[sk-ant-sentinel]");
    expect(result.output).toContain("USER:[smoke-user]");
    expect(result.output).toContain("LOGNAME:[smoke-logname]");
    expect(result.output).toContain("PATH_PRESENT:[SI]");
  });

  it("NON inoltra una var allowlistata ma VUOTA, sì se non-vuota (ANTHROPIC_API_KEY='' vs valorizzata)", async () => {
    // ANTHROPIC_API_KEY="" su process.env (capita quando compose la definisce
    // con `:-` e l'utente ha scelto l'OAuth login): un valore vuoto che
    // raggiunge il child puo' sabotare un login OAuth valido. Difesa a valle:
    // le stringhe vuote NON vengono inoltrate. Una chiave non-vuota invece sì.
    process.env.ANTHROPIC_API_KEY = "";
    cleanups.push(async () => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "ANTHROPIC_API_KEY:[\${ANTHROPIC_API_KEY:-MANCANTE}]"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    // Vuota: deve risultare ASSENTE (MANCANTE) nel child, non "".
    const vuota = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });
    expect(vuota.output).toContain("ANTHROPIC_API_KEY:[MANCANTE]");

    // Non-vuota: deve essere inoltrata.
    process.env.ANTHROPIC_API_KEY = "sk-ant-non-vuota";
    const piena = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });
    expect(piena.output).toContain("ANTHROPIC_API_KEY:[sk-ant-non-vuota]");
  });

  it("extraEnv può aggiungere variabili esplicite (allowlist a parte)", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "EXTRA:\${STUBWISE_TEST_VAR:-MANCANTE}"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath, extraEnv: { STUBWISE_TEST_VAR: "ciao-env" } });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.output).toContain("EXTRA:ciao-env");
  });

  it("extraEnv NON può forzare un segreto fuori allowlist nel child", async () => {
    // Anche se un chiamante (per errore) mettesse ENCRYPTION_KEY in extraEnv,
    // l'allowlist deve avere l'ultima parola: niente segreti del master.
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "ENCRYPTION_KEY:[\${ENCRYPTION_KEY:-MANCANTE}]"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({
      claudePath,
      extraEnv: { ENCRYPTION_KEY: "tentativo-di-leak" },
    });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.output).toContain("ENCRYPTION_KEY:[MANCANTE]");
  });
});

describe("ClaudeCliRunner provider/credenziale (env per kind)", () => {
  // Script che riporta le due var di auth claude: serve per verificare quale
  // viene iniettata e quale esclusa in base al kind della credenziale.
  const AUTH_ECHO = `#!/bin/sh
cat > /dev/null
echo "ANTHROPIC_API_KEY:[\${ANTHROPIC_API_KEY:-MANCANTE}]"
echo "CLAUDE_CODE_OAUTH_TOKEN:[\${CLAUDE_CODE_OAUTH_TOKEN:-MANCANTE}]"
`;

  it("provider kind 'api_key': inietta ANTHROPIC_API_KEY=secret ed ESCLUDE CLAUDE_CODE_OAUTH_TOKEN ereditato", async () => {
    // Token OAuth nel container: con una API key da catena NON deve passare
    // (niente auth doppia).
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-ereditato-dal-container";
    cleanups.push(async () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, AUTH_ECHO);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 1,
      timeoutMs: 10_000,
      provider: { id: "p1", kind: "api_key", secret: "sk-ant-da-catena" },
    });

    expect(result.output).toContain("ANTHROPIC_API_KEY:[sk-ant-da-catena]");
    expect(result.output).toContain("CLAUDE_CODE_OAUTH_TOKEN:[MANCANTE]");
  });

  it("provider kind 'account': inietta CLAUDE_CODE_OAUTH_TOKEN=secret ed ESCLUDE ANTHROPIC_API_KEY ereditato (CRITICO)", async () => {
    // API key nel container: con un account da catena NON deve passare,
    // altrimenti vincerebbe sull'OAuth e saboterebbe l'account.
    process.env.ANTHROPIC_API_KEY = "sk-ant-ereditato-dal-container";
    cleanups.push(async () => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, AUTH_ECHO);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "fixa",
      maxTurns: 1,
      timeoutMs: 10_000,
      provider: { id: "p2", kind: "account", secret: "oauth-token-da-catena" },
    });

    expect(result.output).toContain("CLAUDE_CODE_OAUTH_TOKEN:[oauth-token-da-catena]");
    // Il punto CRITICO: la API key del container NON raggiunge il child.
    expect(result.output).toContain("ANTHROPIC_API_KEY:[MANCANTE]");
  });

  it("senza provider: comportamento storico (ANTHROPIC_API_KEY del container passa se presente)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-del-container";
    cleanups.push(async () => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root, AUTH_ECHO);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.output).toContain("ANTHROPIC_API_KEY:[sk-ant-del-container]");
  });

  it("la denylist resta rispettata anche con un provider iniettato", async () => {
    process.env.ENCRYPTION_KEY = "SENTINEL-ENCRYPTION-KEY";
    cleanups.push(async () => {
      delete process.env.ENCRYPTION_KEY;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "ENCRYPTION_KEY:[\${ENCRYPTION_KEY:-MANCANTE}]"
echo "ANTHROPIC_API_KEY:[\${ANTHROPIC_API_KEY:-MANCANTE}]"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({
      cwd,
      prompt: "ciao",
      maxTurns: 1,
      timeoutMs: 10_000,
      provider: { id: "p3", kind: "api_key", secret: "sk-ant-da-catena" },
    });

    expect(result.output).toContain("ENCRYPTION_KEY:[MANCANTE]");
    expect(result.output).toContain("ANTHROPIC_API_KEY:[sk-ant-da-catena]");
  });
});

describe("FakeAgentRunner", () => {
  it("restituisce output ed exit code di default e registra le chiamate", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const fake = new FakeAgentRunner();

    const result = await fake.run({ cwd, prompt: "primo prompt", maxTurns: 5, timeoutMs: 1000 });

    expect(result).toEqual({ output: "FAKE OK", exitCode: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ cwd, prompt: "primo prompt", maxTurns: 5 });
  });

  it("applica fileChanges relativi al cwd creando le directory intermedie", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const fake = new FakeAgentRunner({
      fileChanges: {
        "src/fix.ts": "export const fixed = true;\n",
        "README.md": "# patched\n",
      },
      output: "patch applicata",
      exitCode: 0,
    });

    const result = await fake.run({ cwd, prompt: "fixa", maxTurns: 80, timeoutMs: 1000 });

    expect(result.output).toBe("patch applicata");
    expect(await readFile(join(cwd, "src", "fix.ts"), "utf8")).toBe("export const fixed = true;\n");
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("# patched\n");
  });

  it("usa la funzione script (anche sincrona) quando fornita", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const fake = new FakeAgentRunner({
      script: (opts) => ({ output: `visto modello ${opts.model ?? "default"}`, exitCode: 2 }),
    });

    const result = await fake.run({ cwd, prompt: "ciao", model: "haiku", maxTurns: 1, timeoutMs: 1000 });

    expect(result).toEqual({ output: "visto modello haiku", exitCode: 2 });
    expect(fake.calls).toHaveLength(1);
  });

  it("registra ogni chiamata in ordine", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const fake = new FakeAgentRunner();

    await fake.run({ cwd, prompt: "triage", model: "haiku", maxTurns: 3, timeoutMs: 1000 });
    await fake.run({
      cwd,
      prompt: "fix",
      maxTurns: 80,
      timeoutMs: 1000,
      allowedTools: ["Bash(npm test:*)"],
    });

    expect(fake.calls.map((c) => c.prompt)).toEqual(["triage", "fix"]);
    expect(fake.calls[0]?.model).toBe("haiku");
    expect(fake.calls[1]?.model).toBeUndefined();
    expect(fake.calls[1]?.allowedTools).toEqual(["Bash(npm test:*)"]);
  });

  it("registra mcpConfig tra le opzioni della chiamata (undefined quando assente)", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const fake = new FakeAgentRunner();

    const mcpConfig = {
      servers: {
        stubwise_ask: {
          command: "node",
          args: ["/app/dist/ask-user-mcp/index.js"],
          env: { ASK_USER_FILE: "/tmp/stubwise-plan-1/question.json" },
        },
      },
    };
    await fake.run({ cwd, prompt: "pianifica", maxTurns: 40, timeoutMs: 1000, mcpConfig });
    await fake.run({ cwd, prompt: "esegui", maxTurns: 80, timeoutMs: 1000 });

    expect(fake.calls[0]?.mcpConfig).toEqual(mcpConfig);
    expect(fake.calls[1]?.mcpConfig).toBeUndefined();
  });

  it("registra pluginDirs/disallowedTools/settingSources tra le opzioni della chiamata", async () => {
    const root = await makeRoot();
    const cwd = await makeCwd(root);
    const fake = new FakeAgentRunner();

    await fake.run({
      cwd,
      prompt: "fixa",
      maxTurns: 80,
      timeoutMs: 1000,
      pluginDirs: ["/plugins/stubwise-base", "/plugins/superpowers"],
      disallowedTools: ["Skill(superpowers:brainstorming)"],
      settingSources: "",
    });
    await fake.run({ cwd, prompt: "triage", maxTurns: 5, timeoutMs: 1000 });

    // L'ordine dei pluginDirs è parte del contratto: il plugin base va primo.
    expect(fake.calls[0]?.pluginDirs).toEqual([
      "/plugins/stubwise-base",
      "/plugins/superpowers",
    ]);
    expect(fake.calls[0]?.disallowedTools).toEqual(["Skill(superpowers:brainstorming)"]);
    expect(fake.calls[0]?.settingSources).toBe("");
    expect(fake.calls[1]?.pluginDirs).toBeUndefined();
    expect(fake.calls[1]?.disallowedTools).toBeUndefined();
    expect(fake.calls[1]?.settingSources).toBeUndefined();
  });
});
