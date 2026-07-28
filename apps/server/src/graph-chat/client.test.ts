import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGraphMcpClient } from "./client.js";

/**
 * I test girano contro un VERO server MCP Streamable HTTP in-process (stesso
 * SDK del container `graphify serve`, stessa modalità stateless: un server e un
 * transport nuovi per ogni richiesta, nessuna sessione). Così il test esercita
 * handshake, serializzazione e cancellazione reali del protocollo, non un mock
 * del `Client`: se l'SDK cambia comportamento ce ne accorgiamo qui.
 */

/** Stato mutabile del finto graphify: i test lo pilotano tra una call e l'altra. */
interface FakeState {
  /** Richieste HTTP ricevute in totale (handshake + tool call). */
  requests: number;
  /** `true` = ogni richiesta risponde 500 (container rotto / non ancora pronto). */
  broken: boolean;
  /** Ritardo applicato all'handler del tool, per provare i timeout. */
  delayMs: number;
  /** `true` = il tool risponde `isError` (grafo assente per quel project_path). */
  toolFails: boolean;
  /** Argomenti dell'ultima invocazione di `query_graph`. */
  lastArgs: Record<string, unknown> | null;
}

interface FakeGraphify {
  url: string;
  state: FakeState;
  close(): Promise<void>;
}

/** Monta il tool `query_graph` con la stessa firma del graphify reale. */
function buildFakeServer(state: FakeState): McpServer {
  const server = new McpServer({ name: "fake-graphify", version: "0.0.0" });
  server.registerTool(
    "query_graph",
    {
      description: "Interroga il knowledge graph",
      inputSchema: {
        question: z.string(),
        project_path: z.string(),
        token_budget: z.number().optional(),
      },
    },
    async (args) => {
      state.lastArgs = args;
      if (state.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }
      if (state.toolFails) {
        return {
          content: [{ type: "text" as const, text: "no graph at that project_path" }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: `SUBGRAPH: ${args.question}` }] };
    },
  );
  return server;
}

async function startFakeGraphify(): Promise<FakeGraphify> {
  const state: FakeState = {
    requests: 0,
    broken: false,
    delayMs: 0,
    toolFails: false,
    lastArgs: null,
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const server = buildFakeServer(state);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const httpServer: Server = createServer((req, res) => {
    state.requests += 1;
    if (state.broken) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("kaboom");
      return;
    }
    handle(req, res).catch(() => {
      // Il client può abortire a metà (timeout): la risposta è già chiusa,
      // nel test non c'è niente da fare.
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

/** Porta sicuramente chiusa: apriamo un listener e lo spegniamo subito. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

function fakeLogger() {
  return { warn: vi.fn(), debug: vi.fn() };
}

const query = { projectPath: "/graphs/repo-1", question: "chi chiama foo?", tokenBudget: 1200 };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("createGraphMcpClient", () => {
  it("interroga query_graph e ritorna il testo del sottografo", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    const client = createGraphMcpClient({ url: fake.url, logger: fakeLogger() });
    cleanups.push(() => client.close());

    const text = await client.queryGraph(query);

    expect(text).toBe("SUBGRAPH: chi chiama foo?");
    expect(fake.state.lastArgs).toMatchObject({
      question: "chi chiama foo?",
      project_path: "/graphs/repo-1",
      token_budget: 1200,
    });
  });

  it("riusa la connessione tra due query (handshake una volta sola)", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    const client = createGraphMcpClient({ url: fake.url, logger: fakeLogger() });
    cleanups.push(() => client.close());

    await client.queryGraph(query);
    const afterFirst = fake.state.requests;
    await client.queryGraph(query);

    // La seconda query costa UNA richiesta (la tool call): se ci fosse un nuovo
    // handshake il delta sarebbe maggiore.
    expect(fake.state.requests - afterFirst).toBe(1);
  });

  it("ritorna null su isError SENZA aprire il circuito", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    const logger = fakeLogger();
    const client = createGraphMcpClient({ url: fake.url, logger });
    cleanups.push(() => client.close());

    fake.state.toolFails = true;
    expect(await client.queryGraph(query)).toBeNull();
    expect(await client.queryGraph(query)).toBeNull();
    expect(await client.queryGraph(query)).toBeNull();

    // Quarto tentativo: il circuito è chiuso, quindi l'I/O avviene ancora e una
    // risposta buona torna a passare (il grafo mancante di UN repo non deve
    // spegnere il retrieval per tutti).
    const before = fake.state.requests;
    fake.state.toolFails = false;
    expect(await client.queryGraph(query)).toBe("SUBGRAPH: chi chiama foo?");
    expect(fake.state.requests).toBeGreaterThan(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ritorna null quando il server non risponde affatto (porta chiusa)", async () => {
    const client = createGraphMcpClient({ url: await closedPortUrl(), logger: fakeLogger() });
    cleanups.push(() => client.close());

    expect(await client.queryGraph(query)).toBeNull();
  });

  it("apre il circuito dopo 3 errori consecutivi: il 4° tentativo non fa I/O", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    const logger = fakeLogger();
    const client = createGraphMcpClient({ url: fake.url, logger });
    cleanups.push(() => client.close());

    fake.state.broken = true;
    expect(await client.queryGraph(query)).toBeNull();
    expect(await client.queryGraph(query)).toBeNull();
    expect(await client.queryGraph(query)).toBeNull();

    const afterThree = fake.state.requests;
    expect(afterThree).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Circuito aperto: nessuna richiesta esce, e nessun altro warn.
    expect(await client.queryGraph(query)).toBeNull();
    expect(await client.queryGraph(query)).toBeNull();
    expect(fake.state.requests).toBe(afterThree);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("ritenta quando il cooldown di 5 minuti è scaduto", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    let clock = 1_000_000;
    const client = createGraphMcpClient({
      url: fake.url,
      logger: fakeLogger(),
      now: () => clock,
    });
    cleanups.push(() => client.close());

    fake.state.broken = true;
    await client.queryGraph(query);
    await client.queryGraph(query);
    await client.queryGraph(query);
    const afterOpen = fake.state.requests;

    // Quattro minuti: ancora aperto.
    clock += 4 * 60_000;
    expect(await client.queryGraph(query)).toBeNull();
    expect(fake.state.requests).toBe(afterOpen);

    // Oltre i cinque: si ritenta e, se il server è tornato, si riprende.
    clock += 2 * 60_000;
    fake.state.broken = false;
    expect(await client.queryGraph(query)).toBe("SUBGRAPH: chi chiama foo?");
    expect(fake.state.requests).toBeGreaterThan(afterOpen);
  });

  it("un successo azzera il contatore degli errori consecutivi", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    const logger = fakeLogger();
    const client = createGraphMcpClient({ url: fake.url, logger });
    cleanups.push(() => client.close());

    fake.state.broken = true;
    await client.queryGraph(query);
    await client.queryGraph(query);

    fake.state.broken = false;
    expect(await client.queryGraph(query)).toBe("SUBGRAPH: chi chiama foo?");

    // Altri due errori: senza l'azzeramento sarebbero il 3° e il 4° e il
    // circuito si aprirebbe.
    fake.state.broken = true;
    await client.queryGraph(query);
    await client.queryGraph(query);
    const afterFailures = fake.state.requests;

    fake.state.broken = false;
    expect(await client.queryGraph(query)).toBe("SUBGRAPH: chi chiama foo?");
    expect(fake.state.requests).toBeGreaterThan(afterFailures);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rispetta il timeout quando il server risponde lento", async () => {
    const fake = await startFakeGraphify();
    cleanups.push(fake.close);
    const client = createGraphMcpClient({ url: fake.url, logger: fakeLogger() });
    cleanups.push(() => client.close());

    fake.state.delayMs = 1_500;
    const started = Date.now();
    const text = await client.queryGraph({ ...query, timeoutMs: 150 });
    const elapsed = Date.now() - started;

    expect(text).toBeNull();
    expect(elapsed).toBeLessThan(1_000);
  });
});
