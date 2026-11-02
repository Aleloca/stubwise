import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { MOVE_TASK } from "../../data/seed/claudeActions";
import { state } from "../../data/store";
import type { ActivityEntry, Task } from "../../data/types";
import i18n, { setLanguage } from "../../i18n";
import { renderWithData } from "../../test/renderWithData";
import { ActivityFeed } from "./ActivityFeed";

// «Claude on behalf of» nella storia della task (area 10a, Task 11; shape
// claude-trace.md). Il commento scritto da Claude per Giulia ha la testata
// «Claude on behalf of Giulia Ferri» ed è di Giulia: lo modifica e lo
// elimina come suo [CT 6, CT 7]. La riga di un cambio di campo col segno ha
// il prefisso al posto del nome; l'inversa di un «Annulla» è una riga
// normale, senza «undid» [CT 8].
//
// Seme (Task 7): MKX-1 di Giulia spostata da W41 a W42 con Claude e poi
// riportata indietro dall'«Annulla».

const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const task = (): Task => state.tasksById.get(MOVE_TASK.id)!;

function renderFeed(personId: string) {
  return renderWithData(<ActivityFeed task={task()} canComment />, { personId });
}

const fieldRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-activity="field_change"]')].map((el) =>
    (el.querySelector("p")?.textContent ?? "").replace(/\s+/g, " "),
  );

/** Il commento del test (il seme ne ha altri sulla stessa task). */
const testComment = () =>
  [...document.querySelectorAll<HTMLElement>('[data-activity="comment"]')].find((el) =>
    /as asked/.test(el.textContent ?? ""),
  );

function addComment(extra: Partial<ActivityEntry> = {}): ActivityEntry {
  const entry: ActivityEntry = {
    id: "act-test-claude-comment",
    taskId: MOVE_TASK.id,
    kind: "comment",
    authorId: GIULIA,
    at: "2026-10-28T10:41:00Z",
    body: "Moved to next week, as asked.",
    via: "claude",
    ...extra,
  };
  state.activity.push(entry);
  return entry;
}

describe("le righe di cambio di campo", () => {
  it("col segno hanno il prefisso; l'inversa dell'«Annulla» è una riga normale col prefisso", async () => {
    renderFeed(ROBERTA);
    await waitFor(() => expect(fieldRows().length).toBeGreaterThan(0));
    const claude = fieldRows().filter((r) => r.includes(MOVE_TASK.to));
    expect(claude).toHaveLength(2);
    for (const row of claude) expect(row).toMatch(/^Claude on behalf of Giulia Ferri · /);
    expect(claude.join(" ")).not.toMatch(/undid/i);

    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(fieldRows().filter((r) => r.includes(MOVE_TASK.to))[0]).toMatch(
        /^Claude per conto di Giulia Ferri · /,
      ),
    );
  });

  it("le righe nate prima del 10a (senza i campi nuovi) non hanno segno", async () => {
    // Apposta SENZA `via`: la forma delle righe di prima.
    state.activity.push({
      id: "act-test-legacy",
      taskId: MOVE_TASK.id,
      kind: "field_change",
      authorId: GIULIA,
      at: "2026-10-01T09:00:00Z",
      field: "status",
      from: "To do",
      to: "Done",
    });
    renderFeed(ROBERTA);
    await waitFor(() =>
      expect(fieldRows().some((r) => r.includes("To do → Done"))).toBe(true),
    );
    const legacy = fieldRows().find((r) => r.includes("To do → Done"))!;
    expect(legacy).toMatch(/^Giulia Ferri · /);
    expect(legacy).not.toMatch(/claude/i);
  });
});

describe("il commento col segno", () => {
  it("testata «Claude on behalf of Giulia Ferri», avatar di Giulia; Giulia lo modifica e lo elimina come suo", async () => {
    addComment();
    const user = userEvent.setup();
    renderFeed(GIULIA);
    const comment = await waitFor(() => {
      const el = testComment();
      if (!el) throw new Error("nessun commento");
      return el;
    });
    expect(comment.querySelector("[data-comment-author]")?.textContent).toBe(
      "Claude on behalf of Giulia Ferri",
    );

    // Modifica: la testata resta col prefisso e dice «edited».
    await user.click(within(comment).getByRole("button", { name: "Edit" }));
    const box = within(comment).getByRole("textbox");
    await user.clear(box);
    await user.type(box, "Moved to W42, as asked.");
    await user.click(within(comment).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(comment).getByText("edited")).toBeInTheDocument());
    expect(comment.querySelector("[data-comment-author]")?.textContent).toBe(
      "Claude on behalf of Giulia Ferri",
    );

    // Elimina: il segno resta sulla riga «Comment deleted» [CT 7].
    await user.click(within(comment).getByRole("button", { name: "Delete" }));
    await user.click(within(comment).getByRole("button", { name: "Delete comment" }));
    const deleted = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-activity="comment-deleted"]');
      if (!el) throw new Error("non eliminato");
      return el;
    });
    expect(within(deleted).getByRole("img", { name: "with Claude" })).toBeInTheDocument();
  });

  it("in italiano la testata dice «Claude per conto di Giulia Ferri»", async () => {
    addComment();
    await i18n.changeLanguage("it");
    renderFeed(ROBERTA);
    await waitFor(() =>
      expect(testComment()?.querySelector("[data-comment-author]")?.textContent).toBe(
        "Claude per conto di Giulia Ferri",
      ),
    );
  });

  it("un commento nato prima del 10a non ha il prefisso", async () => {
    // Apposta SENZA `via`: la forma dei commenti di prima.
    const legacy = addComment();
    delete legacy.via;
    renderFeed(ROBERTA);
    await waitFor(() =>
      expect(testComment()?.querySelector("[data-comment-author]")?.textContent).toBe(
        "Giulia Ferri",
      ),
    );
    expect(testComment()?.textContent).not.toMatch(/claude/i);
  });
});
