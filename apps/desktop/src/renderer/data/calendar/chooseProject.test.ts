import { beforeEach, describe, expect, it } from "vitest";
import { mail, resetApi, setLatency } from "../api";
import { CALENDAR_CASES } from "../seed/calendar";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { MailProposalView } from "../types";

// Lotto 9, voce 2 (a) (72, 0b754a95c): una scadenza del calendario i cui
// invitati portano a più progetti, e di cui non si sa il progetto, è UNA
// «Quale progetto?» condivisa fra gli invitati. Ogni card offre solo i
// candidati in cui chi guarda può confermare; la prima scelta vince.

const as = (personId: string) => setSessionPersonId(personId);
const EVENT = CALENDAR_CASES.chooseDeadline;

beforeEach(() => {
  setLatency(0);
  resetApi();
});

async function chooseCard(): Promise<MailProposalView | undefined> {
  const items = await mail.listMailDecisions();
  return items.find((v) => v.proposal.source === "calendar" && v.proposal.sourceId === EVENT);
}
const candidatesOf = (v: MailProposalView | undefined) =>
  (v?.proposal.actions.find((a) => a.fn === "chooseProject")?.args.projectIds as
    | string[]
    | undefined) ?? [];

describe("la «Quale progetto?» condivisa del calendario", () => {
  it("ogni invitato vede solo i candidati in cui può confermare il traguardo", async () => {
    as("p-matteo");
    expect(candidatesOf(await chooseCard())).toEqual(["prj-mkx", "prj-aud", "prj-psf"]);
    // Giulia è membro di MKX e AUD, ma conferma solo in MKX (tickets.edit); PSF non la riguarda.
    as("p-giulia");
    expect(candidatesOf(await chooseCard())).toEqual(["prj-mkx"]);
  });

  it("chi non è fra gli invitati non la riceve", async () => {
    as("p-sara");
    expect(await chooseCard()).toBeUndefined();
  });

  it("la prima scelta vince: la proposta diventa il traguardo, l'evento prende il progetto; il secondo è `already_handled`", async () => {
    as("p-giulia");
    const id = (await chooseCard())!.proposal.id;
    await mail.chooseProjectFor(id, "prj-mkx");
    const p = state.mailProposals.find((x) => x.id === id)!;
    expect(p.projectId).toBe("prj-mkx");
    expect(p.actions.map((a) => a.fn)).toEqual(["createMilestone"]);
    expect(state.calendarEvents.find((e) => e.id === EVENT)).toMatchObject({
      projectId: "prj-mkx",
      projectBy: "manual",
    });
    as("p-matteo");
    await expect(mail.chooseProjectFor(id, "prj-aud")).rejects.toMatchObject({
      message: "already_handled",
    });
  });

  it("un candidato in cui chi sceglie non può confermare è rifiutato", async () => {
    as("p-giulia");
    const id = (await chooseCard())!.proposal.id;
    await expect(mail.chooseProjectFor(id, "prj-aud")).rejects.toThrow();
    expect(state.mailProposals.find((x) => x.id === id)!.actions[0]!.fn).toBe("chooseProject");
  });
});
