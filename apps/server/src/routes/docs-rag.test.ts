import { describe, expect, it, vi } from "vitest";
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
