import { describe, expect, it } from "vitest";
import { CHAT_PROPOSE_TOOL, CHAT_READ_TOOLS, CHAT_TOOLS } from "./claude-conversation.js";
import { CLAUDE_PROPOSABLE_FNS, claudeActionSignatures } from "./claude-actions.js";

describe("le firme delle azioni per il prompt della chat", () => {
  const lines = claudeActionSignatures().split("\n");

  it("una riga per ogni azione proponibile, e nessun inverso", () => {
    expect(lines.map((l) => /^- (\w+)\(/.exec(l)?.[1])).toEqual([...CLAUDE_PROPOSABLE_FNS]);
    expect(lines.some((l) => l.startsWith("- deleteTask("))).toBe(false);
  });

  it("vengono dagli schemi del server: campi, obbligatorietà, enum, uuid", () => {
    const update = lines.find((l) => l.startsWith("- updateTask("))!;
    expect(update).toContain("id: uuid");
    expect(update).toContain("assigneeId?: uuid | null");
    expect(update).toContain('priority?: "low" | "medium" | "high" | "urgent"');
    expect(lines.find((l) => l.startsWith("- startRun("))).toBe("- startRun({ taskId: uuid })");
    expect(lines.find((l) => l.startsWith("- addComment("))).toBe("- addComment({ taskId: uuid, body: string, replyToId?: uuid })");
  });

  it("i tool della chat: le letture e, in fondo, il solo tool che propone", () => {
    expect(CHAT_TOOLS).toEqual([...CHAT_READ_TOOLS, CHAT_PROPOSE_TOOL]);
    expect(CHAT_READ_TOOLS).toContain("list_people");
  });
});
