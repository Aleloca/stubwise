// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dir = { path: "" };
vi.mock("electron", () => ({ app: { getPath: () => dir.path } }));

const { normalizeInstanceUrl, readInstanceUrl, writeInstanceUrl } = await import("./instance");

beforeEach(() => {
  dir.path = mkdtempSync(join(tmpdir(), "stubwise-instance-"));
});
afterEach(() => rmSync(dir.path, { recursive: true, force: true }));

describe("indirizzo dell'istanza", () => {
  it("accetta https e toglie lo slash finale", () => {
    expect(normalizeInstanceUrl("https://stubwise.example.com/")).toBe("https://stubwise.example.com");
    expect(normalizeInstanceUrl(" https://example.com/stubwise/ ")).toBe("https://example.com/stubwise");
  });

  it("accetta http solo su localhost", () => {
    expect(normalizeInstanceUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeInstanceUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  });

  it("rifiuta http su host remoto", () => {
    expect(normalizeInstanceUrl("http://stubwise.example.com")).toBeNull();
    expect(() => writeInstanceUrl("http://stubwise.example.com")).toThrow();
  });

  it("rifiuta altri schemi, credenziali, query e frammenti", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@example.com",
      "https://example.com/?x=1",
      "https://example.com/#a",
      "example.com",
      "",
    ]) {
      expect(normalizeInstanceUrl(bad), bad).toBeNull();
    }
  });

  it("si scrive e si rilegge da instance.json", () => {
    expect(readInstanceUrl()).toBeNull();
    writeInstanceUrl("https://example.com/");
    expect(readInstanceUrl()).toBe("https://example.com");
    expect(JSON.parse(readFileSync(join(dir.path, "instance.json"), "utf8"))).toEqual({
      url: "https://example.com",
    });
  });

  it("un file manomesso con un indirizzo non valido si legge come assente", () => {
    writeFileSync(join(dir.path, "instance.json"), JSON.stringify({ url: "http://evil.example" }));
    expect(readInstanceUrl()).toBeNull();
    writeFileSync(join(dir.path, "instance.json"), "{not json");
    expect(readInstanceUrl()).toBeNull();
  });
});
