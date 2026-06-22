/**
 * Astrazione iniettabile per l'LLM della chat RAG sui Docs (M6.5).
 *
 * La route `POST /api/projects/:projectId/docs/chat` non parla mai direttamente
 * con un provider: riceve un `ChatLlm` da `buildApp` (decorato sull'app come
 * `embeddingClient`). In produzione è {@link createAnthropicChatLlm}, che
 * stremma una completion via SDK Anthropic; nei test si inietta un fake che
 * emette delta canned, così il plumbing (RAG, SSE, persistenza) è testabile
 * senza rete né credenziali.
 */

import Anthropic from "@anthropic-ai/sdk";
import { aiProviders, decrypt } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { asc, eq } from "drizzle-orm";

/** Messaggio della conversazione passato all'LLM (senza il system, separato). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Input di una generazione: system prompt + storico della conversazione. */
export interface ChatLlmInput {
  system: string;
  messages: ChatMessage[];
  /**
   * Segnale di abort opzionale: quando viene abortito (es. disconnessione del
   * client) l'implementazione DEVE interrompere la generazione sottostante per
   * fermare il consumo di token. L'implementazione Anthropic lo inoltra alla
   * richiesta HTTP dell'SDK; il fake nei test lo ignora (o lo osserva).
   */
  signal?: AbortSignal;
}

/**
 * Esito di un controllo di disponibilità della chat (pre-flight): la chat è
 * servibile solo se esiste un provider AI utilizzabile. `reason` è un codice
 * stabile per la diagnostica/log; il messaggio user-facing lo decide la route.
 */
export interface ChatAvailability {
  available: boolean;
  reason?: string;
}

/**
 * LLM della chat: data una conversazione, emette i delta di testo della
 * risposta come async-iterable (uno yield per frammento). Lo streaming è il
 * contratto: la route li inoltra al client via SSE man mano che arrivano.
 */
export interface ChatLlm {
  stream(input: ChatLlmInput): AsyncIterable<string>;
  /**
   * Controllo PRE-FLIGHT opzionale: riporta se la chat è servibile SENZA aprire
   * uno stream, così la route può rispondere con un errore JSON pulito (503)
   * PRIMA di `reply.hijack()` invece di fallire a metà stream con un evento SSE
   * `error` opaco. L'impl reale verifica che esista un provider `api_key`
   * abilitato e decifrabile; il fake (test) è sempre disponibile. Quando assente,
   * la route salta il pre-flight e si affida al solo fallback mid-stream.
   */
  isAvailable?(): Promise<ChatAvailability>;
}

/**
 * Modello di default per la chat. Allineato al resto del progetto (il worker
 * usa "opus" per i task forti): qui usiamo l'id API completo richiesto dall'SDK
 * Anthropic. Override possibile via buildApp/config in futuro.
 */
export const DEFAULT_CHAT_MODEL = "claude-opus-4-8";

/** Tetto di token in output per una risposta di chat (streaming, ampio). */
const CHAT_MAX_TOKENS = 4096;

export interface CreateAnthropicChatLlmOptions {
  db: Db;
  /** Chiave AES-256 per decifrare il secret del provider AI (app.encryptionKey). */
  encryptionKey: Buffer;
  /** Modello da usare; default {@link DEFAULT_CHAT_MODEL}. */
  model?: string;
}

/**
 * Implementazione reale: legge il PRIMO provider AI abilitato di tipo `api_key`
 * (in ordine di `position`), ne decifra il secret con `encryptionKey`, e
 * stremma una completion Claude col modello configurato.
 *
 * LIMITAZIONE NOTA (v1): la chat richiede un provider `api_key`. I provider
 * `account`/oauth (CLAUDE_CODE_OAUTH_TOKEN) servono il CLI `claude` del worker
 * ma NON l'SDK HTTP `@anthropic-ai/sdk` usato qui — l'SDK vuole una API key.
 * Se non esiste alcun provider `api_key` abilitato, `stream` lancia un errore
 * chiaro: la chat non è servibile finché non si configura un provider API key.
 * (La generazione dei Docs e i fix AI continuano a funzionare con gli account.)
 *
 * Implementazione volutamente minima: i test esercitano il fake, non questa.
 */
/**
 * Risolve la API key Anthropic dal PRIMO provider `api_key` abilitato e
 * decifrabile (ordine di `position`, stesso failover di `stream`). Gli
 * account/oauth sono saltati: l'SDK HTTP non li accetta (vedi limitazione sopra).
 * Restituisce `undefined` se nessun provider utilizzabile esiste — usato sia
 * dal pre-flight ({@link ChatLlm.isAvailable}) sia dallo streaming, così i due
 * percorsi condividono ESATTAMENTE la stessa logica di selezione.
 */
async function resolveApiKey(db: Db, encryptionKey: Buffer): Promise<string | undefined> {
  const rows = await db
    .select({
      id: aiProviders.id,
      kind: aiProviders.kind,
      secretEncrypted: aiProviders.secretEncrypted,
    })
    .from(aiProviders)
    .where(eq(aiProviders.enabled, true))
    .orderBy(asc(aiProviders.position));

  for (const row of rows) {
    if (row.kind !== "api_key") continue;
    try {
      return decrypt(row.secretEncrypted, encryptionKey);
    } catch {
      // Secret non decifrabile: prova il prossimo api_key. Mai loggare il payload.
    }
  }
  return undefined;
}

export function createAnthropicChatLlm(options: CreateAnthropicChatLlmOptions): ChatLlm {
  const { db, encryptionKey } = options;
  const model = options.model ?? DEFAULT_CHAT_MODEL;

  return {
    async isAvailable(): Promise<ChatAvailability> {
      // Pre-flight: la chat è servibile solo se esiste un provider api_key
      // utilizzabile. Stesso percorso di selezione dello stream (no drift).
      const apiKey = await resolveApiKey(db, encryptionKey);
      return apiKey
        ? { available: true }
        : { available: false, reason: "no_api_key_provider" };
    },

    async *stream(input: ChatLlmInput): AsyncIterable<string> {
      const apiKey = await resolveApiKey(db, encryptionKey);
      if (!apiKey) {
        throw new Error(
          "chat RAG non disponibile: nessun provider AI 'api_key' abilitato. " +
            "La chat richiede una API key Anthropic (i provider 'account'/oauth non sono supportati dall'SDK HTTP).",
        );
      }

      const client = new Anthropic({ apiKey });
      // Il signal è inoltrato come request option dell'SDK (secondo argomento):
      // quando viene abortito, l'SDK chiude la richiesta HTTP sottostante e la
      // generazione si ferma davvero (stop al consumo di token), non solo il
      // consumo dell'iterabile lato nostro.
      const messageStream = client.messages.stream(
        {
          model,
          max_tokens: CHAT_MAX_TOKENS,
          system: input.system,
          messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal: input.signal },
      );

      for await (const event of messageStream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    },
  };
}
