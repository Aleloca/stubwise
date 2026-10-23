import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const block = () => screen.findByRole("region", { name: "My week" });

describe("MyWeekBlock", () => {
  it("la settimana corrente in breve: conteggi per giorno, oggi, carico", async () => {
    renderRoute("/home", "p-marco");
    const week = await block();
    const counts = await within(week).findByRole("list", { name: "Tasks per day" });
    const items = within(counts)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // «This week» (senza giorno) per prima; i giorni vuoti col trattino; oggi a parole.
    expect(items).toEqual(["This week—", "Mon1", "Tue—", "Wed—", "Thu—", "Today1"]);
    // Oggi (venerdì): la task sistemata oggi, come riga.
    expect(within(week).getByRole("button", { name: /^STW-13 / })).toBeInTheDocument();
    expect(within(week).getByText(/W43/)).toBeInTheDocument();
    expect(within(week).getByRole("img", { name: /^My load: / })).toBeInTheDocument();
  });

  it("«+N no estimate» anche nel blocco", async () => {
    state.tasks.find((t) => t.code === "AUD-3")!.size = null;
    state.tasks.find((t) => t.code === "STW-13")!.size = null;
    renderRoute("/home", "p-marco");
    const week = await block();
    expect(await within(week).findByText("+2 no estimate")).toBeInTheDocument();
  });

  it("«Open my week» apre la pagina intera", async () => {
    const router = renderRoute("/home", "p-marco");
    const week = await block();
    await userEvent.click(await within(week).findByRole("link", { name: "Open my week" }));
    expect(await screen.findByRole("heading", { level: 1, name: "My week" })).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ view: "week" });
  });

  it("niente in settimana: la frase al posto dei conteggi", async () => {
    for (const t of state.tasks) if (t.assigneeId === "p-marco") t.plannedWeek = null;
    renderRoute("/home", "p-marco");
    const week = await block();
    expect(await within(week).findByText("Nothing planned for you this week")).toBeInTheDocument();
  });

  it("errore dentro il blocco, con «Retry»", async () => {
    failNext("listDayArrangements");
    renderRoute("/home", "p-marco");
    const week = await block();
    await userEvent.click(await within(week).findByRole("button", { name: "Retry" }));
    expect(await within(week).findByRole("list", { name: "Tasks per day" })).toBeInTheDocument();
  });
});
