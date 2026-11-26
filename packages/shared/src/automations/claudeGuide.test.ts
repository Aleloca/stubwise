import { describe, expect, it } from "vitest";
import { AUTOMATION_F4_AVAILABILITY } from "./availability.js";
import { CLAUDE_AUTOMATION_EXAMPLE, claudeAutomationGuide } from "./claudeGuide.js";
import { STUBWISE_TRIGGER_FIELDS } from "./triggerFields.js";
import { validateFlow } from "./validate.js";

describe("la guida ai flussi per Claude (area 10, F2)", () => {
  it("l'esempio è un flusso che il motore accetta, con la build dell'app", () => {
    expect(validateFlow(CLAUDE_AUTOMATION_EXAMPLE, { sources: [], canApprove: () => true, available: AUTOMATION_F4_AVAILABILITY })).toEqual([]);
  });

  it("gli eventi e i loro campi vengono dal motore (ogni campo di request_created c'è)", () => {
    const guide = claudeAutomationGuide();
    for (const f of STUBWISE_TRIGGER_FIELDS.request_created) expect(guide).toContain(f.key);
    expect(guide).toContain('"event":"request_created"');
    expect(guide).toContain("list_departments");
  });
});
