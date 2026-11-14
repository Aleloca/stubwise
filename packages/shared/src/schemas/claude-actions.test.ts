import { describe, expect, it } from "vitest";
import { CHAT_PROPOSE_TOOL, CHAT_READ_TOOLS, CHAT_TOOLS } from "./claude-conversation.js";
import { liveRowTypes } from "../alerts/catalog.js";
import { CLAUDE_ACTION_ARGS, CLAUDE_DECLARED_CLASS, CLAUDE_PROPOSABLE_FNS, claudeActionSignatures } from "./claude-actions.js";

describe("le firme delle azioni per il prompt della chat", () => {
  const lines = claudeActionSignatures().split("\n");

  it("una riga per ogni azione proponibile, e nessun inverso", () => {
    expect(lines.map((l) => /^- (\w+)\(/.exec(l)?.[1])).toEqual([...CLAUDE_PROPOSABLE_FNS]);
    expect(lines.some((l) => l.startsWith("- deleteTask("))).toBe(false);
    expect(lines.some((l) => l.startsWith("- resetSubscription("))).toBe(false);
  });

  it("vengono dagli schemi del server: campi, obbligatorietà, enum, uuid", () => {
    const update = lines.find((l) => l.startsWith("- updateTask("))!;
    expect(update).toContain("id: uuid");
    expect(update).toContain("assigneeId?: uuid | null");
    expect(update).toContain('priority?: "low" | "medium" | "high" | "urgent"');
    expect(lines.find((l) => l.startsWith("- startRun("))).toBe("- startRun({ taskId: uuid })");
    expect(lines.find((l) => l.startsWith("- addComment("))).toBe("- addComment({ taskId: uuid, body: string, replyToId?: uuid })");
  });

  it("setSubscription (area 8, F2, S7): i tipi sono le righe VIVE delle Preferenze, nient'altro", () => {
    const sub = lines.find((l) => l.startsWith("- setSubscription("))!;
    expect(sub).toBeDefined();
    expect(sub).toContain("projectId: uuid");
    expect(sub).toContain("app?: boolean");
    expect(sub).toContain("phone?: boolean");
    for (const t of liveRowTypes()) expect(sub).toContain(JSON.stringify(t));
    // Un tipo del catalogo non ancora vivo non si propone.
    expect(sub).not.toContain('"support.request"');
    expect(CLAUDE_DECLARED_CLASS.setSubscription).toBe("A");
  });

  it("setSubscription: almeno uno fra App e Telefono, e niente campi in più", () => {
    const schema = CLAUDE_ACTION_ARGS.setSubscription;
    const projectId = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";
    expect(schema.safeParse({ projectId, type: "pr.opened", app: false }).success).toBe(true);
    expect(schema.safeParse({ projectId, type: "pr.opened" }).success).toBe(false);
    expect(schema.safeParse({ projectId, type: "pr.opened", app: false, userId: projectId }).success).toBe(false);
    expect(schema.safeParse({ projectId, type: "monitor.alert", app: false }).success).toBe(false);
  });

  it("i tool della chat: le letture e, in fondo, il solo tool che propone", () => {
    expect(CHAT_TOOLS).toEqual([...CHAT_READ_TOOLS, CHAT_PROPOSE_TOOL]);
    expect(CHAT_READ_TOOLS).toContain("list_people");
  });
});
