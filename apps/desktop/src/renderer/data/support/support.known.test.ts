import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { resetApi, setLatency, support } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";

// Registro, A11 r.1414, lotto 3 (supporto), nel prototipo: chi del team ha
// risposto a una conversazione e chi l'ha chiusa nel triage diventano
// `hidden-<n>` se chi guarda non li conosce, uno per la risposta.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("il supporto senza id di chi non si conosce (r.1414)", () => {
  it("chi ha risposto e chi ha chiuso il triage: segnaposti, lo stesso per la stessa persona", async () => {
    const visible = visibleProjectIds(LAURA);
    const c = state.supportConversations.find(
      (x) => visible.has(x.projectId) && x.messages.length > 0,
    )!;
    expect(c).toBeDefined();
    const [who] = strangersTo(LAURA);
    c.messages.push({
      id: "sm-x",
      from: "team",
      authorId: who!,
      body: "On it.",
      at: "2026-11-22T10:00:00Z",
    });
    c.triage = { outcome: "concluded", at: "2026-11-22T10:01:00Z", byUserId: who! };
    setSessionPersonId(LAURA);
    const out = (await support.getSupportConversation(c.code))!;
    expect(out.messages.at(-1)!.authorId).toBe("hidden-1");
    expect(out.lastMessage!.authorId).toBe("hidden-1");
    expect(out.triage!.byUserId).toBe("hidden-1");
    expect(JSON.stringify(out)).not.toContain(who!);
    expect(JSON.stringify(await support.listSupportConversations(c.projectId))).not.toContain(who!);
  });
});
