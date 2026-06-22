import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt, projectEnvFiles, projectEnvVars, projects } from "@stubwise/db";
import { startTestDb, seedGitAccount, type TestDb } from "@stubwise/db/testing";
import { parseDotenv } from "@stubwise/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadProjectEnvFiles,
  materializeEnvFiles,
  type LoadedEnvFile,
} from "./env-files.js";

// Chiave AES a 32 byte deterministica per i test: l'encrypt/decrypt di @stubwise/db
// la richiede di questa lunghezza.
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

let t: TestDb;

beforeAll(async () => {
  t = await startTestDb();
}, 60_000);

afterAll(async () => {
  await t?.stop();
});

let projectSeq = 0;

async function seedProject(): Promise<string> {
  projectSeq++;
  const gitAccountId = await seedGitAccount(t.db);
  const [row] = await t.db
    .insert(projects)
    .values({
      name: `Progetto env ${projectSeq}`,
      slug: `progetto-env-${projectSeq}-${randomBytes(4).toString("hex")}`,
      provider: "github",
      gitAccountId,
      repoUrl: "https://example.com/repo.git",
      defaultBranch: "main",
      ingestionKey: randomBytes(8).toString("hex"),
    })
    .returning();
  if (!row) throw new Error("insert del progetto di test non ha restituito la riga");
  return row.id;
}

async function seedFile(
  projectId: string,
  path: string,
  vars: { key: string; valueEncrypted: string }[],
): Promise<void> {
  const [file] = await t.db
    .insert(projectEnvFiles)
    .values({ projectId, path })
    .returning();
  if (!file) throw new Error("insert del file env di test non ha restituito la riga");
  if (vars.length > 0) {
    await t.db
      .insert(projectEnvVars)
      .values(vars.map((v) => ({ fileId: file.id, key: v.key, valueEncrypted: v.valueEncrypted })));
  }
}

describe("loadProjectEnvFiles", () => {
  it("decifra correttamente le variabili di tutti i file, ordinati per path", async () => {
    const projectId = await seedProject();
    await seedFile(projectId, "apps/web/.env", [
      { key: "API_URL", valueEncrypted: encrypt("https://api.example.com", KEY) },
    ]);
    await seedFile(projectId, ".env", [
      { key: "DATABASE_URL", valueEncrypted: encrypt("postgres://x", KEY) },
      { key: "SECRET", valueEncrypted: encrypt("s3cr3t", KEY) },
    ]);

    const loaded = await loadProjectEnvFiles(t.db, projectId, KEY);

    // Ordinati per path: ".env" prima di "apps/web/.env".
    expect(loaded.map((f) => f.path)).toEqual([".env", "apps/web/.env"]);
    expect(loaded[0]?.vars).toEqual([
      { key: "DATABASE_URL", value: "postgres://x" },
      { key: "SECRET", value: "s3cr3t" },
    ]);
    expect(loaded[1]?.vars).toEqual([{ key: "API_URL", value: "https://api.example.com" }]);
  });

  it("salta una var non decifrabile e tiene le altre, senza lanciare", async () => {
    const projectId = await seedProject();
    await seedFile(projectId, ".env", [
      { key: "OK", valueEncrypted: encrypt("buono", KEY) },
      // Cifrata con un'altra chiave: la decifratura con KEY fallisce.
      { key: "BAD", valueEncrypted: encrypt("cattivo", OTHER_KEY) },
      { key: "OK2", valueEncrypted: encrypt("buono2", KEY) },
    ]);

    const loaded = await loadProjectEnvFiles(t.db, projectId, KEY);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.vars).toEqual([
      { key: "OK", value: "buono" },
      { key: "OK2", value: "buono2" },
    ]);
  });

  it("ritorna [] per un progetto senza file env", async () => {
    const projectId = await seedProject();
    const loaded = await loadProjectEnvFiles(t.db, projectId, KEY);
    expect(loaded).toEqual([]);
  });
});

describe("materializeEnvFiles", () => {
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "stubwise-envtest-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("scrive i file ai path giusti, round-trip via parseDotenv, e crea le sotto-dir", async () => {
    await withTmpDir(async (dir) => {
      const files: LoadedEnvFile[] = [
        { path: ".env", vars: [{ key: "A", value: "1" }] },
        { path: "apps/web/.env", vars: [{ key: "B", value: "valore con spazi" }] },
      ];

      const { writtenPaths, env } = await materializeEnvFiles(dir, files);

      expect(writtenPaths.sort()).toEqual([".env", "apps/web/.env"]);

      const root = await readFile(join(dir, ".env"), "utf8");
      expect(parseDotenv(root)).toEqual([{ key: "A", value: "1" }]);
      expect(root.endsWith("\n")).toBe(true);

      const sub = await readFile(join(dir, "apps/web/.env"), "utf8");
      expect(parseDotenv(sub)).toEqual([{ key: "B", value: "valore con spazi" }]);

      expect(env).toEqual({ A: "1", B: "valore con spazi" });
    });
  });

  it("NON scrive file con path di traversal e non li include in writtenPaths", async () => {
    await withTmpDir(async (dir) => {
      const files: LoadedEnvFile[] = [
        { path: "../escape.env", vars: [{ key: "EVIL", value: "x" }] },
        { path: ".env", vars: [{ key: "OK", value: "y" }] },
      ];

      const { writtenPaths, env } = await materializeEnvFiles(dir, files);

      expect(writtenPaths).toEqual([".env"]);
      expect(env).toEqual({ OK: "y" });

      // Il file fuori dalla tmpdir NON deve esistere.
      await expect(stat(join(dir, "..", "escape.env"))).rejects.toThrow();
    });
  });

  it("unifica le var con last-wins su collisione (ordine per path)", async () => {
    await withTmpDir(async (dir) => {
      const files: LoadedEnvFile[] = [
        { path: ".env", vars: [{ key: "SHARED", value: "primo" }] },
        { path: "z.env", vars: [{ key: "SHARED", value: "ultimo" }] },
      ];

      const { env } = await materializeEnvFiles(dir, files);

      // I file sono già ordinati per path dal loader: l'ultimo vince.
      expect(env.SHARED).toBe("ultimo");
    });
  });
});
