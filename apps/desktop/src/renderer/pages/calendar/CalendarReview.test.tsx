import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendar, failNext, resetApi, setLatency } from "../../data/api";
import { CALENDAR_CASES } from "../../data/seed/calendar";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { setLanguage } from "../../i18n";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";

// I rilievi della revisione del Task 9 (fix round 1): apertura dall'interno
// che non salta in Day, spostamento da tastiera dell'evento giusto, clic dopo
// un trascinamento, barra di più giorni presa oltre il primo, «All day» in
// modifica, bordo della finestra detto a vista, e i minori (Esc durante un
// trascinamento, fuoco del popover, mese, 24 ore in italiano).

const C = CALENDAR_CASES;
const REVIEW_29 = "ev-aud-review-2026-10-29";
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, string | undefined>;
const ev = (id: string) => state.calendarEvents.find((e) => e.id === id)!;
const block = (id: string) =>
  waitFor(() => {
    const b = document.querySelector<HTMLElement>(`[data-event-block="${id}"]`);
    if (!b) throw new Error(`no block ${id}`);
    return b;
  });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

async function openCalendar(url: string, personId = "p-giulia") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: /^(Calendar|Calendario)$/ });
  return router;
}

/** happy-dom non ha geometria: le colonne dei giorni larghe 100 px, una accanto all'altra. */
function layOutColumns() {
  document.querySelectorAll<HTMLElement>("[data-day-column]").forEach((col, i) => {
    col.getBoundingClientRect = () =>
      ({
        left: i * 100,
        right: (i + 1) * 100,
        top: 0,
        bottom: 1152,
        width: 100,
        height: 1152,
        x: i * 100,
        y: 0,
      }) as DOMRect;
  });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia("(min-width: 1200px)", true);
});
afterEach(() => {
  clearToasts();
  act(() => setLanguage("en"));
  setSessionPersonId("p-giulia");
});

describe("rilievi importanti", () => {
  it("aprire un blocco nella vista di default resta in Week (il salto in Day è solo per chi arriva da fuori)", async () => {
    const router = await openCalendar("/calendar");
    await userEvent.click(await block(C.goLive));
    await screen.findByRole("region", { name: "Event" });
    await wait(100);
    expect(search(router).event).toBe(C.goLive);
    expect(search(router).view).toBeUndefined();
    expect(search(router).date).toBeUndefined();
    expect(document.querySelector("[data-calendar-grid]")).toHaveAttribute(
      "data-calendar-grid",
      "week",
    );
  });

  it("da tastiera: preso A, il fuoco su B annulla; Space su B non sposta A", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const a = await block(C.goLive);
    const b = await block(C.lunch);
    const beforeA = ev(C.goLive).startsAt;
    const beforeB = ev(C.lunch).startsAt;
    a.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    act(() => b.focus());
    await user.keyboard(" ");
    await wait(100);
    expect(ev(C.goLive).startsAt).toBe(beforeA);
    expect(ev(C.lunch).startsAt).toBe(beforeB);
    // Esc da qualunque blocco lascia la presa.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector("[data-moving]")).toBeNull());
  });

  it("da tastiera: Space arrivato a un altro blocco lascia l'evento PRESO, non quello del tasto", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const a = await block(C.goLive);
    const b = await block(C.lunch);
    const beforeB = ev(C.lunch).startsAt;
    a.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    // Senza passare dal fuoco (un tasto che arriva a B mentre A è preso).
    fireEvent.keyDown(b, { key: " " });
    await waitFor(() => expect(ev(C.goLive).startsAt).toBe("2026-10-23T11:15:00Z"));
    expect(ev(C.lunch).startsAt).toBe(beforeB);
  });

  it("dopo un ridimensionamento il clic successivo su un altro blocco apre", async () => {
    const router = await openCalendar("/calendar?date=2026-10-23");
    const mine = await block(C.goLive);
    const handle = mine.parentElement!.querySelector<HTMLElement>("[data-resize-handle]")!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 148 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 148 });
    fireEvent.click(handle);
    await wait(50);
    await waitFor(() => expect(ev(C.goLive).endsAt).toBe("2026-10-23T13:00:00Z"));
    fireEvent.click(await block(C.visualsReview));
    await waitFor(() => expect(search(router).event).toBe(C.visualsReview));
  });

  it("dopo un trascinamento fra colonne il clic successivo apre", async () => {
    const router = await openCalendar("/calendar?date=2026-10-23");
    layOutColumns();
    const mine = await block(C.goLive);
    // Venerdì è la colonna 4 (x 400–500): si porta a sabato.
    fireEvent.pointerDown(mine, { button: 0, pointerId: 2, clientX: 450, clientY: 100 });
    fireEvent.pointerMove(mine, { pointerId: 2, clientX: 550, clientY: 100 });
    // Il blocco si è rimontato nella colonna di sabato: il rilascio arriva alla finestra, il clic al blocco nuovo.
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 550, clientY: 100 });
    fireEvent.click(await block(C.goLive));
    await waitFor(() => expect(ev(C.goLive).startsAt).toBe("2026-10-24T11:00:00Z"));
    expect(search(router).event).toBeUndefined();
    await wait(50);
    fireEvent.click(await block(C.lunch));
    await waitFor(() => expect(search(router).event).toBe(C.lunch));
  });

  it("una barra di più giorni presa oltre il primo giorno si sposta di quanto si trascina", async () => {
    const created = await calendar.createEvent({
      title: "Trade fair",
      startsAt: "2026-10-20T00:00:00Z",
      endsAt: "2026-10-23T00:00:00Z",
      allDay: true,
    });
    await calendar.whenCalendarIdle();
    await openCalendar("/calendar?date=2026-10-23");
    layOutColumns();
    const bar = await block(created.id);
    // Presa su mercoledì 21 (colonna 2), portata a giovedì 22: un giorno.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 3, clientX: 250, clientY: 10 });
    fireEvent.pointerMove(bar, { pointerId: 3, clientX: 350, clientY: 10 });
    fireEvent.pointerUp(bar, { pointerId: 3, clientX: 350, clientY: 10 });
    await waitFor(() => expect(ev(created.id).startsAt).toBe("2026-10-21T00:00:00Z"));
    expect(ev(created.id).endsAt).toBe("2026-10-24T00:00:00Z");
  });

  it("«All day» in modifica si salva, in un verso e nell'altro", async () => {
    await openCalendar(`/calendar?event=${C.goLive}&date=2026-10-23`);
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", { name: "Event" });
    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit meeting" });
    await user.click(within(dialog).getByRole("checkbox", { name: "All day" }));
    await user.click(within(dialog).getByRole("button", { name: /^(Save|Send invitations)$/ }));
    await waitFor(() =>
      expect(ev(C.goLive)).toMatchObject({
        allDay: true,
        startsAt: "2026-10-23T00:00:00Z",
        endsAt: "2026-10-24T00:00:00Z",
        save: { state: "saved" },
      }),
    );

    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    dialog = await screen.findByRole("dialog", { name: "Edit meeting" });
    await user.click(within(dialog).getByRole("checkbox", { name: "All day" }));
    await user.click(within(dialog).getByRole("button", { name: /^(Save|Send invitations)$/ }));
    await waitFor(() =>
      expect(ev(C.goLive)).toMatchObject({ allDay: false, save: { state: "saved" } }),
    );
    expect(Date.parse(ev(C.goLive).endsAt) - Date.parse(ev(C.goLive).startsAt)).toBe(30 * 60_000);
  });

  it("spostare oltre il bordo della finestra lo dice in un messaggio a vista", async () => {
    const created = await calendar.createEvent({
      title: "Year-end wrap",
      startsAt: "2026-12-22T10:00:00Z",
      endsAt: "2026-12-22T11:00:00Z",
    });
    await calendar.whenCalendarIdle();
    await openCalendar("/calendar?view=day&date=2026-12-22");
    (await block(created.id)).focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowRight}");
    const text = "Stubwise can schedule up to Dec 22 · use Google Calendar for later dates";
    await waitFor(() =>
      expect(screen.getAllByText(text).some((el) => !el.closest("[data-calendar-announcer]"))).toBe(
        true,
      ),
    );
  });
});

describe("rilievi minori", () => {
  it("Esc durante un trascinamento lo annulla e il rilascio non apre il dettaglio", async () => {
    const router = await openCalendar("/calendar?date=2026-10-23");
    const mine = await block(C.goLive);
    fireEvent.pointerDown(mine, { button: 0, pointerId: 4, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(mine, { pointerId: 4, clientX: 10, clientY: 160 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(mine, { pointerId: 4, clientX: 10, clientY: 160 });
    fireEvent.click(mine);
    await wait(50);
    expect(search(router).event).toBeUndefined();
    expect(ev(C.goLive).startsAt).toBe("2026-10-23T11:00:00Z");
  });

  it("pointercancel annulla il gesto come Esc: niente spostamento, niente riunione nuova", async () => {
    const router = await openCalendar("/calendar?date=2026-10-23");
    const mine = await block(C.goLive);
    fireEvent.pointerDown(mine, { button: 0, pointerId: 6, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(mine, { pointerId: 6, clientX: 10, clientY: 160 });
    fireEvent(window, new PointerEvent("pointercancel", { pointerId: 6 }));
    fireEvent.click(mine);
    await wait(50);
    expect(search(router).event).toBeUndefined();
    expect(ev(C.goLive).startsAt).toBe("2026-10-23T11:00:00Z");
    expect(document.querySelector("[data-moving]")).toBeNull();

    const col = document.querySelector<HTMLElement>('[data-day-column="2026-10-21"]')!;
    fireEvent.pointerDown(col, { button: 0, pointerId: 7, clientX: 10, clientY: 500 });
    fireEvent.pointerMove(col, { pointerId: 7, clientX: 10, clientY: 600 });
    fireEvent(window, new PointerEvent("pointercancel", { pointerId: 7 }));
    await wait(50);
    expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull();
  });

  it("Esc annulla anche il disegno di una riunione nuova", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const col = document.querySelector<HTMLElement>('[data-day-column="2026-10-21"]')!;
    fireEvent.pointerDown(col, { button: 0, pointerId: 5, clientX: 10, clientY: 500 });
    fireEvent.pointerMove(col, { pointerId: 5, clientX: 10, clientY: 600 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(col, { pointerId: 5, clientX: 10, clientY: 600 });
    await wait(50);
    expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull();
  });

  it("un rilascio fuori dalla griglia chiude comunque il gesto (ascolto sulla finestra)", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const mine = await block(C.goLive);
    fireEvent.pointerDown(mine, { button: 0, pointerId: 6, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 10, clientY: 148 });
    fireEvent.pointerUp(window, { pointerId: 6, clientX: 10, clientY: 148 });
    await waitFor(() => expect(ev(C.goLive).startsAt).toBe("2026-10-23T12:00:00Z"));
    expect(document.querySelector("[data-moving]")).toBeNull();
  });

  it("il popover «+N more» intrappola Tab e rende il fuoco al suo bottone", async () => {
    await openCalendar("/calendar?date=2026-10-28");
    const more = await screen.findByRole("button", { name: /^\+\d+ more$/ });
    const user = userEvent.setup();
    await user.click(more);
    const list = await screen.findByRole("dialog", { name: "12 events at this time" });
    const rows = within(list).getAllByRole("button");
    rows.at(-1)!.focus();
    await user.tab();
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("nel mese un salvataggio fallito ha icona e parola, e «Maybe» si distingue", async () => {
    state.calendarEvents.find((e) => e.id === C.saveFails)!.save = {
      state: "failed",
      error: "rejected",
    };
    // Giovedì 29 ha tre eventi: tutti in cella. Giulia risponde «forse» alla revisione.
    state.calendarEvents
      .find((e) => e.id === REVIEW_29)!
      .attendees.find((a) => a.personId === "p-giulia")!.response = "tentative";
    await openCalendar("/calendar?view=month");
    const failed = await block(C.saveFails);
    expect(within(failed).getByText("Couldn't save")).toBeInTheDocument();
    expect(failed.querySelector("svg")).not.toBeNull();
    const maybe = await block(REVIEW_29);
    expect(maybe).toHaveTextContent("Maybe");
  });

  it("in italiano l'ora è a 24 ore", async () => {
    act(() => setLanguage("it"));
    await openCalendar("/calendar");
    expect(await block(C.goLive)).toHaveAccessibleName(/11:00 – 12:00/);
    expect((await block(C.goLive)).getAttribute("aria-label")).not.toMatch(/AM|PM/);
  });

  it("«Move to…» dal menu ⋯ del blocco sposta l'evento", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "More actions for Go-live plan with Sofia" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move Go-live plan with Sofia" });
    fireEvent.change(within(dialog).getByLabelText("Start"), { target: { value: "15:00" } });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(ev(C.goLive)).toMatchObject({
        startsAt: "2026-10-23T15:00:00Z",
        endsAt: "2026-10-23T16:00:00Z",
      }),
    );
    // Chi non organizza non ha il menu.
    expect(
      screen.queryByRole("button", { name: /^More actions for Launch visuals review/ }),
    ).toBeNull();
  });

  it("«Move to…» con la data o l'ora vuota: «Enter a valid date and time», nulla si sposta", async () => {
    await openCalendar("/calendar?date=2026-10-23");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "More actions for Go-live plan with Sofia" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move Go-live plan with Sofia" });
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "" } });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a valid date and time");
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2026-10-23" } });
    fireEvent.change(within(dialog).getByLabelText("Start"), { target: { value: "" } });
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a valid date and time");
    expect(ev(C.goLive).startsAt).toBe("2026-10-23T11:00:00Z");
  });

  it("«Couldn't save · Retry» sta sul blocco stesso", async () => {
    await openCalendar("/calendar?date=2026-10-27");
    const el = await block(C.saveFails);
    el.focus();
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");
    const retry = await screen.findByRole("button", { name: "Retry: Dashboard check" });
    await user.click(retry);
    await waitFor(() => expect(ev(C.saveFails).save?.state).toBe("saved"));
  });

  it("in modifica il primario dice cosa succede: «Send invitations» solo con ospiti nuovi", async () => {
    await openCalendar(`/calendar?event=${C.goLive}&date=2026-10-23`);
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", { name: "Event" });
    await user.click(await within(panel).findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit meeting" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    await user.type(within(dialog).getByRole("combobox", { name: "Guests" }), "Laura");
    await user.click(await within(dialog).findByRole("option", { name: /Laura Costa/ }));
    expect(within(dialog).getByRole("button", { name: "Send invitations" })).toBeInTheDocument();
  });

  describe("l'esito del salvataggio in modifica", () => {
    const announcer = () => document.querySelector("[data-calendar-announcer]")!;
    async function editGoLive() {
      await openCalendar(`/calendar?event=${C.goLive}&date=2026-10-23`);
      const user = userEvent.setup();
      const panel = await screen.findByRole("region", { name: "Event" });
      await user.click(await within(panel).findByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog", { name: "Edit meeting" });
      const title = within(dialog).getByLabelText("Title");
      await user.clear(title);
      await user.type(title, "Go-live plan v2");
      fireEvent.change(within(dialog).getByLabelText("Start"), { target: { value: "15:00" } });
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
    }

    it("lo spostamento rifiutato: «nothing was changed», nessun annuncio di salvataggio", async () => {
      failNext("calendar.moveEvent");
      await editGoLive();
      expect(
        await screen.findByText("Couldn't save the meeting: nothing was changed."),
      ).toBeInTheDocument();
      expect(announcer()).not.toHaveTextContent(/updated/);
      expect(ev(C.goLive)).toMatchObject({ title: "Go-live plan with Sofia", startsAt: "2026-10-23T11:00:00Z" });
    });

    it("rifiutato dopo lo spostamento: non dice «nothing was changed», l'orario nuovo resta", async () => {
      failNext("calendar.updateEvent");
      await editGoLive();
      expect(
        await screen.findByText("Couldn't save every change: the new time is saved."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Couldn't save the meeting: nothing was changed.")).toBeNull();
      expect(announcer()).not.toHaveTextContent(/updated/);
      expect(ev(C.goLive).startsAt).toBe("2026-10-23T15:00:00Z");
    });

    it("nuova riunione: l'annuncio arriva a creazione riuscita, anche a editor chiuso", async () => {
      setLatency(30);
      await openCalendar("/calendar?newMeeting=1&date=2026-10-23");
      const dialog = await screen.findByRole("dialog", { name: "New meeting" });
      const user = userEvent.setup();
      await user.type(within(dialog).getByLabelText("Title"), "Kickoff");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New meeting" })).toBeNull());
      expect(announcer()).not.toHaveTextContent(/created/);
      await waitFor(() => expect(announcer()).toHaveTextContent("Kickoff created"), {
        timeout: 3000,
      });
    });

    it("riuscito: l'annuncio arriva dopo l'esito", async () => {
      setLatency(30);
      await editGoLive();
      // Appena chiuso l'editor, l'esito non c'è ancora: niente annuncio.
      expect(announcer()).not.toHaveTextContent(/updated/);
      await waitFor(() => expect(announcer()).toHaveTextContent("Go-live plan v2 updated"), {
        timeout: 3000,
      });
      expect(ev(C.goLive)).toMatchObject({ title: "Go-live plan v2", startsAt: "2026-10-23T15:00:00Z" });
    });
  });

  it("«tutto il giorno» non si cambia su tutta una serie (livello dati), e l'editor lo spegne", async () => {
    setSessionPersonId("p-laura");
    await expect(
      calendar.moveEvent(
        "ev-stw-standup-2026-10-23",
        "2026-10-23T00:00:00Z",
        "2026-10-24T00:00:00Z",
        "series",
        true,
      ),
    ).rejects.toThrow("invalid: all_day_series");
    await openCalendar("/calendar?event=ev-stw-standup-2026-10-23&date=2026-10-23", "p-laura");
    const panel = await screen.findByRole("region", { name: "Event" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit meeting" });
    expect(within(dialog).getByRole("checkbox", { name: "All day" })).toBeDisabled();
  });
});
