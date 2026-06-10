import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgres://stubwise:secret@localhost:5432/stubwise",
  SESSION_SECRET: "a".repeat(32),
  // 32 byte in base64 (esattamente 44 caratteri con padding)
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  PUBLIC_URL: "https://stubwise.example.com",
};

describe("loadConfig", () => {
  it("restituisce la config parsata con un env valido", () => {
    const config = loadConfig({ ...validEnv, PORT: "8080" });
    expect(config).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      sessionSecret: validEnv.SESSION_SECRET,
      encryptionKey: validEnv.ENCRYPTION_KEY,
      port: 8080,
      publicUrl: validEnv.PUBLIC_URL,
    });
  });

  it("usa 3000 come PORT di default", () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
  });

  it("con env vuoto fallisce elencando tutte le variabili mancanti", () => {
    expect(() => loadConfig({})).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /DATABASE_URL[\s\S]*SESSION_SECRET[\s\S]*ENCRYPTION_KEY[\s\S]*PUBLIC_URL/,
        ),
      }),
    );
  });

  it("rifiuta SESSION_SECRET troppo corto", () => {
    expect(() => loadConfig({ ...validEnv, SESSION_SECRET: "short" })).toThrowError(
      /SESSION_SECRET/,
    );
  });

  it("rifiuta ENCRYPTION_KEY che non è base64 di 32 byte", () => {
    expect(() => loadConfig({ ...validEnv, ENCRYPTION_KEY: "not-base64!" })).toThrowError(
      /ENCRYPTION_KEY/,
    );
    expect(() =>
      loadConfig({ ...validEnv, ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrowError(/ENCRYPTION_KEY/);
  });

  it("rifiuta PORT non numerica", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "abc" })).toThrowError(/PORT/);
  });

  it("usa il default 3000 con PORT vuota (es. .env.example copiato)", () => {
    const config = loadConfig({ ...validEnv, PORT: "" });
    expect(config.port).toBe(3000);
  });

  it("rifiuta PORT fuori range con messaggio in italiano", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "0" })).toThrowError(
      /PORT.*deve essere un numero di porta valido/,
    );
    expect(() => loadConfig({ ...validEnv, PORT: "70000" })).toThrowError(
      /PORT.*deve essere un numero di porta valido/,
    );
  });

  it("rifiuta PUBLIC_URL non valida", () => {
    expect(() => loadConfig({ ...validEnv, PUBLIC_URL: "not a url" })).toThrowError(/PUBLIC_URL/);
  });
});
