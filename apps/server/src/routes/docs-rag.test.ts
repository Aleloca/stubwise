import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLlm, ChatLlmInput } from "./chat-llm.js";
import type { RetrievedChunk } from "./docs-retrieval.js";

// Mock del retrieval: answerDocsQuestion non deve toccare il DB né l'embedding
// reale in questo unit test. Restituiamo chunk canned per asserire il wiring
// (system prompt col contesto, citazioni dedup) senza testcontainers.
const retrieveChunksMock = vi.fn();
const retrieveChunksForProjectMock = vi.fn();
vi.mock("./docs-retrieval.js", () => ({
  retrieveChunks: (...args: unknown[]) => retrieveChunksMock(...args),
  retrieveChunksForProject: (...args: unknown[]) => retrieveChunksForProjectMock(...args),
}));

// Mock del retrieval dal grafo (fase 2b): qui si verifica l'INNESTO (parallelo
// + blocco appeso in coda), non la logica di gating/lettura dei mirror, che ha
// i suoi test su Postgres vero in graph-chat/context.test.ts. `appendGraphContext`
// resta invece l'implementazione REALE (importOriginal): è ciò che asseriamo.
const retrieveGraphContextMock = vi.fn();
const retrieveGraphContextForProjectMock = vi.fn();
vi.mock("../graph-chat/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../graph-chat/context.js")>()),
  retrieveGraphContext: (...args: unknown[]) => retrieveGraphContextMock(...args),
  retrieveGraphContextForProject: (...args: unknown[]) =>
    retrieveGraphContextForProjectMock(...args),
}));

// Import DOPO il vi.mock così il modulo sotto test lega la versione mockata.
const { answerDocsQuestion, answerProjectDocsQuestion, CHAT_RETRIEVAL_K } =
  await import("./docs-rag.js");

function chunk(over: Partial<RetrievedChunk> & { slug: string; title: string }): RetrievedChunk {
  return {
    pageId: `page-${over.slug}`,
    kind: "technical",
    snippet: "snippet",
    score: 1,
    source: "semantic",
    repositoryId: "repo-1",
    repositorySlug: "repo-uno",
    repositoryName: "Repo Uno",
    ...over,
  };
}

// Fake ChatLlm: registra l'input e emette dei delta canned, da accumulare.
const FAKE_DELTAS = ["Risposta ", "dai ", "docs."];
let lastChatInput: ChatLlmInput | null = null;
const fakeChatLlm: ChatLlm = {
  stream(input: ChatLlmInput): AsyncIterable<string> {
    lastChatInput = input;
    return (async function* () {
      for (const d of FAKE_DELTAS) yield d;
    })();
  },
};

// Deps fittizie: db ed embeddingClient sono opachi (il retrieval è mockato),
// ci basta che vengano inoltrati a retrieveChunks.
const fakeDb = { __db: true } as never;
const fakeEmbeddingClient = { __emb: true } as never;

describe("answerDocsQuestion", () => {
  it("accumula lo stream e restituisce testo completo + citazioni dedup", async () => {
    lastChatInput = null;
    retrieveChunksMock.mockResolvedValueOnce([
      chunk({ slug: "auth", title: "Autenticazione" }),
      // Stesso slug: deve essere deduplicato in una sola citazione.
      chunk({ slug: "auth", title: "Autenticazione" }),
      chunk({ slug: "billing", title: "Fatturazione", kind: "functional" }),
    ]);

    const answer = await answerDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { repositoryId: "proj-1", question: "Come funziona l'auth?" },
    );

    // Testo = delta concatenati (accumulo, niente streaming).
    expect(answer.text).toBe(FAKE_DELTAS.join(""));

    // Citazioni dedup per (repository, slug), con kind e repository preservati.
    expect(answer.citations).toEqual([
      {
        slug: "auth",
        title: "Autenticazione",
        kind: "technical",
        repositoryId: "repo-1",
        repositorySlug: "repo-uno",
        repositoryName: "Repo Uno",
      },
      {
        slug: "billing",
        title: "Fatturazione",
        kind: "functional",
        repositoryId: "repo-1",
        repositorySlug: "repo-uno",
        repositoryName: "Repo Uno",
      },
    ]);
  });

  it("recupera con k = CHAT_RETRIEVAL_K (8) e passa la sola domanda come unico messaggio utente", async () => {
    lastChatInput = null;
    retrieveChunksMock.mockResolvedValueOnce([
      chunk({ slug: "zqw", title: "Zqwpayments", snippet: "Il modulo Zqwpayments gestisce gli incassi." }),
    ]);

    const question = "Si può fare un incasso ricorrente?";
    await answerDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { repositoryId: "proj-2", question },
    );

    // retrieveChunks chiamato con le deps inoltrate, la query e k=8.
    expect(CHAT_RETRIEVAL_K).toBe(8);
    expect(retrieveChunksMock).toHaveBeenLastCalledWith(
      fakeDb,
      fakeEmbeddingClient,
      "proj-2",
      question,
      { k: CHAT_RETRIEVAL_K },
    );

    // System prompt col contesto recuperato (snippet + titolo) e regole.
    expect(lastChatInput).not.toBeNull();
    expect(lastChatInput!.system).toContain("Il modulo Zqwpayments gestisce gli incassi.");
    expect(lastChatInput!.system).toContain("Zqwpayments");
    expect(lastChatInput!.system).toContain("CITA SEMPRE");

    // Nessuna history: un solo messaggio, role user, = la domanda.
    expect(lastChatInput!.messages).toEqual([{ role: "user", content: question }]);
    // Nessun AbortSignal (one-shot).
    expect(lastChatInput!.signal).toBeUndefined();
  });

  it("nessun chunk recuperato: nessuna citazione, system prompt col fallback", async () => {
    lastChatInput = null;
    retrieveChunksMock.mockResolvedValueOnce([]);

    const answer = await answerDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { repositoryId: "proj-3", question: "Domanda senza contesto." },
    );

    expect(answer.citations).toEqual([]);
    expect(answer.text).toBe(FAKE_DELTAS.join(""));
    expect(lastChatInput!.system).toContain("nessuna pagina di documentazione rilevante");
  });
});

describe("answerProjectDocsQuestion", () => {
  it("aggrega da PIÙ repo: testo accumulato + citazioni che includono il repo", async () => {
    lastChatInput = null;
    // Chunk da DUE repository diversi dello stesso progetto.
    retrieveChunksForProjectMock.mockResolvedValueOnce([
      chunk({
        slug: "auth",
        title: "Autenticazione",
        repositoryId: "repo-a",
        repositorySlug: "repo-alfa",
        repositoryName: "Repo Alfa",
        snippet: "L'auth di Alfa usa cookie firmati.",
      }),
      chunk({
        slug: "billing",
        title: "Fatturazione",
        kind: "functional",
        repositoryId: "repo-b",
        repositorySlug: "repo-beta",
        repositoryName: "Repo Beta",
        snippet: "La fatturazione di Beta calcola le imposte.",
      }),
    ]);

    const answer = await answerProjectDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { projectId: "proj-1", question: "Come funziona auth e billing?" },
    );

    // Testo = delta accumulati (one-shot, niente streaming).
    expect(answer.text).toBe(FAKE_DELTAS.join(""));

    // Citazioni da ENTRAMBI i repo, con i campi repository valorizzati.
    expect(answer.citations).toEqual([
      {
        slug: "auth",
        title: "Autenticazione",
        kind: "technical",
        repositoryId: "repo-a",
        repositorySlug: "repo-alfa",
        repositoryName: "Repo Alfa",
      },
      {
        slug: "billing",
        title: "Fatturazione",
        kind: "functional",
        repositoryId: "repo-b",
        repositorySlug: "repo-beta",
        repositoryName: "Repo Beta",
      },
    ]);

    // Il system prompt include il contesto cross-repo (snippet + titolo + nome repo).
    expect(lastChatInput!.system).toContain("L'auth di Alfa usa cookie firmati.");
    expect(lastChatInput!.system).toContain("Repo Beta");
    // Nessuna history: un solo messaggio user = la domanda.
    expect(lastChatInput!.messages).toEqual([
      { role: "user", content: "Come funziona auth e billing?" },
    ]);
    expect(lastChatInput!.signal).toBeUndefined();
  });

  it("usa il retrieval cross-repo di progetto (k di default, niente k forzato)", async () => {
    lastChatInput = null;
    retrieveChunksForProjectMock.mockResolvedValueOnce([]);

    await answerProjectDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { projectId: "proj-2", question: "Domanda di progetto." },
    );

    // retrieveChunksForProject chiamato con le deps inoltrate, projectId e query.
    // k NON è forzato: lo dimensiona retrieveChunksForProject di default (D6).
    expect(retrieveChunksForProjectMock).toHaveBeenLastCalledWith(
      fakeDb,
      fakeEmbeddingClient,
      "proj-2",
      "Domanda di progetto.",
    );
  });
});

describe("retrieval dal grafo nei flussi one-shot (fase 2b)", () => {
  /** Blocco finto, nella forma prodotta da buildGraphContextBlock. */
  const GRAPH_BLOCK =
    "--- STRUTTURA DEL CODICE (knowledge graph al commit abcdef1) ---\nNODE login() [src=src/auth.ts loc=L12]";

  /**
   * Deps del grafo come le passa un chiamante interno (`app.graphChat` + il
   * logger della richiesta). Client e config sono opachi: qui il retrieval è
   * mockato, conta solo che l'oggetto venga inoltrato con `db` in testa.
   */
  const graphDeps = {
    client: { __client: true } as never,
    config: { __config: true } as never,
    logger: { debug: (): void => undefined },
  };

  beforeEach(() => {
    lastChatInput = null;
    retrieveGraphContextMock.mockReset();
    retrieveGraphContextForProjectMock.mockReset();
  });

  it("answerDocsQuestion con deps graph: blocco appeso IN CODA al system", async () => {
    retrieveChunksMock.mockResolvedValueOnce([chunk({ slug: "auth", title: "Autenticazione" })]);
    retrieveGraphContextMock.mockResolvedValueOnce(GRAPH_BLOCK);

    await answerDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm, graph: graphDeps },
      { repositoryId: "repo-1", question: "Chi crea la sessione?" },
    );

    // Deps composte con il db del flusso RAG; domanda utente passata verbatim.
    expect(retrieveGraphContextMock).toHaveBeenCalledWith(
      { db: fakeDb, ...graphDeps },
      { repositoryId: "repo-1", question: "Chi crea la sessione?" },
    );
    const system = lastChatInput!.system;
    expect(system).toContain("STRUTTURA DEL CODICE");
    expect(system.indexOf("--- CONTESTO RECUPERATO ---")).toBeLessThan(
      system.indexOf("STRUTTURA DEL CODICE"),
    );
  });

  it("answerDocsQuestion SENZA deps graph: nessuna query e system identico a prima", async () => {
    const chunks = [chunk({ slug: "auth", title: "Autenticazione" })];
    retrieveChunksMock.mockResolvedValueOnce(chunks);
    // Il grafo AVREBBE materiale da dare: senza deps non viene interrogato.
    retrieveGraphContextMock.mockResolvedValue(GRAPH_BLOCK);

    await answerDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { repositoryId: "repo-1", question: "Chi crea la sessione?" },
    );
    const withoutDeps = lastChatInput!.system;
    expect(retrieveGraphContextMock).not.toHaveBeenCalled();
    expect(withoutDeps).not.toContain("STRUTTURA DEL CODICE");

    // Stessa domanda CON le deps ma col grafo a vuoto (fail-open): il system
    // deve tornare identico byte per byte a quello senza deps.
    retrieveChunksMock.mockResolvedValueOnce(chunks);
    retrieveGraphContextMock.mockResolvedValue(null);
    await answerDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm, graph: graphDeps },
      { repositoryId: "repo-1", question: "Chi crea la sessione?" },
    );
    expect(retrieveGraphContextMock).toHaveBeenCalledTimes(1);
    expect(lastChatInput!.system).toBe(withoutDeps);
  });

  it("answerProjectDocsQuestion con deps graph: variante ForProject, blocco in coda", async () => {
    retrieveChunksForProjectMock.mockResolvedValueOnce([
      chunk({ slug: "auth", title: "Autenticazione" }),
    ]);
    retrieveGraphContextForProjectMock.mockResolvedValueOnce(GRAPH_BLOCK);

    await answerProjectDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm, graph: graphDeps },
      { projectId: "proj-1", question: "Come sono collegati i moduli?" },
    );

    expect(retrieveGraphContextForProjectMock).toHaveBeenCalledWith(
      { db: fakeDb, ...graphDeps },
      { projectId: "proj-1", question: "Come sono collegati i moduli?" },
    );
    // La variante per-repo NON è quella usata dal flusso di progetto.
    expect(retrieveGraphContextMock).not.toHaveBeenCalled();
    const system = lastChatInput!.system;
    expect(system.endsWith(GRAPH_BLOCK)).toBe(true);
  });

  it("answerProjectDocsQuestion SENZA deps graph: nessuna query, niente blocco", async () => {
    retrieveChunksForProjectMock.mockResolvedValueOnce([
      chunk({ slug: "auth", title: "Autenticazione" }),
    ]);

    await answerProjectDocsQuestion(
      { db: fakeDb, embeddingClient: fakeEmbeddingClient, chatLlm: fakeChatLlm },
      { projectId: "proj-1", question: "Come sono collegati i moduli?" },
    );

    expect(retrieveGraphContextForProjectMock).not.toHaveBeenCalled();
    expect(lastChatInput!.system).not.toContain("STRUTTURA DEL CODICE");
  });
});
