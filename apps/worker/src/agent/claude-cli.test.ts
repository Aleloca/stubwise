import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliRunner } from "./claude-cli.js";
import { FakeAgentRunner } from "./fake.js";
import { AgentRunError, AgentTimeoutError } from "./runner.js";

// I test usano un FINTO eseguibile `claude`: uno script shell scritto in una
// tmpdir che echeggia argv (`ARGS:`), la working directory (`CWD:`) e lo
// stdin (`STDIN:`). Così verifichiamo il contratto di invocazione del CLI
// reale (flag, cwd, prompt via stdin, exit code, timeout) senza rete, quota
// o binario claude installato.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-agent-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

const ECHO_SCRIPT = `#!/bin/sh
echo "ARGS:$*"
echo "CWD:$(pwd -P)"
printf 'STDIN:%s\\n' "$(cat)"
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
      "ARGS:-p --output-format text --permission-mode acceptEdits --max-turns 7 --model haiku",
    );
  });

  it("omette --model quando non specificato", async () => {
    const root = await makeRoot();
    const claudePath = await makeFakeClaude(root);
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 3, timeoutMs: 10_000 });

    expect(result.output).toContain(
      "ARGS:-p --output-format text --permission-mode acceptEdits --max-turns 3",
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
      "ARGS:-p --output-format text --permission-mode acceptEdits --max-turns 80 --allowedTools Bash(npm test:*) Bash(pnpm test:*)",
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

  it("inoltra l'env del worker al processo anche quando extraEnv è definita (extendEnv default di execa)", async () => {
    // Sentinella su process.env: se passassimo `env` con extendEnv:false,
    // il CLI perderebbe l'ambiente del worker (PATH, config di claude, ...).
    process.env.STUBWISE_INHERITED_SENTINEL = "ereditata-dal-worker";
    cleanups.push(async () => {
      delete process.env.STUBWISE_INHERITED_SENTINEL;
    });

    const root = await makeRoot();
    const claudePath = await makeFakeClaude(
      root,
      `#!/bin/sh
cat > /dev/null
echo "INHERITED:$STUBWISE_INHERITED_SENTINEL"
echo "EXTRA:$STUBWISE_TEST_VAR"
`,
    );
    const cwd = await makeCwd(root);
    const runner = new ClaudeCliRunner({ claudePath, extraEnv: { STUBWISE_TEST_VAR: "ciao-env" } });

    const result = await runner.run({ cwd, prompt: "ciao", maxTurns: 1, timeoutMs: 10_000 });

    expect(result.output).toContain("INHERITED:ereditata-dal-worker");
    expect(result.output).toContain("EXTRA:ciao-env");
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
});
