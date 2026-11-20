import { describe, expect, it } from "vitest";
import { eventsOf } from "./claude";

// Area 10, review I2a (72, 52ba52fa7): chi legge la conversazione di un altro
// (una pubblica) riceve `tool_use` e `tool_result` SENZA contenuto, per ogni
// tool (`withheld: true`, `input: {}`, `content: ""`). La riga dice solo il
// nome del tool e com'è andata (fatta, o l'errore): niente ingresso né
// risultato da aprire, e nessun tentativo di leggere `input` o `content`.
// All'autore arriva tutto, e la riga resta com'era.

const detail = {
  id: "cccccccc-0000-4000-8000-000000000001",
  kind: "free",
  state: "idle",
  inputs: [],
  questions: [],
} as never;

const use = (id: string, toolUseId: string, over: Record<string, unknown>) =>
  ({
    id,
    type: "tool_use",
    segmentId: "s1",
    at: "2026-11-20T10:00:00.000Z",
    data: { toolUseId, name: "read_task", ...over },
  }) as never;
const result = (id: string, toolUseId: string, over: Record<string, unknown>) =>
  ({
    id,
    type: "tool_result",
    segmentId: "s1",
    at: "2026-11-20T10:00:01.000Z",
    data: { toolUseId, ...over },
  }) as never;

const actions = (raw: never[]) =>
  eventsOf(detail, raw, {}, null).filter((e) => e.type === "action");

describe("i tool di una conversazione letta da un altro (withheld)", () => {
  it("solo il nome e «fatto»: niente ingresso né risultato", () => {
    const [row] = actions([
      use("1", "u1", { input: {}, withheld: true }),
      result("2", "u1", { isError: false, content: "", withheld: true }),
    ]);
    expect(row).toMatchObject({
      type: "action",
      tool: "read_task",
      label: "read_task",
      state: "done",
    });
    expect(row).not.toHaveProperty("input");
    expect(row).not.toHaveProperty("result");
  });

  it("un errore resta un errore, sempre senza contenuto", () => {
    const [row] = actions([
      use("1", "u1", { input: {}, withheld: true }),
      result("2", "u1", { isError: true, content: "", withheld: true }),
    ]);
    expect(row).toMatchObject({ state: "failed" });
    expect(row).not.toHaveProperty("result");
  });

  it("all'autore tutto come prima", () => {
    const [row] = actions([
      use("1", "u1", { input: { code: "AUD-12" } }),
      result("2", "u1", { isError: false, content: "Export the report" }),
    ]);
    expect(row).toMatchObject({ state: "done", result: "Export the report" });
    expect(row).toHaveProperty("input");
  });
});
