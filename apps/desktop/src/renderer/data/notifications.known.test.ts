import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo, withoutChannels } from "../test/strangers";
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
    // Revisione del lotto 2 (I3): fuori dai canali leggibili, lo fa conoscere solo il progetto.
    withoutChannels(LAURA, ["p-marco"]);
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

// Revisione del lotto 2, I6: il nome di chi ha agito stava già nel testo
// salvato (`member.added`: «<Nome> added you…»). Chi non lo conosce non lo
// riceve: la pagina compone il testo da `actorName` («Someone»). Gli avvisi
// di sicurezza (`security.*`, solo all'interessato) sono l'eccezione: il nome
// di chi ha agito sul tuo account resta (decisione di 46).
describe("il testo salvato col nome di chi ha agito (I6)", () => {
  it("member.added da uno sconosciuto: né il nome nel testo né l'id", async () => {
    const [who] = strangersTo(LAURA);
    state.notifications.push({
      id: "n-member-added-x",
      kind: "member.added",
      projectId: "prj-acq",
      objectCode: "ACQ",
      departmentId: null,
      recipientIds: [LAURA],
      title: "You've been added to ACQ as Developer",
      body: `${nameOf(who!)} added you to ACQ as Developer.`,
      createdAt: "2026-11-22T10:00:00Z",
      read: false,
      archived: false,
      snoozedUntil: null,
      link: "#/p/ACQ/overview",
      actorId: who!,
    } as (typeof state.notifications)[number]);
    setSessionPersonId(LAURA);
    const out = (await listNotifications()).find((n) => n.id === "n-member-added-x")!;
    expect(out).toBeDefined();
    expect(out.actorName).toBeNull();
    expect(JSON.stringify(out)).not.toContain(nameOf(who!));
    expect(JSON.stringify(out)).not.toContain(who!);
  });

  it("un avviso di sicurezza tiene il nome di chi ha agito sul tuo account", async () => {
    const { publishSecurityAlert } = await import("./me/securityLog");
    const [who] = strangersTo(LAURA);
    publishSecurityAlert(
      LAURA,
      "Sign-in email changed",
      `${nameOf(who!)} changed your sign-in email.`,
    );
    setSessionPersonId(LAURA);
    const out = (await listNotifications()).find((n) => n.title === "Sign-in email changed")!;
    expect(out).toBeDefined();
    expect(out.body).toContain(nameOf(who!));
  });
});
