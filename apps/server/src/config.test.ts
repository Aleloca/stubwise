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
      trustProxy: false,
      // Default degli embedding (Ollama in-rete, bge-m3, niente API key).
      embeddingBaseUrl: "http://ollama:11434/v1",
      embeddingModel: "bge-m3",
      embeddingApiKey: undefined,
      // Default dei tetti giornalieri del widget.
      widgetDailyMessageCap: 200,
      widgetDailyTicketCap: 50,
      // Default del volume dei grafi graphify (stesso path del worker).
      graphsDir: "/graphs",
    });
  });

  it("legge GRAPHS_DIR dall'env, con /graphs come default", () => {
    expect(loadConfig(validEnv).graphsDir).toBe("/graphs");
    expect(loadConfig({ ...validEnv, GRAPHS_DIR: "/srv/graphs" }).graphsDir).toBe("/srv/graphs");
    // Stringa vuota (es. `GRAPHS_DIR=` copiata da .env.example) → default.
    expect(loadConfig({ ...validEnv, GRAPHS_DIR: "" }).graphsDir).toBe("/graphs");
  });

  it("legge WIDGET_DAILY_*_CAP dall'env quando presenti", () => {
    const config = loadConfig({
      ...validEnv,
      WIDGET_DAILY_MESSAGE_CAP: "500",
      WIDGET_DAILY_TICKET_CAP: "25",
    });
    expect(config.widgetDailyMessageCap).toBe(500);
    expect(config.widgetDailyTicketCap).toBe(25);
  });

  it("usa i default dei tetti widget (200 messaggi, 50 ticket)", () => {
    const config = loadConfig(validEnv);
    expect(config.widgetDailyMessageCap).toBe(200);
    expect(config.widgetDailyTicketCap).toBe(50);
  });

  it("legge EMBEDDING_* dall'env quando presenti", () => {
    const config = loadConfig({
      ...validEnv,
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_API_KEY: "sk-test",
    });
    expect(config.embeddingBaseUrl).toBe("https://api.openai.com/v1");
    expect(config.embeddingModel).toBe("text-embedding-3-small");
    expect(config.embeddingApiKey).toBe("sk-test");
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

  it("TRUST_PROXY è false di default", () => {
    expect(loadConfig(validEnv).trustProxy).toBe(false);
  });

  it("interpreta TRUST_PROXY=true (e altri valori veritieri) come true", () => {
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "1" }).trustProxy).toBe(true);
  });

  it("interpreta TRUST_PROXY=false (o vuota) come false", () => {
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "" }).trustProxy).toBe(false);
  });
});
