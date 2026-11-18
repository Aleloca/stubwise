import { describe, expect, it } from "vitest";
import {
  aiModelSourceOf,
  isKnownModelChoice,
  AI_OPERATIONS,
  AI_OPERATION_GROUPS,
  CONFIGURABLE_AI_OPERATIONS,
  aiModelChoiceSchema,
  isConfigurableAiOperation,
  resolveApiModelId,
} from "./ai-operations.js";

describe("catalogo operazioni AI", () => {
  it("ogni operazione compare in esattamente un gruppo", () => {
    const all = AI_OPERATION_GROUPS.flatMap((g) => g.operations);
    expect([...all].sort()).toEqual([...AI_OPERATIONS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("le configurabili escludono le tre tecniche e contengono le altre 25 (con `automation_step`, area 7 F3, quella di Support, area 8 F3, le due dei server, area 8 F4b, e il giudizio della posta, «Clienti in attesa»)", () => {
    for (const op of ["plugin_smoke", "credential_test", "usage_probe"] as const) {
      expect(CONFIGURABLE_AI_OPERATIONS).not.toContain(op);
      expect(isConfigurableAiOperation(op)).toBe(false);
    }
    expect(CONFIGURABLE_AI_OPERATIONS).toHaveLength(25);
    expect(isConfigurableAiOperation("mail_reply_judgment")).toBe(true);
    expect(isConfigurableAiOperation("support_triage_check")).toBe(true);
    expect(isConfigurableAiOperation("triage")).toBe(true);
  });

  it("resolveApiModelId risolve gli alias e lascia gli id", () => {
    expect(resolveApiModelId("opus")).toBe("claude-opus-5-5");
    expect(resolveApiModelId("sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveApiModelId("haiku")).toBe("claude-haiku-5-5");
    expect(resolveApiModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("rifiuta un modello fuori catalogo", () => {
    expect(aiModelChoiceSchema.safeParse("opsu").success).toBe(false);
    expect(aiModelChoiceSchema.safeParse("opus").success).toBe(true);
  });

  it("i gruppi coincidono con il design §1", () => {
    expect(AI_OPERATION_GROUPS).toEqual([
      { group: "tickets", operations: ["triage", "fix_plan", "fix_execute", "pr_review", "summary"] },
      { group: "backlog", operations: ["backlog_intake", "backlog_refine"] },
      { group: "nightly", operations: ["commit_summary", "release_notes", "docs_nightly"] },
      { group: "docs", operations: ["docs_generation", "drive_summary"] },
      { group: "reports", operations: ["daily_report", "weekly_brief"] },
      { group: "mail", operations: ["mail_classify", "mail_draft", "meeting_summary", "mail_reply_judgment"] },
      { group: "automations", operations: ["automation_step"] },
      { group: "support", operations: ["support_triage_check"] },
      { group: "servers", operations: ["server_analysis", "server_fix_plan"] },
      { group: "chat", operations: ["chat", "claude_chat", "backlog_merge"] },
      { group: "technical", operations: ["plugin_smoke", "credential_test", "usage_probe"] },
    ]);
  });
});

describe("aiModelSourceOf (area 9, F3: la fonte del modello)", () => {
  it("un'impostazione vince solo se è nel catalogo; poi l'env; poi il default", () => {
    expect(aiModelSourceOf("fix_plan", "opus", ["fix_plan"])).toBe("setting");
    expect(aiModelSourceOf("fix_plan", "gpt-9", ["fix_plan"])).toBe("env");
    expect(aiModelSourceOf("fix_plan", "gpt-9", null)).toBe("default");
    expect(aiModelSourceOf("fix_plan", null, ["pr_review"])).toBe("default");
    expect(isKnownModelChoice("sonnet")).toBe(true);
    expect(isKnownModelChoice(undefined)).toBe(false);
  });
});
