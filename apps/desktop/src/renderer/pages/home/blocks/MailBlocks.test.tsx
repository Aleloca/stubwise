import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { CALENDAR_CASES } from "../../../data/seed/calendar/events";
import { MAIL_CASES } from "../../../data/seed/mail";
import { setSessionPersonId } from "../../../data/session";
import { now, state } from "../../../data/store";
import { VIEW_AS_PERSONAS, grantProjectRole, viewerFor } from "../../../data/viewer";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { clearPendingAnswers, setUndoWindow } from "../pendingAnswers";
import { BLOCKS, CATALOG_KINDS } from "./registry";

// Posta e Calendario nella Home (area 6, Task 11): i blocchi «Upcoming» e
// «Important email», le proposte della posta in «Decide» e la privacy
// (Review Focus 1): un admin e un collega dello stesso progetto che non è
// destinatario non vedono NULLA della posta degli altri — come se non
// esistesse. Giulia è destinataria della condivisa di AUD (con Matteo, Laura
// in cc); Roberta è admin; Alessia è in AUD ma in nessuna email.

const SHARED_THREAD = "th-aud-billing-vat";
const SHARED_SUBJECT = "Billing export: we need the VAT number column by Monday";
const SHARED_PROPOSAL = "mp-aud-billing-vat";

const MEETING_PROPOSAL = "mp-aud-weekly-review";

const block = (name: string) => screen.findByRole("region", { name });
/** La voce di una proposta in «Decide», quando c'è. */
async function mailItem(id: string): Promise<HTMLElement> {
  const decide = await block("Decide");
  return waitFor(() => {
    // Oltre le prime 5 voci, «Show N more» espande sul posto.
    const more = within(decide).queryByRole("button", { name: /^Show \d+ more$/ });
    if (more) fireEvent.click(more);
    const el = decide.querySelector<HTMLElement>(`[data-mail-decision="${id}"]`);
    if (!el) throw new Error(`no proposal ${id} yet`);
    return el;
  });
}
const pathname = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;
const searchOf = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;

/** Un account Google collegato per chi non ce l'ha: i blocchi leggono, non chiedono di collegare. */
function connect(personId: string) {
  state.googleAccounts.push({
    personId,
    email: `${personId}@example.com`,
    status: "connected",
    since: now(),
  });
}

/** Tutti gli oggetti delle email del seme: nessuno deve comparire a chi non le vede. */
const allSubjects = () => [...new Set(state.mailMessages.map((m) => m.subject))];

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
  setUndoWindow(0);
});

afterEach(() => {
  clearPendingAnswers();
  clearToasts();
  setUndoWindow(null);
});

describe("Home: catalogo e Home nuove", () => {
  it("i due blocchi sono nel catalogo per tutti, senza permessi", () => {
    expect(CATALOG_KINDS).toEqual(expect.arrayContaining(["upcomingEvents", "importantMail"]));
    for (const persona of VIEW_AS_PERSONAS) {
      const viewer = viewerFor(persona.personId);
      expect(BLOCKS.upcomingEvents.available(viewer)).toBe(true);
      expect(BLOCKS.importantMail.available(viewer)).toBe(true);
    }
  });

  it("una Home nuova: Decide → My week → Upcoming → Important email, poi il reparto", async () => {
    renderRoute("/home", "p-giulia");
    await block("Decide");
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles.slice(0, 5)).toEqual([
      "Decide",
      "My week",
      "Upcoming",
      "Important email",
      "My tasks",
    ]);
  });

  it("una Home già personalizzata non cambia (Marco)", async () => {
    renderRoute("/home", "p-marco");
    await block("Decide");
    expect(screen.queryByRole("region", { name: "Upcoming" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Important email" })).toBeNull();
  });
});

describe("Home: «Important email»", () => {
  it("le alte non lette di chi guarda, con mittente, oggetto, progetto, scadenza; aprire una la toglie", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    const region = await block("Important email");
    const row = await waitFor(() => {
      const el = region.querySelector<HTMLElement>(`[data-important-mail="${SHARED_THREAD}"]`);
      if (!el) throw new Error("no row yet");
      return el;
    });
    expect(row).toHaveTextContent("Sofia Marchetti");
    expect(row).toHaveTextContent(SHARED_SUBJECT);
    expect(row).toHaveTextContent("AUD");
    const link = within(row).getByRole("link");
    // Il nome accessibile dice tutto a parole, importanza compresa.
    expect(link).toHaveAccessibleName(
      /^Unread · High importance · Sofia Marchetti · Billing export.* · AUD Audin 2.0 · Due Oct 26/,
    );
    expect(within(region).getByRole("link", { name: "Open Mail" })).toBeInTheDocument();

    await user.click(link);
    await waitFor(() => expect(pathname(router)).toBe(`/mail/${SHARED_THREAD}`));
    // La Posta la segna letta (dopo la permanenza): al ritorno la riga non c'è più.
    await waitFor(
      () =>
        expect(
          state.mailMessages.find((m) => m.id === MAIL_CASES.shared)!.readByPersonIds,
        ).toContain("p-giulia"),
      { timeout: 4000 },
    );
    act(() => router.history.push("/home"));
    const again = await block("Important email");
    await waitFor(() => expect(again.querySelectorAll("[data-important-mail]")).toHaveLength(1));
    expect(again.querySelector(`[data-important-mail="${SHARED_THREAD}"]`)).toBeNull();
  });

  it("senza account Google il blocco c'è e lo dice, con «Connect»", async () => {
    renderRoute("/home", "p-alessia");
    const region = await block("Important email");
    expect(
      await within(region).findByText("Connect your Google account to see important email here"),
    ).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("collegamento scaduto: le righe restano, con «Connection expired · Reconnect»", async () => {
    renderRoute("/home", "p-laura");
    const region = await block("Important email");
    expect(await within(region).findByText(/Connection expired/)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });
});

describe("Home: «Upcoming»", () => {
  it("da adesso a fine di domani, in TODAY, il «tutto il giorno» in testa; clic → Calendario sul giorno con l'evento", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    const region = await block("Upcoming");
    const today = await within(region).findByRole("group", { name: "Today" });
    const ids = [...today.querySelectorAll("[data-upcoming-event]")].map((el) =>
      el.getAttribute("data-upcoming-event"),
    );
    // Finito alle 12:00 (adesso): fuori. Il «tutto il giorno» prima degli eventi con orario.
    expect(ids).not.toContain(CALENDAR_CASES.goLive);
    expect(ids[0]).toBe(CALENDAR_CASES.pressDay);
    expect(ids).toEqual(expect.arrayContaining([CALENDAR_CASES.lunch, CALENDAR_CASES.invite]));
    // L'invito senza risposta lo dice a parole; il progetto con la scheda ha il segno.
    const invite = today.querySelector<HTMLElement>(
      `[data-upcoming-event="${CALENDAR_CASES.invite}"]`,
    )!;
    expect(invite).toHaveTextContent("Not answered");
    const review = today.querySelector<HTMLElement>(
      `[data-upcoming-event="${CALENDAR_CASES.visualsReview}"]`,
    )!;
    expect(within(review).getByRole("link")).toHaveAccessibleName(/MKX/);

    await user.click(
      within(
        today.querySelector<HTMLElement>(`[data-upcoming-event="${CALENDAR_CASES.lunch}"]`)!,
      ).getByRole("link"),
    );
    await waitFor(() => expect(pathname(router)).toBe("/calendar"));
    expect(searchOf(router)).toMatchObject({
      view: "day",
      date: "2026-10-23",
      event: CALENDAR_CASES.lunch,
    });
  });

  it("un evento rifiutato non c'è", async () => {
    const lunch = state.calendarEvents.find((e) => e.id === CALENDAR_CASES.visualsReview)!;
    lunch.attendees.find((a) => a.personId === "p-giulia")!.response = "declined";
    renderRoute("/home", "p-giulia");
    const region = await block("Upcoming");
    await within(region).findByRole("group", { name: "Today" });
    expect(
      region.querySelector(`[data-upcoming-event="${CALENDAR_CASES.visualsReview}"]`),
    ).toBeNull();
  });
});

describe("Home: proposte della posta in «Decide»", () => {
  it("Giulia ha la condivisa con l'origine; conferma sul posto con «Undo», nasce una sola task", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const decide = await block("Decide");
    const item = await waitFor(() => {
      const el = decide.querySelector<HTMLElement>(`[data-mail-decision="${SHARED_PROPOSAL}"]`);
      if (!el) throw new Error("no proposal yet");
      return el;
    });
    expect(item).toHaveTextContent(`From an email · Sofia Marchetti · ${SHARED_SUBJECT}`);
    expect(within(item).getByRole("link", { name: "Open email" })).toHaveAttribute(
      "href",
      expect.stringContaining(`/mail/${SHARED_THREAD}`),
    );
    const tasksBefore = state.tasks.length;
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Confirmed for AUD")).toBeInTheDocument();
    await waitFor(() =>
      expect(state.mailProposals.find((p) => p.id === SHARED_PROPOSAL)!.status).toBe("confirmed"),
    );
    expect(state.tasks.length).toBe(tasksBefore + 1);
    await waitFor(() =>
      expect(decide.querySelector(`[data-mail-decision="${SHARED_PROPOSAL}"]`)).toBeNull(),
    );
  });

  it("«Undo» entro la finestra: la conferma non parte e la proposta torna", async () => {
    setUndoWindow(60_000);
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const decide = await block("Decide");
    const item = await waitFor(() => {
      const el = decide.querySelector<HTMLElement>(`[data-mail-decision="${SHARED_PROPOSAL}"]`);
      if (!el) throw new Error("no proposal yet");
      return el;
    });
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(state.mailProposals.find((p) => p.id === SHARED_PROPOSAL)!.status).toBe("open");
    await waitFor(() =>
      expect(
        decide.querySelector(`[data-mail-decision="${SHARED_PROPOSAL}"]`)!.closest("li"),
      ).not.toHaveAttribute("data-closed"),
    );
  });

  it("decisa da un altro: sparisce da «Decide» di tutti gli altri destinatari", async () => {
    // Prima c'è, per Giulia e per Laura (in cc).
    for (const personId of ["p-giulia", "p-laura"]) {
      setSessionPersonId(personId);
      expect((await api.mail.listMailDecisions()).map((v) => v.proposal.id)).toContain(
        SHARED_PROPOSAL,
      );
    }
    setSessionPersonId("p-matteo");
    await api.mail.confirmMailProposal(SHARED_PROPOSAL, {});
    for (const personId of ["p-giulia", "p-laura"]) {
      renderRoute("/home", personId);
      const region = await block("Decide");
      // Le altre voci ci sono (il blocco è pronto), la proposta decisa no.
      await waitFor(() => expect(region.querySelector("ul")).not.toBeNull());
      expect(region.querySelector(`[data-mail-decision="${SHARED_PROPOSAL}"]`)).toBeNull();
      cleanup();
    }
  });

  it("la seconda decisione: «Already confirmed by Matteo Conti» col link alla task nata, nulla due volte", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    const item = await mailItem(SHARED_PROPOSAL);
    setSessionPersonId("p-matteo");
    const outcome = await api.mail.confirmMailProposal(SHARED_PROPOSAL, {});
    const born = (outcome as { resultCodes: string[] }).resultCodes[0]!;
    setSessionPersonId("p-giulia");
    const tasksAfterMatteo = state.tasks.length;
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText("Already confirmed by Matteo Conti. Nothing was created twice."),
    ).toBeInTheDocument();
    expect(state.tasks.length).toBe(tasksAfterMatteo);
    await user.click(screen.getByRole("button", { name: `Open ${born}` }));
    await waitFor(() => expect(searchOf(router)).toMatchObject({ task: born }));
  });

  it("già ignorata da un altro: «Already ignored by …», senza link", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const item = await mailItem(SHARED_PROPOSAL);
    setSessionPersonId("p-laura");
    await api.mail.ignoreMailProposal(SHARED_PROPOSAL);
    setSessionPersonId("p-giulia");
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText("Already ignored by Laura Costa. Nothing was created."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open [A-Z]+-\d+$/ })).toBeNull();
  });

  it("una conferma non eseguita (tutto o niente) lo dice, col link all'email in Posta", async () => {
    // Un titolo vuoto: la mutazione la rifiuta a metà, la proposta finisce `failed`.
    const p = state.mailProposals.find((x) => x.id === SHARED_PROPOSAL)!;
    p.actions[0]!.args.title = "  ";
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    const item = await mailItem(SHARED_PROPOSAL);
    const tasksBefore = state.tasks.length;
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText("The proposal for AUD couldn't be completed. Nothing was changed."),
    ).toBeInTheDocument();
    expect(p.status).toBe("failed");
    expect(state.tasks.length).toBe(tasksBefore);
    await user.click(screen.getByRole("button", { name: "Open email" }));
    await waitFor(() => expect(pathname(router)).toBe(`/mail/${SHARED_THREAD}`));
  });

  it("densità di blocco: la prima azione per intero, «+3 more» espande sul posto", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const item = await mailItem(MEETING_PROPOSAL);
    expect(item).toHaveTextContent(/From the meeting Weekly review with Audin/);
    expect(item.querySelectorAll("[data-action-row]")).toHaveLength(1);
    await user.click(within(item).getByRole("button", { name: "+3 more" }));
    expect(item.querySelectorAll("[data-action-row]")).toHaveLength(4);
    expect(within(item).queryByRole("button", { name: "+3 more" })).toBeNull();
    // L'estratto è sempre aperto in «Decide».
    expect(
      within(item).getByRole("button", { name: "Hide what Stubwise read" }),
    ).toBeInTheDocument();
  });

  it("cambiare persona nella finestra dell'«Undo»: la conferma parte a nome di Giulia", async () => {
    setUndoWindow(60_000);
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const item = await mailItem(SHARED_PROPOSAL);
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(state.mailProposals.find((x) => x.id === SHARED_PROPOSAL)!.status).toBe("open");
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    await user.click(await screen.findByRole("radio", { name: /Marco Bellini/ }));
    await waitFor(() =>
      expect(state.mailProposals.find((x) => x.id === SHARED_PROPOSAL)).toMatchObject({
        status: "confirmed",
        decidedById: "p-giulia",
      }),
    );
    await block("Decide");
    expect(screen.queryByText(/It's back in Decide|couldn't be completed/)).toBeNull();
  });

  it("decisa da un altro mentre «Decide» è aperto: sparisce alla prima rilettura", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const decide = await block("Decide");
    await mailItem(SHARED_PROPOSAL);
    setSessionPersonId("p-matteo");
    await api.mail.confirmMailProposal(SHARED_PROPOSAL, {});
    setSessionPersonId("p-giulia");
    // Ancora lì: nessuno ha riletto. Giulia ignora un'altra proposta: la
    // decisione rilegge «Decide», e quella condivisa se ne va.
    expect(decide.querySelector(`[data-mail-decision="${SHARED_PROPOSAL}"]`)).not.toBeNull();
    const other = await mailItem("mp-stw-copy-freeze");
    await user.click(within(other).getByRole("button", { name: "Ignore" }));
    await waitFor(() =>
      expect(decide.querySelector(`[data-mail-decision="${SHARED_PROPOSAL}"]`)).toBeNull(),
    );
  });
});

describe("Calendario: `?newMeeting=1` si toglie comunque", () => {
  it("lettura dell'account fallita: niente dialogo, e il parametro se ne va", async () => {
    api.failNext("drive.getGoogleAccount");
    const router = renderRoute("/calendar?newMeeting=1", "p-giulia");
    await waitFor(() => expect(searchOf(router).newMeeting).toBeUndefined());
    expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull();
  });

  it("senza account Google: niente dialogo, e il parametro se ne va", async () => {
    const router = renderRoute("/calendar?newMeeting=1", "p-alessia");
    await waitFor(() => expect(searchOf(router).newMeeting).toBeUndefined());
    expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull();
  });
});

describe("Home: J/K fra le righe dei blocchi", () => {
  it("«Important email» e «Upcoming»: J e K muovono il fuoco fra le righe, Enter apre", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    const mail = await block("Important email");
    const mailLinks = await waitFor(() => {
      const links = [...mail.querySelectorAll<HTMLElement>("[data-important-mail] > a")];
      if (links.length < 2) throw new Error("rows not yet");
      return links;
    });
    mailLinks[0]!.focus();
    await user.keyboard("j");
    expect(mailLinks[1]).toHaveFocus();
    await user.keyboard("j");
    expect(mailLinks[1]).toHaveFocus(); // all'estremità resta
    await user.keyboard("k");
    expect(mailLinks[0]).toHaveFocus();

    const upcoming = await block("Upcoming");
    const eventLinks = await waitFor(() => {
      const links = [...upcoming.querySelectorAll<HTMLElement>("[data-upcoming-event] > a")];
      if (links.length < 2) throw new Error("rows not yet");
      return links;
    });
    eventLinks[0]!.focus();
    await user.keyboard("j");
    expect(eventLinks[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pathname(router)).toBe("/calendar"));
  });

  it("fuori dal blocco J/K non muovono le righe", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const mail = await block("Important email");
    await waitFor(() => expect(mail.querySelector("[data-important-mail] > a")).not.toBeNull());
    screen.getByRole("button", { name: "Customize" }).focus();
    await user.keyboard("j");
    expect(mail.contains(document.activeElement)).toBe(false);
  });
});

describe("Privacy della posta nella Home e in ⌘K (Review Focus 1)", () => {
  for (const [personId, who] of [
    ["p-roberta", "l'admin"],
    ["p-alessia", "un collega di AUD non destinatario"],
  ] as const) {
    it(`${who}: «Important email» vuoto, in «Decide» nessuna email, niente in ⌘K`, async () => {
      connect(personId);
      const user = userEvent.setup();
      renderRoute("/home", personId);
      const mail = await block("Important email");
      expect(await within(mail).findByText("Nothing important")).toBeInTheDocument();
      const decide = await block("Decide");
      // Pronto: con voci (le altre risposte dell'admin) o vuoto (Alessia).
      await waitFor(() =>
        expect(
          decide.querySelector("ul") ?? within(decide).queryByText("Nothing to decide"),
        ).not.toBeNull(),
      );
      await new Promise((r) => setTimeout(r, 50));
      // Nemmeno la passata di STW all'admin: ha il permesso, ma non è membro (R-I25).
      expect(decide.querySelector("[data-mail-decision]")).toBeNull();
      const page = document.body.textContent ?? "";
      for (const subject of allSubjects()) expect(page).not.toContain(subject);

      await user.keyboard("{Control>}k{/Control}");
      const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
      await user.keyboard("VAT number");
      // Le altre ricerche arrivano (la riga «Search all mail» c'è sempre), la posta no.
      await within(dialog).findByRole("option", { name: "Search all mail for “VAT number”" });
      await new Promise((r) => setTimeout(r, 200));
      expect(within(dialog).queryByRole("group", { name: "Mail" })).toBeNull();
      expect(dialog.querySelector("[data-palette-mail]")).toBeNull();
    });
  }
});

describe("Proposte passate al progetto in «Decide», a chi non è destinatario", () => {
  it("dall'email: chi l'ha passata e a chi era, con l'estratto aperto, senza origine", async () => {
    // Simone: membro di STW, Project Lead, non destinatario dell'email di Ivo.
    grantProjectRole("p-simone", "prj-stw", "project_lead");
    connect("p-simone");
    renderRoute("/home", "p-simone");
    const item = await mailItem("mp-stw-release-notes-date");
    expect(within(item).queryByRole("link", { name: "Open email" })).toBeNull();
    expect(item.textContent).not.toMatch(/From an email|From the meeting/);
    expect(item).toHaveTextContent("Handed to STW by Giulia Ferri");
    expect(item).toHaveTextContent("from an email to Giulia Ferri");
    expect(within(item).getByRole("button", { name: "Hide what Stubwise read" })).toBeInTheDocument();
    expect(item.querySelector("blockquote")).toHaveTextContent(
      "The wording of the release notes is approved on our side.",
    );
  });

  it("da una riunione a cui non era: solo le azioni e «from a meeting», niente estratto (R-I24)", async () => {
    grantProjectRole("p-giulia", "prj-aud", "viewer");
    setSessionPersonId("p-giulia");
    await api.mail.handMailProposal(MEETING_PROPOSAL);
    grantProjectRole("p-stefano", "prj-aud", "project_lead");
    connect("p-stefano");
    renderRoute("/home", "p-stefano");
    const item = await mailItem(MEETING_PROPOSAL);
    expect(item).toHaveTextContent("Handed to AUD by Giulia Ferri");
    expect(item).toHaveTextContent("from a meeting");
    expect(item).not.toHaveTextContent("from an email to");
    expect(item.querySelector("blockquote")).toBeNull();
    expect(within(item).queryByRole("button", { name: /what Stubwise read/ })).toBeNull();
    const summary = state.mailProposals.find((p) => p.id === MEETING_PROPOSAL)!.excerpt;
    expect(document.body.textContent).not.toContain(summary.slice(0, 40));
  });
});

describe("⌘K: gruppo «Mail» e azioni", () => {
  it("Giulia trova l'email (dopo File, prima di Channels/Messages); la riga apre la conversazione", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("VAT number");
    const group = await within(dialog).findByRole("group", { name: "Mail" });
    const row = await waitFor(() => {
      const el = group.querySelector<HTMLElement>("[data-palette-mail]");
      if (!el) throw new Error("no mail yet");
      return el;
    });
    expect(row).toHaveTextContent(SHARED_SUBJECT);
    const headings = [...dialog.querySelectorAll(".heading-group")].map((h) => h.textContent);
    const at = headings.indexOf("Mail");
    for (const before of ["Files"]) {
      if (headings.includes(before)) expect(headings.indexOf(before)).toBeLessThan(at);
    }
    for (const after of ["Channels", "Messages", "Actions", "More"]) {
      if (headings.includes(after)) expect(headings.indexOf(after)).toBeGreaterThan(at);
    }
    expect(headings.at(-1)).toBe("More");
    await user.click(row);
    await waitFor(() => expect(pathname(router)).toBe(`/mail/${SHARED_THREAD}`));
  });

  it("«New email» e «New meeting»: la nuova email nella Posta, il dialogo sul Calendario", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    let dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("new email");
    await within(dialog).findByRole("option", { name: "New email", selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(searchOf(router)).toMatchObject({ compose: "new" }));

    await user.keyboard("{Control>}k{/Control}");
    dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("new meeting");
    await within(dialog).findByRole("option", { name: "New meeting", selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pathname(router)).toBe("/calendar"));
    expect(await screen.findByRole("dialog", { name: "New meeting" })).toBeInTheDocument();
    // Il parametro si toglie: tornare indietro non riapre il dialogo.
    await waitFor(() => expect(searchOf(router).newMeeting).toBeUndefined());
  });
});
