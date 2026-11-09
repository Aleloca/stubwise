import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSettings, resetApi, setLatency } from "../data/api";
import { setSessionPersonId } from "../data/session";
import { resetViewerGrants } from "../data/viewer";
import { renderRoute } from "../test/renderRoute";

// Review Focus 1 nelle pagine (area 9c, Task 6, RF 1): con ACQ archiviato,
// il binario, ⌘K, la Home e le notifiche di Laura non lo nominano più — e
// prima di archiviarlo sì (il test sa dove guardare).

const LAURA = "p-laura";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetViewerGrants());

async function home() {
  renderRoute("/home", LAURA);
  await screen.findByRole("heading", { level: 1, name: "Home" });
  const rail = screen.getAllByRole("navigation")[0]!;
  return rail;
}

/** Il testo di ciò che ⌘K offre cercando «ACQ». */
async function paletteFor(query: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Search and commands" }));
  const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
  await user.type(within(dialog).getByRole("combobox"), query);
  await new Promise((r) => setTimeout(r, 300));
  const text = within(dialog).getByRole("listbox").textContent ?? "";
  await user.keyboard("{Escape}");
  return text;
}

async function notificationsText() {
  await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  const panel = await screen.findByRole("dialog", { name: /Notifications/ });
  await waitFor(() => expect(panel.textContent?.length ?? 0).toBeGreaterThan(20));
  const text = panel.textContent ?? "";
  await userEvent.keyboard("{Escape}");
  return text;
}

describe("un progetto archiviato non riappare nelle pagine (RF 1)", () => {
  it("binario, ⌘K, Home e notifiche di Laura: ACQ c'è, poi archiviato non c'è più", async () => {
    let rail = await home();
    await waitFor(() => expect(rail).toHaveTextContent(/ACQ/));
    expect((await paletteFor("ACQ")).replaceAll("“ACQ”", "")).toMatch(/ACQ/);
    cleanup();

    setSessionPersonId(LAURA);
    expect(await projectSettings.archiveProject("prj-acq")).toEqual({ ok: true });
    rail = await home();
    await new Promise((r) => setTimeout(r, 300));
    expect(rail).not.toHaveTextContent(/ACQ/);
    expect(screen.getByRole("main")).not.toHaveTextContent(/\bACQ\b/);
    // Le righe «Search all … for “ACQ”» ripetono solo ciò che si è scritto.
    expect((await paletteFor("ACQ")).replaceAll("“ACQ”", "")).not.toMatch(/ACQ/);
    expect(await notificationsText()).not.toMatch(/\bACQ\b/);
  });
});
