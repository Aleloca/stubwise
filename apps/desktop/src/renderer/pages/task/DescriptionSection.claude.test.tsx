import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { taskDescriptionDraftFor } from "../../data/claude/drafts";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { setLanguage } from "../../i18n";
import { fillableFor } from "../../layout/claudePanel/fillable";
import { resetPanelToggle } from "../../layout/claudePanel/panelEvents";
import { renderRoute } from "../../test/renderRoute";

// La descrizione di una task dal riquadro di Claude (area 10b, Task 10, D1;
// shape `claude-drafts.md` §3.6): il campo `taskDescription` c'è solo per
// chi può modificare la task; mettere la bozza apre il modo modifica col
// testo e il segno, senza prendere il fuoco [DR 8]. La task non cambia finché
// la persona non preme «Save»: allora è un suo gesto (nessun «Claude on
// behalf of»). Esc butta la bozza, e la riga dice `changed_after`.

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ_7 = "t-acq-7";
type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
const draftEvents = (): DraftEvent[] =>
  [...state.conversationEvents.values()].flat().filter((e): e is DraftEvent => e.type === "draft");

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetPanelToggle();
});
afterEach(() => {
  act(() => setLanguage("en"));
  setSessionPersonId("p-giulia");
});

const panel = () => document.getElementById("claude-panel");
const panelOpen = () => panel() !== null && !panel()!.hidden;
const panelBox = () => within(panel()!).getByRole("textbox", { name: "Message to Claude" });
const draftRow = () => panel()?.querySelector<HTMLElement>("[data-draft-row]") ?? null;
const taskPanel = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-task-detail]");
    if (!el) throw new Error("no task panel");
    return el;
  });
const descriptionBox = (root: HTMLElement) =>
  within(root).queryByRole("textbox", { name: "Description" }) as HTMLTextAreaElement | null;
const mark = (root: HTMLElement) => root.querySelector("[data-claude-draft-mark]");

async function askPanel(user: ReturnType<typeof userEvent.setup>, text: string) {
  if (!panelOpen()) await user.keyboard("{Control>}j{/Control}");
  await waitFor(() => expect(panelBox()).toHaveFocus());
  await user.type(panelBox(), `${text}{Enter}`);
}

describe("La descrizione dal riquadro (D1)", () => {
  it("si apre in modifica col testo e il segno; la task non cambia finché Laura non salva; salvata, è sua", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/tasks?task=ACQ-7", LAURA);
    const root = await taskPanel();
    const task = state.tasksById.get(ACQ_7)!;
    const activity = JSON.stringify(state.activity);
    const expected = taskDescriptionDraftFor(LAURA, ACQ_7);
    if (!expected.ok) throw new Error(expected.reason);
    await askPanel(user, "write the description");
    await waitFor(() => expect(descriptionBox(root)?.value).toBe(expected.text));
    expect(mark(root)).toHaveTextContent("Claude's draft");
    expect(mark(root)).toHaveTextContent("edit it before saving");
    for (const code of expected.sources) expect(mark(root)).toHaveTextContent(code);
    // Il fuoco resta nel riquadro, e un annuncio dice dove sta la bozza.
    expect(panel()!.contains(document.activeElement)).toBe(true);
    expect(
      within(root).getByText("Claude's draft is in the description of ACQ-7. Save it to keep it."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(draftRow()).toHaveTextContent("Put a draft in the description of ACQ-7"),
    );
    // Nessuna modifica della task, nessuna attività.
    expect(task.description).toBe("");
    expect(JSON.stringify(state.activity)).toBe(activity);

    await user.click(within(root).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.tasksById.get(ACQ_7)!.description).toBe(expected.text));
    const last = state.activity.filter((a) => a.taskId === ACQ_7).at(-1)!;
    expect(last).toMatchObject({ kind: "field_change", field: "description", authorId: LAURA });
    expect(last).not.toHaveProperty("via");
    expect(mark(root)).toBeNull();
    // I1: salvata, la bozza è della persona: la riga non offre più «Undo» («com'era» mentirebbe).
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("changed_after"));
    expect(within(draftRow()!).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(draftRow()).not.toHaveTextContent("as it was");
    // Il fuoco non è mai sul body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Esc: la descrizione resta com'era e la riga dice `changed_after`", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/tasks?task=ACQ-7", LAURA);
    const root = await taskPanel();
    await askPanel(user, "write the description");
    const box = await waitFor(() => {
      const b = descriptionBox(root);
      if (!b?.value) throw new Error("no draft");
      return b;
    });
    box.focus();
    await user.keyboard("{Escape}");
    expect(descriptionBox(root)).toBeNull();
    // Il campo sparisce col fuoco dentro: torna su «Add», mai sul body (I2).
    expect(document.activeElement).toBe(
      within(root).getByRole("button", { name: "Edit description" }),
    );
    expect(state.tasksById.get(ACQ_7)!.description).toBe("");
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("changed_after"));
    expect(draftRow()).toHaveTextContent("The field changed afterwards · can't undo from here");
  });

  it("con una descrizione già scritta: «Replace or add below?», e il campo non cambia finché non si sceglie", async () => {
    const user = userEvent.setup();
    state.tasksById.get(ACQ_7)!.description = "Written by hand.";
    renderRoute("/p/ACQ/tasks?task=ACQ-7", LAURA);
    const root = await taskPanel();
    await askPanel(user, "write the description");
    const ask = await waitFor(() =>
      within(draftRow()!).getByRole("group", {
        name: "The description already has text. Replace it, or add the draft below?",
      }),
    );
    expect(descriptionBox(root)).toBeNull();
    await user.click(within(ask).getByRole("button", { name: "Add below" }));
    await waitFor(() => expect(descriptionBox(root)?.value).toMatch(/^Written by hand\.\n\n/));
    expect(state.tasksById.get(ACQ_7)!.description).toBe("Written by hand.");
  });

  it("con il pannello di un'altra task aperto: la riga è `waiting`, e la descrizione aperta non cambia", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/tasks?task=ACQ-3", LAURA);
    const root = await taskPanel();
    const other = [...state.tasksById.values()].find((x) => x.code === "ACQ-3")!;
    const before = other.description;
    await askPanel(user, "write the description for ACQ-7");
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("waiting"));
    expect(descriptionBox(root)).toBeNull();
    expect(other.description).toBe(before);
    expect(draftRow()).toHaveTextContent("The draft for the description of ACQ-7 is ready");
  });

  it("Sara senza `canEdit`: il campo non c'è, e nessuna bozza entra nella descrizione", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/tasks?task=ACQ-7", SARA);
    const root = await taskPanel();
    // Il campo non è dichiarato: il riquadro non ha dove scrivere.
    expect(fillableFor({ kind: "taskDescription", taskId: ACQ_7 })).toBeNull();
    await askPanel(user, "write the description");
    await waitFor(() => expect(panel()!.textContent).toMatch(/You can't edit ACQ-7/));
    expect(draftEvents()).toEqual([]);
    expect(descriptionBox(root)).toBeNull();
    expect(state.tasksById.get(ACQ_7)!.description).toBe("");
  });
});

describe("La riga letta da un altro", () => {
  it("un lettore della pubblica che non vede ACQ: la riga è chiusa e non dice il codice", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/tasks?task=ACQ-7", LAURA);
    await taskPanel();
    await askPanel(user, "write the description");
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("placed"));
    const conversationId = [...state.conversationEvents.entries()].find(([, events]) =>
      events.some((e) => e.type === "draft"),
    )![0];
    const detail = await api.getConversation(conversationId);
    expect(detail!.ownerId).toBe(LAURA);
    document.body.replaceChildren();
    // Pubblica, poi letta da chi non vede ACQ.
    setSessionPersonId(LAURA);
    await api.setVisibility(conversationId, "public", {
      confirmedProjectIds: ["prj-acq"],
    });
    renderRoute(`/claude/${conversationId}`, "p-giulia");
    const row = await screen.findByText("Claude put a draft in a field");
    expect(row.closest("[data-draft-row]")!.textContent!.toLowerCase()).not.toMatch(/acq/);
    expect(within(row.closest("[data-draft-row]") as HTMLElement).queryByRole("button")).toBeNull();
  });
});
