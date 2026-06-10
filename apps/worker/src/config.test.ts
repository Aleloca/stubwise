import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

const VALID = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/stubwise",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("loadWorkerConfig", () => {
  it("carica una configurazione valida con i default", () => {
    const config = loadWorkerConfig(VALID);
    expect(config.databaseUrl).toBe(VALID.DATABASE_URL);
    expect(config.encryptionKey).toBeInstanceOf(Buffer);
    expect(config.encryptionKey.toString("base64")).toBe(VALID.ENCRYPTION_KEY);
    expect(config.mirrorsDir).toBe("/var/stubwise/mirrors");
    expect(config.concurrency).toBe(2);
    expect(config.staleAfterMinutes).toBe(30);
  });

  it("rispetta MIRRORS_DIR, WORKER_CONCURRENCY e WORKER_STALE_MINUTES espliciti", () => {
    const config = loadWorkerConfig({
      ...VALID,
      MIRRORS_DIR: "/data/mirrors",
      WORKER_CONCURRENCY: "4",
      WORKER_STALE_MINUTES: "45",
    });
    expect(config.mirrorsDir).toBe("/data/mirrors");
    expect(config.concurrency).toBe(4);
    expect(config.staleAfterMinutes).toBe(45);
  });

  it("variabili vuote (es. copiate da .env.example) usano il default", () => {
    const config = loadWorkerConfig({
      ...VALID,
      MIRRORS_DIR: "",
      WORKER_CONCURRENCY: "",
      WORKER_STALE_MINUTES: "",
    });
    expect(config.mirrorsDir).toBe("/var/stubwise/mirrors");
    expect(config.concurrency).toBe(2);
    expect(config.staleAfterMinutes).toBe(30);
  });

  it("rifiuta una WORKER_STALE_MINUTES non numerica o < 1", () => {
    expect(() => loadWorkerConfig({ ...VALID, WORKER_STALE_MINUTES: "tanto" })).toThrow(
      /WORKER_STALE_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, WORKER_STALE_MINUTES: "0" })).toThrow(
      /WORKER_STALE_MINUTES/,
    );
  });

  it("elenca tutte le variabili mancanti o non valide in un solo errore", () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL[\s\S]*ENCRYPTION_KEY/);
  });

  it("rifiuta una ENCRYPTION_KEY che non è 32 byte in base64", () => {
    expect(() => loadWorkerConfig({ ...VALID, ENCRYPTION_KEY: "corta" })).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      loadWorkerConfig({ ...VALID, ENCRYPTION_KEY: randomBytes(16).toString("base64") }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("rifiuta una WORKER_CONCURRENCY non numerica o fuori range", () => {
    expect(() => loadWorkerConfig({ ...VALID, WORKER_CONCURRENCY: "zero" })).toThrow(
      /WORKER_CONCURRENCY/,
    );
    expect(() => loadWorkerConfig({ ...VALID, WORKER_CONCURRENCY: "0" })).toThrow(
      /WORKER_CONCURRENCY/,
    );
  });
});
