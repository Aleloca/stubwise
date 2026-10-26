import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendar, mail, resetApi, setLatency } from "../../data/api";
import { daysFromToday } from "../../data/seed/dates";
import { EV_AUD_REVIEW_YESTERDAY } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { failNext, state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";

// Un evento passato con trascrizione (Task 10, shape meeting-prep.md §6): al
// posto della scheda, «Meeting summary» per chi c'era (testo generato,
// trascrizione, email di Gemini, proposte ancora aperte) e «Tasks from this
// meeting»; per il membro che non c'era solo le task nate, e nulla che dica
// che un riassunto esiste.

const YESTERDAY = daysFromToday(-1);
const REVIEW_PROPOSAL = "mp-aud-weekly-review";
/** La prossima revisione di AUD, futura. */
const NEXT_REVIEW = `ev-aud-review-${daysFromToday(6)}`;
const SUMMARY = /client accepts the go-live plan/;

const ev = () => state.calendarEvents.find((e) => e.id === EV_AUD_REVIEW_YESTERDAY)!;
const transcript = () =>
  state.meetingTranscripts.find((t) => t.eventId === EV_AUD_REVIEW_YESTERDAY)!;

/** Il Calendario chiede l'account Google: nel seme ce l'hanno solo Giulia e Matteo. */
function connectGoogle(personId: string) {
  if (state.googleAccounts.some((a) => a.personId === personId)) return;
  state.googleAccounts.push({
    personId,
    email: `${personId.slice(2)}@example.com`,
    status: "connected",
    since: `${YESTERDAY}T08:00:00Z`,
  });
}

async function openReview(personId = "p-giulia") {
  connectGoogle(personId);
  const router = renderRoute(`/calendar?event=${EV_AUD_REVIEW_YESTERDAY}&date=${YESTERDAY}`, personId);
  const panel = await screen.findByRole("region", { name: "Event" });
  await within(panel).findByRole("heading", { level: 2, name: "AUD weekly review" });
  return { router, panel };
}

/** Alessia (AUD) ha l'evento nel suo calendario ma non era invitata: membro non partecipante. */
function alessiaSeesTheEvent() {
  ev().calendarPersonIds.push("p-alessia");
}

async function confirmReview(indexes = [0, 1, 2]) {
  setSessionPersonId("p-giulia");
  const out = await mail.confirmMailProposal(REVIEW_PROPOSAL, { actionIndexes: indexes });
  return out.status === "confirmed" ? out.resultCodes : [];
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia("(min-width: 1200px)", true);
});
afterEach(() => {
  resetViewerGrants();
  closeGoogleAccount();
  clearToasts();
  setSessionPersonId("p-giulia");
});

describe("Riassunto della riunione — partecipante", () => {
  it("riassunto segnato come testo generato, trascrizione, email di Gemini, proposte aperte e task nate", async () => {
    const { panel } = await openReview();
    const summary = await within(panel).findByRole("region", { name: "Meeting summary" });
    expect(within(summary).getByText("Generated text")).toBeInTheDocument();
    expect(within(summary).getByText(SUMMARY)).toBeInTheDocument();
    expect(
      within(summary).getByText("Generated text").compareDocumentPosition(
        within(summary).getByText(SUMMARY),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(summary).getByRole("button", { name: "Open the transcript" })).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: /From the email by Gemini/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/mail/"),
    );
    // La proposta della trascrizione è ancora aperta: la card con la conferma sul posto.
    expect(
      await within(summary).findByText(/Send Sofia the revised go-live plan in writing/),
    ).toBeInTheDocument();

    const tasks = await within(panel).findByRole("region", { name: "Tasks from this meeting" });
    expect(await within(tasks).findByText("No tasks came out of this meeting")).toBeInTheDocument();
  });

  it("confermata la proposta, le task nate con il loro stato di adesso", async () => {
    const codes = await confirmReview();
    const { panel } = await openReview();
    const tasks = await within(panel).findByRole("region", { name: "Tasks from this meeting" });
    for (const code of codes) expect(await within(tasks).findByText(code)).toBeInTheDocument();
    expect(within(tasks).getAllByText(/^(Open|In progress|Done|Overdue.*|Request)$/)).toHaveLength(
      codes.length,
    );
  });

  it("trascrizione in lettura: lo dice al posto del riassunto", async () => {
    transcript().doc = "reading";
    const { panel } = await openReview();
    const summary = await within(panel).findByRole("region", { name: "Meeting summary" });
    expect(within(summary).getByText("Reading the transcript…")).toBeInTheDocument();
    expect(within(summary).queryByText(SUMMARY)).toBeNull();
  });

  it("documento non raggiungibile: lo dice, nessun riassunto, «No tasks yet»", async () => {
    transcript().doc = "unreachable";
    const { panel } = await openReview();
    const summary = await within(panel).findByRole("region", { name: "Meeting summary" });
    expect(within(summary).getByText("Couldn't open the transcript document")).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "Open in Google Docs" })).toBeInTheDocument();
    expect(within(summary).queryByText(SUMMARY)).toBeNull();
    const tasks = await within(panel).findByRole("region", { name: "Tasks from this meeting" });
    expect(await within(tasks).findByText("No tasks yet")).toBeInTheDocument();
  });
});

describe("Riassunto della riunione — chi non c'era, chi non è membro", () => {
  it("membro non partecipante: nulla finché non nascono task, poi solo «Tasks from this meeting»", async () => {
    alessiaSeesTheEvent();
    const first = await openReview("p-alessia");
    await waitFor(() => expect(first.panel.querySelector("[aria-busy='true']")).toBeNull());
    expect(within(first.panel).queryByRole("region", { name: "Meeting summary" })).toBeNull();
    expect(within(first.panel).queryByRole("region", { name: "Tasks from this meeting" })).toBeNull();
  });

  it("membro non partecipante con task nate: le task, nessun riassunto né testo generato", async () => {
    alessiaSeesTheEvent();
    const codes = await confirmReview();
    const { panel } = await openReview("p-alessia");
    const tasks = await within(panel).findByRole("region", { name: "Tasks from this meeting" });
    for (const code of codes) expect(await within(tasks).findByText(code)).toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Meeting summary" })).toBeNull();
    expect(within(panel).queryByText("Generated text")).toBeNull();
    expect(within(panel).queryByText(SUMMARY)).toBeNull();
    expect(within(panel).queryByText(/transcript/i)).toBeNull();
  });

  it.each([
    // Chiara (marketing) non vede AUD; Roberta (admin) lo vede ma non ne è membro (R-I7).
    ["p-chiara", "Chiara Gallo"],
    ["p-roberta", "Roberta Fontana"],
  ])(
    "partecipante non membro del progetto (%s): il riassunto sì, la scheda di preparazione no",
    async (personId, name) => {
      expect(state.projectsById.get("prj-aud")!.memberIds).not.toContain(personId);
      const guest = {
        email: `${personId}@stubwise.example`,
        name,
        personId,
        response: "accepted" as const,
        organizer: false,
      };
      ev().attendees.push(guest);
      const next = state.calendarEvents.find((e) => e.id === NEXT_REVIEW)!;
      next.attendees.push({ ...guest });

      const { router, panel } = await openReview(personId);
      const summary = await within(panel).findByRole("region", { name: "Meeting summary" });
      expect(within(summary).getByText("Generated text")).toBeInTheDocument();
      expect(within(summary).getByText(SUMMARY)).toBeInTheDocument();

      // La prossima revisione: invitato, ma senza scheda (serve essere membri).
      setSessionPersonId(personId);
      expect(await calendar.getMeetingPrep(NEXT_REVIEW)).toBeNull();
      await router.navigate({
        to: "/calendar",
        search: { event: NEXT_REVIEW, date: daysFromToday(6) },
      } as never);
      const again = await screen.findByRole("region", { name: "Event" });
      await within(again).findByText(/^(AUD|No project)$/);
      await waitFor(() => expect(within(again).queryByText(SUMMARY)).toBeNull());
      expect(within(again).queryByRole("region", { name: "Prepare" })).toBeNull();
    },
  );

  it("evento senza progetto: il riassunto resta di chi ha partecipato", async () => {
    ev().projectId = null;
    const { panel } = await openReview();
    const summary = await within(panel).findByRole("region", { name: "Meeting summary" });
    expect(within(summary).getByText(SUMMARY)).toBeInTheDocument();
  });
});

describe("Riassunto della riunione — errori", () => {
  it("le task nate non si caricano: «Retry» nella loro sezione, il riassunto resta", async () => {
    failNext("mail.tasksBornFrom");
    const { panel } = await openReview();
    const tasks = await within(panel).findByRole("region", { name: "Tasks from this meeting" });
    expect(await within(tasks).findByRole("alert")).toHaveTextContent(
      "Couldn't load Tasks from this meeting",
    );
    expect(
      within(await within(panel).findByRole("region", { name: "Meeting summary" })).getByText(SUMMARY),
    ).toBeInTheDocument();
    await userEvent.click(within(tasks).getByRole("button", { name: "Retry" }));
    expect(await within(tasks).findByText("No tasks came out of this meeting")).toBeInTheDocument();
  });

  it("il riassunto non si carica: un avviso neutro con «Retry»", async () => {
    failNext("mail.getMeetingSummary");
    const { panel } = await openReview();
    const alert = await within(panel).findByText("Couldn't load what came out of this meeting");
    await userEvent.click(within(alert.closest("[role='alert']")! as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(
      await within(await within(panel).findByRole("region", { name: "Meeting summary" })).findByText(SUMMARY),
    ).toBeInTheDocument();
  });
});
