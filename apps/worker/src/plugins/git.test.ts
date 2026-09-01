import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fetchAtRef, PluginGitError } from "./git.js";

/**
 * Test di `fetchAtRef` su repo git LOCALI VERI (niente rete, niente mock):
 * un repo sorgente creato con `git init` + commit fa da "origin". L'unico test
 * che apre un socket punta a 127.0.0.1 su una porta chiusa (connessione
 * rifiutata subito) e serve solo a verificare la redazione delle credenziali.
 */

/**
 * Opzioni dei test che usano repo locali. L'allowlist di PRODUZIONE è solo
 * `https` (default di `fetchAtRef`): qui serve il trasporto `file`, e
 * l'override è esplicito per test invece di allargare il default — un
 * ampliamento fatto "per far passare i test" finirebbe dritto in produzione.
 */
const LOCAL = { timeoutMs: 30_000, allowedProtocols: ["file"] };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const COMMIT_ARGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-plugin-git-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

interface Source {
  dir: string;
  /** Sha del primo commit (`f1.txt`), NON la punta: non è pubblicizzato. */
  firstSha: string;
  /** Sha della punta di `main` (`f1.txt` + `f2.txt`). */
  tipSha: string;
}

/** Repo sorgente con due commit su `main`. */
async function makeSource(root: string): Promise<Source> {
  const dir = join(root, "source");
  await execa("git", ["init", "-q", "-b", "main", dir]);
  const commit = async (file: string, message: string): Promise<string> => {
    await execa("sh", ["-c", `echo ${message} > ${join(dir, file)}`]);
    await execa("git", [...COMMIT_ARGS, "add", "."], { cwd: dir });
    await execa("git", [...COMMIT_ARGS, "commit", "-q", "-m", message], { cwd: dir });
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
    return stdout.trim();
  };
  const firstSha = await commit("f1.txt", "uno");
  const tipSha = await commit("f2.txt", "due");
  return { dir, firstSha, tipSha };
}

/**
 * Esegue `fn` come se il server remoto fosse "severo": forza il protocollo git
 * v0 nel processo figlio (via `GIT_CONFIG_*`, che `git` legge dall'ambiente
 * ereditato). Con il v0 un `fetch --depth 1 <sha-non-pubblicizzato>` viene
 * RIFIUTATO — esattamente l'errore che alcuni server danno su uno sha
 * arbitrario, e il motivo per cui esiste il fallback a fetch pieno. In v2
 * (default) il transport locale accetta qualunque sha, quindi senza questa
 * forzatura il ramo di fallback non verrebbe mai esercitato.
 */
async function withStrictServer<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.version";
  process.env.GIT_CONFIG_VALUE_0 = "0";
  try {
    return await fn();
  } finally {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("GIT_CONFIG_COUNT", previous.count);
    restore("GIT_CONFIG_KEY_0", previous.key);
    restore("GIT_CONFIG_VALUE_0", previous.value);
  }
}

describe("fetchAtRef", () => {
  it("scarica un branch, restituisce lo sha e rimuove .git", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);
    const dest = join(root, "dest", "nested");

    const { sha } = await fetchAtRef(source.dir, "main", dest, LOCAL);

    expect(sha).toBe(source.tipSha);
    // La dir di destinazione viene creata: il chiamante passa un path nuovo.
    expect(await readFile(join(dest, "f2.txt"), "utf8")).toBe("due\n");
    // `.git` sparisce: la dir del plugin è solo contenuto, e resterebbe un
    // repo git dentro un plugin che il CLI carica.
    expect(existsSync(join(dest, ".git"))).toBe(false);
  });

  it("scarica uno sha (punta) con il fetch shallow", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);
    const dest = join(root, "dest");

    const { sha } = await fetchAtRef(source.dir, source.tipSha, dest, LOCAL);

    expect(sha).toBe(source.tipSha);
    expect(existsSync(join(dest, "f2.txt"))).toBe(true);
  });

  it("ripiega sul fetch pieno quando il server rifiuta lo sha in shallow", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);
    const dest = join(root, "dest");

    // Precondizione del test: con il server "severo" il fetch shallow di
    // questo sha fallisce davvero. Senza questa verifica il test resterebbe
    // verde anche se il primo tentativo riuscisse, senza esercitare il
    // fallback.
    await withStrictServer(async () => {
      const probe = join(root, "probe");
      await execa("git", ["init", "-q", "-b", "main", probe]);
      await expect(
        execa("git", ["fetch", "--depth", "1", "--no-tags", source.dir, source.firstSha], {
          cwd: probe,
        }),
      ).rejects.toThrow();
    });

    const { sha } = await withStrictServer(() =>
      fetchAtRef(source.dir, source.firstSha, dest, LOCAL),
    );

    expect(sha).toBe(source.firstSha);
    // È davvero il PRIMO commit: il secondo file non esiste ancora.
    expect(existsSync(join(dest, "f1.txt"))).toBe(true);
    expect(existsSync(join(dest, "f2.txt"))).toBe(false);
    expect(existsSync(join(dest, ".git"))).toBe(false);
  });

  it("fallisce con un errore parlante se il ref non esiste", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);

    await expect(fetchAtRef(source.dir, "non-esiste", join(root, "dest"), LOCAL)).rejects.toThrow(
      PluginGitError,
    );
    await expect(fetchAtRef(source.dir, "non-esiste", join(root, "dest2"), LOCAL)).rejects.toThrow(
      /non-esiste/,
    );
  });

  it("redige le credenziali nell'URL dal messaggio d'errore", async () => {
    const root = await makeRoot();
    // Porta 1 su localhost: connessione rifiutata subito, nessuna rete esterna.
    const url = "https://utente:supersegreto@127.0.0.1:1/org/plugin.git";

    const error = await fetchAtRef(url, "main", join(root, "dest"), {
      timeoutMs: 30_000,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(PluginGitError);
    expect(error!.message).not.toContain("supersegreto");
    expect(error!.message).not.toContain("utente");
    expect(error!.message).toContain("[REDACTED]");
  });

  it("rifiuta url e ref che sembrano opzioni, senza eseguire git", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);

    await expect(
      fetchAtRef("--upload-pack=touch /tmp/x", "main", join(root, "a"), LOCAL),
    ).rejects.toThrow(PluginGitError);
    await expect(fetchAtRef(source.dir, "--depth=99", join(root, "b"), LOCAL)).rejects.toThrow(
      PluginGitError,
    );
    // Nessuna delle due destinazioni è stata toccata.
    expect(existsSync(join(root, "a"))).toBe(false);
    expect(existsSync(join(root, "b"))).toBe(false);
  });

  it("rifiuta i trasporti fuori dall'allowlist di default (solo https)", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);

    // Path locale: senza allowlist git lo accetterebbe (trasporto `file`).
    const local = await fetchAtRef(source.dir, "main", join(root, "d1"), {
      timeoutMs: 30_000,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(local).toBeInstanceOf(PluginGitError);
    expect(local!.message).toMatch(/file/);

    // `ext::` esegue un comando arbitrario: è IL motivo dell'allowlist.
    // Il file sentinella non deve nascere in nessun caso.
    const sentinel = join(root, "eseguito");
    const ext = await fetchAtRef(`ext::sh -c touch% ${sentinel}`, "main", join(root, "d2"), {
      timeoutMs: 30_000,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(ext).toBeInstanceOf(PluginGitError);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rispetta il timeout complessivo", async () => {
    const root = await makeRoot();
    const source = await makeSource(root);

    const error = await fetchAtRef(source.dir, "main", join(root, "dest"), {
      timeoutMs: 1,
      allowedProtocols: ["file"],
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(PluginGitError);
    expect(error!.message).toMatch(/timeout/i);
  });
});
