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

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { agentRuns, aiModelSettings, aiProviders, decrypt } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { aiModelChoiceSchema, resolveApiModelId } from "@stubwise/shared";
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
  /**
   * A cosa serve la generazione, per il modello e per i consumi: `operation`
   * sceglie la riga di `ai_model_settings` e tagga la riga di `agent_runs`;
   * `projectId` è il progetto a cui attribuire la spesa (null se il chiamante
   * non ne ha uno). Obbligatorio apposta: un chiamante nuovo che lo dimentica
   * non compila, invece di finire in Usage con un'operazione sbagliata.
   */
  usage: ChatUsage;
}

/** Operazione e progetto di una generazione della chat (vedi {@link ChatLlmInput.usage}). */
export interface ChatUsage {
  operation: "chat" | "backlog_merge";
  projectId: string | null;
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
  /**
   * Modello quando `ai_model_settings` non ha una riga (valida) per
   * l'operazione; default {@link DEFAULT_CHAT_MODEL}.
   */
  model?: string;
  /**
   * Client Anthropic iniettabile: nei test un finto che emette gli eventi dello
   * stream (la network guard del server vieta le chiamate vere). Default: il
   * client dell'SDK con la API key del provider.
   */
  createClient?: (apiKey: string) => Pick<Anthropic, "messages">;
  /** Logger per i fallimenti best-effort (impostazione non valida, insert dei consumi). */
  logger?: { warn: (obj: object, msg: string) => void };
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
 * I test delle rotte esercitano il fake; questa ha i suoi in chat-llm.test.ts
 * (client Anthropic iniettato, niente rete).
 */
/**
 * Risolve la API key Anthropic dal PRIMO provider `api_key` abilitato e
 * decifrabile (ordine di `position`, stesso failover di `stream`). Gli
 * account/oauth sono saltati: l'SDK HTTP non li accetta (vedi limitazione sopra).
 * Restituisce anche l'id del provider, che la riga dei consumi registra.
 * Restituisce `undefined` se nessun provider utilizzabile esiste — usato sia
 * dal pre-flight ({@link ChatLlm.isAvailable}) sia dallo streaming, così i due
 * percorsi condividono ESATTAMENTE la stessa logica di selezione.
 */
async function resolveApiKey(
  db: Db,
  encryptionKey: Buffer,
): Promise<{ apiKey: string; providerId: string } | undefined> {
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
      return { apiKey: decrypt(row.secretEncrypted, encryptionKey), providerId: row.id };
    } catch {
      // Secret non decifrabile: prova il prossimo api_key. Mai loggare il payload.
    }
  }
  return undefined;
}

/**
 * Modello effettivo per un'operazione: la riga di `ai_model_settings` se c'è
 * ed è nel catalogo (alias risolto nell'id API, l'SDK non accetta alias),
 * altrimenti `fallback`. Letta a OGNI generazione: un cambio vale dalla
 * prossima risposta, senza riavvii. Un valore fuori catalogo (riga vecchia,
 * catalogo cambiato in un deploy successivo) si ignora con una riga di log.
 */
async function resolveChatModel(
  db: Db,
  operation: ChatUsage["operation"],
  fallback: string,
  logger: CreateAnthropicChatLlmOptions["logger"],
): Promise<string> {
  const [row] = await db
    .select({ model: aiModelSettings.model })
    .from(aiModelSettings)
    .where(eq(aiModelSettings.operation, operation));
  if (!row) return fallback;
  const parsed = aiModelChoiceSchema.safeParse(row.model);
  if (!parsed.success) {
    logger?.warn(
      { operation, model: row.model },
      "ai_model_settings: modello fuori catalogo, uso il default",
    );
    return fallback;
  }
  return resolveApiModelId(parsed.data);
}

/** Token di una generazione, raccolti dagli eventi dello stream. */
interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function createAnthropicChatLlm(options: CreateAnthropicChatLlmOptions): ChatLlm {
  const { db, encryptionKey, logger } = options;
  const fallbackModel = options.model ?? DEFAULT_CHAT_MODEL;
  const createClient =
    options.createClient ?? ((apiKey: string) => new Anthropic({ apiKey }));

  /**
   * Riga dei consumi in `agent_runs`, best-effort: un errore d'insert si logga
   * e si ingoia, mai propagato a chi sta leggendo la risposta. Nessun owner
   * (job/review/posta) e nessuna fase: la chat non ne ha. `cost_usd` resta
   * nullo: l'API non riporta il costo, Usage lo stima dai token.
   */
  async function recordUsage(args: {
    usage: ChatUsage;
    providerId: string;
    model: string;
    tokens: StreamUsage;
  }): Promise<void> {
    try {
      await db.insert(agentRuns).values({
        operation: args.usage.operation,
        projectId: args.usage.projectId,
        providerId: args.providerId,
        runId: randomUUID(),
        model: args.model,
        inputTokens: args.tokens.inputTokens,
        outputTokens: args.tokens.outputTokens,
        cacheReadTokens: args.tokens.cacheReadTokens,
        cacheCreationTokens: args.tokens.cacheCreationTokens,
        costUsd: null,
      });
    } catch (err) {
      logger?.warn({ err, operation: args.usage.operation }, "chat: consumi non registrati");
    }
  }

  return {
    async isAvailable(): Promise<ChatAvailability> {
      // Pre-flight: la chat è servibile solo se esiste un provider api_key
      // utilizzabile. Stesso percorso di selezione dello stream (no drift).
      const resolved = await resolveApiKey(db, encryptionKey);
      return resolved
        ? { available: true }
        : { available: false, reason: "no_api_key_provider" };
    },

    async *stream(input: ChatLlmInput): AsyncIterable<string> {
      const resolved = await resolveApiKey(db, encryptionKey);
      if (!resolved) {
        throw new Error(
          "chat RAG non disponibile: nessun provider AI 'api_key' abilitato. " +
            "La chat richiede una API key Anthropic (i provider 'account'/oauth non sono supportati dall'SDK HTTP).",
        );
      }
      const model = await resolveChatModel(db, input.usage.operation, fallbackModel, logger);

      const client = createClient(resolved.apiKey);
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

      // Token: input e cache da `message_start`, output dall'ULTIMO
      // `message_delta` (è cumulativo). Senza `message_start` la richiesta non è
      // mai partita davvero: niente riga. Interrotto prima di un
      // `message_delta` (abort, errore) → output 0: i token in uscita già
      // generati non ci sono noti.
      let tokens: StreamUsage | undefined;
      try {
        for await (const event of messageStream) {
          if (event.type === "message_start") {
            const u = event.message.usage;
            tokens = {
              inputTokens: u.input_tokens,
              outputTokens: 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            };
          } else if (event.type === "message_delta") {
            if (tokens) tokens.outputTokens = event.usage.output_tokens;
          } else if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
        }
      } finally {
        // A fine stream in OGNI caso (completo, errore, consumatore uscito dal
        // loop): fire-and-forget, così la scrittura non ritarda la chiusura
        // della risposta al client. recordUsage non lancia mai.
        if (tokens) {
          void recordUsage({ usage: input.usage, providerId: resolved.providerId, model, tokens });
        }
      }
    },
  };
}
