import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { grantInstancePermission, resetViewerGrants } from "../../data/viewer";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;

/** La rassegna aperta da un indirizzo, a nome di quella persona. */
async function review(personId: string, query = "") {
  const router = renderRoute(`/projects?view=person${query}`, personId);
  await screen.findByRole("list", { name: /^Development/ });
  return router;
}

const personRows = () =>
  [...document.querySelectorAll("[data-person-row]")].map((r) => r.getAttribute("data-person-row"));

const row = (personId: string) =>
  document.querySelector<HTMLElement>(`[data-person-row="${personId}"]`)!;

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("Activity → By person", () => {
  it("senza il permesso «By person» non c'è, e un link diretto lo dice", async () => {
    renderRoute("/projects", "p-sara");
    await screen.findByRole("list", { name: "All projects" });
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await waitFor(() => expect(document.querySelector("[data-activity-day]")).not.toBeNull());
    expect(screen.queryByRole("radio", { name: "By person" })).toBeNull();

    document.body.innerHTML = "";
    renderRoute("/projects?view=person", "p-sara");
    expect(
      await screen.findByRole("heading", { name: "You can't see people's activity" }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-person-row]")).toBeNull();
  });

  it("dalla scheda Activity si passa a By person; una riga di sintesi per persona", async () => {
    const router = renderRoute("/projects", "p-giulia");
    await screen.findByRole("list", { name: "All projects" });
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await userEvent.click(await screen.findByRole("radio", { name: "By person" }));
    await waitFor(() => expect(search(router).view).toBe("person"));
    await screen.findByRole("list", { name: /^Development/ });
    const simone = row("p-simone");
    expect(simone).toHaveTextContent("Simone Rossetti");
    expect(simone).toHaveTextContent("2 commits");
    // Nessun conteggio a zero nella sintesi.
    expect(simone).not.toHaveTextContent(/\b0 /);
    // Claude non è una persona della rassegna.
    expect(personRows()).not.toContain("p-claude");
  });

  it("[ e ] cambiano giorno, nell'indirizzo; niente futuro", async () => {
    const router = await review("p-roberta");
    expect(personRows()).not.toContain("p-laura"); // il suo commit è di ieri
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
    await userEvent.keyboard("[[");
    await waitFor(() => expect(search(router).date).toBe("2026-10-22"));
    await waitFor(() => expect(personRows()).toContain("p-laura"));
    expect(screen.getByRole("button", { name: /Yesterday/ })).toBeInTheDocument();
    await userEvent.keyboard("]");
    await waitFor(() => expect(search(router).date).toBeUndefined());
    await waitFor(() => expect(personRows()).not.toContain("p-laura"));
  });

  it("un giorno dal link oltre oggi torna a oggi", async () => {
    await review("p-roberta", "&date=2026-11-30");
    expect(screen.getByRole("button", { name: /Today/ })).toBeInTheDocument();
  });

  it("solo i progetti che chi guarda vede, anche nei conteggi", async () => {
    grantInstancePermission("p-sara", "people.activity.view");
    await review("p-sara"); // Sara non vede AUD
    expect(personRows()).not.toContain("p-stefano"); // solo commit su AUD
    expect(screen.queryByRole("list", { name: /Commits from unlinked authors/ })).toBeNull();
    document.body.innerHTML = "";
    await review("p-roberta");
    expect(personRows()).toContain("p-stefano");
    expect(screen.getByRole("list", { name: /Commits from unlinked authors/ })).toBeInTheDocument();
  });

  it("aperta, una persona mostra i commit col messaggio e sotto il testo generato etichettato", async () => {
    await review("p-giulia");
    await userEvent.click(within(row("p-simone")).getByRole("button", { name: /Simone Rossetti/ }));
    const commit = await waitFor(() => {
      const el = row("p-simone").querySelector<HTMLElement>("[data-commit]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(commit).toHaveTextContent("feat(board): move cards between columns with the keyboard");
    expect(within(commit).getByText("Generated text")).toBeInTheDocument();
    expect(commit).toHaveTextContent(/Cards on the board can now be moved/);
    // Il messaggio originale viene prima del testo generato.
    const text = commit.textContent!;
    expect(text.indexOf("feat(board)")).toBeLessThan(text.indexOf("Generated text"));
  });

  it("il filtro reparto sta nell'indirizzo e lascia solo quel reparto", async () => {
    const router = await review("p-roberta");
    await userEvent.click(screen.getByRole("button", { name: /Department/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Development" }));
    await waitFor(() => expect(search(router).dept).toBe("dep-development"));
    await waitFor(() => expect(screen.queryByRole("list", { name: /^Administration/ })).toBeNull());
    expect(screen.getByRole("list", { name: /^Development/ })).toBeInTheDocument();
  });

  it("«Generate report» con settings.manage; chi non l'ha vede solo lo stato", async () => {
    await review("p-roberta");
    const stefano = row("p-stefano"); // AUD, oggi: report non generato
    expect(stefano).toHaveTextContent("Daily report: not generated");
    await userEvent.click(within(stefano).getByRole("button", { name: "Generate report" }));
    await waitFor(() => expect(row("p-stefano")).toHaveTextContent("Daily report: ready"));

    document.body.innerHTML = "";
    resetApi();
    await review("p-laura"); // project lead, senza settings.manage
    expect(row("p-simone")).toHaveTextContent(/Daily report/);
    expect(screen.queryByRole("button", { name: "Generate report" })).toBeNull();
  });

  it("«Link a person» con users.manage: i commit passano sotto la persona", async () => {
    await review("p-roberta");
    const unlinked = screen.getByRole("list", { name: /Commits from unlinked authors/ });
    expect(unlinked).toHaveTextContent("kevin.ortega");
    await userEvent.click(within(unlinked).getByRole("button", { name: /Link a person/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Stefano Amato/ }));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: /Commits from unlinked authors/ })).toBeNull(),
    );
    await waitFor(() => expect(row("p-stefano")).toHaveTextContent("2 commits"));

    document.body.innerHTML = "";
    resetApi();
    await review("p-laura");
    expect(screen.queryByRole("button", { name: /Link a person/ })).toBeNull();
  });

  it("report scritto prima degli ultimi commit: «N new commits not included», e «Regenerate»", async () => {
    await review("p-roberta");
    // Il report di oggi di STW è delle 10:00: dopo sono arrivati due commit.
    const simone = row("p-simone");
    expect(simone).toHaveTextContent("Daily report: ready");
    expect(simone.querySelector("[data-report-stale]")).toHaveTextContent(
      "2 new commits not included",
    );
    // AUD non ha ancora il report: nessun avviso.
    expect(row("p-stefano").querySelector("[data-report-stale]")).toBeNull();
    await userEvent.click(within(simone).getByRole("button", { name: "Regenerate the daily report of STW" }));
    await waitFor(() => expect(row("p-simone").querySelector("[data-report-stale]")).toBeNull());
    expect(row("p-simone")).toHaveTextContent("Daily report: ready");

    document.body.innerHTML = "";
    resetApi();
    await review("p-laura"); // senza settings.manage: l'avviso sì, «Regenerate» no
    expect(row("p-simone").querySelector("[data-report-stale]")).not.toBeNull();
    expect(within(row("p-simone")).queryByRole("button", { name: /^Regenerate/ })).toBeNull();
  });

  it("chi ha commit su più progetti: l'avviso dice di quale report, uno per progetto", async () => {
    // Ieri Marco ha commit su STW e su AUD; il report di AUD è stato scritto alle 11:00.
    const yesterday = state.dailyReports.find((r) => r.id === "rep-aud-1")!;
    yesterday.generatedAt = `${yesterday.date}T11:00:00Z`;
    await review("p-roberta", `&date=${yesterday.date}`);
    const marco = row("p-marco");
    const stale = [...marco.querySelectorAll("[data-report-stale]")];
    expect(stale.map((s) => s.getAttribute("data-report-stale"))).toEqual(["AUD"]);
    expect(stale[0]).toHaveTextContent("AUD 3 new commits not included");
    expect(
      within(marco).getByRole("button", { name: "Regenerate the daily report of AUD" }),
    ).toBeInTheDocument();
  });

  it("la ricerca per nome lascia solo chi corrisponde; senza nessuno «Clear filters»", async () => {
    await review("p-roberta");
    const box = screen.getByRole("searchbox", { name: "Find a person" });
    await userEvent.type(box, "simo");
    await waitFor(() => expect(personRows()).toEqual(["p-simone"]));
    await userEvent.clear(box);
    await userEvent.type(box, "nobody at all");
    expect(await screen.findByRole("heading", { name: "Nobody matches" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(personRows().length).toBeGreaterThan(1));
    expect(box).toHaveValue("");
  });

  it("un giorno senza attività lo dice, e porta al giorno prima", async () => {
    const router = renderRoute("/projects?view=person&date=2026-09-06", "p-roberta");
    expect(
      await screen.findByRole("heading", { name: /^Nothing happened on / }),
    ).toBeInTheDocument();
    // Quello del vuoto, con la parola (nella barra c'è la freccia con lo stesso nome).
    const previous = screen
      .getAllByRole("button", { name: "Previous day" })
      .find((b) => b.textContent === "Previous day")!;
    await userEvent.click(previous);
    await waitFor(() => expect(search(router).date).toBe("2026-09-05"));
  });

  it("errore di caricamento: lo dice, e «Retry» ricarica", async () => {
    failNext("listPeopleActivity");
    renderRoute("/projects?view=person", "p-roberta");
    expect(await screen.findByText("Couldn't load the review.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: /^Development/ })).toBeInTheDocument();
  });
});
