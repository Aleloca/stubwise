import i18n from "i18next";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { AUTOMATION_SOURCES } from "../../data/seed/automations";
import type { Step } from "../../data/types";
import { draftFlow, type FlowSpec } from "./draftFlow";
import { validateFlow } from "@stubwise/shared";

// La bozza di Claude dalla frase di S1 (area 10b, Task 5): solo i blocchi
// del motore, il filtro sull'inizio (D3), i passi «Parte da solo» e l'email
// che chiede approvazione al proprietario.

const SUPPORT = "dep-support";
const S1: FlowSpec = {
  event: "request_created",
  when: { fromSupport: true, urgency: "high" },
  steps: [
    { kind: "createTask", departmentId: SUPPORT, dueInDays: 1 },
    { kind: "notify", departmentId: SUPPORT },
  ],
};

const kinds = (steps: Step[]) => steps.map((s) => s.kind);

describe("draftFlow", () => {
  for (const lng of ["en", "it"]) {
    const t = i18n.getFixedT(lng);

    it(`${lng}: lo scenario S1, il filtro con le due condizioni e i due passi che partono da soli`, () => {
      const flow = draftFlow(S1, t);
      expect(flow.trigger).toEqual({
        kind: "stubwise",
        event: "request_created",
        filter: {
          all: [
            { left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "high" } },
            { left: { ref: "richiesta.dal_supporto" }, op: "is", right: { value: true } },
          ],
        },
      });
      expect(kinds(flow.steps)).toEqual(["createTask", "notify"]);
      expect(flow.steps[0]).toMatchObject({
        kind: "createTask",
        assignee: { departmentId: SUPPORT },
        dueInDays: 1,
        project: { mode: "own" },
        approval: { mode: "auto" },
      });
      expect(flow.steps[1]).toMatchObject({
        kind: "notify",
        who: { departmentId: SUPPORT },
        approval: { mode: "auto" },
      });
      expect(
        validateFlow(flow, {
          sources: AUTOMATION_SOURCES,
          canApprove: () => true,
          projectId: "prj-acq",
        }),
      ).toEqual([]);
    });

    it(`${lng}: con l'email, l'email chiede approvazione al proprietario`, () => {
      const flow = draftFlow({ ...S1, steps: [...S1.steps, { kind: "sendEmail" }] }, t);
      expect(kinds(flow.steps)).toEqual(["createTask", "notify", "sendEmail"]);
      expect(flow.steps[2]).toMatchObject({
        kind: "sendEmail",
        approval: { mode: "ask", who: { owner: true } },
      });
      const ids = flow.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        validateFlow(flow, {
          sources: AUTOMATION_SOURCES,
          canApprove: () => true,
          projectId: "prj-acq",
        }),
      ).toEqual([]);
    });
  }

  it("senza dati del filtro: nessun filtro (non un gruppo vuoto)", () => {
    const flow = draftFlow({ ...S1, when: {} }, i18n.getFixedT("en"));
    expect(flow.trigger).toEqual({ kind: "stubwise", event: "request_created" });
  });

  it("solo urgente: una condizione sola, sull'urgenza", () => {
    const flow = draftFlow({ ...S1, when: { urgency: "high" } }, i18n.getFixedT("en"));
    expect(flow.trigger).toMatchObject({
      filter: { all: [{ left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "high" } }] },
    });
  });

  it("i testi dei passi nella lingua di chi chiede, coi dati dell'evento come riferimenti", () => {
    const en = draftFlow(S1, i18n.getFixedT("en")).steps[1] as Extract<Step, { kind: "notify" }>;
    const it_ = draftFlow(S1, i18n.getFixedT("it")).steps[1] as Extract<Step, { kind: "notify" }>;
    expect(en.text).not.toBe(it_.text);
    expect(en.text).toContain("{{richiesta.titolo}}");
    expect(it_.text).toContain("{{richiesta.titolo}}");
  });
});
