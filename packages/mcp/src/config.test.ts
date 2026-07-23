import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, readProjectSlug } from "./config.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-mcp-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("usa il baseUrl di default quando STUBWISE_URL è assente", () => {
    const config = loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("rimuove il trailing slash da STUBWISE_URL", () => {
    const config = loadConfig({
      cwd: dir,
      env: { STUBWISE_TOKEN: "stw_pat_abc", STUBWISE_URL: "https://stubwise.example.com/" },
    });
    expect(config.baseUrl).toBe("https://stubwise.example.com");
  });

  it("lancia un errore chiaro quando STUBWISE_URL non è un URL valido", () => {
    expect(() =>
      loadConfig({
        cwd: dir,
        env: { STUBWISE_TOKEN: "stw_pat_abc", STUBWISE_URL: "non e un url" },
      }),
    ).toThrow(/STUBWISE_URL non è un URL valido/);
  });

  it("lancia un errore chiaro quando STUBWISE_TOKEN manca", () => {
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/STUBWISE_TOKEN non impostato/);
  });

  it("lancia un errore quando STUBWISE_TOKEN è vuoto", () => {
    expect(() => loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "   " } })).toThrow(
      /STUBWISE_TOKEN/,
    );
  });

  it("legge projectSlug da .stubwise.json nella cwd", () => {
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ project: "my-project" }));
    const config = loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.projectSlug).toBe("my-project");
  });

  it("risale le cartelle per trovare .stubwise.json da una sottocartella", () => {
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ project: "root-project" }));
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const config = loadConfig({ cwd: nested, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.projectSlug).toBe("root-project");
  });

  it("ritorna projectSlug null quando il file è assente", () => {
    const config = loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.projectSlug).toBeNull();
  });

  it("ritorna null (senza crashare) su JSON malformato", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(join(dir, ".stubwise.json"), "{ this is not json ");
    const config = loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.projectSlug).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("ritorna null quando manca il campo project", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ foo: "bar" }));
    const config = loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.projectSlug).toBeNull();
  });

  it("ignora (senza leggerlo) un .stubwise.json oltre il cap di dimensione", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Oltre 64KB: JSON valido con campo project ma volutamente enorme.
    const padding = "x".repeat(70 * 1024);
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ project: "big", padding }));
    const config = loadConfig({ cwd: dir, env: { STUBWISE_TOKEN: "stw_pat_abc" } });
    expect(config.projectSlug).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

// readProjectSlug è esportata perché va rieseguita FRESCA a ogni tool call
// (vedi resolveProject): copertura diretta della funzione riusata.
describe("readProjectSlug", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stubwise-mcp-slug-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("trova lo slug da .stubwise.json nella cwd", () => {
    writeFileSync(join(dir, ".stubwise.json"), JSON.stringify({ project: "found" }));
    expect(readProjectSlug(dir)).toBe("found");
  });

  it("ritorna null quando il file è assente", () => {
    expect(readProjectSlug(dir)).toBeNull();
  });

  it("ritorna null (senza crashare) su JSON malformato", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(join(dir, ".stubwise.json"), "{ this is not json ");
    expect(readProjectSlug(dir)).toBeNull();
  });
});
