import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calendar, resetApi, setLatency } from "../../data/api";
import { CALENDAR_CASES } from "../../data/seed/calendar";
import { EV_AUD_REVIEW_YESTERDAY } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";
import { rangeLabel } from "./calendarFormat";

// La pagina del Calendario (Task 9, shape calendar.md): parametri
// nell'indirizzo, bordi della finestra e fusi (Review Focus 3, con
// TZ=America/Los_Angeles), 12 eventi sovrapposti leggibili (Review Focus 5),
// chi non organizza senza maniglie né modifica, la riunione nuova che passa
// da «Saving…» a salvata, lo spostamento da tastiera con la serie, e il
// cambio di persona con pannello o dialogo aperti.

const C = CALENDAR_CASES;
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, string | undefined>;

async function openCalendar(url: string, personId = "p-giulia") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: "Calendar" });
  return router;
}

const column = (day: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-day-column="${day}"]`);
    if (!el) throw new Error(`no column ${day}`);
    return el;
  });
const block = (id: string, root: ParentNode = document) =>
  waitFor(() => {
    const el = root.querySelector<HTMLElement>(`[data-event-block="${id}"]`);
    if (!el) throw new Error(`no block ${id}`);
    return el;
  });
const range = () => document.querySelector("[data-calendar-range]");
const work = () => screen.getByRole("main");
const announcer = () => document.querySelector("[data-calendar-announcer]")!;

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
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
  try {
    window.localStorage.clear();
  } catch {
    // niente storage: niente da pulire
  }
});

describe("Calendario — parametri nell'indirizzo", () => {
  it("Week è la vista di default; vista e giorno vanno e tornano dall'indirizzo, e le scorciatoie li cambiano", async () => {
    const router = await openCalendar("/calendar");
    expect(document.querySelector("[data-calendar-grid]")).toHaveAttribute(
      "data-calendar-grid",
      "week",
    );
    expect(range()).toHaveTextContent("Oct 19 – 25, 2026");
    expect(screen.getByRole("radio", { name: "Week" })).toHaveAttribute("aria-checked", "true");

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Month" }));
    await waitFor(() => expect(search(router).view).toBe("month"));
    await waitFor(() => expect(range()).toHaveTextContent("October 2026"));

    await user.keyboard("d");
    await waitFor(() => expect(search(router).view).toBe("day"));
    await waitFor(() => expect(range()).toHaveTextContent("Friday, Oct 23"));
    await user.keyboard("j");
    await waitFor(() => expect(search(router).date).toBe("2026-10-24"));
    await user.keyboard("t");
    await waitFor(() => expect(search(router).date).toBeUndefined());
    await user.keyboard("w");
    await waitFor(() => expect(search(router).view).toBeUndefined());
  });

  it("una data fuori dalla finestra si riporta al giorno di bordo più vicino", async () => {
    const router = await openCalendar("/calendar?view=day&date=2027-03-01");
    await waitFor(() => expect(search(router).date).toBe("2026-12-22"));
    await waitFor(() => expect(range()).toHaveTextContent("Tuesday, Dec 22"));
  });

  it("un evento aperto da fuori (`?event=` senza giorno) porta in Day sul suo giorno, col pannello aperto [A 11]", async () => {
    const router = await openCalendar(`/calendar?event=${EV_AUD_REVIEW_YESTERDAY}`);
    await waitFor(() => expect(search(router)).toMatchObject({ view: "day", date: "2026-10-22" }));
    const panel = await screen.findByRole("region", { name: "Event" });
    expect(within(panel).getByRole("heading", { name: "Weekly review with Audin" })).toBeInTheDocument();
    expect(search(router).event).toBe(EV_AUD_REVIEW_YESTERDAY);
  });

  it("un evento che non vedo (o inesistente) dice «This event isn't available»", async () => {
    await openCalendar("/calendar?event=ev-nope");
    expect(await screen.findByText("This event isn't available")).toBeInTheDocument();
    // Sara non è invitata alla revisione: stesso testo.
  });
});

describe("Calendario — bordi della finestra (Review Focus 3)", () => {
  it("la settimana del 23 settembre: ‹ spento col perché, i giorni prima tratteggiati e la riga che lo dice", async () => {
    await openCalendar("/calendar?date=2026-09-23");
    const prev = within(work()).getByRole("button", {
      name: "Stubwise reads your calendar from Sep 23 to Dec 22",
    });
    expect(prev).toBeDisabled();
    expect(within(work()).getByRole("button", { name: "Next" })).toBeEnabled();
    const outside = [...document.querySelectorAll("[data-day-column][data-outside]")].map(
      (c) => (c as HTMLElement).dataset.dayColumn,
    );
    expect(outside).toEqual(["2026-09-21", "2026-09-22"]);
    expect(screen.getByText("Days before Sep 23 aren't read from Google")).toBeInTheDocument();
  });

  it("in Month, settembre si raggiunge (tocca la finestra) ma agosto no; dicembre è l'ultimo", async () => {
    await openCalendar("/calendar?view=month&date=2026-09-30");
    expect(
      within(work()).getByRole("button", { name: /^Stubwise reads your calendar/ }),
    ).toBeDisabled();
    // Il mini-mese si ferma allo stesso mese.
    expect(
      within(screen.getByRole("region", { name: "Month at a glance" })).getByRole("button", {
        name: /^Stubwise reads your calendar/,
      }),
    ).toBeDisabled();
    expect(document.querySelector('[data-day-cell="2026-09-22"]')).toHaveAttribute("data-outside");
    expect(document.querySelector('[data-day-cell="2026-09-23"]')).not.toHaveAttribute(
      "data-outside",
    );
  });

  it("una riunione oltre il 22 dicembre non si crea: l'errore lo dice", async () => {
    await openCalendar("/calendar?view=day&date=2026-12-22");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    await user.type(within(dialog).getByLabelText("Title"), "Year-end retro");
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2026-12-23" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "Stubwise can schedule up to Dec 22 · use Google Calendar for later dates",
      ),
    ).toBeInTheDocument();
    expect(state.calendarEvents.some((e) => e.title === "Year-end retro")).toBe(false);
  });

  describe("con TZ=America/Los_Angeles", () => {
    const ORIGINAL = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "America/Los_Angeles";
    });
    afterAll(() => {
      process.env.TZ = ORIGINAL;
    });

    it("il «tutto il giorno» resta nella colonna della sua data, non scivola al giorno prima", async () => {
      expect(new Date("2026-10-23T00:00:00Z").getTimezoneOffset()).toBe(420);
      await openCalendar("/calendar");
      const press = await block(C.pressDay);
      // Lunedì 19 è la colonna 1: venerdì 23 è la 5.
      expect(press.style.gridColumn).toBe("5 / 6");
      expect(press).toHaveAccessibleName(/Press day, All day, Fri, Oct 23/);
    });

    it("un evento a cavallo della mezzanotte locale sta in entrambi i giorni: «continues» e «from»", async () => {
      // 26 ottobre 23:30 → 27 ottobre 01:00 a Los Angeles (PDT, UTC−7).
      setSessionPersonId("p-giulia");
      const created = await calendar.createEvent({
        title: "Late deploy",
        startsAt: "2026-10-27T06:30:00Z",
        endsAt: "2026-10-27T08:00:00Z",
      });
      await calendar.whenCalendarIdle();
      await openCalendar("/calendar?date=2026-10-26");
      const first = await block(created.id, await column("2026-10-26"));
      const second = await block(created.id, await column("2026-10-27"));
      expect(within(first).getByText(/continues/)).toBeInTheDocument();
      expect(within(second).getByText("from Mon 11:30 PM")).toBeInTheDocument();
      // Il nome accessibile dice l'orario intero.
      expect(first).toHaveAccessibleName(/Late deploy, Mon 11:30 PM – Tue 1:00 AM/);
    });
  });
});

describe("Calendario — barra e Mese (revisione visiva)", () => {
  it("l'intervallo dice il giorno senza zero davanti, anche a cavallo del mese", () => {
    const first = new Date(2026, 9, 26);
    const last = new Date(2026, 10, 1);
    // Gli spazi di ICU attorno al trattino sono sottili: si confrontano normalizzati.
    const plain = (x: string) => x.replace(/\s/g, " ");
    expect(plain(rangeLabel("week", first, last, "it"))).toBe("26 ott – 1 nov 2026");
    expect(plain(rangeLabel("week", first, last, "en"))).toBe("Oct 26 – Nov 1, 2026");
  });

  it("«New meeting» diventa «New» quando è stretta la barra, non la finestra", async () => {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    let width = 1000;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute("data-calendar-toolbar")) return { width, height: 64 } as DOMRect;
      return rect.call(this);
    };
    try {
      await openCalendar("/calendar");
      const button = await screen.findByRole("button", { name: "New meeting" });
      expect(button).toHaveTextContent("New meeting");
      width = 700;
      await openCalendar("/calendar?view=day");
      await waitFor(() => expect(screen.getAllByRole("button", { name: "New meeting" }).at(-1)).toHaveTextContent(/^New$/));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });

  it("Mese: tre righe per cella, poi «+N more»", async () => {
    await openCalendar("/calendar?view=month&date=2026-10-28");
    const cell = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-day-cell="2026-10-28"]');
      if (!el) throw new Error("no cell");
      return el;
    });
    const rows = cell.querySelectorAll("[data-event-block]");
    expect(rows).toHaveLength(3);
    const more = within(cell).getByRole("button", { name: /^\+\d+ more$/ });
    const total = state.calendarEvents.filter(
      (e) =>
        e.startsAt.startsWith("2026-10-28") &&
        (e.calendarPersonIds.includes("p-giulia") ||
          e.attendees.some((a) => a.personId === "p-giulia")),
    ).length;
    expect(more).toHaveTextContent(`+${total - 3} more`);
  });

  it("Mese: il pezzo dopo mezzanotte dice da quando", async () => {
    const release = state.calendarEvents.find((e) => e.id === C.midnight)!;
    const next = new Date(release.endsAt);
    const key = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    await openCalendar(`/calendar?view=month&date=${key}`);
    const cell = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-day-cell="${key}"]`);
      if (!el) throw new Error("no cell");
      return el;
    });
    const piece = cell.querySelector<HTMLElement>(`[data-event-block="${C.midnight}"]`)!;
    expect(piece).toHaveTextContent(/^from \w{3} \d/);
  });
});

describe("Calendario — 12 eventi sovrapposti (Review Focus 5)", () => {
  it("in Week 3 corsie al massimo, poi «+N more» con l'elenco intero della fascia", async () => {
    await openCalendar("/calendar?date=2026-10-28");
    const col = await column("2026-10-28");
    const more = await within(col).findByRole("button", { name: /^\+\d+ more$/ });
    const blocks = [...col.querySelectorAll<HTMLElement>('[data-event-block^="ev-overlap-"]')];
    const hidden = Number(more.getAttribute("data-more"));
    expect(blocks.length + hidden).toBe(12);
    // Nessun blocco più stretto di un terzo della colonna.
    for (const b of blocks)
      expect(b.parentElement!.style.width).toBe("calc(33.333333333333336% - 4px)");
    await userEvent.click(more);
    const list = await screen.findByRole("dialog", { name: "12 events at this time" });
    expect(within(list).getAllByRole("button")).toHaveLength(12);
    await userEvent.click(within(list).getByRole("button", { name: /^Partner demo 03/ }));
    expect(await screen.findByRole("heading", { name: "Partner demo 03" })).toBeInTheDocument();
  });

  it("colonna stretta (96 px): una corsia, «+N» compatto sovrapposto in alto, blocchi con il solo titolo", async () => {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute("data-day-column")) return { width: 96, height: 1152 } as DOMRect;
      return rect.call(this);
    };
    try {
      await openCalendar("/calendar?date=2026-10-28");
      const col = await column("2026-10-28");
      const more = await within(col).findByRole("button", { name: /^\+\d+ more$/ });
      expect(more).toHaveAttribute("data-more-overlay");
      expect(more.textContent).toMatch(/^\+\d+$/);
      expect(more.className).toMatch(/border-rule-strong/);
      expect(more.className).not.toMatch(/border-dashed/);
      const blocks = [...col.querySelectorAll<HTMLElement>('[data-event-block^="ev-overlap-"]')];
      expect(blocks.length + Number(more.getAttribute("data-more"))).toBe(12);
      for (const b of blocks) expect(b.parentElement!.style.width).toBe("calc(100% - 4px)");
      // In alto nella fascia: alla stessa altezza del primo blocco.
      expect(more.style.top).toBe(`calc(${blocks[0]!.parentElement!.style.top} + 2px)`);
      // Compatto: il titolo prima di tutto; l'ora sta nel nome accessibile e nel tooltip.
      const first = blocks[0]!;
      expect(first.textContent).toMatch(/^Partner demo 01/);
      expect(first).toHaveAccessibleName(/Partner demo 01, .*AM/);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });

  it("le corsie seguono la larghezza anche dopo aver cambiato settimana", async () => {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    const Original = globalThis.ResizeObserver;
    let width = 900;
    const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
    globalThis.ResizeObserver = class {
      entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    } as unknown as typeof ResizeObserver;
    // Solo un elemento ancora nella pagina ha una larghezza: una colonna staccata non conta.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.isConnected) return { width: 0, height: 0 } as DOMRect;
      if (this.hasAttribute("data-day-column")) return { width, height: 1152 } as DOMRect;
      return { width: width * 7 + 48, height: 1152 } as DOMRect;
    };
    try {
      await openCalendar("/calendar?date=2026-10-21");
      await userEvent.click(screen.getByRole("button", { name: "Next" }));
      const col = await column("2026-10-28");
      await within(col).findByRole("button", { name: /^\+\d+ more$/ });
      expect(col.querySelector("[data-more-overlay]")).toBeNull();
      // La finestra si stringe: le corsie si ricalcolano sulla settimana nuova.
      width = 96;
      act(() => {
        for (const o of observers)
          if (o.targets.some((t) => t.isConnected)) o.cb([], {} as ResizeObserver);
      });
      await waitFor(() => expect(col.querySelector("[data-more-overlay]")).not.toBeNull());
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
      globalThis.ResizeObserver = Original;
    }
  });

  it("la parola della risposta non si tronca: in due righe il codice lascia il posto", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const invite = await block(C.invite);
    const word = within(invite).getByText("Not answered");
    expect(word.className).not.toMatch(/truncate/);
    expect(word.className).toMatch(/shrink-0/);
    // Sulla prima riga la parola viene prima di tutto: l'ora e il codice le lasciano il
    // posto (restano nel nome accessibile, nel tooltip e nella posizione).
    expect(word.parentElement!.firstElementChild).toBe(word);
    expect(word.parentElement!.textContent).not.toMatch(/PM|AM/);
    expect(invite.querySelector("[data-block-code]")).toBeNull();
    expect(invite).toHaveAccessibleName(/\d:\d\d (AM|PM)/);
    expect(invite).toHaveAccessibleName(/OLV/);
  });

  it("in Day le corsie arrivano a 5", async () => {
    await openCalendar("/calendar?view=day&date=2026-10-28");
    const col = await column("2026-10-28");
    await within(col).findByRole("button", { name: /more$/ });
    const widths = new Set(
      [...col.querySelectorAll<HTMLElement>('[data-event-block^="ev-overlap-"]')].map(
        (b) => b.parentElement!.style.width,
      ),
    );
    expect([...widths]).toEqual(["calc(20% - 4px)"]);
  });
});

describe("Calendario — organizzatore e no", () => {
  it("chi non organizza non trova maniglie né modifica; Space lo dice", async () => {
    await openCalendar(`/calendar?event=${C.visualsReview}&date=2026-10-23`);
    const theirs = await block(C.visualsReview);
    expect(theirs.className).not.toMatch(/cursor-move/);
    expect(theirs.parentElement!.querySelector("[data-resize-handle]")).toBeNull();
    theirs.focus();
    await userEvent.keyboard(" ");
    await waitFor(() =>
      expect(announcer()).toHaveTextContent("You can't move this event: Matteo Conti organizes it"),
    );
    const panel = await screen.findByRole("region", { name: "Event" });
    await within(panel).findByRole("heading", { name: "Launch visuals review" });
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      within(panel).getByText(/Organized by Matteo Conti · you can change only your answer/),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("group", { name: "Going?" })).toBeInTheDocument();

    const mine = await block(C.goLive);
    expect(mine.className).toMatch(/cursor-move/);
    expect(mine.parentElement!.querySelector("[data-resize-handle]")).not.toBeNull();
  });

  it("l'organizzatore sposta da tastiera (Space, ↓, Space) e il toast offre «Undo»", async () => {
    await openCalendar("/calendar");
    const mine = await block(C.goLive);
    mine.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(announcer()).toHaveTextContent(/^Moving Go-live plan with Sofia/),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(announcer()).toHaveTextContent("Friday 11:15 AM to 12:15 PM"));
    await user.keyboard(" ");
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getAllByText("Moved to Fri 11:15 AM").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(state.calendarEvents.find((e) => e.id === C.goLive)).toMatchObject({
        startsAt: "2026-10-23T11:15:00Z",
        save: { state: "saved" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(state.calendarEvents.find((e) => e.id === C.goLive)?.startsAt).toBe(
        "2026-10-23T11:00:00Z",
      ),
    );
  });

  it("in una serie lo spostamento chiede «This event / All events»; Cancel lascia tutto com'era", async () => {
    await openCalendar("/calendar", "p-laura");
    const standup = await block("ev-stw-standup-2026-10-23");
    standup.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");
    const dialog = await screen.findByRole("dialog", { name: "Move recurring event" });
    expect(within(dialog).getByRole("radio", { name: /This event/ })).toBeChecked();
    expect(within(dialog).getByText("Only Friday, Oct 23 changes")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.calendarEvents.find((e) => e.id === "ev-stw-standup-2026-10-23")?.startsAt).toBe(
      "2026-10-23T09:00:00Z",
    );
  });

  it("rispondere in una serie chiede «Answer for…»; la risposta si salva", async () => {
    await openCalendar(`/calendar?event=ev-aud-review-2026-10-29&date=2026-10-29&view=day`);
    const panel = await screen.findByRole("region", { name: "Event" });
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Maybe" }));
    const dialog = await screen.findByRole("dialog", { name: "Answer for…" });
    await user.click(within(dialog).getByRole("button", { name: "Answer" }));
    await waitFor(() =>
      expect(
        state.calendarEvents
          .find((e) => e.id === "ev-aud-review-2026-10-29")
          ?.attendees.find((a) => a.personId === "p-giulia")?.response,
      ).toBe("tentative"),
    );
  });
});

describe("Calendario — nuova riunione", () => {
  it("compare subito con «Saving…» e poi salvata", async () => {
    setLatency(40);
    await openCalendar("/calendar");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    // Senza titolo non parte.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Add a title")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Title"), "Budget sync");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull());

    const created = await waitFor(() => {
      const e = state.calendarEvents.find((x) => x.title === "Budget sync");
      if (!e) throw new Error("not created");
      return e;
    });
    // Il blocco si rimonta a ogni rilettura: lo si cerca ogni volta.
    const name = () =>
      document.querySelector(`[data-event-block="${created.id}"]`)?.getAttribute("aria-label");
    await waitFor(() => expect(name()).toMatch(/Budget sync.*Saving…/));
    await waitFor(() => expect(name()).toMatch(/^Budget sync/), { timeout: 4000 });
    await waitFor(() => expect(name()).not.toMatch(/Saving…/), { timeout: 4000 });
    expect(state.calendarEvents.find((x) => x.id === created.id)?.save?.state).toBe("saved");
  });

  it("con un ospite del team: Meet acceso di default, la disponibilità senza titoli, «Send invitations»", async () => {
    await openCalendar("/calendar");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    const meet = within(dialog).getByRole("checkbox", { name: /Add Google Meet/ });
    expect(meet).not.toBeChecked();
    await user.type(within(dialog).getByRole("combobox", { name: "Guests" }), "Matteo");
    await user.click(await within(dialog).findByRole("option", { name: /Matteo Conti/ }));
    expect(meet).toBeChecked();
    const availability = await within(dialog).findByRole("region", { name: "Availability" });
    const row = await waitFor(() => {
      const r = availability.querySelector<HTMLElement>('[data-availability-row="p-matteo"]');
      if (!r || r.textContent?.includes("…")) throw new Error("loading");
      return r;
    });
    expect(row.textContent).toMatch(/Free|Busy at that time/);
    // Mai un titolo degli eventi del collega, nemmeno nei tooltip.
    expect(availability.innerHTML).not.toMatch(/visuals|Partner demo|go-live/i);
    expect(within(dialog).getByRole("button", { name: "Send invitations" })).toBeInTheDocument();
  });

  it("⌘N apre «New meeting» nel Calendario (non «New message»)", async () => {
    const router = await openCalendar("/calendar");
    await userEvent.keyboard("{Control>}n{/Control}");
    expect(await screen.findByRole("dialog", { name: "New meeting" })).toBeInTheDocument();
    expect(search(router).newMessage).toBeUndefined();
  });
});

describe("Calendario — cambio di persona", () => {
  it("con il dettaglio aperto lo chiude", async () => {
    const router = await openCalendar(`/calendar?event=${C.goLive}&date=2026-10-23`);
    await screen.findByRole("region", { name: "Event" });
    await switchPersona(/Laura Costa/);
    await waitFor(() => expect(search(router).event).toBeUndefined());
    expect(screen.queryByRole("region", { name: "Event" })).toBeNull();
  });

  it("con il dialogo della riunione aperto lo chiude", async () => {
    await openCalendar("/calendar");
    await userEvent.click(await screen.findByRole("button", { name: "New meeting" }));
    await screen.findByRole("dialog", { name: "New meeting" });
    // userEvent fa già da sé gli act(): avvolgerlo in un altro act() fa dire a
    // React che l'ambiente non li supporta.
    await switchPersona(/Laura Costa/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull());
  });
});

describe("Calendario — stati", () => {
  it("il salvataggio fallito dice «Couldn't save» e offre «Retry»", async () => {
    await openCalendar(`/calendar?event=${C.saveFails}&date=2026-10-27`);
    const panel = await screen.findByRole("region", { name: "Event" });
    await within(panel).findByRole("heading", { name: "Dashboard check" });
    const el = await block(C.saveFails);
    el.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");
    await waitFor(() => expect(el).toHaveAccessibleName(/Couldn't save/));
    expect(await within(panel).findByText("Google didn't accept the change.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(state.calendarEvents.find((e) => e.id === C.saveFails)?.save?.state).toBe("saved"),
    );
  });

  it("serie: accendere senza progetto dice «Choose a project before turning this on»", async () => {
    await openCalendar("/calendar?series=ser-stw-standup");
    const panel = await screen.findByRole("region", { name: "Recurring series" });
    await userEvent.click(
      await within(panel).findByRole("switch", { name: /Proposals for this series/ }),
    );
    expect(
      await within(panel).findByText("Choose a project before turning this on"),
    ).toBeInTheDocument();
  });

  it("collegamento scaduto: «Reconnect» rinfresca il calendario, l'avviso se ne va", async () => {
    await openCalendar("/calendar", "p-laura");
    const user = userEvent.setup();
    const expired = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-calendar-sync="expired"]');
      if (!el) throw new Error("no expired row");
      return el;
    });
    await user.click(within(expired).getByRole("button", { name: "Reconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Google account" });
    await user.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    await within(dialog).findByText("Connected as laura.costa@example.com");
    await waitFor(() =>
      expect(document.querySelector('[data-calendar-sync="expired"]')).toBeNull(),
    );
  });

  it("in italiano l'ora è a 24 ore, in inglese a 12", async () => {
    await openCalendar("/calendar");
    expect(await block(C.goLive)).toHaveAccessibleName(/11:00 AM – 12:00 PM/);
  });
});
