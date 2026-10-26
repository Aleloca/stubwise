import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { state } from "../store";
import { planNotify, resolveAssignee, type ActionEffect } from "./plans";
import { holdersOfRole } from "./visibility";
import { initialState } from "../../domain/automations/engine";
import { describe as describeStep } from "../../domain/automations/preview";
import i18n from "../../i18n";
import { roleWords } from "../../pages/automations/format";
import type { Step } from "../types";

// Chi avvisa un passo e chi riceve una task (fix round 1 del Task 6): una
// persona scelta, il dato Persona (già letto dal motore) o un ruolo nel
// progetto del passo.

const AUD = "prj-aud";
const aut = () => state.automations.find((a) => a.code === "AUD-A1")!;
const eff = (who: unknown): ActionEffect =>
  ({ kind: "notify", stepId: "n", path: "0", args: { who, text: "Ciao" } }) as never;

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("planNotify", () => {
  it("un ruolo nel progetto: la prima persona col ruolo, in ordine alfabetico", () => {
    const lead = holdersOfRole(AUD, "project_lead")[0]!;
    const p = planNotify(eff({ projectRole: "project_lead" }), aut());
    expect(p).toEqual({ ok: true, plan: { personId: lead, projectId: AUD, text: "Ciao" } });
  });

  it("un ruolo che nessuno ha: il passo fallisce con «no_recipient», mai un avviso a caso", () => {
    const p = planNotify(eff({ projectRole: "nessuno" }), aut());
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.outcome).toMatchObject({ input: { error: "no_recipient" } });
  });

  it("una persona scelta o il dato Persona letto: lei", () => {
    const p = planNotify(eff({ personId: "p-laura" }), aut());
    expect(p.ok && p.plan.personId).toBe("p-laura");
    const empty = planNotify(eff({ personId: "" }), aut());
    expect(empty.ok).toBe(false);
  });
});

describe("anteprima dell'avviso a un ruolo", () => {
  it("chi approva vede il ruolo, e la pagina lo dice col progetto («Project Lead of AUD»)", () => {
    const step: Step = {
      id: "n",
      kind: "notify",
      who: { projectRole: "project_lead" },
      text: "Ciao",
      approval: { mode: "ask", who: { owner: true } },
    };
    const st = initialState(
      { trigger: { kind: "manual" }, titleTemplate: "x", steps: [step] },
      "2026-10-26T12:00:00Z",
    );
    const { preview } = describeStep(st, step as never, null);
    expect(preview).toEqual({ ruolo: "project_lead", testo: "Ciao" });
    const names = { project: () => ({ code: "AUD", name: "Audin 2.0" }) } as never;
    expect(roleWords("project_lead", "prj-aud", names, i18n.t)).toBe("Project Lead of AUD");
    const none = { project: () => null } as never;
    expect(roleWords("project_lead", null, none, i18n.t)).toBe("the project's Project Lead");
  });
});

describe("resolveAssignee", () => {
  it("il dato Persona vuoto (o che non è una persona): senza incaricato, con l'avviso", () => {
    expect(resolveAssignee({ personId: "" }, AUD)).toMatchObject({
      assigneeId: null,
      by: "none",
      reason: "Il dato della persona è vuoto: la task nasce senza incaricato.",
    });
    expect(resolveAssignee({ personId: "Mario Rossi" }, AUD).assigneeId).toBeNull();
    expect(resolveAssignee({ personId: "p-laura" }, AUD)).toMatchObject({
      assigneeId: "p-laura",
      by: "person",
    });
  });
});
