import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import { writeAccess } from "./access/index";
import { listNotifications, resetApi, setLatency } from "./api";
import { PEOPLE } from "./seed/people";
import { setSessionPersonId } from "./session";
import { state } from "./store";

// Registro, A11 r.1414 (decisioni del maintainer, 23 nov 2026), l'inbox del
// prototipo: chi guarda non riceve l'id di chi non conosce (gli altri
// destinatari, chi ha fatto partire Claude), al suo posto `hidden-<n>`; i
// nomi seguono «chi si conosce», quindi un disattivato di un progetto visibile
// resta col suo nome.

const LAURA = "p-laura";
const nameOf = (id: string) => PEOPLE.find((p) => p.id === id)!.name;

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

/** Una card che arriva a Laura, fuori dalla Chat, e la sua riga nello stato. */
async function lauraCard() {
  setSessionPersonId(LAURA);
  const card = (await listNotifications()).find((n) => n.chatMessageId === undefined)!;
  expect(card).toBeDefined();
  return { card, raw: state.notifications.find((n) => n.id === card.id)! };
}

describe("l'inbox senza id di chi non si conosce (r.1414)", () => {
  it("gli altri destinatari e chi ha fatto partire Claude: segnaposti, il proprio id resta", async () => {
    const { raw } = await lauraCard();
    const [who] = strangersTo(LAURA);
    raw.recipientIds = [...new Set([...raw.recipientIds, LAURA, who!])];
    raw.viaClaude = { personId: who!, actionId: "act-none" };
    setSessionPersonId(LAURA);
    const out = (await listNotifications()).find((n) => n.id === raw.id)!;
    expect(out.recipientIds).toContain(LAURA);
    expect(out.recipientIds).toContain("hidden-1");
    expect(out.viaClaude!.personId).toBe("hidden-1");
    expect(out.viaClaudeName).toBeNull();
    expect(JSON.stringify(out)).not.toContain(who!);
    expect(JSON.stringify(out)).not.toContain(nameOf(who!));
  });

  it("chi ha agito, disattivato in un progetto visibile: resta col suo nome", async () => {
    const { raw } = await lauraCard();
    raw.actorId = "p-marco";
    writeAccess((s) => {
      const row = s.people.find((p) => p.personId === "p-marco")!;
      row.status = "deactivated";
      row.deactivatedAt = "2026-11-20T10:00:00Z";
    });
    setSessionPersonId(LAURA);
    const out = (await listNotifications()).find((n) => n.id === raw.id)!;
    expect(out.actorName).toBe(nameOf("p-marco"));
  });
});
