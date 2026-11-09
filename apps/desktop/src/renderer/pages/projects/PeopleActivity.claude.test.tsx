import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { TODAY } from "../../data/dates";
import { state } from "../../data/store";
import i18n from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// «Claude on behalf of» nella rassegna del giorno per persona e nella storia
// del progetto (area 10a, Task 11; shape claude-trace.md [CT 9]). Le azioni
// contano per la persona: la sintesi non distingue, dentro le righe fatte
// con Claude finiscono con l'anello fermo e «with Claude». La voce nuova
// «deleted» entra nella sintesi solo se > 0; la task eliminata si dice con
// codice e titolo di allora, e il codice non è un link (nota T2 → T11).

const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const MKX = "prj-mkx";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

/** Oggi Giulia, con Claude, sposta una task di MKX ed elimina MKX-31; a mano ne sposta un'altra. */
function seedToday() {
  const [withClaude, byHand] = state.tasks.filter((t) => t.projectId === MKX);
  state.activity.push(
    {
      id: "act-test-via",
      taskId: withClaude!.id,
      kind: "field_change",
      authorId: GIULIA,
      at: `${TODAY}T10:41:00Z`,
      field: "week",
      from: "2026-W45",
      to: "2026-W46",
      via: "claude",
    },
    // Apposta SENZA `via`: una riga come quelle nate prima del 10a.
    {
      id: "act-test-hand",
      taskId: byHand!.id,
      kind: "field_change",
      authorId: GIULIA,
      at: `${TODAY}T10:50:00Z`,
      field: "week",
      from: "2026-W45",
      to: "2026-W47",
    },
  );
  state.deletedTasks.push({
    id: "t-mkx-gone",
    code: "MKX-31",
    projectId: MKX,
    title: "Prova",
    deletedAt: `${TODAY}T11:02:00Z`,
    deletedById: GIULIA,
    via: "claude",
  });
  return { withClaude: withClaude!, byHand: byHand! };
}

const rowText = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

describe("la rassegna del giorno per persona", () => {
  it("la sintesi conta anche le eliminate; dentro, le righe fatte con Claude dicono «with Claude»", async () => {
    const { withClaude, byHand } = seedToday();
    const user = userEvent.setup();
    renderRoute(`/projects?view=person&date=${TODAY}`, ROBERTA);
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-person-row="${GIULIA}"]`);
      if (!el) throw new Error("Giulia non c'è");
      return el;
    });
    const toggle = row.querySelector<HTMLElement>("[data-person-toggle]")!;
    expect(rowText(toggle)).toMatch(/2 moved · 1 deleted/);
    // Claude non diventa una persona della rassegna.
    expect(document.querySelector('[data-person-row="p-claude"]')).toBeNull();

    await user.click(toggle);
    const moved = row.querySelector<HTMLElement>('[data-person-category="moved"]')!;
    const movedRows = [...moved.querySelectorAll("li")];
    const claudeRow = movedRows.find((li) => rowText(li).includes(withClaude.code))!;
    const handRow = movedRows.find((li) => rowText(li).includes(byHand.code))!;
    expect(within(claudeRow).getByText("with Claude")).toBeInTheDocument();
    expect(rowText(handRow)).not.toMatch(/claude/i);

    const deleted = row.querySelector<HTMLElement>('[data-person-category="deleted"]')!;
    expect(within(deleted).getByRole("heading", { name: "Deleted" })).toBeInTheDocument();
    const gone = deleted.querySelector("li")!;
    expect(rowText(gone)).toMatch(/MKX-31\s?Prova/);
    expect(within(gone).getByText("with Claude")).toBeInTheDocument();
    // La task non c'è più: niente da aprire.
    expect(within(gone).queryByRole("button")).toBeNull();
  });

  it("senza eliminate la sintesi non dice «deleted»", async () => {
    renderRoute(`/projects?view=person&date=${TODAY}`, ROBERTA);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-person-row]").length).toBeGreaterThan(0),
    );
    expect(document.body.textContent ?? "").not.toMatch(/\d deleted/);
  });
});

describe("la storia del progetto (Activity)", () => {
  it("la task eliminata: chi, codice e titolo di allora, col prefisso se fatta con Claude; il codice non è un link", async () => {
    seedToday();
    const user = userEvent.setup();
    renderRoute("/projects", ROBERTA);
    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-activity-event="task_deleted"]');
      if (!el) throw new Error("nessuna eliminata");
      return el;
    });
    expect(rowText(row)).toContain("Claude on behalf of Giulia Ferri deleted MKX-31 “Prova”");
    expect(within(row).queryByRole("button")).toBeNull();
  });
});
