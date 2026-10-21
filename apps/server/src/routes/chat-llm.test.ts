import { randomBytes, randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns, aiModelSettings, aiProviders, encrypt, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { createAnthropicChatLlm, DEFAULT_CHAT_MODEL, type ChatLlmInput } from "./chat-llm.js";

/**
 * Implementazione REALE della chat (SDK Anthropic) con il client iniettato: la
 * network guard del server fa fallire un test che parla con l'API vera, quindi
 * qui il client è un finto che emette gli eventi dello stream dell'SDK.
 *
 * Copre: il modello scelto in `ai_model_settings` per l'operazione, il default
 * quando la riga manca, e la riga di consumo in `agent_runs` scritta a fine
 * stream (anche interrotto), best-effort.
 */

let testDb: TestDb;
let db: Db;
let projectId: string;
let providerId: string;
const encryptionKey = randomBytes(32);

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  const [provider] = await db
    .insert(aiProviders)
    .values({
      position: 0,
      kind: "api_key",
      label: "Console",
      secretEncrypted: encrypt("sk-ant-test", encryptionKey),
    })
    .returning({ id: aiProviders.id });
  providerId = provider!.id;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

beforeEach(async () => {
  await db.delete(agentRuns);
  await db.delete(aiModelSettings);
});

type StreamEvent = Record<string, unknown>;

const MESSAGE_START: StreamEvent = {
  type: "message_start",
  message: {
    usage: {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  },
};
const TEXT_DELTA: StreamEvent = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "ciao" },
};
const MESSAGE_DELTA: StreamEvent = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 50 },
};

/** Client finto: registra i parametri e stremma gli eventi dati (o lancia dopo). */
function fakeClient(events: StreamEvent[], opts: { throwAfter?: boolean } = {}) {
  const calls: { model: string }[] = [];
  const createClient = () =>
    ({
      messages: {
        stream(params: { model: string }) {
          calls.push(params);
          return (async function* () {
            for (const e of events) yield e;
            if (opts.throwAfter) throw new Error("Request was aborted.");
          })();
        },
      },
    }) as unknown as Pick<Anthropic, "messages">;
  return { calls, createClient };
}

function input(overrides: Partial<ChatLlmInput["usage"]> = {}): ChatLlmInput {
  return {
    system: "sys",
    messages: [{ role: "user", content: "domanda" }],
    usage: { operation: "chat", projectId, ...overrides },
  };
}

async function drain(it: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const d of it) text += d;
  return text;
}

/**
 * La riga si scrive DOPO lo stream, senza che il consumatore la aspetti: ogni
 * test aspetta le sue, o una riga in ritardo finirebbe nel test successivo.
 */
async function waitForRuns(n: number) {
  return vi.waitFor(
    async () => {
      const rows = await db.select().from(agentRuns);
      if (rows.length < n) throw new Error(`righe: ${rows.length}`);
      return rows;
    },
    { timeout: 5_000, interval: 50 },
  );
}

describe("createAnthropicChatLlm", () => {
  it("registra una riga in agent_runs coi token di message_start e dell'ultimo message_delta", async () => {
    const { createClient } = fakeClient([MESSAGE_START, TEXT_DELTA, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    expect(await drain(llm.stream(input()))).toBe("ciao");

    const [row] = await waitForRuns(1);
    expect(row).toMatchObject({
      operation: "chat",
      projectId,
      providerId,
      model: DEFAULT_CHAT_MODEL,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: null,
      phase: null,
      jobId: null,
    });
    expect(row!.runId).toEqual(expect.any(String));
  });

  it("operazione backlog_merge e progetto nullo finiscono nella riga così come sono", async () => {
    const { createClient } = fakeClient([MESSAGE_START, TEXT_DELTA, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    await drain(llm.stream(input({ operation: "backlog_merge", projectId: null })));

    const [row] = await waitForRuns(1);
    expect(row).toMatchObject({ operation: "backlog_merge", projectId: null });
  });

  it("con ai_model_settings(chat='sonnet') il client riceve l'id API risolto", async () => {
    await db.insert(aiModelSettings).values({ operation: "chat", model: "sonnet" });
    const { calls, createClient } = fakeClient([MESSAGE_START, TEXT_DELTA, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    await drain(llm.stream(input()));

    expect(calls[0]!.model).toBe("claude-sonnet-5-5");
    const [row] = await waitForRuns(1);
    expect(row!.model).toBe("claude-sonnet-5-5");
  });

  it("l'impostazione è per operazione: quella di backlog_merge non tocca la chat", async () => {
    await db.insert(aiModelSettings).values({ operation: "backlog_merge", model: "haiku" });
    const { calls, createClient } = fakeClient([MESSAGE_START, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    await drain(llm.stream(input()));
    await drain(llm.stream(input({ operation: "backlog_merge" })));

    expect(calls.map((c) => c.model)).toEqual([DEFAULT_CHAT_MODEL, "claude-haiku-5-5"]);
    await waitForRuns(2);
  });

  it("senza riga in ai_model_settings usa il default (claude-opus-4-8)", async () => {
    const { calls, createClient } = fakeClient([MESSAGE_START, TEXT_DELTA, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    await drain(llm.stream(input()));

    expect(calls[0]!.model).toBe("claude-opus-4-8");
    await waitForRuns(1);
  });

  it("senza riga vale options.model se passato", async () => {
    const { calls, createClient } = fakeClient([MESSAGE_START, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient, model: "claude-x" });

    await drain(llm.stream(input()));

    expect(calls[0]!.model).toBe("claude-x");
    await waitForRuns(1);
  });

  it("stream interrotto dal consumatore dopo message_start → riga con output_tokens=0", async () => {
    const { createClient } = fakeClient([MESSAGE_START, TEXT_DELTA, TEXT_DELTA, MESSAGE_DELTA]);
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    // Il consumatore legge un frammento e se ne va (return() sull'iteratore).
    const iterator = llm.stream(input())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    const [row] = await waitForRuns(1);
    expect(row).toMatchObject({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 10 });
  });

  it("stream abortito (errore dell'SDK) dopo message_start → riga registrata e errore propagato", async () => {
    const { createClient } = fakeClient([MESSAGE_START, TEXT_DELTA], { throwAfter: true });
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient });

    await expect(drain(llm.stream(input()))).rejects.toThrow("Request was aborted.");

    const [row] = await waitForRuns(1);
    expect(row).toMatchObject({ inputTokens: 100, outputTokens: 0 });
  });

  it("un insert che fallisce non rompe lo stream", async () => {
    const { createClient } = fakeClient([MESSAGE_START, TEXT_DELTA, MESSAGE_DELTA]);
    const warn = vi.fn();
    const llm = createAnthropicChatLlm({ db, encryptionKey, createClient, logger: { warn } });

    // Progetto inesistente: la FK fa fallire l'insert della riga di consumo.
    const text = await drain(llm.stream(input({ projectId: randomUUID() })));

    expect(text).toBe("ciao");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(await db.select().from(agentRuns).where(eq(agentRuns.operation, "chat"))).toEqual([]);
  });
});
