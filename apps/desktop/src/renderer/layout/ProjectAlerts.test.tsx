import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { alerts, failNext, resetApi, setLatency } from "../data/api";
import { setSessionPersonId } from "../data/session";
import { grantProjectRole } from "../data/viewer";
import { renderRoute } from "../test/renderRoute";

// Il popover «Alerts» nella testata del progetto (Task 7, shape alerts.md):
// le stesse righe della pagina, sulla stessa query.

const LAURA = "p-laura";
const SARA = "p-sara";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});

const bell = () => screen.findByRole("button", { name: "Alerts for AUD" });

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await bell());
  return screen.findByRole("dialog", { name: "Alerts in AUD" });
}

describe("popover «Alerts»", () => {
  it("si apre dalla campanella con le righe compatte; Esc chiude e il fuoco torna alla campanella", async () => {
    renderRoute("/p/AUD/overview", LAURA);
    const user = userEvent.setup();
    expect(await bell()).toHaveAttribute(
      "title",
      expect.stringMatching(/^Alerts for AUD · \d+ on/),
    );
    const pop = await openPopover(user);
    expect(within(pop).getByRole("heading", { name: "Pull requests" })).toBeVisible();
    expect(within(pop).getByRole("switch", { name: "Release failed in AUD, App" })).toBeVisible();
    // Il «quando» nel nome accessibile, non a schermo.
    expect(
      within(pop).getByRole("switch", { name: "Release failed in AUD, App" }),
    ).toHaveAccessibleDescription(/When a release of AUD fails after the merge/);
    expect(
      within(pop).getByText("Prototype: phone alerts are saved, but nothing is sent."),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Alerts in AUD" })).toBeNull());
    expect(await bell()).toHaveFocus();
  });

  it("coerente con la pagina: un cambio nel popover si vede nella pagina, e viceversa", async () => {
    const router = renderRoute("/p/AUD/overview", LAURA);
    const user = userEvent.setup();
    let pop = await openPopover(user);
    const app = within(pop).getByRole("switch", { name: "New PR in AUD, App" });
    expect(app).toHaveAttribute("aria-checked", "false");
    await user.click(app);
    expect(app).toHaveAttribute("aria-checked", "true");
    // «All notification settings» porta alla pagina con AUD aperto.
    await user.click(within(pop).getByRole("link", { name: "All notification settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/preferences/notifications"));
    expect(router.state.location.search).toMatchObject({ project: "AUD" });
    const page = await screen.findByRole("switch", { name: "New PR in AUD, App" });
    expect(page).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(document.querySelector('[data-group-header="AUD"]')).toHaveFocus());
    // Dalla pagina al popover.
    await user.click(screen.getByRole("switch", { name: "Release failed in AUD, App" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Release failed in AUD, App" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    await router.navigate({
      to: "/p/$code/$section",
      params: { code: "AUD", section: "overview" },
    });
    pop = await openPopover(user);
    expect(within(pop).getByRole("switch", { name: "New PR in AUD, App" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(pop).getByRole("switch", { name: "Release failed in AUD, App" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("«Turn everything off» col toast e «Undo»; la campanella barrata solo senza obbligatori", async () => {
    renderRoute("/p/STW/overview", SARA);
    const user = userEvent.setup();
    const stwBell = () => screen.findByRole("button", { name: "Alerts for STW" });
    expect(await stwBell()).not.toHaveAttribute("data-alerts-off");
    await user.click(await stwBell());
    const pop = await screen.findByRole("dialog", { name: "Alerts in STW" });
    await user.click(within(pop).getByRole("button", { name: "Turn everything off" }));
    expect(
      await screen.findByText(
        "Everything off in STW. Alerts you already got stay; you'll still get the ones meant only for you.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        within(pop)
          .getAllByRole("switch")
          .every((s) => s.getAttribute("aria-checked") === "false"),
      ).toBe(true),
    );
    // Tutte le iscrizioni spente: la campanella è barrata (R-K16).
    expect(await stwBell()).toHaveAttribute("data-alerts-off", "true");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect(await stwBell()).not.toHaveAttribute("data-alerts-off"));
  });

  it("R-K16: barrata con tutte le iscrizioni spente anche se qualche avviso arriva comunque, e lo dice", async () => {
    renderRoute("/p/AUD/overview", LAURA);
    const user = userEvent.setup();
    const still = "Some alerts still reach you, like a failed release you merged.";
    const pop = await openPopover(user);
    expect(within(pop).queryByText(still)).toBeNull();
    await user.click(within(pop).getByRole("button", { name: "Turn everything off" }));
    await waitFor(() =>
      expect(within(pop).getByText(/^Everything off · 1 always on/)).toBeVisible(),
    );
    expect(await bell()).toHaveAttribute("data-alerts-off", "true");
    expect(await bell()).toHaveAttribute("title", expect.stringContaining(still));
    expect(within(pop).getByText(still)).toBeVisible();
  });

  it("errore nel popover: una riga con «Retry», il resto della colonna intatto", async () => {
    renderRoute("/p/AUD/overview", LAURA);
    const user = userEvent.setup();
    const pop = await openPopover(user);
    // La rilettura dopo una scrittura fallisce.
    failNext("alerts.subscriptionRows");
    await user.click(within(pop).getByRole("switch", { name: "New PR in AUD, App" }));
    expect(await within(pop).findByText("Couldn't load alerts.")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Project sections" })).toBeVisible();
    await user.click(within(pop).getByRole("button", { name: "Retry" }));
    expect(await within(pop).findByRole("switch", { name: "New PR in AUD, App" })).toBeVisible();
  });

  it("permesso perso con il popover aperto: la riga diventa sospesa sul posto", async () => {
    // Un'iscrizione esplicita (spenta e riaccesa): quella di partenza seguirebbe i permessi di adesso.
    setSessionPersonId(LAURA);
    await alerts.setSubscription("prj-aud", "pr.analysis_issues", { app: false });
    await alerts.setSubscription("prj-aud", "pr.analysis_issues", { app: true });
    renderRoute("/p/AUD/overview", LAURA);
    const user = userEvent.setup();
    const pop = await openPopover(user);
    const row = () => pop.querySelector<HTMLElement>('[data-alert-row="pr.analysis_issues"]')!;
    expect(within(row()).getAllByRole("switch")).toHaveLength(2);
    grantProjectRole(LAURA, "prj-aud", "contributor");
    // Una scrittura qualunque ricarica la query: la riga si rilegge sospesa, il popover resta aperto.
    await user.click(within(pop).getByRole("switch", { name: "New PR in AUD, App" }));
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "suspended"));
    expect(row()).toHaveTextContent("Paused");
    expect(within(row()).queryByRole("switch")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Alerts in AUD" })).toBeVisible();
  });
});
