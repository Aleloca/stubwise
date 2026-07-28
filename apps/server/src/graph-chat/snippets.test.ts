import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorSlug } from "@stubwise/shared/mirror-slug";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractSnippets } from "./snippets.js";

/**
 * Nessun mock di git: i test girano su un mirror BARE vero, clonato da un repo
 * temporaneo con due commit. È l'unico modo per verificare davvero il pezzo
 * delicato — leggere il contenuto AL COMMIT del grafo, non quello attuale.
 */

/** URL fittizio del repository: serve solo a calcolare lo slug della dir. */
const REPO_URL = "https://git.example.com/acme/demo.git";

/** File di 60 righe numerate: il numero di riga è nel testo, così le asserzioni sono leggibili. */
function numberedFile(marker: string, lines = 60): string {
  return Array.from({ length: lines }, (_, i) => `riga ${i + 1} ${marker}`).join("\n") + "\n";
}

let root: string;
let mirrorsDir: string;
/** Sha del PRIMO commit: contiene la versione "v1" di alpha.ts. */
let firstSha: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "graph-snippets-"));
  const repo = join(root, "source");
  mirrorsDir = join(root, "mirrors");
  await mkdir(join(repo, "src"), { recursive: true });

  const git = (args: string[]) => execa("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);

  await writeFile(join(repo, "src", "alpha.ts"), numberedFile("v1"));
  await writeFile(join(repo, "src", "beta.ts"), numberedFile("beta"));
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "primo commit"]);
  firstSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

  // Secondo commit: alpha.ts cambia (v2) e nasce gamma.ts, assente nel primo.
  await writeFile(join(repo, "src", "alpha.ts"), numberedFile("v2"));
  await writeFile(join(repo, "src", "gamma.ts"), numberedFile("gamma"));
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "secondo commit"]);

  await mkdir(mirrorsDir, { recursive: true });
  await execa("git", ["clone", "--bare", "-q", repo, join(mirrorsDir, mirrorSlug(REPO_URL))]);
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** Parametri di default: i singoli test sovrascrivono ciò che serve. */
function params(overrides: Partial<Parameters<typeof extractSnippets>[0]> = {}) {
  return {
    mirrorsDir,
    repoUrl: REPO_URL,
    commitSha: firstSha,
    nodes: [],
    maxNodes: 6,
    maxTotalChars: 100_000,
    ...overrides,
  };
}

describe("extractSnippets", () => {
  it("apre una finestra [L-3, L+35] attorno al nodo", async () => {
    const snippets = await extractSnippets(
      params({ nodes: [{ label: "alpha", path: "src/alpha.ts", line: 20 }] }),
    );

    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({ path: "src/alpha.ts", startLine: 17, endLine: 55 });
    const lines = snippets[0]!.code.split("\n");
    expect(lines[0]).toBe("riga 17 v1");
    expect(lines.at(-1)).toBe("riga 55 v1");
  });

  it("clampa la finestra ai bordi del file", async () => {
    const snippets = await extractSnippets(
      params({
        nodes: [
          { label: "inizio", path: "src/alpha.ts", line: 2 },
          { label: "fine", path: "src/beta.ts", line: 58 },
        ],
      }),
    );

    // Riga 2: start non può scendere sotto 1.
    expect(snippets[0]).toMatchObject({ startLine: 1, endLine: 37 });
    expect(snippets[0]!.code.split("\n")[0]).toBe("riga 1 v1");
    // Riga 58 su un file di 60: end si ferma all'ultima riga.
    expect(snippets[1]).toMatchObject({ startLine: 55, endLine: 60 });
    expect(snippets[1]!.code.split("\n").at(-1)).toBe("riga 60 beta");
  });

  it("legge il contenuto AL COMMIT indicato, non quello di HEAD", async () => {
    const snippets = await extractSnippets(
      params({ nodes: [{ label: "alpha", path: "src/alpha.ts", line: 10 }] }),
    );

    expect(snippets[0]!.code).toContain("riga 10 v1");
    expect(snippets[0]!.code).not.toContain("v2");
  });

  it("ripiega su HEAD quando lo sha non risolve", async () => {
    const snippets = await extractSnippets(
      params({
        commitSha: "0".repeat(40),
        nodes: [{ label: "alpha", path: "src/alpha.ts", line: 10 }],
      }),
    );

    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.code).toContain("riga 10 v2");
  });

  it("salta in silenzio i file assenti in quel commit e prosegue con gli altri", async () => {
    const snippets = await extractSnippets(
      params({
        nodes: [
          // Non esiste in nessun commit: né lo sha né il fallback HEAD lo trovano.
          { label: "manca", path: "src/inesistente.ts", line: 5 },
          { label: "beta", path: "src/beta.ts", line: 5 },
        ],
      }),
    );

    expect(snippets.map((s) => s.path)).toEqual(["src/beta.ts"]);
  });

  it("usa il fallback HEAD anche per un file nato dopo il commit del grafo", async () => {
    const snippets = await extractSnippets(
      params({ nodes: [{ label: "gamma", path: "src/gamma.ts", line: 5 }] }),
    );

    expect(snippets[0]!.code).toContain("riga 5 gamma");
  });

  it("si ferma al tetto di caratteri senza aggiungere lo snippet che sfora", async () => {
    const snippets = await extractSnippets(
      params({
        maxTotalChars: 600,
        nodes: [
          { label: "uno", path: "src/alpha.ts", line: 20 },
          { label: "due", path: "src/beta.ts", line: 20 },
          { label: "tre", path: "src/beta.ts", line: 50 },
        ],
      }),
    );

    // Una finestra di 39 righe è ~450 char: la prima entra, la seconda sfora.
    expect(snippets.map((s) => s.path)).toEqual(["src/alpha.ts"]);
    expect(snippets[0]!.code.length).toBeLessThanOrEqual(600);
  });

  it("rispetta maxNodes", async () => {
    const snippets = await extractSnippets(
      params({
        maxNodes: 2,
        nodes: [
          { label: "uno", path: "src/alpha.ts", line: 5 },
          { label: "due", path: "src/beta.ts", line: 5 },
          { label: "tre", path: "src/beta.ts", line: 50 },
        ],
      }),
    );

    expect(snippets).toHaveLength(2);
  });

  it("ritorna [] se la directory del mirror non esiste, senza lanciare", async () => {
    const snippets = await extractSnippets(
      params({
        mirrorsDir: join(root, "mirrors-che-non-esistono"),
        nodes: [{ label: "alpha", path: "src/alpha.ts", line: 10 }],
      }),
    );

    expect(snippets).toEqual([]);
  });

  it("ritorna [] senza nodi (nessun processo git avviato)", async () => {
    await expect(extractSnippets(params())).resolves.toEqual([]);
  });
});
