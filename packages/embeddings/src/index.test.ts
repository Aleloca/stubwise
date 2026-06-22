import { describe, expect, it, vi } from "vitest";

import {
  createEmbeddingClient,
  createFakeEmbeddingClient,
  FAKE_EMBEDDING_DIMENSION,
  type FetchLike,
} from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createEmbeddingClient", () => {
  it("chiama ${baseUrl}/embeddings col metodo/body/model giusti e ritorna i vettori in ordine", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
    );
    const client = createEmbeddingClient({
      baseUrl: "http://ollama:11434/v1",
      model: "bge-m3",
      fetch: fetchMock,
    });

    const out = await client.embed(["a", "b"]);

    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://ollama:11434/v1/embeddings");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      model: "bge-m3",
      input: ["a", "b"],
    });
  });

  it("invia Authorization: Bearer <apiKey> quando apiKey è presente", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ data: [{ embedding: [1] }] }));
    const client = createEmbeddingClient({
      baseUrl: "http://ollama:11434/v1",
      model: "bge-m3",
      apiKey: "secret-key",
      fetch: fetchMock,
    });

    await client.embed(["x"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-key");
  });

  it("omette Authorization quando apiKey è assente", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ data: [{ embedding: [1] }] }));
    const client = createEmbeddingClient({
      baseUrl: "http://ollama:11434/v1",
      model: "bge-m3",
      fetch: fetchMock,
    });

    await client.embed(["x"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("propaga gli errori HTTP con un messaggio che include lo status", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("upstream exploded", { status: 500 }),
    );
    const client = createEmbeddingClient({
      baseUrl: "http://ollama:11434/v1",
      model: "bge-m3",
      fetch: fetchMock,
    });

    await expect(client.embed(["x"])).rejects.toThrow(/500/);
    await expect(
      createEmbeddingClient({
        baseUrl: "http://ollama:11434/v1",
        model: "bge-m3",
        fetch: vi.fn(async () => new Response("upstream exploded", { status: 500 })),
      }).embed(["x"]),
    ).rejects.toThrow(/upstream exploded/);
  });

  it("con input vuoto ritorna [] senza chiamare fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    const client = createEmbeddingClient({
      baseUrl: "http://ollama:11434/v1",
      model: "bge-m3",
      fetch: fetchMock,
    });

    const out = await client.embed([]);

    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("solleva se la risposta ha meno embedding degli input", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1] }] }));
    const client = createEmbeddingClient({
      baseUrl: "http://ollama:11434/v1",
      model: "bge-m3",
      fetch: fetchMock,
    });

    await expect(client.embed(["a", "b"])).rejects.toThrow();
  });
});

describe("createFakeEmbeddingClient", () => {
  it("è deterministico: stesso input → stesso vettore di 1024 dimensioni", async () => {
    const fake = createFakeEmbeddingClient();
    const [v1] = await fake.embed(["ciao mondo"]);
    const [v2] = await fake.embed(["ciao mondo"]);

    expect(v1).toHaveLength(FAKE_EMBEDDING_DIMENSION);
    expect(FAKE_EMBEDDING_DIMENSION).toBe(1024);
    expect(v1).toEqual(v2);
  });

  it("input diversi → vettori diversi", async () => {
    const fake = createFakeEmbeddingClient();
    const [a] = await fake.embed(["alpha"]);
    const [b] = await fake.embed(["beta"]);

    expect(a).not.toEqual(b);
  });

  it("rispetta la dimensione configurabile e l'ordine degli input", async () => {
    const fake = createFakeEmbeddingClient({ dimension: 8 });
    const out = await fake.embed(["x", "y"]);

    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(8);
    expect(out[1]).toHaveLength(8);
    expect(out[0]).not.toEqual(out[1]);
  });
});
