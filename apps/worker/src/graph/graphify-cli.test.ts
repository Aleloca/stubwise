import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphifyRunner, GRAPHIFY_OUTPUT_MAX_CHARS } from "./graphify-cli.js";

/**
 * Verifica REALE del wrapper (nessun mock di execa): al posto del binario
 * graphify si spawna il Node corrente, che stampa ciò che vede (argv, cwd, env)
 * ed esce col codice richiesto. Così si controllano il contratto di errori
 * (exit non-zero, timeout e binario assente sono RISULTATI, non eccezioni) e
 * l'env passato al child — l'auth del claude CLI dentro, i segreti fuori.
 */
describe("createGraphifyRunner", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "graphify-cli-"));
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  it("passa argomenti, cwd e GRAPHIFY_OUT al processo e cattura l'output", async () => {
    const run = createGraphifyRunner(process.execPath);
    const result = await run({
      args: [
        "-e",
        // Con `node -e <script> a b c` gli argomenti extra partono da argv[1].
        "console.log('ARGV=' + process.argv.slice(1).join('|')); console.log('CWD=' + process.cwd()); console.log('OUT=' + (process.env.GRAPHIFY_OUT ?? 'UNSET'))",
        "extract",
        "/wt",
        "--code-only",
      ],
      cwd: dir,
      extraEnv: { GRAPHIFY_OUT: "/graphs/repo-1/graphify-out" },
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ARGV=extract|/wt|--code-only");
    // macOS risolve /tmp in /private/tmp: basta il suffisso della dir reale.
    expect(result.output).toContain(`CWD=`);
    expect(result.output).toContain("OUT=/graphs/repo-1/graphify-out");
  });

  it("cattura stderr e NON lancia su exit non-zero", async () => {
    const run = createGraphifyRunner(process.execPath);
    const result = await run({
      args: ["-e", "console.error('boom sul grafo'); process.exit(3)"],
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom sul grafo");
  });

  it("inoltra l'auth del claude CLI e le var GRAPHIFY_*, ma non i segreti del master", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token-oauth";
    process.env.GRAPHIFY_CLAUDE_CLI_MODEL = "haiku";
    process.env.ENCRYPTION_KEY = "segreto-del-master";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/stubwise";

    const run = createGraphifyRunner(process.execPath);
    const result = await run({
      args: [
        "-e",
        "console.log(['PATH','HOME','CLAUDE_CODE_OAUTH_TOKEN','GRAPHIFY_CLAUDE_CLI_MODEL','ENCRYPTION_KEY','DATABASE_URL'].map((k) => k + '=' + (process.env[k] ?? 'UNSET')).join('\\n'))",
      ],
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("CLAUDE_CODE_OAUTH_TOKEN=token-oauth");
    expect(result.output).toContain("GRAPHIFY_CLAUDE_CLI_MODEL=haiku");
    expect(result.output).not.toContain("PATH=UNSET");
    expect(result.output).toContain("ENCRYPTION_KEY=UNSET");
    expect(result.output).toContain("DATABASE_URL=UNSET");
  });

  it("il timeout è un risultato con exit non-zero e motivo, non un'eccezione", async () => {
    const run = createGraphifyRunner(process.execPath);
    const result = await run({
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: dir,
      timeoutMs: 200,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("timeout");
  });

  it("il binario assente è un risultato con il motivo nell'output", async () => {
    const run = createGraphifyRunner(join(dir, "graphify-che-non-esiste"));
    const result = await run({ args: ["extract"], cwd: dir, timeoutMs: 30_000 });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("non eseguibile");
  });

  it("tronca gli output enormi", async () => {
    const run = createGraphifyRunner(process.execPath);
    const result = await run({
      args: ["-e", `console.log('x'.repeat(${GRAPHIFY_OUTPUT_MAX_CHARS * 2}))`],
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[output troncato]");
    expect(result.output.length).toBeLessThan(GRAPHIFY_OUTPUT_MAX_CHARS + 100);
  });
});
