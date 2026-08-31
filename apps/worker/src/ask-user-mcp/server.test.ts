import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASK_USER_TOOL_NAME,
  buildAskUserServer,
  handleAskUser,
  loadAskUserConfig,
  type AskUserConfig,
} from "./server.js";

/** Directory temporanea del test: il file-bridge ci viene scritto davvero. */
let dir: string;
/** Path del file-bridge usato dalla maggior parte dei test. */
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-user-mcp-test-"));
  filePath = join(dir, "question.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Config di comodo: file nella temp dir, round 1 su un tetto di 5. */
function config(overrides: Partial<AskUserConfig> = {}): AskUserConfig {
  return { filePath, round: 1, maxRounds: 5, ...overrides };
}

/** Argomenti validi minimi (2 opzioni, nessun consiglio). */
function validArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "Vuoi la migrazione online o una finestra di manutenzione?",
    options: [
      { label: "Migrazione online", consequence: "Più lavoro, zero downtime" },
      { label: "Finestra di manutenzione" },
    ],
    ...overrides,
  };
}

/** Estrae il testo del primo blocco di contenuto di un risultato di tool. */
function textOf(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("loadAskUserConfig", () => {
  it("fallisce in modo esplicito se ASK_USER_FILE manca", () => {
    expect(() => loadAskUserConfig({})).toThrow(/ASK_USER_FILE/);
  });

  it("fallisce anche se ASK_USER_FILE è una stringa vuota o di soli spazi", () => {
    expect(() => loadAskUserConfig({ ASK_USER_FILE: "   " })).toThrow(/ASK_USER_FILE/);
  });

  it("legge round e tetto dalle env numeriche", () => {
    const cfg = loadAskUserConfig({
      ASK_USER_FILE: filePath,
      ASK_USER_ROUND: "3",
      ASK_USER_MAX_ROUNDS: "4",
    });
    expect(cfg).toEqual({ filePath, round: 3, maxRounds: 4 });
  });

  it("usa i default (round 1, tetto 5) se round e tetto mancano", () => {
    const cfg = loadAskUserConfig({ ASK_USER_FILE: filePath });
    expect(cfg).toEqual({ filePath, round: 1, maxRounds: 5 });
  });

  it("ripiega sui default (avvisando su stderr) se round o tetto non sono interi positivi", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadAskUserConfig({
      ASK_USER_FILE: filePath,
      ASK_USER_ROUND: "abc",
      ASK_USER_MAX_ROUNDS: "0",
    });
    expect(cfg).toEqual({ filePath, round: 1, maxRounds: 5 });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("handleAskUser — validazione dello schema", () => {
  it("rifiuta una sola opzione senza scrivere il file", async () => {
    const result = await handleAskUser(validArgs({ options: [{ label: "Unica" }] }), config());
    expect(result.isError).toBe(true);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("rifiuta cinque opzioni", async () => {
    const options = [1, 2, 3, 4, 5].map((n) => ({ label: `Opzione ${n}` }));
    const result = await handleAskUser(validArgs({ options }), config());
    expect(result.isError).toBe(true);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("rifiuta un recommendedIndex fuori dal range delle opzioni", async () => {
    const result = await handleAskUser(validArgs({ recommendedIndex: 2 }), config());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/recommendedIndex/);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("rifiuta una domanda vuota", async () => {
    const result = await handleAskUser(validArgs({ question: "" }), config());
    expect(result.isError).toBe(true);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });
});

describe("handleAskUser — scrittura del file-bridge", () => {
  it("scrive un JSON ri-parsabile con i campi della domanda", async () => {
    const result = await handleAskUser(
      validArgs({ recommendedIndex: 1, allowFreeText: false }),
      config(),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(
      "Domanda registrata. Termina il turno ORA senza produrre il piano: riceverai la risposta in un turno successivo.",
    );

    const written = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      question: "Vuoi la migrazione online o una finestra di manutenzione?",
      options: [
        { label: "Migrazione online", consequence: "Più lavoro, zero downtime" },
        { label: "Finestra di manutenzione" },
      ],
      recommendedIndex: 1,
      allowFreeText: false,
    });
  });

  it("mette allowFreeText a true quando l'agente non lo passa", async () => {
    await handleAskUser(validArgs(), config());
    const written = JSON.parse(await readFile(filePath, "utf8")) as { allowFreeText: boolean };
    expect(written.allowFreeText).toBe(true);
  });

  it("crea la directory del file se non esiste e non lascia file temporanei", async () => {
    const nested = join(dir, "run", "question.json");
    await handleAskUser(validArgs(), config({ filePath: nested }));

    const written = JSON.parse(await readFile(nested, "utf8")) as { question: string };
    expect(written.question).toContain("migrazione");

    expect(await readdir(join(dir, "run"))).toEqual(["question.json"]);
  });
});

describe("handleAskUser — tetto e idempotenza", () => {
  it("oltre il tetto risponde di decidere da solo e NON scrive il file", async () => {
    const result = await handleAskUser(validArgs(), config({ round: 6, maxRounds: 5 }));

    expect(textOf(result)).toBe(
      "Tetto di domande raggiunto (5): scegli tu l'opzione più ragionevole e documenta la scelta nella sezione 'Decisioni e assunzioni' del piano.",
    );
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("all'ultimo round consentito scrive ancora", async () => {
    const result = await handleAskUser(validArgs(), config({ round: 5, maxRounds: 5 }));
    expect(textOf(result)).toMatch(/Domanda registrata/);
    await expect(readFile(filePath, "utf8")).resolves.toContain("question");
  });

  it("alla seconda chiamata nello stesso turno non sovrascrive la domanda già registrata", async () => {
    await handleAskUser(validArgs(), config());
    const primo = await readFile(filePath, "utf8");

    const result = await handleAskUser(
      validArgs({ question: "Una domanda del tutto diversa?" }),
      config(),
    );

    expect(textOf(result)).toBe("Hai già una domanda registrata: termina il turno.");
    expect(await readFile(filePath, "utf8")).toBe(primo);
    // Nemmeno il tentativo respinto lascia scarti nella dir del run.
    expect(await readdir(dir)).toEqual(["question.json"]);
  });

  it("con due chiamate concorrenti ne registra UNA sola, senza sovrascritture", async () => {
    // La creazione è esclusiva (link → EEXIST), quindi non c'è finestra TOCTOU
    // fra controllo e scrittura: il CLI può parallelizzare le tool call.
    const [primo, secondo] = await Promise.all([
      handleAskUser(validArgs({ question: "Prima domanda concorrente?" }), config()),
      handleAskUser(validArgs({ question: "Seconda domanda concorrente?" }), config()),
    ]);

    const testi = [textOf(primo!), textOf(secondo!)].sort();
    expect(testi).toEqual([
      "Domanda registrata. Termina il turno ORA senza produrre il piano: riceverai la risposta in un turno successivo.",
      "Hai già una domanda registrata: termina il turno.",
    ]);

    const written = JSON.parse(await readFile(filePath, "utf8")) as { question: string };
    expect(written.question).toMatch(/^(Prima|Seconda) domanda concorrente\?$/);
    expect(await readdir(dir)).toEqual(["question.json"]);
  });

  it("non sovrascrive nemmeno un file preesistente scritto da altri", async () => {
    await writeFile(filePath, "{}", "utf8");
    const result = await handleAskUser(validArgs(), config());
    expect(textOf(result)).toBe("Hai già una domanda registrata: termina il turno.");
    expect(await readFile(filePath, "utf8")).toBe("{}");
  });
});

describe("handleAskUser — fallimento della scrittura", () => {
  it("torna un errore al modello E lo logga su stderr con path e causa", async () => {
    // Il genitore del file è un FILE, non una directory: la creazione della dir
    // fallisce (ENOTDIR) come farebbe un problema di permessi o di disco.
    const ostacolo = join(dir, "non-una-dir");
    await writeFile(ostacolo, "x", "utf8");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleAskUser(
      validArgs(),
      config({ filePath: join(ostacolo, "question.json") }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Impossibile registrare la domanda: /);
    expect(stderr).toHaveBeenCalledTimes(1);
    const logged = String(stderr.mock.calls[0]?.[0]);
    expect(logged).toContain("ask_user: scrittura del file-bridge");
    expect(logged).toContain(join(ostacolo, "question.json"));
  });
});

describe("buildAskUserServer", () => {
  it("registra il solo tool ask_user", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    const server = buildAskUserServer(config());

    expect(server).toBeInstanceOf(McpServer);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([ASK_USER_TOOL_NAME]);
  });

  it("risponde a tools/list e tools/call con un risultato MCP ben formato", async () => {
    const server = buildAskUserServer(config());
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([ASK_USER_TOOL_NAME]);

    const called = await client.callTool({
      name: ASK_USER_TOOL_NAME,
      arguments: validArgs(),
    });
    expect(called.content).toEqual([
      {
        type: "text",
        text: "Domanda registrata. Termina il turno ORA senza produrre il piano: riceverai la risposta in un turno successivo.",
      },
    ]);
    await expect(readFile(filePath, "utf8")).resolves.toContain("migrazione");

    await client.close();
    await server.close();
  });
});
