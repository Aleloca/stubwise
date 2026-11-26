import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FALLBACK_MAX_PER_DAY, FALLBACK_MAX_PER_MINUTE } from "./automations/webhook-limits.js";
import { loadConfig, SERVER_ENV_NAMES } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgres://stubwise:secret@localhost:5432/stubwise",
  SESSION_SECRET: "a".repeat(32),
  // 32 byte in base64 (esattamente 44 caratteri con padding)
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  PUBLIC_URL: "https://stubwise.example.com",
};

describe("loadConfig", () => {
  it("VAULT_DESKTOP: SPENTA di default e con la stringa vuota; accesa con true, 1, on (lotto 10)", () => {
    expect(loadConfig({ ...validEnv }).vaultDesktop).toBe(false);
    expect(loadConfig({ ...validEnv, VAULT_DESKTOP: "" }).vaultDesktop).toBe(false);
    for (const value of ["false", "0", "off"]) expect(loadConfig({ ...validEnv, VAULT_DESKTOP: value }).vaultDesktop, value).toBe(false);
    for (const value of ["true", "1", "on"]) expect(loadConfig({ ...validEnv, VAULT_DESKTOP: value }).vaultDesktop, value).toBe(true);
    expect(() => loadConfig({ ...validEnv, VAULT_DESKTOP: "sì" })).toThrow();
  });

  it("MAIL_CLASSIFY_V2: spenta di default e con la stringa vuota, accesa solo con true (area 6, F2)", () => {
    expect(loadConfig({ ...validEnv }).mailClassifyV2).toBe(false);
    expect(loadConfig({ ...validEnv, MAIL_CLASSIFY_V2: "" }).mailClassifyV2).toBe(false);
    expect(loadConfig({ ...validEnv, MAIL_CLASSIFY_V2: "true" }).mailClassifyV2).toBe(true);
  });

  it("restituisce la config parsata con un env valido", () => {
    const config = loadConfig({ ...validEnv, PORT: "8080" });
    expect(config).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      sessionSecret: validEnv.SESSION_SECRET,
      encryptionKey: validEnv.ENCRYPTION_KEY,
      port: 8080,
      publicUrl: validEnv.PUBLIC_URL,
      // Area 6, F2: la classificazione nuova spenta di default.
      mailClassifyV2: false,
      vaultDesktop: false,
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
      // Default del retrieval dal grafo nelle chat (feature accesa).
      graphifyMcpUrl: "http://graphify:8080/mcp",
      graphChatTokenBudget: 1200,
      graphChatSnippetMaxChars: 6000,
      graphChatSnippetNodes: 6,
      // Default del volume dei mirror git (stesso path del worker).
      mirrorsDir: "/var/stubwise/mirrors",
      productEmbedPollSeconds: 30,
    });
  });

  it("legge GRAPHIFY_MCP_URL dall'env, col server MCP in-rete come default", () => {
    expect(loadConfig(validEnv).graphifyMcpUrl).toBe("http://graphify:8080/mcp");
    expect(
      loadConfig({ ...validEnv, GRAPHIFY_MCP_URL: "http://localhost:9090/mcp" }).graphifyMcpUrl,
    ).toBe("http://localhost:9090/mcp");
  });

  it("area 11, F3: PRODUCT_EMBED_POLL_SECONDS: 30 di default, un numero se dato, vuota spegne, sotto 5 è un errore", () => {
    expect(loadConfig(validEnv).productEmbedPollSeconds).toBe(30);
    expect(loadConfig({ ...validEnv, PRODUCT_EMBED_POLL_SECONDS: "60" }).productEmbedPollSeconds).toBe(60);
    expect(loadConfig({ ...validEnv, PRODUCT_EMBED_POLL_SECONDS: "" }).productEmbedPollSeconds).toBeUndefined();
    expect(() => loadConfig({ ...validEnv, PRODUCT_EMBED_POLL_SECONDS: "2" })).toThrow();
  });

  it("con GRAPHIFY_MCP_URL vuota spegne la feature (undefined, NON il default)", () => {
    // Rollback switch: a differenza delle altre variabili, qui la stringa vuota
    // NON ricade sul default — disattiva il retrieval dal grafo.
    expect(loadConfig({ ...validEnv, GRAPHIFY_MCP_URL: "" }).graphifyMcpUrl).toBeUndefined();
    expect(loadConfig({ ...validEnv, GRAPHIFY_MCP_URL: "   " }).graphifyMcpUrl).toBeUndefined();
  });

  it("legge i GRAPH_CHAT_* dall'env quando presenti", () => {
    const config = loadConfig({
      ...validEnv,
      GRAPH_CHAT_TOKEN_BUDGET: "2000",
      GRAPH_CHAT_SNIPPET_MAX_CHARS: "10000",
      GRAPH_CHAT_SNIPPET_NODES: "3",
    });
    expect(config.graphChatTokenBudget).toBe(2000);
    expect(config.graphChatSnippetMaxChars).toBe(10000);
    expect(config.graphChatSnippetNodes).toBe(3);
  });

  it("usa i default dei GRAPH_CHAT_* anche con le variabili vuote", () => {
    const config = loadConfig({
      ...validEnv,
      GRAPH_CHAT_TOKEN_BUDGET: "",
      GRAPH_CHAT_SNIPPET_MAX_CHARS: "",
      GRAPH_CHAT_SNIPPET_NODES: "",
    });
    expect(config.graphChatTokenBudget).toBe(1200);
    expect(config.graphChatSnippetMaxChars).toBe(6000);
    expect(config.graphChatSnippetNodes).toBe(6);
  });

  it("rifiuta i GRAPH_CHAT_* non interi o non positivi", () => {
    expect(() => loadConfig({ ...validEnv, GRAPH_CHAT_TOKEN_BUDGET: "abc" })).toThrowError(
      /GRAPH_CHAT_TOKEN_BUDGET/,
    );
    expect(() => loadConfig({ ...validEnv, GRAPH_CHAT_SNIPPET_NODES: "0" })).toThrowError(
      /GRAPH_CHAT_SNIPPET_NODES/,
    );
    expect(() => loadConfig({ ...validEnv, GRAPH_CHAT_SNIPPET_MAX_CHARS: "1.5" })).toThrowError(
      /GRAPH_CHAT_SNIPPET_MAX_CHARS/,
    );
  });

  it("legge MIRRORS_DIR dall'env, con lo stesso default del worker", () => {
    expect(loadConfig(validEnv).mirrorsDir).toBe("/var/stubwise/mirrors");
    expect(loadConfig({ ...validEnv, MIRRORS_DIR: "/srv/mirrors" }).mirrorsDir).toBe(
      "/srv/mirrors",
    );
    expect(loadConfig({ ...validEnv, MIRRORS_DIR: "" }).mirrorsDir).toBe("/var/stubwise/mirrors");
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

/*
 * Il compose NON usa `env_file`: una env che manca dall'`environment` del
 * servizio non arriva al container, e regolarla in `/opt/stubwise/.env` non ha
 * effetto (26 nov 2026: al server mancavano i due massimi del webhook in
 * arrivo, che stanno fuori dallo schema, in `automations/webhook-limits.ts`). Questi test leggono il compose vero.
 */

/** Le voci dell'`environment` di un servizio del compose, nome → valore grezzo. */
function composeEnvironment(service: string): Map<string, string> {
  const text = readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8");
  const out = new Map<string, string>();
  let inService = false;
  let inEnv = false;
  for (const line of text.split("\n")) {
    if (/^ {2}[a-z][\w-]*:\s*$/.test(line)) {
      inService = line.trim() === `${service}:`;
      inEnv = false;
      continue;
    }
    if (!inService) continue;
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) inEnv = false;
    if (!inEnv) continue;
    const m = /^\s+-\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line) ?? /^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim().replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

/**
 * Ciò che il container riceve quando `.env` NON nomina la variabile (né le
 * altre a cui il default rimanda): la sostituzione di compose con un ambiente
 * vuoto. `${A:-x}` e `${A-x}` → x, `${A}` → stringa vuota.
 */
function composeDefault(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "$" || raw[i + 1] !== "{") {
      out += raw[i];
      continue;
    }
    let depth = 0;
    let j = i + 1;
    for (; j < raw.length; j++) {
      if (raw[j] === "{") depth++;
      else if (raw[j] === "}" && --depth === 0) break;
    }
    const inner = raw.slice(i + 2, j);
    const m = /^[A-Z][A-Z0-9_]*(:?-)([\s\S]*)$/.exec(inner);
    out += m ? composeDefault(m[2]!) : "";
    i = j;
  }
  return out;
}

/** La forma `${NOME:-…}`/`${NOME-…}` di una voce che rimanda a sé stessa, o null (valore fisso). */
function selfReference(name: string, raw: string): ":-" | "-" | "" | null {
  const m = new RegExp(`^\\$\\{${name}(:?-)?`).exec(raw);
  if (!m) return null;
  return (m[1] ?? "") as ":-" | "-" | "";
}

/**
 * Come una env regolabile deve stare in `.env.example`: `NOME=` una volta
 * sola; ma con `${NOME-…}` (la stringa vuota ha un significato suo, di solito
 * «spento») COMMENTATA, `#NOME=`: una riga vuota copiata in `.env` spegnerebbe
 * la funzione. Restituisce il problema, o null.
 */
function exampleProblem(example: string[], name: string, form: ":-" | "-" | ""): string | null {
  const plain = example.filter((line) => line.startsWith(`${name}=`)).length;
  const commented = example.filter((line) => line.startsWith(`#${name}=`)).length;
  if (form === "-") return plain === 0 && commented === 1 ? null : `${name}: serve una sola riga #${name}= e nessuna ${name}=`;
  return plain === 1 ? null : `${name}: serve una sola riga ${name}= (ne ha ${plain})`;
}

describe("docker-compose: le env del server", () => {
  const env = composeEnvironment("server");
  const example = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8").split("\n");
  /** Le env lette FUORI dallo schema, col default del codice. */
  const outsideSchema: [string, string][] = [
    ["AUTOMATION_WEBHOOK_MAX_PER_MINUTE", String(FALLBACK_MAX_PER_MINUTE)],
    ["AUTOMATION_WEBHOOK_MAX_PER_DAY", String(FALLBACK_MAX_PER_DAY)],
  ];

  it("(a) ogni env dello schema, e quelle lette fuori, arriva al server dal compose", () => {
    expect(env.size).toBeGreaterThan(15);
    const names = [...SERVER_ENV_NAMES, ...outsideSchema.map(([name]) => name)];
    expect(names.filter((name) => !env.has(name))).toEqual([]);
  });

  it("(b) il default del compose dà la config del default del codice; `:-` solo dove vuota = assente", () => {
    const base = loadConfig({ ...validEnv });
    let checked = 0;
    for (const [name, raw] of env) {
      if (!SERVER_ENV_NAMES.includes(name) || name in validEnv) continue;
      const form = selfReference(name, raw);
      if (form === null) continue; // valore fisso (un percorso, TRUST_PROXY): non regolabile da `.env`
      checked++;
      expect(loadConfig({ ...validEnv, [name]: composeDefault(raw) }), `${name} = ${raw}`).toEqual(base);
      if (form === ":-") expect(loadConfig({ ...validEnv, [name]: "" }), `${name}: vuota ≠ assente, serve \${${name}-…}`).toEqual(base);
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("(b) i massimi del webhook: il default del compose è quello del codice, e la vuota vale il default", () => {
    for (const [name, fallback] of outsideSchema) {
      const raw = env.get(name)!;
      expect(selfReference(name, raw), name).toBe(":-");
      expect(composeDefault(raw), name).toBe(fallback);
    }
  });

  it("(c) ogni env regolabile, dello schema o letta fuori, compare in .env.example, nella forma giusta", () => {
    const names = [...SERVER_ENV_NAMES, ...outsideSchema.map(([name]) => name)];
    const problems = names.flatMap((name) => {
      const form = selfReference(name, env.get(name) ?? "");
      return form === null ? [] : [exampleProblem(example, name, form)].filter((p) => p !== null);
    });
    expect(problems).toEqual([]);
  });
});
