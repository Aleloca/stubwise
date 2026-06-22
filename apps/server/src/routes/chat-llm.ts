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
}

/**
 * LLM della chat: data una conversazione, emette i delta di testo della
 * risposta come async-iterable (uno yield per frammento). Lo streaming è il
 * contratto: la route li inoltra al client via SSE man mano che arrivano.
 */
export interface ChatLlm {
  stream(input: ChatLlmInput): AsyncIterable<string>;
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
export function createAnthropicChatLlm(options: CreateAnthropicChatLlmOptions): ChatLlm {
  const { db, encryptionKey } = options;
  const model = options.model ?? DEFAULT_CHAT_MODEL;

  return {
    async *stream(input: ChatLlmInput): AsyncIterable<string> {
      // Primo provider api_key abilitato (ordine di failover). Gli account/oauth
      // sono saltati: l'SDK HTTP non li accetta (vedi limitazione sopra).
      const rows = await db
        .select({
          id: aiProviders.id,
          kind: aiProviders.kind,
          secretEncrypted: aiProviders.secretEncrypted,
        })
        .from(aiProviders)
        .where(eq(aiProviders.enabled, true))
        .orderBy(asc(aiProviders.position));

      let apiKey: string | undefined;
      for (const row of rows) {
        if (row.kind !== "api_key") continue;
        try {
          apiKey = decrypt(row.secretEncrypted, encryptionKey);
          break;
        } catch {
          // Secret non decifrabile: prova il prossimo api_key. Mai loggare il payload.
          continue;
        }
      }
      if (!apiKey) {
        throw new Error(
          "chat RAG non disponibile: nessun provider AI 'api_key' abilitato. " +
            "La chat richiede una API key Anthropic (i provider 'account'/oauth non sono supportati dall'SDK HTTP).",
        );
      }

      const client = new Anthropic({ apiKey });
      const messageStream = client.messages.stream({
        model,
        max_tokens: CHAT_MAX_TOKENS,
        system: input.system,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      });

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
