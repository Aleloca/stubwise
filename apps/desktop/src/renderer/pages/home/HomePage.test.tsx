import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteFilter,
  failNext,
  getPersonalHome,
  listDecisionRequests,
  resetApi,
  setLatency,
} from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";
import { clearPendingAnswers, setUndoWindow } from "./pendingAnswers";

beforeEach(() => {
  setLatency(0);
  resetApi();
  setUndoWindow(0);
});

afterEach(() => {
  clearPendingAnswers();
  clearToasts();
  setUndoWindow(null);
});

const block = (name: string) => screen.findByRole("region", { name });
const changedLine = () => screen.queryByText("Your department's Home has changed");

async function openDecisionsOf(personId: string) {
  setSessionPersonId(personId);
  return listDecisionRequests({ askedOfId: personId, open: true });
}

describe("HomePage", () => {
  it("blocchi risolti: Decide e My week in testa, poi quelli del reparto", async () => {
    renderRoute("/home", "p-giulia");
    await block("Decide");
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles.slice(0, 4)).toEqual(["Decide", "My week", "My tasks", "Upcoming milestones"]);
  });

  it("Giulia vede le sue decisioni; rispondere le toglie e la risposta arriva", async () => {
    const mine = await openDecisionsOf("p-giulia");
    expect(mine.length).toBeGreaterThan(1);
    renderRoute("/home", "p-giulia");
    const decide = await block("Decide");
    for (const d of mine) expect(await within(decide).findByText(d.question)).toBeInTheDocument();

    const first = mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
    const group = within(decide).getByRole("group", { name: `Answer: ${first.question}` });
    await userEvent.click(within(group).getByRole("button", { name: first.options[0]! }));
    // Sparisce subito dalla Home (resta solo nell'animazione, fuori dall'albero accessibile).
    expect(within(decide).queryByRole("group", { name: `Answer: ${first.question}` })).toBeNull();
    await waitFor(() =>
      expect(state.decisions.find((d) => d.id === first.id)!.answer?.optionIndex).toBe(0),
    );
    expect(screen.getByText(/^Answered on /)).toBeInTheDocument();
  });

  it("«Undo» entro la finestra: la risposta non parte e la voce torna", async () => {
    setUndoWindow(60_000);
    const [first] = await openDecisionsOf("p-marco");
    renderRoute("/home", "p-marco");
    const decide = await block("Decide");
    const group = await within(decide).findByRole("group", { name: `Answer: ${first!.question}` });
    await userEvent.click(within(group).getByRole("button", { name: first!.options[1]! }));
    expect(within(decide).queryByRole("group", { name: `Answer: ${first!.question}` })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await within(decide).findByRole("group", { name: `Answer: ${first!.question}` }),
    ).toBeInTheDocument();
    expect(state.decisions.find((d) => d.id === first!.id)!.answer).toBeNull();
  });

  it("una risposta che non riesce torna al suo posto e un messaggio lo dice", async () => {
    const [first] = await openDecisionsOf("p-marco");
    renderRoute("/home", "p-marco");
    const decide = await block("Decide");
    const group = await within(decide).findByRole("group", { name: `Answer: ${first!.question}` });
    failNext("answerDecision");
    await userEvent.click(within(group).getByRole("button", { name: first!.options[0]! }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/It's back in Decide/);
    expect(
      await within(decide).findByRole("group", { name: `Answer: ${first!.question}` }),
    ).toBeInTheDocument();
  });

  it("«Other…» risponde a testo libero", async () => {
    const [first] = await openDecisionsOf("p-marco");
    renderRoute("/home", "p-marco");
    const decide = await block("Decide");
    const group = await within(decide).findByRole("group", { name: `Answer: ${first!.question}` });
    await userEvent.click(within(group).getByRole("button", { name: "Other…" }));
    await userEvent.type(
      within(decide).getByRole("textbox", { name: "Your answer" }),
      "Ask finance",
    );
    await userEvent.click(within(decide).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(state.decisions.find((d) => d.id === first!.id)!.answer?.text).toBe("Ask finance"),
    );
  });

  it("«Turn into task» apre la nuova task dalla richiesta e la richiesta esce da Decide", async () => {
    const router = renderRoute("/home", "p-giulia");
    const decide = await block("Decide");
    const turn = await within(decide).findByRole("button", {
      name: "Turn into task: Landing page for the showroom event",
    });
    await userEvent.click(turn);
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue(
        "Landing page for the showroom event",
      ),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(state.requests.find((r) => r.id === "req-mkx-2")!.status).toBe("converted"),
    );
    const created = state.tasks.find((t) => t.requestId === "req-mkx-2")!;
    expect(created.projectId).toBe("prj-mkx");
    await waitFor(() =>
      expect((router.state.location.search as { task?: string }).task).toBe(created.code),
    );
    await waitFor(() =>
      expect(
        within(decide).queryByRole("button", {
          name: "Turn into task: Landing page for the showroom event",
        }),
      ).toBeNull(),
    );
  });

  it("l'errore di un blocco resta nel blocco, con Retry; gli altri si vedono", async () => {
    failNext("listMilestones");
    renderRoute("/home", "p-giulia");
    const milestones = await block("Upcoming milestones");
    expect(await within(milestones).findByRole("alert")).toHaveTextContent(
      "Couldn't load Upcoming milestones.",
    );
    const decide = await block("Decide");
    expect(within(decide).queryByRole("alert")).toBeNull();
    expect(await within(decide).findAllByRole("group")).not.toHaveLength(0);
    await userEvent.click(within(milestones).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(milestones).queryByRole("alert")).toBeNull());
  });

  it("verifica col seed: Sara (Contributor, quindi con tickets.create) ha «New requests»; Irene (Viewer) no, né nel catalogo", async () => {
    renderRoute("/home", "p-sara");
    expect(await block("New requests")).toBeInTheDocument();
    cleanup();

    renderRoute("/home", "p-irene");
    await block("Decide");
    expect(screen.queryByRole("region", { name: "New requests" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add block" }));
    const menu = await screen.findByRole("menu", { name: "Add block" });
    expect(
      within(menu).getByRole("menuitem", { name: "Claude's work for me" }),
    ).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "New requests" })).toBeNull();
  });

  it("Laura modifica la Home di Development e Marco, con la Home personale, vede la riga «has changed»", async () => {
    // Marco ha già una modifica da vedere nel seed: la guarda, la riga se ne va.
    renderRoute("/home", "p-marco");
    await block("Decide");
    await userEvent.click(await screen.findByRole("button", { name: "See what's new" }));
    const news = await screen.findByRole("region", { name: "New in your department's Home" });
    expect(within(news).getByText("Stalled in my projects")).toBeInTheDocument();
    await userEvent.click(within(news).getByRole("button", { name: "Close" }));
    cleanup();
    renderRoute("/home", "p-marco");
    await block("Decide");
    expect(changedLine()).toBeNull();
    cleanup();

    renderRoute("/home", "p-laura");
    await block("Decide");
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Development Home" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add block" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Upcoming milestones" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("Development Home saved.");
    expect(
      state.departmentHomes.find((h) => h.departmentId === "dep-development")!.blocks.at(-1),
    ).toEqual({ kind: "upcomingMilestones" });
    cleanup();

    renderRoute("/home", "p-marco");
    await block("Decide");
    expect(await screen.findByText("Your department's Home has changed")).toBeInTheDocument();
    // La sua Home resta la sua.
    expect(screen.queryByRole("region", { name: "Upcoming milestones" })).toBeNull();
  });

  it("R-B12: dopo «Add to Home» nessuna riga «has changed»", async () => {
    renderRoute("/filters/flt-open", "p-sara");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    await userEvent.click(within(actions).getByRole("button", { name: "Add to Home" }));
    await screen.findByText("Added Open to your Home.");
    cleanup();
    renderRoute("/home", "p-sara");
    expect(await block("Open")).toBeInTheDocument();
    expect(changedLine()).toBeNull();
  });

  it("R-B12: il primo salvataggio dall'editor non accende la riga", async () => {
    renderRoute("/home", "p-sara");
    await block("Decide");
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Hide Stalled in my projects" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("Home saved.");
    await block("Decide");
    expect(screen.queryByRole("region", { name: "Stalled in my projects" })).toBeNull();
    expect(changedLine()).toBeNull();
  });

  it("riordino da tastiera: Spazio prende, freccia su sposta, Spazio lascia; Done salva l'ordine", async () => {
    renderRoute("/home", "p-giulia");
    await block("Decide");
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "My Home" }));
    const handle = await screen.findByRole("button", { name: "Move Upcoming milestones" });
    handle.focus();
    await userEvent.keyboard(" ");
    expect(screen.getByText("Picked up Upcoming milestones, position 4 of 5.")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard(" ");
    expect(
      screen.getByText(/Upcoming milestones dropped at position 3 of 5\./),
    ).toBeInTheDocument();
    // I fissi non si nascondono.
    const list = screen.getByRole("list", { name: "Blocks of the Home" });
    expect(within(list).queryByRole("button", { name: "Hide Decide" })).toBeNull();
    expect(within(list).getAllByText("Always shown")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("Home saved.");
    setSessionPersonId("p-giulia");
    expect((await getPersonalHome())!.blocks.map((b) => b.kind)).toEqual([
      "decide",
      "myWeek",
      "upcomingMilestones",
      "myTasks",
      "filter",
    ]);
  });

  it("«Reset to department Home» chiede conferma e torna alla Home del reparto", async () => {
    renderRoute("/home", "p-marco");
    await block("Decide");
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reset to department Home" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset to your department's Home?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await screen.findByText("Back to your department's Home.");
    expect(state.personalHomes.some((h) => h.personId === "p-marco")).toBe(false);
    expect(await block("Stalled in my projects")).toBeInTheDocument();
  });

  it("un filtro eliminato: riga calma e «Remove block», niente righe vecchie", async () => {
    setSessionPersonId("p-giulia");
    await deleteFilter("flt-no-estimate");
    renderRoute("/home", "p-giulia");
    await screen.findByText("This filter is no longer available");
    const gone = screen.getByRole("region", { name: "Saved filter" });
    expect(gone.querySelector("[data-task-row]")).toBeNull();
    await userEvent.click(within(gone).getByRole("button", { name: "Remove block" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Saved filter" })).toBeNull());
    setSessionPersonId("p-giulia");
    expect((await getPersonalHome())!.blocks.some((b) => b.kind === "filter")).toBe(false);
  });

  it("My tasks: tre schede e gruppi per scadenza, al massimo 5 righe per gruppo", async () => {
    renderRoute("/home", "p-giulia");
    const myTasks = await block("My tasks");
    const tabs = await within(myTasks).findAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "Assigned to me",
      "Delegated",
      "Following",
    ]);
    for (const list of within(myTasks).queryAllByRole("list")) {
      expect(within(list).getAllByRole("listitem").length).toBeLessThanOrEqual(5);
    }
  });
});
