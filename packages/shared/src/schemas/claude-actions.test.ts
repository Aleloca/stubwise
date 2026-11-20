import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readerSchema, UNKNOWN } from "../reader.js";
import { CHAT_PROPOSE_TOOL, CHAT_READ_TOOLS, CHAT_TOOLS } from "./claude-conversation.js";
import { liveRowTypes } from "../alerts/catalog.js";
import { CLAUDE_ACTION_ARGS, CLAUDE_DECLARED_CLASS, CLAUDE_FILL_FIELD_MAX, CLAUDE_PROPOSABLE_FNS, RENDERER_FNS, claudeActionSignatures, claudeProposalViewSchema } from "./claude-actions.js";

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
    expect(sub).not.toContain('"task.created"');
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

describe("la proposta di un server di prima (area 9, F7: campi additivi)", () => {
  it("senza `reauth` né `labels` si legge, coi default", () => {
    const old = {
      id: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01",
      sessionId: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a02",
      actions: [{ fn: "addMember", args: {} }],
      summary: "s",
      cls: "B",
      reasons: [],
      status: "open",
      canConfirm: true,
      canCancel: true,
      failure: null,
      groupId: null,
      undoOfGroupId: null,
      createdAt: "2026-11-19T10:00:00.000Z",
    };
    const parsed = claudeProposalViewSchema.parse(old);
    expect(parsed.reauth).toBe(false);
    expect(parsed.actions[0]).toMatchObject({ reauth: false, labels: { person: null, role: null } });
  });
});

describe("le firme coi permessi d'istanza di chi chiede (area 9, F7)", () => {
  it("senza il permesso le voci d'istanza non compaiono; quelle di progetto sì; senza permessi passati, tutte", () => {
    const fns = (text: string) => text.split("\n").map((l) => /^- (\w+)\(/.exec(l)?.[1]);
    const none = fns(claudeActionSignatures(new Set()));
    expect(none).not.toContain("setModel");
    expect(none).not.toContain("registerPlugin");
    expect(none).toContain("addMember");
    expect(none).toContain("updateTask");
    const settings = fns(claudeActionSignatures(new Set(["settings.manage"])));
    expect(settings).toContain("setModel");
    expect(settings).not.toContain("removePlugin");
    expect(fns(claudeActionSignatures())).toEqual([...CLAUDE_PROPOSABLE_FNS]);
  });
});

describe("area 10, F6: fillField", () => {
  const T = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";
  const R = "7a2d3b63-2e8c-4d5f-8b62-1c7b8f3f2b12";
  const ok = (a: unknown) => CLAUDE_ACTION_ARGS.fillField.safeParse(a).success;

  it("la descrizione vuole la task; le note vogliono repository e PR; mai entrambe", () => {
    expect(ok({ field: "task.description", taskId: T, text: "Cosa fare" })).toBe(true);
    expect(ok({ field: "release.notes", repositoryId: R, prNumber: 12, text: "- AUD-7: login" })).toBe(true);
    expect(ok({ field: "task.description", text: "x" })).toBe(false);
    expect(ok({ field: "task.description", taskId: T, repositoryId: R, prNumber: 1, text: "x" })).toBe(false);
    expect(ok({ field: "release.notes", repositoryId: R, text: "x" })).toBe(false);
    expect(ok({ field: "release.notes", repositoryId: R, prNumber: 1, taskId: T, text: "x" })).toBe(false);
    expect(ok({ field: "task.title", taskId: T, text: "x" })).toBe(false);
    expect(ok({ field: "task.description", taskId: T, text: "x", save: true })).toBe(false);
    expect(ok({ field: "task.description", taskId: T, text: "   " })).toBe(false);
  });

  it("il tetto è quello della rotta del campo: 100 000 la descrizione, 20 000 le note", () => {
    expect(CLAUDE_FILL_FIELD_MAX).toEqual({ "task.description": 100_000, "release.notes": 20_000 });
    expect(ok({ field: "task.description", taskId: T, text: "a".repeat(100_000) })).toBe(true);
    expect(ok({ field: "task.description", taskId: T, text: "a".repeat(100_001) })).toBe(false);
    expect(ok({ field: "release.notes", repositoryId: R, prNumber: 1, text: "a".repeat(20_000) })).toBe(true);
    expect(ok({ field: "release.notes", repositoryId: R, prNumber: 1, text: "a".repeat(20_001) })).toBe(false);
  });

  it("A, proponibile, ed eseguita dal renderer come pageAction", () => {
    expect(CLAUDE_DECLARED_CLASS.fillField).toBe("A");
    expect(CLAUDE_PROPOSABLE_FNS).toContain("fillField");
    expect([...RENDERER_FNS].sort()).toEqual(["fillField", "pageAction"]);
  });

  it("un client vecchio, il cui enum non conosce fillField, la legge come UNKNOWN e non perde la proposta (D-10 = a)", () => {
    const old = z.object({ fn: z.enum(CLAUDE_PROPOSABLE_FNS.filter((f) => f !== "fillField") as [string, ...string[]]), args: z.record(z.string(), z.unknown()) });
    const read = readerSchema(z.object({ actions: z.array(old), summary: z.string() })).parse({
      actions: [{ fn: "fillField", args: { field: "task.description", taskId: T, text: "bozza" } }],
      summary: "La descrizione di AUD-12",
    });
    expect(read).toEqual({ actions: [{ fn: UNKNOWN, args: { field: "task.description", taskId: T, text: "bozza" } }], summary: "La descrizione di AUD-12" });
  });
});
