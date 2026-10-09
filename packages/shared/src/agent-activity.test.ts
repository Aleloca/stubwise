import { describe, expect, it } from "vitest";
import { describeAgentActivity } from "./agent-activity.js";

const tool = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  data: { name, input },
});

describe("describeAgentActivity", () => {
  it("modifiche ai file → edit col path", () => {
    expect(describeAgentActivity(tool("Edit", { file_path: "apps/x/routes/tickets.ts" }))).toEqual({
      kind: "edit",
      target: "apps/x/routes/tickets.ts",
    });
    expect(describeAgentActivity(tool("Write", { file_path: "a.ts" })).kind).toBe("edit");
  });

  it("Bash → run con la prima riga del comando, troncata a 80", () => {
    const long = `pnpm test ${"x".repeat(200)}\nsecond line`;
    const out = describeAgentActivity(tool("Bash", { command: long }));
    expect(out.kind).toBe("run");
    expect(out.target!.length).toBeLessThanOrEqual(80);
    expect(out.target).not.toContain("second line");
  });

  it("ricerca, lettura, web, domanda, subagent", () => {
    expect(describeAgentActivity(tool("Grep", { pattern: "foo" }))).toEqual({ kind: "search", target: "foo" });
    expect(describeAgentActivity(tool("Read", { file_path: "b.ts" }))).toEqual({ kind: "read", target: "b.ts" });
    expect(describeAgentActivity(tool("WebFetch", { url: "https://x.y" })).kind).toBe("web");
    expect(describeAgentActivity(tool("mcp__stubwise_ask__ask_user", {})).kind).toBe("ask");
    expect(describeAgentActivity(tool("Task", { description: "esplora" }))).toEqual({
      kind: "subagent",
      target: "esplora",
    });
  });

  it("testo dell'agente → write; tool sconosciuto → other col nome", () => {
    expect(describeAgentActivity({ type: "assistant_text", data: { text: "ciao" } })).toEqual({
      kind: "write",
      target: null,
    });
    expect(describeAgentActivity(tool("mcp__x__y", {}))).toEqual({ kind: "other", target: "mcp__x__y" });
  });

  it("input malformato non lancia", () => {
    expect(describeAgentActivity({ type: "tool_use", data: {} })).toEqual({ kind: "other", target: null });
  });
});
