import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { automations, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";

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
