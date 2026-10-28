import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearToasts } from "../../tasks-ui/Toast";
import { SUPPORT_TWO_UP_QUERY } from "./format";
import { clearReplyStore } from "./replyStore";

// La vista Widget di Support (Task 9, shape support.md §6, R-K13): solo per
// chi ha `widget.manage`, coi campi del web, snippet e guida, eliminare con
// conferma sul posto (le conversazioni restano).

beforeEach(() => {
  setLatency(0);
  resetApi();
  clearReplyStore();
  setMatchMedia(SUPPORT_TWO_UP_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
  act(() => setLanguage("en"));
});

async function open(path: string, person = "p-matteo") {
  const router = renderRoute(path, person);
  await screen.findByRole("heading", { level: 1, name: "Support" });
  return router;
}

describe("Support — Widget", () => {
  it("senza widget.manage non c'è il selettore, e ?view=widgets resta sulle conversazioni", async () => {
    await open("/p/ACQ/support?view=widgets", "p-sara");
    expect(await screen.findByRole("listbox", { name: "Conversations" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Support views" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New widget" })).toBeNull();
  });

  it("con widget.manage: «Conversations · Widgets 1», righe con stato in parole e conversazioni", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support");
    const views = await screen.findByRole("group", { name: "Support views" });
    expect(within(views).getByRole("button", { name: "Conversations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(await within(views).findByRole("button", { name: /Widgets\s*1/ }));
    expect(within(views).getByRole("button", { name: "Conversations" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const list = await screen.findByRole("list", { name: "Widgets" });
    const row = within(list).getByRole("listitem");
    expect(row).toHaveTextContent("Customer portal help");
    expect(row).toHaveTextContent("On");
    expect(row).toHaveTextContent("3 conversations");
  });

  it("Edit: i campi del web, lo snippet e la guida; salvare cambia il widget", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets");
    await user.click(await screen.findByRole("button", { name: "Edit Customer portal help" }));
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    for (const label of [
      "Name",
      "Sites",
      "Title",
      "Welcome message",
      "Instructions for the assistant",
      "Language",
      "Messages per day",
      "Requests per day",
    ]) {
      expect(within(panel).getByLabelText(label)).toBeInTheDocument();
    }
    expect(
      within(panel).getByRole("checkbox", { name: "On: it accepts new conversations" }),
    ).toBeChecked();
    expect(within(panel).getByText(/Stubwise\.initWidget/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Copy guide" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Download .md" })).toBeInTheDocument();
    const title = within(panel).getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Ask us");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.supportWidgets[0]!.title).toBe("Ask us"));
  });

  it("un valore sbagliato: il motivo in parole, nulla salvato", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    const cap = within(panel).getByLabelText("Messages per day");
    await user.type(cap, "0");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Messages per day: a whole number from 1 to 100000, or empty.",
    );
    expect(state.supportWidgets[0]!.dailyMessageCap).toBeNull();
  });

  it("New widget: solo il nome serve; poi c'è nell'elenco", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets");
    await user.click(await screen.findByRole("button", { name: "New widget" }));
    const panel = await screen.findByRole("complementary", { name: "New widget" });
    await user.type(within(panel).getByLabelText("Name"), "Help centre");
    await user.click(within(panel).getByRole("button", { name: "Create widget" }));
    const list = await screen.findByRole("list", { name: "Widgets" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(list).toHaveTextContent("Help centre");
  });

  it("Delete widget: conferma sul posto, le conversazioni restano", async () => {
    const user = userEvent.setup();
    const conversations = state.supportConversations.length;
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    await user.click(within(panel).getByRole("button", { name: "Delete widget" }));
    expect(
      within(panel).getByText("Delete Customer portal help? Its conversations stay."),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No widgets yet")).toBeInTheDocument();
    expect(state.supportConversations).toHaveLength(conversations);
  });
});
