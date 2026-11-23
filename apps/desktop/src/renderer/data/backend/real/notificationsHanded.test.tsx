import { describe, expect, it } from "vitest";
import { NotificationItem } from "../../../notifications/NotificationItem";
import { renderWithData } from "../../../test/renderWithData";
import { presentInboxItem } from "./notifications";

// Lotto 4, D-2.0 (decisione del maintainer, 23 nov 2026), nella build app:
// la card `google.proposal_handed` di una proposta CONDIVISA passata al
// progetto (il server la lega con `google.sourceProposalId`, derivato a
// lettura) si mostra come nel prototipo: compare nel pannello, apre la Home
// («Da decidere») e, decisa, dice «Already decided». Una card di PRIMA (una
// passata della casella, senza `sourceProposalId`) resta «Open in web».

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "77777777-7777-4777-8777-777777777777";
const ctx = {
  taskCodes: new Map<string, string>(),
  projectCodes: new Map([[PROJECT_ID, "AUD"]]),
  viewerId: "33333333-3333-4333-8333-333333333333",
  personName: () => null,
};

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "88888888-8888-4888-8888-888888888888",
    kind: "google.proposal_handed",
    status: "open",
    text: "Una proposta della posta passata ad AUD",
    actions: [],
    projectId: PROJECT_ID,
    ticketId: null,
    createdAt: "2026-11-23T10:00:00.000Z",
    readAt: null,
    url: "/inbox",
    google: { sourceProposalId: PROPOSAL, decision: null, blockedIndices: [], handed: false },
    ...over,
  }) as never;

function cardText(n: ReturnType<typeof presentInboxItem>): string {
  const { container, unmount } = renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "AUD", name: "Audit" }}
        onOpen={() => {}}
        onChange={() => {}}
      />
    </ul>,
    { personId: "p-giulia" },
  );
  const text = (container.querySelector("[data-notification]")?.textContent ?? "").replace(
    /\s+/g,
    " ",
  );
  unmount();
  return text;
}

describe("la card di una proposta passata nella build app", () => {
  it("apre la Home, senza «Open in web», col testo del prototipo", () => {
    const n = presentInboxItem(item(), ctx);
    expect(n).toMatchObject({ kind: "google.proposal_handed", objectCode: "AUD", link: "#/home" });
    expect(n.webHref).toBeUndefined();
    expect(n.proposalDecided).toBeUndefined();
    const text = cardText(n);
    expect(text).toContain("A mail proposal handed to AUD");
    // L'evento non porta chi l'ha passata: «Someone», come per uno sconosciuto.
    expect(text).toContain("Someone handed it to the project. Decide it in Home.");
  });

  it("chiusa da una decisione (anche di un altro): «Already decided»", () => {
    for (const over of [
      { status: "handled" },
      {
        google: {
          sourceProposalId: PROPOSAL,
          decision: { status: "actioned", chosen: [], error: null },
          blockedIndices: [],
          handed: false,
        },
      },
    ]) {
      const n = presentInboxItem(item(over), ctx);
      expect(n.proposalDecided).toBe(true);
      expect(cardText(n)).toContain("Already decided: nothing left to do.");
    }
  });

  it("una card di prima (senza `sourceProposalId`): «Open in web», come oggi", () => {
    const n = presentInboxItem(item({ google: undefined }), ctx);
    expect(n.link).toBe("");
    expect(n.webHref).toBe("/inbox");
    expect(n.proposalDecided).toBeUndefined();
  });
});
