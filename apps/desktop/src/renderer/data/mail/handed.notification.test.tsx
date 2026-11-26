import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationItem } from "../../notifications/NotificationItem";
import { renderWithData } from "../../test/renderWithData";
import { listNotifications, mail, resetApi, setLatency } from "../api";
import { DECISION_NOTIFICATION_KINDS } from "../seed/notifications";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { AppNotification } from "../types";
import { grantProjectRole } from "../viewer";

// Lotto 4, D-2.0 (decisione del maintainer, 23 nov 2026): chi riceve una
// proposta PASSATA al progetto ha una notifica, che apre la Home (in «Da
// decidere» la proposta resta). La ricevono i membri che possono confermarla
// adesso, tranne chi l'ha passata e chi ne è già destinatario. Decisa da un
// altro, la notifica lo dice.

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";
const SHARED = "mp-aud-billing-vat"; // Giulia e Matteo destinatari, Laura in cc: createTask

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

const handedFor = async (personId: string): Promise<AppNotification[]> => {
  as(personId);
  return (await listNotifications()).filter((n) => n.kind === "google.proposal_handed");
};

function cardText(n: AppNotification, personId: string): string {
  const { container, unmount } = renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "AUD", name: "Audit" }}
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

describe("la notifica di una proposta passata (D-2.0)", () => {
  async function handToAud() {
    grantProjectRole("p-giulia", AUD, "viewer");
    grantProjectRole("p-stefano", AUD, "project_lead");
    as("p-giulia");
    await mail.handMailProposal(SHARED);
  }

  it("la riceve chi può confermarla e non è destinatario; non chi l'ha passata, né i destinatari", async () => {
    await handToAud();
    const [n] = await handedFor("p-stefano");
    expect(n).toMatchObject({ kind: "google.proposal_handed", projectId: AUD, link: "#/home" });
    expect(await handedFor("p-giulia")).toEqual([]);
    expect(await handedFor("p-matteo")).toEqual([]);
    // È un'informazione nel pannello, non più una decisione nascosta.
    expect(DECISION_NOTIFICATION_KINDS as readonly string[]).not.toContain(
      "google.proposal_handed",
    );
  });

  it("la card dice chi l'ha passata e dove decidere", async () => {
    await handToAud();
    const [n] = await handedFor("p-stefano");
    const text = cardText(n!, "p-stefano");
    expect(text).toContain("A mail proposal handed to AUD");
    expect(text).toContain("Giulia Ferri handed it to the project. Decide it in Home.");
  });

  it("decisa da un altro: la card lo dice", async () => {
    await handToAud();
    as("p-matteo");
    await mail.confirmMailProposal(SHARED);
    const [n] = await handedFor("p-stefano");
    expect(n!.proposalDecided).toBe(true);
    expect(cardText(n!, "p-stefano")).toContain("Already decided: nothing left to do.");
  });

  it("senza nessuno da avvisare il passaggio riesce lo stesso, e nessuna notifica nasce", async () => {
    grantProjectRole("p-giulia", AUD, "viewer");
    const before = state.notifications.length;
    as("p-giulia");
    await mail.handMailProposal(SHARED);
    const added = state.notifications
      .slice(before)
      .filter((n) => n.kind === "google.proposal_handed");
    // Matteo (destinatario) può confermarla: è escluso; se nessun altro può, nessuna notifica.
    for (const n of added) expect(n.recipientIds).not.toContain("p-matteo");
    expect(state.mailProposals.find((p) => p.id === SHARED)!.status).toBe("handed");
  });
});
