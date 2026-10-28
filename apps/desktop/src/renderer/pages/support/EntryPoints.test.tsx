import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { resetViewerGrants, viewerFor } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { BLOCKS } from "../home/blocks/registry";
import { SUPPORT_TWO_UP_QUERY } from "./format";
import { clearReplyStore } from "./replyStore";

// Le porte d'ingresso di Support (Task 9): il blocco Home «Clienti in
// attesa» ([A 17]: nel catalogo di chi ha `support.reply`, mai nelle Home
// di default) e ⌘K (le conversazioni per codice, «New widget»).

beforeEach(() => {
  setLatency(0);
  resetApi();
  clearReplyStore();
  window.localStorage.clear();
  setMatchMedia(SUPPORT_TWO_UP_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

/** La Home di `personId` con il solo blocco «Clienti in attesa». */
function homeWithWaiting(personId: string) {
  state.personalHomes = [
    ...state.personalHomes.filter((h) => h.personId !== personId),
    { personId, blocks: [{ kind: "waitingCustomers" }], seenDepartmentUpdates: {} },
  ];
}

describe("Home — «Customers waiting»", () => {
  it("nel catalogo di chi ha support.reply, non di Sara; mai nelle Home di default", async () => {
    expect(BLOCKS.waitingCustomers.available(viewerFor("p-matteo"))).toBe(true);
    expect(BLOCKS.waitingCustomers.available(viewerFor("p-sara"))).toBe(false);
    renderRoute("/home", "p-laura");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    expect(screen.queryByRole("region", { name: /^Customers waiting/ })).toBeNull();
  });

  it("le attese più vecchie in alto, con «waiting»; il clic apre il dettaglio", async () => {
    homeWithWaiting("p-matteo");
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-matteo");
    const block = await screen.findByRole("region", { name: /^Customers waiting/ });
    const row = await within(block).findByRole("link", { name: /ACQ-S2/ });
    expect(row).toHaveTextContent("Lucia Benedetti");
    expect(row).toHaveTextContent("waiting 3 h");
    await user.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S2"));
  });

  it("vuoto: «No customer is waiting»", async () => {
    homeWithWaiting("p-matteo");
    state.supportConversations = state.supportConversations.filter((c) => c.code !== "ACQ-S2");
    renderRoute("/home", "p-matteo");
    const block = await screen.findByRole("region", { name: /^Customers waiting/ });
    expect(await within(block).findByText("No customer is waiting")).toBeInTheDocument();
  });
});

describe("⌘K — conversazioni di Support", () => {
  it("una conversazione per codice: codice · cliente · stato, e porta al dettaglio", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-matteo");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "ACQ-S2");
    const group = await within(dialog).findByRole("group", { name: "Support" });
    const option = within(group).getByRole("option", { name: /ACQ-S2/ });
    expect(option).toHaveTextContent("Lucia Benedetti");
    expect(option).toHaveTextContent("Waiting on us");
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S2"));
  });

  it("chi non vede ACQ non la trova (R-G5)", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-giulia");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "ACQ-S2");
    await waitFor(() =>
      expect(within(dialog).queryByRole("group", { name: "Support" })).toBeNull(),
    );
  });

  it("«New widget» dentro ACQ per chi ha widget.manage: apre il pannello", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/support", "p-matteo");
    await screen.findByRole("heading", { name: "Support", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "New widget");
    await user.click(await within(dialog).findByRole("option", { name: /^New widget/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ view: "widgets", widget: "new" }),
    );
    expect(await screen.findByRole("complementary", { name: "New widget" })).toBeInTheDocument();
  });
});

describe("Pannello della richiesta — «Where it comes from» [A 15]", () => {
  it("dal widget: canale · cliente · codice col link; la conversazione si apre sul posto, chiusa di default", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/requests?request=req-acq-1", "p-sara");
    const section = await screen.findByRole("region", { name: "Where it comes from" });
    expect(section).toHaveTextContent("From the widget · Lucia Benedetti · ACQ-S2");
    const messages = state.supportConversations.find((c) => c.code === "ACQ-S2")!.messages.length;
    expect(within(section).queryByRole("list", { name: "Conversation" })).toBeNull();
    await user.click(
      within(section).getByRole("button", { name: `Show the conversation (${messages} messages)` }),
    );
    const list = within(section).getByRole("list", { name: "Conversation" });
    expect(list.querySelectorAll("[data-support-message]")).toHaveLength(messages);
    // In sola lettura: nessuna casella.
    expect(within(section).queryByRole("form")).toBeNull();
    await user.click(within(section).getByRole("link", { name: "ACQ-S2" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/support/ACQ-S2"));
  });

  it("da Claude Code: canale e cliente, senza codice", async () => {
    renderRoute("/p/ACQ/requests?request=req-acq-2", "p-matteo");
    const section = await screen.findByRole("region", { name: "Where it comes from" });
    expect(section).toHaveTextContent("From Claude Code · Technical office, Comune di Valfonda");
    expect(within(section).queryByRole("link")).toBeNull();
  });

  it("una richiesta che non nasce da Support non ha la sezione", async () => {
    const other = state.requests.find((r) => r.projectId === "prj-aud" && !r.origin)!;
    renderRoute(`/p/AUD/requests?request=${other.id}`, "p-matteo");
    await screen.findByRole("heading", { name: other.title });
    expect(screen.queryByRole("region", { name: "Where it comes from" })).toBeNull();
  });
});
