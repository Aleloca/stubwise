import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
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
});
