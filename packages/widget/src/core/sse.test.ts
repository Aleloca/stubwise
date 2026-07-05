import { describe, expect, it } from "vitest";
import { parseSseStream, type WidgetSseEvent } from "./sse.js";

/**
 * Costruisce una Response con un corpo SSE spezzato ESATTAMENTE ai confini dati
 * (anche a metà di `data: ` o di un JSON), per verificare il buffering.
 */
function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(chunks: string[]): Promise<WidgetSseEvent[]> {
  const events: WidgetSseEvent[] = [];
  await parseSseStream(responseFromChunks(chunks), (ev) => events.push(ev));
  return events;
}

describe("parseSseStream", () => {
  it("parsa delta, ticket_proposal e done da eventi interi", async () => {
    const events = await collect([
      'data: {"type":"delta","text":"ciao"}\n\n',
      'data: {"type":"ticket_proposal","proposal":{"title":"T","body":"B","type":"bug"}}\n\n',
      'data: {"type":"done","conversationId":"c1","citations":[]}\n\n',
    ]);
    expect(events).toEqual([
      { type: "delta", text: "ciao" },
      { type: "ticket_proposal", proposal: { title: "T", body: "B", type: "bug" } },
      { type: "done", conversationId: "c1", citations: [] },
    ]);
  });

  it("riassembla eventi spezzati a metà (anche a metà di 'data: ')", async () => {
    const events = await collect([
      "da",
      'ta: {"type":"del',
      'ta","text":"a"}\n',
      "\ndata: {",
      '"type":"done","conversationId":"c1","citations":[]}\n\n',
    ]);
    expect(events).toEqual([
      { type: "delta", text: "a" },
      { type: "done", conversationId: "c1", citations: [] },
    ]);
  });

  it("processa più eventi presenti in un unico chunk", async () => {
    const events = await collect([
      'data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\n',
    ]);
    expect(events).toEqual([
      { type: "delta", text: "a" },
      { type: "delta", text: "b" },
    ]);
  });

  it("ignora JSON non parsabile senza lanciare", async () => {
    const events = await collect([
      "data: {non-json\n\n",
      'data: {"type":"delta","text":"ok"}\n\n',
    ]);
    expect(events).toEqual([{ type: "delta", text: "ok" }]);
  });

  it("ignora eventi con type sconosciuto", async () => {
    const events = await collect([
      'data: {"type":"heartbeat"}\n\n',
      'data: {"type":"delta","text":"ok"}\n\n',
    ]);
    expect(events).toEqual([{ type: "delta", text: "ok" }]);
  });

  it("ignora righe non-data e data vuoti", async () => {
    const events = await collect([
      ": commento\n\n",
      "data:\n\n",
      'data: {"type":"delta","text":"ok"}\n\n',
    ]);
    expect(events).toEqual([{ type: "delta", text: "ok" }]);
  });

  it("emette error con message", async () => {
    const events = await collect(['data: {"type":"error","message":"boom"}\n\n']);
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("non lancia se lo stream termina senza done", async () => {
    const events = await collect(['data: {"type":"delta","text":"a"}\n\n']);
    expect(events).toEqual([{ type: "delta", text: "a" }]);
  });

  it("si risolve senza eventi su body assente", async () => {
    const events: WidgetSseEvent[] = [];
    await parseSseStream(new Response(null), (ev) => events.push(ev));
    expect(events).toEqual([]);
  });

  it("cancella il reader e ri-propaga se onEvent lancia", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"delta","text":"a"}\n\n'));
        // NON chiudiamo: verifichiamo che il finally cancelli il reader.
      },
      cancel() {
        cancelled = true;
      },
    });
    const boom = new Error("consumer boom");
    await expect(
      parseSseStream(new Response(stream), () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(cancelled).toBe(true);
  });

  it("emette error e interrompe se il buffer supera il cap senza terminatore", async () => {
    // Un unico chunk oltre 1MB senza mai un "\n\n": deve tagliare con un error
    // sintetico e non processare l'evento delta valido che segue.
    const huge = "data: " + "x".repeat(1_000_001);
    const events = await collect([huge, '\n\ndata: {"type":"delta","text":"tardi"}\n\n']);
    expect(events).toEqual([{ type: "error", message: "stream buffer overflow" }]);
  });
});
