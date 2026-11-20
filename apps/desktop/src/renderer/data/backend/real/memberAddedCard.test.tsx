import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { NotificationItem } from "../../../notifications/NotificationItem";
import { renderWithData } from "../../../test/renderWithData";
import { presentInboxItem } from "./notifications";

// `member.added` nella build app (area 10, F5 di 72, D-11 = b): la card del
// server porta `memberAdded` (derivato a lettura: chi è entrato, il ruolo di
// adesso, chi ha agito, i nomi solo se chi guarda li vede), `alertMandatory:
// "added"` per chi è entrato e `undoneBy` se Claude l'ha fatto entrare e
// «Annulla» l'ha tolto. Ne nascono le due card del prototipo, nella lingua di
// chi guarda: «You've been added…» per chi entra, «A added B…» per chi gestisce.

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const LUCA = "33333333-3333-4333-8333-333333333333";
const LAURA = "44444444-4444-4444-8444-444444444444";
const MATTEO = "55555555-5555-4555-8555-555555555555";
const ctx = (viewerId: string) => ({
  taskCodes: new Map<string, string>(),
  projectCodes: new Map([[PROJECT_ID, "ACQ"]]),
  viewerId,
  personName: (id: string) => (id === LAURA ? "Laura Costa" : null),
});

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "88888888-8888-4888-8888-888888888888",
    kind: "member.added",
    status: "open",
    text: "Luca Bianchi joined ACQ as Developer",
    actions: [],
    projectId: PROJECT_ID,
    ticketId: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    readAt: null,
    url: "/app/#/projects/22222222-2222-4222-8222-222222222222/members",
    memberAdded: {
      addedUserId: LUCA,
      addedName: "Luca Bianchi",
      roleName: "Developer",
      actorName: "Laura Costa",
    },
    undoneBy: null,
    ...over,
  }) as never;

function cardText(n: ReturnType<typeof presentInboxItem>, personId: string): string {
  const { container, unmount } = renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "ACQ", name: "Acquedotto" }}
        onOpen={() => {}}
        onChange={() => {}}
      />
    </ul>,
    { personId },
  );
  const text = (container.querySelector("[data-notification]")?.textContent ?? "").replace(
    /\s+/g,
    " ",
  );
  unmount();
  return text;
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("member.added nella build app", () => {
  it("per chi è entrato: «You've been added», per obbligo, e apre il progetto", () => {
    const n = presentInboxItem(item({ alertMandatory: "added" }), ctx(LUCA));
    expect(n).toMatchObject({
      kind: "member.added",
      objectCode: "ACQ",
      roleName: "Developer",
      actorName: "Laura Costa",
      link: "#/p/ACQ/overview",
      mandatory: [{ personId: LUCA, reason: "added" }],
    });
    expect(n.memberName).toBeUndefined();
    expect(n.notOpenable).toBeUndefined();
    const text = cardText(n, "p-luca");
    expect(text).toContain("You've been added to ACQ as Developer");
    expect(text).toContain("Laura Costa added you to ACQ as Developer.");
  });

  it("per chi gestisce i membri: chi è entrato; in it «ad ACQ»", async () => {
    const n = presentInboxItem(item(), ctx(MATTEO));
    expect(n.memberName).toBe("Luca Bianchi");
    expect(cardText(n, "p-matteo")).toContain(
      "Laura Costa added Luca Bianchi to ACQ as Developer.",
    );
    await i18n.changeLanguage("it");
    expect(cardText(n, "p-matteo")).toContain(
      "Laura Costa ha aggiunto Luca Bianchi ad ACQ come Developer.",
    );
  });

  it("nomi che chi guarda non vede (R-G5), un ruolo che non c'è più ([SC 15])", () => {
    const n = presentInboxItem(
      item({
        memberAdded: { addedUserId: LUCA, addedName: null, roleName: null, actorName: null },
      }),
      ctx(MATTEO),
    );
    const text = cardText(n, "p-matteo");
    expect(text).toContain("Someone joined ACQ as a role that no longer exists");
    expect(text).toContain("Someone added someone to ACQ");
  });

  it("da Claude per conto di Laura, poi annullata: «Undone by», e per chi era entrato non apre più niente ([SC 16])", () => {
    const via = {
      viaClaude: true,
      viaClaudeActionId: "99999999-9999-4999-8999-999999999999",
      viaClaudeRequesterId: LAURA,
      undoneBy: { id: LAURA, name: "Laura Costa" },
    };
    const mine = presentInboxItem(item({ alertMandatory: "added", ...via }), ctx(LUCA));
    expect(mine).toMatchObject({ undoneByName: "Laura Costa", notOpenable: true, link: "" });
    const text = cardText(mine, "p-luca");
    expect(text).toContain("Claude on behalf of Laura Costa added you to ACQ as Developer.");
    expect(text).toContain("Undone by Laura Costa");
    // Per chi gestisce resta apribile: vede ancora il progetto.
    const theirs = presentInboxItem(item(via), ctx(MATTEO));
    expect(theirs).toMatchObject({ undoneByName: "Laura Costa", link: "#/p/ACQ/overview" });
    expect(theirs.notOpenable).toBeUndefined();
  });

  it("una card di un server di prima, senza `memberAdded`: il testo del server com'è", () => {
    const n = presentInboxItem(item({ memberAdded: null }), ctx(MATTEO));
    expect(n.title).toBe("Luca Bianchi joined ACQ as Developer");
    expect(n.roleName).toBeUndefined();
  });
});
