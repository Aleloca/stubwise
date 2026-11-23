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

const google = () => ({
  sourceProposalId: PROPOSAL,
  decision: null,
  blockedIndices: [],
  handed: false,
  handedByUser: null,
  proposalDecided: false,
});

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
    google: google(),
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
  it("apre la Home, senza «Open in web», col nome di chi l'ha passata (`handedByUser`)", () => {
    const n = presentInboxItem(
      item({
        google: {
          ...google(),
          handedByUser: { id: "44444444-4444-4444-8444-444444444444", name: "Giulia Ferri" },
        },
      }),
      ctx,
    );
    expect(n).toMatchObject({ kind: "google.proposal_handed", objectCode: "AUD", link: "#/home" });
    expect(n.webHref).toBeUndefined();
    expect(n.proposalDecided).toBeUndefined();
    const text = cardText(n);
    expect(text).toContain("A mail proposal handed to AUD");
    expect(text).toContain("Giulia Ferri handed it to the project. Decide it in Home.");
  });

  it("chi l'ha passata e chi guarda non conosce (`hidden-n`, nome null), o un server senza il campo: «Someone»", () => {
    for (const handedByUser of [
      { id: "hidden-1", name: null },
      { id: "hidden-1", name: "Giulia Ferri" },
      null,
    ]) {
      const n = presentInboxItem(item({ google: { ...google(), handedByUser } }), ctx);
      expect(cardText(n)).toContain("Someone handed it to the project. Decide it in Home.");
    }
  });

  it("`proposalDecided` dal server: «Already decided»; una card archiviata da chi la riceve no", () => {
    const decided = presentInboxItem(item({ google: { ...google(), proposalDecided: true } }), ctx);
    expect(decided.proposalDecided).toBe(true);
    expect(cardText(decided)).toContain("Already decided: nothing left to do.");
    // Archiviata a mano (`handled`), ma la proposta è ancora da decidere.
    const archived = presentInboxItem(item({ status: "handled" }), ctx);
    expect(archived.archived).toBe(true);
    expect(archived.proposalDecided).toBeUndefined();
  });

  it("una card di prima (senza `sourceProposalId`): «Open in web», come oggi", () => {
    const n = presentInboxItem(item({ google: undefined }), ctx);
    expect(n.link).toBe("");
    expect(n.webHref).toBe("/inbox");
    expect(n.proposalDecided).toBeUndefined();
  });
});
