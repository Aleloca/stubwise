import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { __secretValuesForTest } from "../../data/admin/secrets";
import { markReauthenticated } from "../../data/auth/reauth";
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
    expect(row).toHaveTextContent("8 conversations");
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

  it("siti ammessi (area 8, F3): elenco vuoto = qualunque sito, e lo dice; si salvano normalizzati", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    const sites = within(panel).getByLabelText(/^Sites/);
    await user.clear(sites);
    expect(within(panel).getByText("Any site can load this widget.")).toBeInTheDocument();
    await user.type(sites, "https://Shop.Example.com/");
    expect(within(panel).queryByText("Any site can load this widget.")).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(state.supportWidgets[0]!.origins).toEqual(["https://shop.example.com"]),
    );
  });

  it("a elenco vuoto la riga del widget lo dice (review F3, m1)", async () => {
    state.supportWidgets[0]!.origins = [];
    await open("/p/ACQ/support?view=widgets");
    const list = await screen.findByRole("list", { name: "Widgets" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("Any site");
  });

  it("modificare il titolo non riscrive i siti: quelli di un collega restano (review F3, m2)", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    // Un collega cambia i siti mentre il pannello è aperto.
    state.supportWidgets[0]!.origins = ["https://colleague.example.com"];
    const title = within(panel).getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Ask us");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.supportWidgets[0]!.title).toBe("Ask us"));
    expect(state.supportWidgets[0]!.origins).toEqual(["https://colleague.example.com"]);
  });

  it("un sito in http fuori da localhost: il motivo, nulla salvato", async () => {
    const user = userEvent.setup();
    const before = [...state.supportWidgets[0]!.origins];
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    const sites = within(panel).getByLabelText(/^Sites/);
    await user.clear(sites);
    await user.type(sites, "http://shop.example.com");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Each site must be like https://example.com",
    );
    expect(state.supportWidgets[0]!.origins).toEqual(before);
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

  it("API per i siti (S6): «Customer identity» dice da quando c'è il segreto; rigenerarlo chiede la riconferma e lo mostra una volta sola", async () => {
    const user = userEvent.setup();
    const before = state.supportWidgets[0]!.identitySecretRotatedAt;
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    const identity = within(panel).getByRole("region", { name: "Customer identity" });
    expect(identity).toHaveTextContent(/Secret made on/);
    // L'id del widget è il claim `aud` del token: accanto al segreto, copiabile.
    expect(within(identity).getByText("wdg-acq-portal")).toBeInTheDocument();
    expect(within(identity).getByRole("button", { name: "Copy widget id" })).toBeInTheDocument();
    await user.click(within(identity).getByRole("button", { name: "Regenerate secret…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Make a new identity secret for Customer portal help?",
    });
    expect(dialog).toHaveTextContent(
      "The current secret stops working now: tokens signed with it are refused.",
    );
    expect(dialog).toHaveTextContent("The new secret is shown only once.");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(confirm).getByLabelText("Code"), "123456");
    const once = await within(dialog).findByTestId("secret-once");
    const secret = __secretValuesForTest().find((x) => x.kind === "widget_identity_secret")!
      .values[0]!;
    expect(once.querySelector("[data-secret-value]")!.textContent).toBe(secret);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(secret);
    expect(state.supportWidgets[0]!.identitySecretRotatedAt).not.toBe(before);
  });

  it("API per i siti (S6): senza segreto «Make a secret…», e «Only verified customers» non si accende", async () => {
    const user = userEvent.setup();
    Object.assign(state.supportWidgets[0]!, {
      identitySecretSet: false,
      identitySecretRotatedAt: null,
    });
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    const identity = within(panel).getByRole("region", { name: "Customer identity" });
    expect(identity).toHaveTextContent("No secret yet.");
    expect(within(identity).getByRole("button", { name: "Make a secret…" })).toBeInTheDocument();
    const toggle = within(panel).getByRole("checkbox", { name: "Only verified customers" });
    expect(toggle).toBeDisabled();
    expect(panel).toHaveTextContent("Make a secret first.");
    expect(state.supportWidgets[0]!.identityRequired).toBe(false);
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it("API per i siti (S6): «Only verified customers» si salva col widget", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    const toggle = within(panel).getByRole("checkbox", { name: "Only verified customers" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.supportWidgets[0]!.identityRequired).toBe(true));
  });

  it("review S6 (1): salvare solo il nome non rispegne «Only verified customers» acceso nel frattempo da un collega", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    state.supportWidgets[0]!.identityRequired = true; // un collega, a pannello aperto
    const name = within(panel).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Portal help");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.supportWidgets[0]!.name).toBe("Portal help"));
    expect(state.supportWidgets[0]!.identityRequired).toBe(true);
  });

  it("review S6 (3): acceso quando il segreto non c'è più, l'errore del campo è «Make a secret first.»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    await user.click(within(panel).getByRole("checkbox", { name: "Only verified customers" }));
    state.supportWidgets[0]!.identitySecretSet = false;
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Make a secret first.");
  });

  it("review S6 (2): mentre il segreto si crea il dialogo non si chiude, e il segreto nuovo si vede", async () => {
    const user = userEvent.setup();
    markReauthenticated("p-matteo");
    await open("/p/ACQ/support?view=widgets&widget=wdg-acq-portal");
    const panel = await screen.findByRole("complementary", { name: "Edit Customer portal help" });
    await user.click(within(panel).getByRole("button", { name: "Regenerate secret…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Make a new identity secret for Customer portal help?",
    });
    setLatency(300);
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog).toBeInTheDocument();
    expect(await within(dialog).findByTestId("secret-once")).toBeInTheDocument();
  });
});
