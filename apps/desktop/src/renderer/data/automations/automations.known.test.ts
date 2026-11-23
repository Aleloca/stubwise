import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { automations, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { PEOPLE } from "../seed/people";
import { state } from "../store";

const nameOf = (id: string) => PEOPLE.find((p) => p.id === id)!.name;

// Registro, A11 r.1414, lotto 3 (automazioni), nel prototipo: di
// un'automazione che chi guarda vede, il titolare, chi l'ha creata e chi
// l'ha messa in pausa; di un'esecuzione, il titolare e chi ha agito nel
// registro: `hidden-<n>` per chi non conosce, il proprio id resta.

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("le automazioni senza id di chi non si conosce (r.1414)", () => {
  it("titolare, chi l'ha creata, chi l'ha messa in pausa: segnaposti", async () => {
    setSessionPersonId("p-laura");
    const [row] = await automations.listAutomations();
    expect(row).toBeDefined();
    const a = state.automations.find((x) => x.id === row!.id)!;
    const [who] = strangersTo("p-laura");
    a.ownerId = who!;
    a.createdById = who!;
    a.pausedById = who!;
    const out = (await automations.listAutomations()).find((x) => x.id === a.id)!;
    expect(out.ownerId).toBe("hidden-1");
    expect(out.createdById).toBe("hidden-1");
    expect(out.pausedById).toBe("hidden-1");
    expect(JSON.stringify(await automations.getAutomation(a.id))).not.toContain(who!);
  });

  it("un'esecuzione: il titolare e chi ha agito nel registro", async () => {
    setSessionPersonId("p-laura");
    const visible = await automations.listAutomations();
    const run = state.automationRuns.find(
      (r) => visible.some((a) => a.id === r.automationId) && r.log.length > 0,
    )!;
    expect(run).toBeDefined();
    const [who] = strangersTo("p-laura");
    state.automations.find((a) => a.id === run.automationId)!.ownerId = who!;
    run.log[0] = { ...run.log[0]!, byId: who! };
    const out = (await automations.getRun(run.id))!;
    expect(out.ownerId).toBe("hidden-1");
    expect(out.log[0]!.byId).toBe("hidden-1");
    expect(JSON.stringify(out)).not.toContain(who!);
  });
});

// Revisione del lotto 2-3 (46): il flusso. Le persone dei passi (incaricato,
// chi avvisare, chi approva) sono segnaposti per chi non le conosce; un
// salvataggio con un segnaposto è `invalid: flow`, e un passo che torna senza
// la persona (il campo omesso) la tiene com'era. I testi dei problemi non
// dicono il nome di chi chi guarda non conosce.
describe("il flusso delle automazioni senza chi non si conosce (r.1414)", () => {
  /** Un'automazione che Laura gestisce, con un «Avvisa» e un'approvazione per uno sconosciuto. */
  async function withStrangerSteps() {
    setSessionPersonId("p-laura");
    const row = (await automations.listAutomations()).find((x) => x.permissions.manage)!;
    expect(row).toBeDefined();
    const a = state.automations.find((x) => x.id === row.id)!;
    const [who] = strangersTo("p-laura");
    const flow = a.versions.at(-1)!.flow;
    flow.steps.push(
      {
        id: "s-known-notify",
        kind: "notify",
        who: { personId: who! },
        text: "Hi",
        approval: { mode: "auto" },
      },
      {
        id: "s-known-ask",
        kind: "createMilestone",
        name: "M",
        dueInDays: null,
        project: { mode: "own" },
        approval: { mode: "ask", who: { personId: who! } },
      },
    );
    return { a, who: who! };
  }

  it("in lettura le persone dei passi sono segnaposti", async () => {
    const { a, who } = await withStrangerSteps();
    const detail = (await automations.getAutomation(a.id))!;
    const flow = detail.automation.versions.at(-1)!.flow;
    const notify = flow.steps.find((x) => x.id === "s-known-notify") as {
      who: { personId: string };
    };
    const ask = flow.steps.find((x) => x.id === "s-known-ask") as {
      approval: { who: { personId: string } };
    };
    expect(notify.who.personId).toMatch(/^hidden-\d+$/);
    expect(ask.approval.who.personId).toBe(notify.who.personId);
    expect(JSON.stringify(detail.automation)).not.toContain(who);
  });

  it("salvare con un segnaposto: invalid; senza la persona: resta quella di prima", async () => {
    const { a, who } = await withStrangerSteps();
    const read = (await automations.getAutomation(a.id))!.automation.versions.at(-1)!.flow;
    const err = await automations.saveDraft(a.id, read).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toBe("invalid: flow");
    const omitted = structuredClone(read);
    for (const step of omitted.steps) {
      if (step.id === "s-known-notify") (step as { who: object }).who = {};
      if (step.id === "s-known-ask") (step as { approval: { who: object } }).approval.who = {};
    }
    await automations.saveDraft(a.id, omitted);
    const stored = state.automations.find((x) => x.id === a.id)!.versions.at(-1)!.flow;
    expect(stored.steps.find((x) => x.id === "s-known-notify")).toMatchObject({
      who: { personId: who },
    });
    expect(stored.steps.find((x) => x.id === "s-known-ask")).toMatchObject({
      approval: { mode: "ask", who: { personId: who } },
    });
  });

  it("un problema col nome di uno sconosciuto: né nei parametri né nel motivo", async () => {
    setSessionPersonId("p-laura");
    const visible = await automations.listAutomations();
    const run = state.automationRuns.find(
      (r) => visible.some((a) => a.id === r.automationId) && r.log.length > 0,
    )!;
    const [who] = strangersTo("p-laura");
    const name = nameOf(who!);
    run.log[0] = {
      ...run.log[0]!,
      why: { code: "cantManage", params: { owner: name, name: "Other" } },
      reason: `Permesso perso: il proprietario (${name}) non può gestire «Other».`,
    };
    const out = (await automations.getRun(run.id))!;
    expect(out.log[0]!.why!.params!.owner).toBe("");
    expect(out.log[0]!.why!.params!.name).toBe("Other");
    expect(JSON.stringify(out)).not.toContain(name);
  });
});
