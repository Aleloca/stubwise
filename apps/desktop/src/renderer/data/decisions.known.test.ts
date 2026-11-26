import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import { listClaudeDecisions, listDecisionRequests, resetApi, setLatency } from "./api";
import { setSessionPersonId } from "./session";
import { state, visibleProjectIds } from "./store";

// Registro, A11 r.1414, lotto 3 (decisioni), nel prototipo: chi ha chiesto,
// a chi si chiede, chi ha risposto, il titolare della conversazione di Claude
// che aspetta una scelta: segnaposti per chi guarda non li conosce.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("le decisioni senza id di chi non si conosce (r.1414)", () => {
  it("chi ha chiesto, a chi, chi ha risposto: segnaposti, lo stesso per la stessa persona", async () => {
    const visible = visibleProjectIds(LAURA);
    const d = state.decisions.find((x) => visible.has(state.tasksById.get(x.taskId)!.projectId))!;
    expect(d).toBeDefined();
    const [who] = strangersTo(LAURA);
    d.askedById = who!;
    d.askedOfId = who!;
    d.answer = { optionIndex: 0, text: null, at: "2026-11-20T10:00:00Z", byId: who! };
    setSessionPersonId(LAURA);
    const out = (await listDecisionRequests({ taskId: d.taskId })).find((x) => x.id === d.id)!;
    expect(out.askedById).toBe("hidden-1");
    expect(out.askedOfId).toBe("hidden-1");
    expect(out.answer!.byId).toBe("hidden-1");
    expect(JSON.stringify(await listDecisionRequests({}))).not.toContain(who!);
  });

  it("le decisioni di Claude: il titolare che non si conosce, segnaposto", async () => {
    setSessionPersonId(LAURA);
    const [first] = await listClaudeDecisions();
    if (!first || !("conversationId" in first) || !first.conversationId)
      return expect.fail("nessuna decisione di Claude per Laura");
    const c = state.conversations.find((x) => x.id === first.conversationId)!;
    const [who] = strangersTo(LAURA);
    c.ownerId = who!;
    const out = (await listClaudeDecisions()).find((x) => x.id === first.id)!;
    expect((out as { ownerId?: string }).ownerId).toBe("hidden-1");
  });
});
