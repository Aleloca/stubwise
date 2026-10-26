import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { state } from "../store";
import { planNotify, resolveAssignee, type ActionEffect } from "./plans";
import { holdersOfRole } from "./visibility";

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
