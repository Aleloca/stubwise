import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

afterEach(() => clearToasts());

const card = (code: string) => screen.findByRole("button", { name: new RegExp(`^${code} `) });
/** La colonna (il giorno) in cui sta la carta: `0` = in settimana, senza giorno. */
const dayOf = (code: string) =>
  document.querySelector(`[data-card="${code}"]`)?.closest<HTMLElement>("[data-day]")?.dataset.day;
const taskOf = (code: string) => state.tasks.find((t) => t.code === code)!;

describe("MyWeekPage", () => {
  it("sei colonne, «This week» (senza giorno) a sinistra di lun–ven; oggi detto a parole", async () => {
    renderRoute("/home?view=week", "p-marco");
    expect(await screen.findByRole("heading", { level: 1, name: "My week" })).toBeInTheDocument();
    await card("AUD-3");
    const days = [...document.querySelectorAll<HTMLElement>("[data-day]")].map((d) => d.dataset.day);
    expect(days).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(screen.getByRole("region", { name: /^Friday, Oct 23, today/ })).toBeInTheDocument();
    // Le sistemazioni del seed: AUD-3 lunedì, STW-13 venerdì.
    expect(dayOf("AUD-3")).toBe("1");
    expect(dayOf("STW-13")).toBe("5");
  });

  it("una task spostata su mercoledì (da tastiera) resta lì dopo il ricaricamento", async () => {
    renderRoute("/home?view=week", "p-marco");
    const aud3 = await card("AUD-3");
    aud3.focus();
    fireEvent.keyDown(aud3, { key: " " });
    expect(screen.getByTestId("week-announcer")).toHaveTextContent("Picked up AUD-3, in Monday");
    fireEvent.keyDown(aud3, { key: "ArrowRight" });
    fireEvent.keyDown(aud3, { key: "ArrowRight" });
    expect(screen.getByTestId("week-announcer")).toHaveTextContent("AUD-3 is over Wednesday");
    fireEvent.keyDown(aud3, { key: " " });
    expect(screen.getByTestId("week-announcer")).toHaveTextContent("AUD-3 moved to Wednesday");
    // Ottimistico: subito su mercoledì, e il fuoco resta sulla carta.
    await waitFor(() => expect(dayOf("AUD-3")).toBe("3"));
    await waitFor(() =>
      expect(state.arrangements.find((a) => a.taskId === "t-aud-3")?.day).toBe(3),
    );
    expect(document.activeElement?.getAttribute("data-card")).toBe("AUD-3");

    cleanup();
    renderRoute("/home?view=week", "p-marco");
    await card("AUD-3");
    expect(dayOf("AUD-3")).toBe("3");
  });

  it("Esc annulla lo spostamento: la carta resta dov'era", async () => {
    renderRoute("/home?view=week", "p-marco");
    const aud3 = await card("AUD-3");
    aud3.focus();
    fireEvent.keyDown(aud3, { key: " " });
    fireEvent.keyDown(aud3, { key: "ArrowLeft" });
    fireEvent.keyDown(aud3, { key: "Escape" });
    expect(screen.getByTestId("week-announcer")).toHaveTextContent(
      "Move cancelled. AUD-3 is back in Monday",
    );
    expect(dayOf("AUD-3")).toBe("1");
    expect(state.arrangements.find((a) => a.taskId === "t-aud-3")?.day).toBe(1);
  });

  it("uno spostamento che non riesce torna indietro e un messaggio lo dice", async () => {
    renderRoute("/home?view=week", "p-marco");
    const aud3 = await card("AUD-3");
    failNext("setDay");
    aud3.focus();
    fireEvent.keyDown(aud3, { key: " " });
    fireEvent.keyDown(aud3, { key: "ArrowRight" });
    fireEvent.keyDown(aud3, { key: " " });
    expect(
      await screen.findByText("Couldn't move AUD-3. It's back where it was."),
    ).toBeInTheDocument();
    await waitFor(() => expect(dayOf("AUD-3")).toBe("1"));
  });

  it("cambiarle settimana dal dettaglio la riporta senza giorno", async () => {
    renderRoute("/home?view=week&task=AUD-3", "p-marco");
    await card("AUD-3");
    expect(dayOf("AUD-3")).toBe("1");
    await userEvent.click(await screen.findByRole("button", { name: /^Week: .*Change$/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /^W44/ }));
    await waitFor(() => expect(taskOf("AUD-3").plannedWeek).toBe("2026-W44"));
    await waitFor(() => expect(document.querySelector('[data-card="AUD-3"]')).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await card("AUD-3");
    expect(dayOf("AUD-3")).toBe("0");
  });

  it("una task slittata due volte mostra «Slipped ×2»", async () => {
    renderRoute("/home?view=week", "p-giulia");
    const frl2 = await card("FRL-2");
    expect(within(frl2).getByText("Slipped ×2")).toBeInTheDocument();
    // Chi non è slittata non ha il segno.
    expect(within(await card("STW-10")).queryByText(/Slipped/)).toBeNull();
  });

  it("con 2 task senza stima la barra dice «+2 no estimate», senza contarle zero (Review Focus 4)", async () => {
    taskOf("AUD-3").size = null;
    taskOf("STW-13").size = null;
    renderRoute("/home?view=week", "p-marco");
    await card("AUD-3");
    expect(screen.getByText("+2 no estimate")).toBeInTheDocument();
    // Nessun numero di peso a schermo: la barra dice solo una proporzione.
    expect(screen.getByRole("img", { name: /^My load: \d+% of your usual week$/ })).toBeInTheDocument();
  });

  it("la barra si confronta con la settimana solita: traccia al doppio, filetto a metà", async () => {
    // Marco ha lavoro stimato in W41 e W42: la sua settimana solita esiste.
    renderRoute("/home?view=week", "p-marco");
    await card("AUD-3");
    const bar = screen.getByRole("img", { name: /^My load: \d+% of your usual week$/ });
    expect(bar).toHaveAttribute("title", "Compared to your usual week");
    const marker = bar.querySelector<HTMLElement>("[data-load-marker]")!;
    expect(marker.style.left).toBe("50%");
    expect(marker).toHaveAttribute("title", "Your usual week");
  });

  it("senza storia (meno di due settimane passate) niente barra: le taglie e «+N no estimate»", async () => {
    // Giulia ha lavoro stimato solo in W41 fra le sei settimane prima.
    taskOf("STW-10").size = null;
    renderRoute("/home?view=week", "p-giulia");
    await card("STW-10");
    expect(screen.queryByRole("img", { name: /^My load/ })).toBeNull();
    expect(screen.getByTitle(/^Sizes this week\./)).toHaveTextContent(/^\d+ (XL|L|M|S|XS)( · \d+ (XL|L|M|S|XS))*$/);
    // STW-10 senza stima si aggiunge a quelle che già non ne avevano.
    expect(screen.getByText(/^\+\d+ no estimate$/)).toBeInTheDocument();
  });

  it("un nome di task lungo è troncato, intero nel `title` (Review Focus 5)", async () => {
    const long =
      "Coordinate the cross-department review of the onboarding checklist for every new enterprise workspace";
    taskOf("AUD-3").title = long;
    renderRoute("/home?view=week", "p-marco");
    const aud3 = await card("AUD-3");
    const title = within(aud3).getByText(long);
    expect(title).toHaveAttribute("title", long);
    expect(title.className).toMatch(/line-clamp-/);
  });

  it("«Plan next week» passa alla settimana dopo; la precedente è in sola lettura", async () => {
    renderRoute("/home?view=week", "p-marco");
    await card("AUD-3");
    expect(screen.getByText(/W43/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Plan next week" }));
    expect(await card("AUD-4")).toBeInTheDocument();
    expect(screen.getByText(/W44/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "This week" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
    const done = await card("AUD-9");
    expect(screen.getByText(/Past week/)).toBeInTheDocument();
    // In sola lettura la carta si apre ma non si prende.
    done.focus();
    fireEvent.keyDown(done, { key: " " });
    expect(screen.getByTestId("week-announcer")).toBeEmptyDOMElement();
  });

  it("vuoto con la frase, errore con «Retry»", async () => {
    failNext("listDayArrangements");
    renderRoute("/home?view=week", "p-marco");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await card("AUD-3");

    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByText("Nothing planned for you in W45")).toBeInTheDocument();
  });
});
