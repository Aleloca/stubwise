/**
 * `@stubwise/embeddings` — client puro per API OpenAI-compatibile `/v1/embeddings`.
 *
 * Niente side-effect impliciti: `fetch` è iniettabile (default: la global `fetch`) così
 * i test usano un fake e il chiamante (worker/server) passa quella reale. Il client
 * conosce solo il contratto OpenAI:
 *   POST ${baseUrl}/embeddings  body { model, input: string[] }
 *   → { data: [{ embedding: number[] }, ...] }   (in ordine di input)
 *
 * Esporta anche un `createFakeEmbeddingClient` deterministico (vettori da hash stabile
 * del testo, default 1024 dim come bge-m3) per i test a valle di worker/server, senza rete.
 */

/** Dimensione di default dei vettori prodotti dal fake (bge-m3 = 1024). */
export const FAKE_EMBEDDING_DIMENSION = 1024;

/** Sottoinsieme di `fetch` usato dal client (per facilitarne l'iniezione nei test). */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface EmbeddingClient {
  /** Ritorna un vettore per ogni input, nello stesso ordine. */
  embed(inputs: string[]): Promise<number[][]>;
}

export interface CreateEmbeddingClientOptions {
  /** Base URL già comprensiva di `/v1` (es. `http://ollama:11434/v1`). */
  baseUrl: string;
  /** Nome del modello di embedding (es. `bge-m3`). */
  model: string;
  /** API key opzionale: se presente viene inviata come `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** `fetch` iniettabile; default: la global `fetch`. */
  fetch?: FetchLike;
}

interface OpenAIEmbeddingResponse {
  data?: { embedding?: number[] }[];
}

/** Unisce baseUrl e path senza generare doppie slash. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createEmbeddingClient(
  options: CreateEmbeddingClientOptions,
): EmbeddingClient {
  const { baseUrl, model, apiKey } = options;
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike | undefined);

  if (!doFetch) {
    throw new Error(
      "createEmbeddingClient: nessun `fetch` disponibile (global mancante); passarne uno via options.fetch",
    );
  }

  const url = joinUrl(baseUrl, "embeddings");

  return {
    async embed(inputs: string[]): Promise<number[][]> {
      // Input vuoto: nessuna chiamata di rete, risultato banale.
      if (inputs.length === 0) return [];

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const response = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: inputs }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Embedding request to ${url} failed with status ${response.status}` +
            (detail ? `: ${detail}` : ""),
        );
      }

      const payload = (await response.json()) as OpenAIEmbeddingResponse;
      const data = payload.data;
      if (!data || data.length !== inputs.length) {
        throw new Error(
          `Embedding response from ${url} returned ${data?.length ?? 0} embeddings for ${inputs.length} inputs`,
        );
      }

      return data.map((item, i) => {
        const embedding = item?.embedding;
        if (!embedding) {
          throw new Error(
            `Embedding response from ${url} is missing the embedding at index ${i}`,
          );
        }
        return embedding;
      });
    },
  };
}

export interface CreateFakeEmbeddingClientOptions {
  /** Dimensione dei vettori prodotti; default `FAKE_EMBEDDING_DIMENSION` (1024). */
  dimension?: number;
}

/**
 * Hash deterministico (FNV-1a 32-bit) di una stringa. Stabile tra run/processi:
 * a differenza di `Math.random` o degli hash di V8, non dipende dallo stato del runtime.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // moltiplicazione FNV mantenuta entro 32 bit unsigned
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Embedding client DETERMINISTICO e senza rete per i test a valle.
 * Per ogni input genera un vettore della dimensione richiesta i cui valori derivano da un
 * PRNG (xorshift32) seedato con l'hash FNV-1a del testo: stesso testo → stesso vettore,
 * testi diversi → vettori (quasi sempre) diversi. Valori normalizzati in `[-1, 1)`.
 */
export function createFakeEmbeddingClient(
  options: CreateFakeEmbeddingClientOptions = {},
): EmbeddingClient {
  const dimension = options.dimension ?? FAKE_EMBEDDING_DIMENSION;

  function vectorFor(text: string): number[] {
    // seed != 0 (xorshift degenera su 0): l'hash FNV-1a è già pseudo-uniforme, ma forziamo.
    let state = fnv1a(text) || 1;
    const vector = new Array<number>(dimension);
    for (let i = 0; i < dimension; i++) {
      // xorshift32
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      vector[i] = (state / 0xffffffff) * 2 - 1;
    }
    return vector;
  }

  return {
    async embed(inputs: string[]): Promise<number[][]> {
      return inputs.map(vectorFor);
    },
  };
}
