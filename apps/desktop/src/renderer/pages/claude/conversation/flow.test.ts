import { describe, expect, it } from "vitest";
import type { ConversationEvent, EventDraft } from "../../../data/types";
import { citedRefs, flowItems } from "./flow";

const at = (m: number) => `2026-10-24T10:${String(m).padStart(2, "0")}:00Z`;
let n = 0;
const ev = (e: EventDraft & { at?: string }): ConversationEvent =>
  ({ id: `e${++n}`, at: at(n), ...e }) as ConversationEvent;

describe("flowItems", () => {
  it("azioni consecutive in un gruppo, citazione attaccata al messaggio, intestazione a inizio turno", () => {
    const items = flowItems([
      ev({
        type: "user",
        authorId: "p-giulia",
        text: "Hi",
        attachments: [],
        delivery: "delivered",
      }),
      ev({ type: "action", tool: "a", label: "A", state: "done" }),
      ev({ type: "action", tool: "b", label: "B", state: "done" }),
      ev({ type: "assistant", text: "Done", done: true }),
      ev({ type: "citation", refs: [{ kind: "task", id: "t1" }] }),
      ev({ type: "action", tool: "c", label: "C", state: "running" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "claude", "actions", "assistant", "actions"]);
    expect(items[2]).toMatchObject({ actions: [{ label: "A" }, { label: "B" }] });
    expect(items[3]).toMatchObject({ refs: [{ kind: "task", id: "t1" }] });
  });

  it("le fasi: durata dall'apertura, numero per nome", () => {
    const items = flowItems([
      ev({ type: "phase", phase: "correction", outcome: null, at: at(0) }),
      ev({ type: "phase", phase: "correction", outcome: "ok", at: at(4) }),
      ev({ type: "phase", phase: "correction", outcome: null, at: at(10) }),
    ]).filter((i) => i.kind === "phase");
    expect(items.map((i) => i.kind === "phase" && [i.ordinal, i.startedAt])).toEqual([
      [1, null],
      [1, at(0)],
      [2, null],
    ]);
  });

  it("citedRefs: ogni oggetto una volta", () => {
    expect(
      citedRefs([
        ev({
          type: "citation",
          refs: [
            { kind: "task", id: "t1" },
            { kind: "doc", id: "d" },
          ],
        }),
        ev({ type: "citation", refs: [{ kind: "task", id: "t1" }] }),
      ]),
    ).toEqual([
      { kind: "task", id: "t1" },
      { kind: "doc", id: "d" },
    ]);
  });
});
