import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { BASE_PLUGIN_NAME, basePluginPath } from "./base.js";

/**
 * Test del plugin base bundlato nell'immagine del worker.
 *
 * Sono test di COMPORTAMENTO, non di testo sorgente: l'hook viene eseguito
 * davvero con `sh` e il suo stdout viene passato a `JSON.parse`. È l'unico modo
 * per accorgersi che un apostrofo o una virgoletta nel contratto rompono il
 * JSON — un hook che stampa spazzatura degraderebbe ogni run.
 */

function pluginDir(): string {
  const dir = basePluginPath();
  if (!dir) throw new Error("plugin base non trovato accanto al modulo");
  return dir;
}

/** Esegue lo script dell'hook con `sh`, con lo stdin e l'env indicati. */
async function runHook(
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = join(pluginDir(), "hooks", "session-start.sh");
  // `/bin/sh` assoluto: uno dei casi mette in PATH una dir inesistente.
  const child = spawn("/bin/sh", [script], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir(), ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  // Lo script può uscire PRIMA che la scrittura su stdin sia stata consumata —
  // è proprio quello che fa il caso del node rotto, che esce subito dopo la
  // command substitution. Quando succede la pipe è già chiusa e la write emette
  // un EPIPE ASINCRONO: senza un handler diventa un'eccezione non gestita che
  // fa fallire l'intero run di vitest a test verdi (visto in CI, non in locale:
  // è una corsa che perde solo su una macchina lenta o carica).
  // Qui l'EPIPE è atteso e innocuo — questi test asseriscono sul codice di
  // uscita e su stdout, non sul fatto che lo script abbia letto lo stdin.
  // Si ignora SOLO EPIPE: un altro errore sulla pipe resta un errore vero.
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  child.stdin.write(options.stdin ?? "");
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

describe("basePluginPath", () => {
  it("risolve la directory del plugin base accanto al modulo", () => {
    const dir = basePluginPath();
    expect(dir).not.toBeNull();
    // L'invariante che regge sia in `src/plugins` sia in `dist/plugins`
    // (nell'immagine: `/app/dist/plugins/base.js` → `/app/plugins/stubwise-base`).
    expect(relative(join(dir!, "..", ".."), dir!).split("/")).toEqual([
      "plugins",
      BASE_PLUGIN_NAME,
    ]);
  });
});

describe("manifest del plugin base", () => {
  it("plugin.json è JSON valido e si chiama stubwise-base", () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginDir(), ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown; description?: unknown };
    expect(manifest.name).toBe(BASE_PLUGIN_NAME);
    expect(typeof manifest.description).toBe("string");
  });

  it("hooks.json registra il SessionStart sullo script del plugin", () => {
    const hooks = JSON.parse(
      readFileSync(join(pluginDir(), "hooks", "hooks.json"), "utf8"),
    ) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { type: string; command: string }[] }[]
      >;
    };
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart"]);
    const groups = hooks.hooks.SessionStart;
    expect(groups).toHaveLength(1);
    // `compact` NON e' di troppo: i run lunghi auto-compattano e dopo la
    // compaction sia il prompt sia l'additionalContext sopravvivono solo
    // diluiti nel riassunto, proprio dove le skill di terze parti spingono di
    // piu' a committare. Costo: ~370 token re-iniettati per compaction.
    expect(groups?.[0]?.matcher).toBe("startup|resume|compact");
    expect(groups?.[0]?.hooks).toEqual([
      {
        type: "command",
        command: "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
      },
    ]);
  });

  it("lo script dell'hook è eseguibile (il bit sta in git)", () => {
    const mode = statSync(join(pluginDir(), "hooks", "session-start.sh")).mode;
    expect(mode & 0o111).toBe(0o111);
  });

  it("espone UNA sola skill, con frontmatter name/description", () => {
    const skill = readFileSync(
      join(pluginDir(), "skills", "stubwise-conventions", "SKILL.md"),
      "utf8",
    );
    expect(skill.startsWith("---\n")).toBe(true);
    const frontmatter = skill.slice(4, skill.indexOf("\n---\n", 3));
    expect(frontmatter).toMatch(/^name: stubwise-conventions$/m);
    expect(frontmatter).toMatch(/^description: \S/m);
  });
});

describe("hook SessionStart", () => {
  it("stampa un JSON valido col contratto della run", async () => {
    const { code, stdout } = await runHook({
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const contract = parsed.hookSpecificOutput.additionalContext;
    // I punti del contratto (design §3): niente commit/push, il report è il
    // body della PR, pianificazione read-only con decisioni, domande via
    // ask_user, e i quattro adattamenti espliciti alle skill di superpowers.
    for (const needle of [
      "commit",
      "push",
      "STUBWISE_REPORT.md",
      "ask_user",
      "superpowers:brainstorming",
      "superpowers:using-git-worktrees",
      "superpowers:finishing-a-development-branch",
      "superpowers:dispatching-parallel-agents",
      "superpowers:subagent-driven-development",
    ]) {
      expect(contract).toContain(needle);
    }
    expect(contract.toLowerCase()).toContain("read-only");
    expect(contract.toLowerCase()).toContain("decision");
    // Lo stesso hook entra anche nei run di backlog (deep dive, chat), dove il
    // deliverable NON e' un piano: la forma la decide il prompt, non il
    // contratto. Senza questa riga il contratto istruirebbe male quei run.
    expect(contract).toContain("your prompt");
  });

  it("risponde anche alla compaction (source: compact)", async () => {
    // Lo script e' agnostico al `source`; il test fissa l'intento del matcher.
    const { code, stdout } = await runHook({
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "compact",
      }),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("git commit");
  });

  it("resta sotto i 400 token stimati (~4 caratteri per token)", async () => {
    const { stdout } = await runHook({ stdin: "{}" });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(
      Math.ceil(parsed.hookSpecificOutput.additionalContext.length / 4),
    ).toBeLessThan(400);
  });

  it("non si blocca né fallisce con stdin vuoto", async () => {
    const { code, stdout } = await runHook({ stdin: "" });
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("esce 0 in silenzio se node fallisce sporcando stdout", async () => {
    // Protegge la command substitution + `|| exit 0`: senza, la spazzatura di
    // un node rotto finirebbe nel contesto della sessione a ogni run.
    const fakeBin = mkdtempSync(join(tmpdir(), "stubwise-fake-node-"));
    writeFileSync(
      join(fakeBin, "node"),
      "#!/bin/sh\necho 'non sono JSON'\nexit 1\n",
      { mode: 0o755 },
    );
    const { code, stdout } = await runHook({
      stdin: "{}",
      env: { PATH: fakeBin },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("esce 0 in silenzio se node non è sul PATH", async () => {
    // Fail-open: un hook che non riesce a costruire il JSON non deve poter
    // degradare il run (stdout non-JSON sarebbe peggio del contratto assente).
    const { code, stdout } = await runHook({
      stdin: "{}",
      env: { PATH: "/nonexistent-stubwise" },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
