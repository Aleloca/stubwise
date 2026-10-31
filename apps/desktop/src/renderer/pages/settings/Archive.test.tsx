import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

// Progetto → Settings → Archive (area 9c, Task 11, shape project-archive.md
// «Archive»). Laura è Project Lead di ACQ (archivia); Sara è in ACQ senza
// `project.settings.manage` (legge e basta). Il `busy` lo dà il livello dati
// alla conferma: una sessione viva di Claude in ACQ.

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  clearToasts();
  resetReauthForTest();
  await automations.whenAutomationsIdle();
  resetApi();
  await i18n.changeLanguage("en");
});

async function open(personId: string) {
  const router = renderRoute("/p/ACQ/settings/archive", personId);
  await screen.findByRole("heading", { level: 1, name: "Archive" });
  return router;
}

const archiveButton = () => screen.getByRole("button", { name: "Archive ACQ…" });

/** Un'automazione di ACQ accesa, che aspetta un giorno: le sue esecuzioni restano aperte. */
async function openAutomationRuns(count: number) {
  setSessionPersonId(LAURA);
  const a = await automations.createAutomation({
    name: "Reminder",
    projectId: ACQ,
    flow: {
      trigger: { kind: "manual" },
      steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
      titleTemplate: "Wait",
    },
  });
  await automations.activate(a.id);
  for (let i = 0; i < count; i++) await automations.startManual(a.id);
  await automations.whenAutomationsIdle();
}

describe("Archive: la sezione", () => {
  it("dice cosa succede, e dove si elimina; nessun bottone di Delete", async () => {
    await open(LAURA);
    expect(
      screen.getByText(
        "Archive ACQ when the work is over. It can be reopened at any time; only a full admin can delete it for good, and only once it's archived.",
      ),
    ).toBeVisible();
    const what = screen.getByRole("list", { name: "What happens" });
    expect(
      within(what)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "ACQ leaves the rail, All projects, ⌘K, Home and notifications, for everyone.",
      "Its members and full admins can still read it, in All projects → Archived.",
      "Its automations stop and no new Claude work starts. Automation runs still open are cancelled, with the note “Project archived”.",
      "Nothing is deleted. Reopen brings it back as it was, settings included.",
    ]);
    expect(
      screen.getByText(
        "Deleting for good happens from the archived project's page, and only a full admin can do it.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(archiveButton()).not.toHaveAttribute("aria-disabled");
  });

  it("Sara: la riga ○ con «Who?», il bottone spento letto da quella riga", async () => {
    await open(SARA);
    const line = document.querySelector<HTMLElement>(
      '[data-view-only-line="manageProjectSettings"]',
    )!;
    expect(line).toBeVisible();
    expect(within(line).getByRole("button", { name: /Who/ })).toHaveAttribute(
      "data-who-can",
      "manageProjectSettings",
    );
    const button = archiveButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.getAttribute("aria-describedby")).toBe(line.id);
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Archive: il dialogo", () => {
  it("Laura con una sessione viva → busy in parole; finita la sessione, archivia e va ad All projects", async () => {
    const user = userEvent.setup();
    // La sessione di Claude su t-acq-3, tenuta al lavoro finché il test non la chiude.
    const run = state.conversations.find((c) => c.id === "cv-run-acq-3")!;
    run.state = "working";
    const code = state.tasksById.get("t-acq-3")!.code;
    const router = await open(LAURA);

    await user.click(archiveButton());
    const dialog = await screen.findByRole("dialog", { name: "Archive ACQ?" });
    // Il fuoco va a Cancel: è un gesto che tocca altri.
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    // Con zero esecuzioni aperte la riga non c'è (anteprima letta).
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog).not.toHaveTextContent(/automation runs? still open/);
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));

    const busy = await screen.findByRole("dialog", { name: "ACQ can't be archived yet" });
    expect(busy).toHaveTextContent(`Claude is working on ${code} “${run.title}”.`);
    // Un glifo per riga e basta: niente triangolo accanto alla lista (rifinitura 12).
    const list = within(busy).getByRole("list");
    expect(busy.querySelector(".text-warning svg")).toBeNull();
    expect(within(list).getAllByRole("listitem")[0]!.querySelectorAll("svg")).toHaveLength(1);
    expect(busy).toHaveTextContent(
      "Wait for it to finish, or stop it from its page, then archive again.",
    );
    expect(within(busy).getByRole("link", { name: code })).toHaveAttribute(
      "href",
      `#/p/ACQ/tasks?task=${code}`,
    );
    // Niente è cambiato.
    expect(state.projectsById.get(ACQ)!.archived).toBeFalsy();

    // La sessione finisce.
    run.state = "finished";
    await user.click(within(busy).getByRole("button", { name: "Archive again" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    expect(
      await screen.findByText("ACQ is archived. Its members find it in Archived."),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: /All projects/ })).toHaveFocus(),
    );
    // ACQ non c'è nel binario né nei progetti; c'è in Archived.
    const rail = screen.getAllByRole("navigation")[0]!;
    await waitFor(() => expect(rail).not.toHaveTextContent(/ACQ/));
    const archivedTab = await screen.findByRole("tab", { name: /Archived/ });
    expect(archivedTab).toHaveTextContent("Archived1");
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent(/ACQ/);
    await user.click(archivedTab);
    expect(await screen.findByRole("link", { name: /ACQ/ })).toBeVisible();
  });

  it("«2 automation runs still open will be cancelled.» dall'anteprima; senza esecuzioni la riga non c'è", async () => {
    const user = userEvent.setup();
    await openAutomationRuns(2);
    await open(LAURA);
    await user.click(archiveButton());
    const dialog = await screen.findByRole("dialog", { name: "Archive ACQ?" });
    expect(
      await within(dialog).findByText("2 automation runs still open will be cancelled."),
    ).toBeVisible();
  });

  it("Cancel chiude e il fuoco torna al bottone; «Open Archived» del toast apre la scheda", async () => {
    const user = userEvent.setup();
    const router = await open(LAURA);
    await user.click(archiveButton());
    let dialog = await screen.findByRole("dialog", { name: "Archive ACQ?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(archiveButton()).toHaveFocus();

    await user.click(archiveButton());
    dialog = await screen.findByRole("dialog", { name: "Archive ACQ?" });
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    await user.click(await screen.findByRole("button", { name: "Open Archived" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Archived/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(router.state.location.search).toMatchObject({ view: "archived" });
  });

  it("qualcuno l'ha già archiviato: la frase, e si va ad All projects", async () => {
    const user = userEvent.setup();
    const router = await open(LAURA);
    await user.click(archiveButton());
    const dialog = await screen.findByRole("dialog", { name: "Archive ACQ?" });
    // L'altra finestra: Roberta archivia ACQ fra l'apertura e la conferma.
    state.projectsById.get(ACQ)!.archived = { at: new Date().toISOString(), byId: "p-roberta" };
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    expect(await screen.findByText("Someone already archived ACQ.")).toBeVisible();
  });

  it("in italiano, le righe dello shape", async () => {
    await i18n.changeLanguage("it");
    renderRoute("/p/ACQ/settings/archive", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Archivia" });
    expect(screen.getByRole("button", { name: "Archivia ACQ…" })).toBeVisible();
    expect(
      screen.getByText("ACQ esce da binario, Tutti i progetti, ⌘K, Home e notifiche, per tutti."),
    ).toBeVisible();
  });
});
