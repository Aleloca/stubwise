import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { CALENDAR_CASES } from "../../../data/seed/calendar/events";
import { MAIL_CASES } from "../../../data/seed/mail";
import { setSessionPersonId } from "../../../data/session";
import { now, state } from "../../../data/store";
import { VIEW_AS_PERSONAS, viewerFor } from "../../../data/viewer";
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

const block = (name: string) => screen.findByRole("region", { name });
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

  it("la seconda decisione: «Already decided by Matteo Conti», nulla due volte", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    const decide = await block("Decide");
    const item = await waitFor(() => {
      const el = decide.querySelector<HTMLElement>(`[data-mail-decision="${SHARED_PROPOSAL}"]`);
      if (!el) throw new Error("no proposal yet");
      return el;
    });
    setSessionPersonId("p-matteo");
    await api.mail.confirmMailProposal(SHARED_PROPOSAL, {});
    setSessionPersonId("p-giulia");
    const tasksAfterMatteo = state.tasks.length;
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Already decided by Matteo Conti.")).toBeInTheDocument();
    expect(state.tasks.length).toBe(tasksAfterMatteo);
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
      // Pronto: con voci (l'admin) o vuoto (Alessia).
      await waitFor(() =>
        expect(
          decide.querySelector("ul") ?? within(decide).queryByText("Nothing to decide"),
        ).not.toBeNull(),
      );
      await new Promise((r) => setTimeout(r, 50));
      // Solo una proposta PASSATA al progetto può arrivare a chi non è
      // destinatario (con il permesso nel progetto: l'admin): con l'estratto,
      // senza riga d'origine né link all'email.
      for (const item of decide.querySelectorAll<HTMLElement>("[data-mail-decision]")) {
        const id = item.getAttribute("data-mail-decision");
        expect(state.mailProposals.find((p) => p.id === id)!.status).toBe("handed");
        expect(within(item).queryByRole("link", { name: "Open email" })).toBeNull();
        expect(item.textContent).not.toMatch(/From an email|From the meeting/);
      }
      if (personId === "p-alessia") expect(decide.querySelector("[data-mail-decision]")).toBeNull();
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
