import { beforeEach, describe, expect, it } from "vitest";
import { listRequests, listTasks, pulse, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// Le proposte del polso nel prototipo (shape `pulse-proposals.md`): TRM è
// fermo, e il polso propone a chi può avviare lavoro due richieste da cui
// ripartire. Si decide solo in Home (PQ-1b).

beforeEach(() => {
  resetApi();
  setLatency(0);
});

describe("le proposte del polso", () => {
  it("chi può avviare lavoro in TRM la vede: il progetto, i giorni, le voci con la suggerita", async () => {
    setSessionPersonId(await pulseRecipient());
    const [p] = await pulse.listPulseProposals();
    expect(p).toMatchObject({ projectCode: "TRM", idleDays: 9 });
    expect(p!.options.map((o) => o.title)).toEqual([
      "Delivery photos from the drivers' app",
      "Sign-off on the delivery note",
    ]);
    expect(p!.options.map((o) => o.suggested)).toEqual([true, false]);
  });

  it("una destinataria che ADESSO non può avviare lavoro nel progetto non la vede, né la avvia (PQ-4)", async () => {
    // Sara è membro di TRM senza `runs.start`: come chi l'ha persa dopo l'arrivo.
    state.pulseProposals[0]!.recipientIds.push("p-sara");
    setSessionPersonId("p-sara");
    expect(await pulse.listPulseProposals()).toEqual([]);
    expect(await pulse.startPulseProposal("pulse-trm-1", 0)).toEqual({ ok: false, reason: "forbidden" });
  });

  it("Start: la richiesta diventa una task, Claude parte, la proposta sparisce", async () => {
    setSessionPersonId(await pulseRecipient());
    const [p] = await pulse.listPulseProposals();
    const r = await pulse.startPulseProposal(p!.id, 0);
    if (!r.ok) throw new Error(r.reason);
    expect(r.taskCode).toMatch(/^TRM-\d+$/);
    const task = (await listTasks()).find((t) => t.code === r.taskCode);
    expect(task?.title).toBe("Delivery photos from the drivers' app");
    expect((await listRequests("prj-trm")).find((q) => q.id === "req-trm-1")?.status).toBe("converted");
    expect(await pulse.listPulseProposals()).toEqual([]);
  });

  it("una voce non più aperta: superata, senza creare niente", async () => {
    setSessionPersonId(await pulseRecipient());
    const [p] = await pulse.listPulseProposals();
    await pulse.startPulseProposal(p!.id, 1);
    expect(await pulse.startPulseProposal(p!.id, 1)).toEqual({ ok: false, reason: "stale" });
  });

  it("Not now: sparisce per chi l'ha archiviata, non per gli altri destinatari", async () => {
    const me = await pulseRecipient();
    setSessionPersonId(me);
    const [p] = await pulse.listPulseProposals();
    await pulse.dismissPulseProposal(p!.id);
    expect(await pulse.listPulseProposals()).toEqual([]);
    const { PULSE_PROPOSALS } = await import("../seed/pulse");
    setSessionPersonId(PULSE_PROPOSALS[0]!.recipientIds.find((id) => id !== me)!);
    expect(await pulse.listPulseProposals()).toHaveLength(1);
  });

  it("M5: budget del mese finito (per chi non ha plans.approve): rifiuto `budget_exhausted`, e niente task", async () => {
    state.instance.simulate.budgetReached = true;
    setSessionPersonId("p-marco");
    const [p] = await pulse.listPulseProposals();
    expect(await pulse.startPulseProposal(p!.id, 0)).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(state.requests.find((r) => r.id === "req-trm-1")!.status).toBe("new");
  });
});

/** Chi riceve la proposta del seme: il primo destinatario che può avviare lavoro in TRM. */
async function pulseRecipient(): Promise<string> {
  const { PULSE_PROPOSALS } = await import("../seed/pulse");
  return PULSE_PROPOSALS[0]!.recipientIds[0]!
}
