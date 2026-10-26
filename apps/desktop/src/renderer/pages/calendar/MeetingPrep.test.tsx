import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mail, resetApi, setLatency } from "../../data/api";
import { CALENDAR_CASES } from "../../data/seed/calendar";
import { daysFromToday, TODAY } from "../../data/seed/dates";
import { EV_AUD_REVIEW_YESTERDAY, MAIL_CASES } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { failNext, state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";

// La scheda di preparazione nel dettaglio di un evento futuro (Task 10,
// shape meeting-prep.md): il partecipante legge il riassunto delle riunioni
// precedenti, il membro che non c'era solo le cose da fare, chi non è membro
// (o un evento senza progetto) solo i dettagli dell'evento. Ogni sezione ha
// il suo caricamento, errore e vuoto; il cambio di persona non lascia la
// scheda di prima.

const C = CALENDAR_CASES;
const AUD = "prj-aud";
/** La prossima revisione di AUD: Matteo organizza, Giulia, Laura e Marco invitati. */
const NEXT_REVIEW = `ev-aud-review-${daysFromToday(6)}`;
const REVIEW_PROPOSAL = "mp-aud-weekly-review";
const SUMMARY = /client accepts the go-live plan/;

const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, string | undefined>;

/** Il Calendario chiede l'account Google: nel seme ce l'hanno solo Giulia e Matteo. */
function connectGoogle(personId: string) {
  if (state.googleAccounts.some((a) => a.personId === personId)) return;
  state.googleAccounts.push({
    personId,
    email: `${personId.slice(2)}@example.com`,
    status: "connected",
    since: `${TODAY}T08:00:00Z`,
  });
}

async function openEvent(id: string, day: string, personId = "p-giulia") {
  connectGoogle(personId);
  const router = renderRoute(`/calendar?event=${id}&date=${day}`, personId);
  const panel = await screen.findByRole("region", { name: "Event" });
  return { router, panel };
}

const sheet = (panel: HTMLElement) => within(panel).findByRole("region", { name: "Prepare" });
const section = (root: HTMLElement, name: string) => within(root).findByRole("region", { name });

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

/** Un'email di AUD, la più recente di tutte, solo nella casella di Matteo. */
function onlyForMatteo() {
  const shared = state.mailMessages.find((m) => m.id === MAIL_CASES.shared)!;
  state.mailMessages.push({
    ...structuredClone(shared),
    id: "mm-test-only-matteo",
    messageId: "<only-matteo@audin.example>",
    threadId: "th-test-only-matteo",
    to: [shared.to.find((a) => a.personId === "p-matteo")!],
    cc: null,
    subject: "Only for Matteo",
    at: `${TODAY}T11:59:00Z`,
    mailboxPersonIds: ["p-matteo"],
    readByPersonIds: [],
  });
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

describe("Scheda di preparazione — chi la vede e cosa", () => {
  it("un partecipante: tre sezioni nell'ordine, il riassunto della riunione precedente segnato come testo generato", async () => {
    const { panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const prep = await sheet(panel);
    expect(within(prep).getAllByRole("link", { name: /AUD/ })[0]).toHaveAttribute(
      "href",
      expect.stringContaining("/p/AUD/overview"),
    );
    const names = within(prep)
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label") ?? document.getElementById(r.getAttribute("aria-labelledby")!)?.textContent);
    expect(names).toEqual(["Recent email", "Last meetings", "Project status"]);

    const meetings = await section(prep, "Last meetings");
    expect(
      await within(meetings).findAllByRole("button", { name: /AUD weekly review/ }),
    ).toHaveLength(2);
    expect(within(meetings).getByText("Generated text")).toBeInTheDocument();
    expect(within(meetings).getByText(SUMMARY)).toBeInTheDocument();
    // «Generated text» si annuncia PRIMA del riassunto.
    const tag = within(meetings).getByText("Generated text");
    expect(
      tag.compareDocumentPosition(within(meetings).getByText(SUMMARY)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(prep).getByRole("link", { name: "Open AUD overview" })).toBeInTheDocument();
  });

  it("un membro che non c'era: titolo, data e task nate; nessun riassunto e nessun segno che esista [A 2]", async () => {
    setSessionPersonId("p-giulia");
    const out = await mail.confirmMailProposal(REVIEW_PROPOSAL, { actionIndexes: [0, 1, 2] });
    expect(out.status).toBe("confirmed");
    const codes = out.status === "confirmed" ? out.resultCodes : [];

    // Alessia è invitata al controllo della dashboard di AUD, non alla revisione di ieri.
    const { panel } = await openEvent(C.saveFails, "2026-10-27", "p-alessia");
    const meetings = await section(await sheet(panel), "Last meetings");
    const item = (await within(meetings).findByText("AUD weekly review")).closest("li")!;
    // Il titolo non apre l'evento: lei non lo vede.
    expect(within(item).queryByRole("button", { name: /AUD weekly review/ })).toBeNull();
    for (const code of codes) expect(within(item).getByText(code)).toBeInTheDocument();
    expect(within(meetings).queryByText("Generated text")).toBeNull();
    expect(within(meetings).queryByText(SUMMARY)).toBeNull();
    expect(within(meetings).queryByText(/Summary|transcript/i)).toBeNull();
  });

  it("un non membro del progetto: solo i dettagli dell'evento", async () => {
    // L'all-hands lo vede tutta l'azienda; spostato su AUD, Chiara non ne è membro.
    state.calendarEvents.find((e) => e.id === C.allHands)!.projectId = AUD;
    const day = state.calendarEvents.find((e) => e.id === C.allHands)!.startsAt.slice(0, 10);
    const { panel } = await openEvent(C.allHands, day, "p-chiara");
    await within(panel).findByRole("heading", { level: 2 });
    await waitFor(() => expect(within(panel).queryByText("Loading…")).toBeNull());
    expect(within(panel).queryByRole("region", { name: "Prepare" })).toBeNull();
    expect(within(panel).queryByText("Recent email")).toBeNull();
  });

  it("un evento senza progetto: nessuna scheda", async () => {
    const day = state.calendarEvents.find((e) => e.id === C.lunch)!.startsAt.slice(0, 10);
    const { panel } = await openEvent(C.lunch, day);
    await within(panel).findByRole("heading", { level: 2 });
    expect(within(panel).queryByRole("region", { name: "Prepare" })).toBeNull();
  });

  it("le email sono quelle di chi guarda; il cambio di persona con la scheda aperta non lascia quelle di prima", async () => {
    onlyForMatteo();
    const { router, panel } = await openEvent(NEXT_REVIEW, daysFromToday(6), "p-matteo");
    const email = await section(await sheet(panel), "Recent email");
    const row = await within(email).findByRole("link", { name: /Only for Matteo/ });
    expect(row).toHaveAttribute("href", expect.stringContaining("/mail/th-test-only-matteo"));

    await switchPersona(/Laura Costa/);
    await waitFor(() => expect(search(router).event).toBeUndefined());
    expect(screen.queryByText("Only for Matteo")).toBeNull();

    // Riaperto da Laura: la sua scheda, senza l'email di Matteo.
    await router.navigate({
      to: "/calendar",
      search: { event: NEXT_REVIEW, date: daysFromToday(6) },
    } as never);
    const again = await screen.findByRole("region", { name: "Event" });
    const lauraMail = await section(await sheet(again), "Recent email");
    await within(lauraMail).findAllByRole("link");
    expect(within(lauraMail).queryByText("Only for Matteo")).toBeNull();
  });
});

describe("Scheda di preparazione — stati per sezione", () => {
  it("caricamento: ogni sezione ha il suo scheletro, poi il contenuto", async () => {
    setLatency(200);
    const { panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const prep = await sheet(panel);
    for (const name of ["Recent email", "Last meetings", "Project status"]) {
      const s = within(prep).getByRole("region", { name });
      expect(s.querySelector("[aria-busy='true']")).not.toBeNull();
    }
    const meetings = await section(prep, "Last meetings");
    expect(await within(meetings).findByText(SUMMARY, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("errore della scheda: «Retry» dentro ogni sezione, e riprova", async () => {
    failNext("calendar.getMeetingPrep");
    const { panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const prep = await sheet(panel);
    const email = await section(prep, "Recent email");
    expect(await within(email).findByRole("alert")).toHaveTextContent("Couldn't load Recent email");
    await userEvent.click(within(email).getByRole("button", { name: "Retry" }));
    expect(await within(await section(prep, "Last meetings")).findByText(SUMMARY)).toBeInTheDocument();
  });

  it("errore di una sola lettura dello stato: le altre sezioni restano", async () => {
    // Lo stato del progetto legge anche gli stati del progetto (avanzamento dei
    // traguardi): sul Calendario lo fa solo lei.
    failNext("listProjectStatuses");
    const { panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const prep = await sheet(panel);
    const status = await section(prep, "Project status");
    expect(await within(status).findByRole("alert")).toHaveTextContent(
      "Couldn't load Project status",
    );
    expect(await within(await section(prep, "Last meetings")).findByText(SUMMARY)).toBeInTheDocument();
    expect(within(await section(prep, "Recent email")).queryByRole("alert")).toBeNull();
    await userEvent.click(within(status).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(status).queryByRole("alert")).toBeNull());
    expect(await within(status).findByRole("link", { name: /In progress/ })).toBeInTheDocument();
  });

  it("vuoti: nessuna email, nessuna riunione precedente, niente di aperto", async () => {
    state.mailMessages.length = 0;
    state.calendarEvents = state.calendarEvents.filter(
      (e) => e.projectId !== AUD || e.id === NEXT_REVIEW || Date.parse(e.endsAt) > Date.parse(`${TODAY}T12:00:00Z`),
    );
    state.tasks = state.tasks.filter((t) => t.projectId !== AUD);
    for (const m of state.milestones) if (m.projectId === AUD) m.closed = true;
    const { panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const prep = await sheet(panel);
    expect(
      await within(await section(prep, "Recent email")).findByText("No recent email with you about AUD"),
    ).toBeInTheDocument();
    expect(
      await within(await section(prep, "Last meetings")).findByText("No earlier meetings on AUD"),
    ).toBeInTheDocument();
    expect(
      await within(await section(prep, "Project status")).findByText("Nothing open on AUD"),
    ).toBeInTheDocument();
  });

  it("documento della trascrizione non raggiungibile: lo dice, niente riassunto", async () => {
    state.meetingTranscripts.find((t) => t.eventId === EV_AUD_REVIEW_YESTERDAY)!.doc =
      "unreachable";
    const { panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const meetings = await section(await sheet(panel), "Last meetings");
    expect(
      await within(meetings).findByText("Couldn't open the transcript document"),
    ).toBeInTheDocument();
    expect(within(meetings).queryByText(SUMMARY)).toBeNull();
    expect(within(meetings).getByRole("button", { name: "Open in Google Docs" })).toBeInTheDocument();
  });
});

describe("Scheda di preparazione — dove portano le righe", () => {
  it("una task apre il suo pannello al posto dell'evento, e «Back to event» riporta indietro [A 4]", async () => {
    setSessionPersonId("p-giulia");
    const out = await mail.confirmMailProposal(REVIEW_PROPOSAL, { actionIndexes: [0] });
    const code = out.status === "confirmed" ? out.resultCodes[0]! : "";
    const { router, panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const meetings = await section(await sheet(panel), "Last meetings");
    await userEvent.click(await within(meetings).findByRole("button", { name: new RegExp(code) }));
    await waitFor(() => expect(search(router).task).toBe(code));
    expect(search(router).event).toBeUndefined();
    await userEvent.click(await screen.findByRole("button", { name: "Back to event" }));
    await waitFor(() => expect(search(router).event).toBe(NEXT_REVIEW));
    expect(search(router).task).toBeUndefined();
  });

  it("il titolo di una riunione precedente che vedo apre quell'evento", async () => {
    const { router, panel } = await openEvent(NEXT_REVIEW, daysFromToday(6));
    const meetings = await section(await sheet(panel), "Last meetings");
    // Dalla più recente: la revisione di ieri prima di quella della settimana scorsa.
    const [yesterday] = await within(meetings).findAllByRole("button", { name: /AUD weekly review/ });
    await userEvent.click(yesterday!);
    await waitFor(() => expect(search(router).event).toBe(EV_AUD_REVIEW_YESTERDAY));
  });
});

describe("Segno «Preparation available» sui blocchi della griglia", () => {
  const block = (id: string) =>
    waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-event-block="${id}"]`);
      if (!el) throw new Error(`no block ${id}`);
      return el;
    });

  it("c'è sugli eventi futuri di un progetto di cui sono membro, a parole nel nome del blocco", async () => {
    renderRoute(`/calendar?date=${daysFromToday(6)}`, "p-giulia");
    const next = await block(NEXT_REVIEW);
    await waitFor(() => expect(next).toHaveAccessibleName(/Preparation available/));
    expect(next.querySelector("[data-prep-mark]")).toHaveAttribute("title", "Open to prepare");
  });

  it("non c'è su un evento passato, né su uno senza progetto", async () => {
    // La settimana di oggi: la revisione di ieri (passata) e il pranzo di oggi (senza progetto).
    renderRoute(`/calendar?date=${TODAY}`, "p-giulia");
    const past = await block(EV_AUD_REVIEW_YESTERDAY);
    await waitFor(() => expect(past).toHaveAccessibleName(/AUD Audin/));
    expect(past).not.toHaveAccessibleName(/Preparation available/);
    expect(past.querySelector("[data-prep-mark]")).toBeNull();
    expect(state.calendarEvents.find((e) => e.id === C.lunch)!.projectId).toBeNull();
    const lunch = await block(C.lunch);
    expect(lunch).not.toHaveAccessibleName(/Preparation available/);
    expect(lunch.querySelector("[data-prep-mark]")).toBeNull();
  });

  it.each([
    // Chiara non vede AUD; Roberta (admin) lo vede ma non ne è membro (R-I7).
    ["p-chiara", "Chiara Lombardi"],
    ["p-roberta", "Roberta Fontana"],
  ])("non c'è per un invitato che non è membro del progetto (%s)", async (personId, name) => {
    expect(state.projectsById.get(AUD)!.memberIds).not.toContain(personId);
    connectGoogle(personId);
    state.calendarEvents
      .find((e) => e.id === NEXT_REVIEW)!
      .attendees.push({
        email: `${personId}@stubwise.example`,
        name,
        personId,
        response: "accepted",
        organizer: false,
      });
    renderRoute(`/calendar?date=${daysFromToday(6)}`, personId);
    const next = await block(NEXT_REVIEW);
    await waitFor(() => expect(next).toHaveAccessibleName(/AUD weekly review/));
    expect(next).not.toHaveAccessibleName(/Preparation available/);
    expect(next.querySelector("[data-prep-mark]")).toBeNull();
  });
});
