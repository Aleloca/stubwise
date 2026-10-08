// apps/worker/src/sessions/stream-parser.test.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ResultTracker,
  capabilitiesOf,
  parseStreamLine,
  partialTextOf,
  toSessionEvents,
} from "./stream-parser.js";

const here = dirname(fileURLToPath(import.meta.url));

const trace = (name: string) =>
  readFileSync(join(here, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .map(parseStreamLine)
    .filter((e): e is NonNullable<typeof e> => e !== null);

describe("parseStreamLine", () => {
  it("riga vuota o non JSON → null, mai un'eccezione", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("not json")).toBeNull();
    expect(parseStreamLine("[1,2]")).toBeNull();
  });
});

describe("toSessionEvents", () => {
  it("su due turni produce testo e due turn_end, e niente dagli stream_event", () => {
    const events = trace("two-turns").flatMap(toSessionEvents);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    expect(events.some((e) => e.type === "assistant_text")).toBe(true);
    expect(events.every((e) => e.type !== ("stream_event" as never))).toBe(true);
  });

  it("un tool produce tool_use e tool_result legati dallo stesso toolUseId", () => {
    const events = trace("mid-turn-message").flatMap(toSessionEvents);
    const use = events.find((e) => e.type === "tool_use")!;
    const res = events.find((e) => e.type === "tool_result")!;
    expect(use.data["name"]).toBe("Bash");
    expect(res.data["toolUseId"]).toBe(use.data["toolUseId"]);
  });

  it("un tool_result enorme è troncato a 16 KB con la marca", () => {
    const big = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(40_000) }] },
    };
    const [ev] = toSessionEvents(big);
    expect(String(ev!.data["content"]).length).toBeLessThanOrEqual(16_400);
    expect(ev!.data["truncated"]).toBe(true);
  });
});

describe("partialTextOf / capabilitiesOf", () => {
  it("estrae i delta di testo e le capabilities dell'init", () => {
    const evs = trace("two-turns");
    expect(evs.map(partialTextOf).filter(Boolean).join("")).toContain("ONE");
    const caps = evs.map(capabilitiesOf).find((c) => c !== null)!;
    expect(caps).toContain("interrupt_receipt_v1");
  });
});

describe("ResultTracker", () => {
  it("usa l'ULTIMO result: output, session id e usage cumulativo", () => {
    const t = new ResultTracker();
    const evs = trace("two-turns");
    evs.forEach((e) => t.observe(e));
    const results = evs.filter((e) => e.type === "result");
    const last = results[results.length - 1]!;
    const out = t.toRunResult(0, "");
    expect(out.output).toBe(last["result"]);
    expect(out.sessionId).toBe(last["session_id"]);
    expect(out.usage?.totalCostUsd).toBe(last["total_cost_usd"]);
  });

  it("interruzione seguita da messaggio: l'esito è il result finale, non l'errore", () => {
    const t = new ResultTracker();
    trace("interrupt-then-message").forEach((e) => t.observe(e));
    const out = t.toRunResult(0, "");
    expect(out.exitCode).toBe(0);
    expect(out.output).toMatch(/OK/);
  });

  it("senza result usa il fallback grezzo", () => {
    const t = new ResultTracker();
    expect(t.hasResult).toBe(false);
    expect(t.toRunResult(1, "raw").output).toBe("raw");
  });
});
