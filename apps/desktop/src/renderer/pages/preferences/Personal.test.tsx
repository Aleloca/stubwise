import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, me, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { state } from "../../data/store";
import i18n from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Le Preferenze personali (area 9a, Task 7, shape preferences-account.md):
// Account, Security, Tokens, Claude Code, Language & theme e il valore
// mostrato una volta (`SecretOnce`). Persone del seme: Giulia (casella
// collegata, due altre sessioni), Laura (secondo fattore con una passkey,
// casella da ricollegare), Sara (senza secondo fattore), Marco.

const GIULIA = "p-giulia";
const LAURA = "p-laura";
const SARA = "p-sara";
const MARCO = "p-marco";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const nav = () => screen.getByRole("navigation", { name: "Preferences sections" });
const goTo = async (user: ReturnType<typeof userEvent.setup>, section: string) => {
  await user.click(within(nav()).getByRole("link", { name: new RegExp(`^${section}`) }));
  await heading(section);
};

/** Il dialogo «Confirm it's you»: il codice del prototipo, e l'azione riparte da sola. */
async function confirmItsYou(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(dialog).getByLabelText("Code"), "123456");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
  );
}

describe("cornice", () => {
  it("la colonna ha le sei sezioni, senza segnaposto; «Off» accanto a Security solo per Sara", async () => {
    renderRoute("/preferences/account", GIULIA);
    expect(await heading("Account")).toBeVisible();
    expect(
      within(nav())
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "Notifications",
      "Account",
      "Security",
      "Tokens",
      "Claude Code",
      "Language & theme",
    ]);
    expect(screen.queryByText("Arrives with a later area.")).toBeNull();
    expect(within(nav()).queryByText("Off")).toBeNull();
  });

  it("Sara: «Off» accanto a Security", async () => {
    renderRoute("/preferences/look", SARA);
    await heading("Language & theme");
    expect(await within(nav()).findByText("Off")).toBeVisible();
  });
});

describe("Account", () => {
  it("cambio password: la corrente sbagliata si dice in parole; giusta chiude le altre sessioni", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/account", GIULIA);
    await heading("Account");
    await user.type(await screen.findByLabelText("Current password"), "wrong-one");
    await user.type(screen.getByLabelText("New password"), "a-new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "a-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("The current password is wrong.")).toBeVisible();
    expect(state.sessions.filter((s) => s.personId === GIULIA)).toHaveLength(3);

    await user.clear(screen.getByLabelText("Current password"));
    await user.type(screen.getByLabelText("Current password"), "stubwise");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(
      await screen.findByText("Password changed. 2 other sessions were signed out."),
    ).toBeVisible();
    expect(state.sessions.filter((s) => s.personId === GIULIA)).toHaveLength(1);
    // Il modulo si svuota: la password non resta nei campi.
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("le password diverse o corte non partono", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/account", GIULIA);
    await user.type(await screen.findByLabelText("Current password"), "stubwise");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "shorter");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("The passwords don't match.")).toBeVisible();
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("Confirm new password"), "short");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Use at least 8 characters.")).toBeVisible();
    expect(state.passwords.has(GIULIA)).toBe(false);
  });

  it("nome: Save compare con una modifica e il nome cambia; email non valida si dice sotto il campo", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/account", GIULIA);
    const name = await screen.findByLabelText("Name");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await user.clear(name);
    await user.type(name, "Giulia Ferri Neri");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeVisible();
    expect((await me.getMyProfile()).name).toBe("Giulia Ferri Neri");

    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "nope");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a full email address.")).toBeVisible();
  });

  it("Proposals che non si cambia: ✕, la frase e Retry, che rifà il cambio", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/account", GIULIA);
    const proposals = await screen.findByRole("switch", { name: "Proposals" });
    failNext("me.setProposals");
    await user.click(proposals);
    expect(await screen.findByText("Couldn't change Proposals. Try again.")).toBeVisible();
    expect(state.mailboxes.find((b) => b.personId === GIULIA)!.proposalsEnabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(state.mailboxes.find((b) => b.personId === GIULIA)!.proposalsEnabled).toBe(false),
    );
  });

  it("caselle Google: Proposals, scollegare (dice Posta, Calendario e Drive), collegare con l'esito di Google", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/account", GIULIA);
    const proposals = await screen.findByRole("switch", { name: "Proposals" });
    expect(proposals).toHaveAttribute("aria-checked", "true");
    await user.click(proposals);
    await waitFor(() =>
      expect(state.mailboxes.find((b) => b.personId === GIULIA)!.proposalsEnabled).toBe(false),
    );
    const email = state.mailboxes.find((b) => b.personId === GIULIA)!.email;

    await user.click(screen.getByRole("button", { name: `More for ${email}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect…" }));
    const confirm = await screen.findByRole("group", { name: "Disconnect — sure?" });
    expect(within(confirm).getByText(/Mail and Calendar will stop showing/)).toBeVisible();
    expect(within(confirm).getByText(/same Google account as your Drive/)).toBeVisible();
    await user.click(within(confirm).getByRole("button", { name: "Disconnect — sure?" }));
    expect(
      await screen.findByText(
        "No mailbox connected. Connect one to see your mail and calendar in Stubwise.",
      ),
    ).toBeVisible();
    expect(state.mailboxes.some((b) => b.personId === GIULIA)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect a mailbox" });
    // Il consenso del web resta, in un paragrafo a sé.
    expect(within(dialog).getByText(/send them to the AI analysis provider/)).toBeVisible();
    await user.click(within(dialog).getByRole("radio", { name: "Wrong domain" }));
    await user.click(within(dialog).getByRole("button", { name: "Continue on Google" }));
    expect(
      await within(dialog).findByText(/not on a domain of the chosen Workspace/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("radio", { name: "Connected" }));
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Connect a mailbox" })).toBeNull(),
    );
    expect(await screen.findByRole("switch", { name: "Proposals" })).toBeVisible();
    expect(state.mailboxes.some((b) => b.personId === GIULIA)).toBe(true);
  });

  it("Laura: la casella da ricollegare dice perché e offre Reconnect sulla riga", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/account", LAURA);
    expect(
      await screen.findByText("Needs reconnecting: access was revoked on Google"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    const dialog = await screen.findByRole("dialog", { name: /^Reconnect / });
    await user.click(within(dialog).getByRole("button", { name: "Continue on Google" }));
    await waitFor(() => expect(screen.queryByText(/Needs reconnecting/)).toBeNull());
  });
});

describe("Security", () => {
  it("Sara: Off → Set up now → QR e chiave → primo codice → On, e i codici di backup una volta", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", SARA);
    await heading("Security");
    await waitFor(() =>
      expect(document.querySelector('[data-security-status="off"]')).toHaveTextContent("Off"),
    );
    // Senza l'app non ci sono passkey né codici.
    expect(screen.queryByRole("heading", { name: "Passkeys" })).toBeNull();
    // Un bottone solo per la stessa azione [R2].
    expect(screen.queryAllByRole("button", { name: /^Set up/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Set up now" }));
    expect(
      await screen.findByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeVisible();
    expect(screen.getByText("Prototype: this QR code is made up.")).toBeVisible();
    await user.type(screen.getByLabelText("First code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("heading", { name: "Your backup codes" })).toBeVisible();
    expect(await screen.findByText(/^On · authenticator app/)).toBeVisible();
    const codes = within(screen.getByTestId("secret-once")).getAllByRole("listitem");
    expect(codes).toHaveLength(10);
  });

  it("passkey: aggiungi (con riconferma), rinomina, rimuovi", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", LAURA);
    await screen.findByRole("heading", { name: "Passkeys" });
    expect(
      await screen.findByText(/^On · authenticator app, 1 passkey, 10 backup codes left/),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add passkey" }));
    await user.type(screen.getByLabelText("Name this passkey"), "Work laptop");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Simulate passkey" }));
    await confirmItsYou(user);
    expect(await screen.findByText("Work laptop")).toBeVisible();
    expect(state.passkeys.filter((k) => k.personId === LAURA)).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Rename Work laptop" }));
    const field = screen.getByLabelText("New name for Work laptop");
    await user.clear(field);
    await user.type(field, "Office iMac{Enter}");
    expect(await screen.findByText("Office iMac")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "More for Office iMac" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    await user.click(await screen.findByRole("button", { name: "Remove — sure?" }));
    await waitFor(() => expect(screen.queryByText("Office iMac")).toBeNull());
    expect(state.passkeys.filter((k) => k.personId === LAURA)).toHaveLength(1);
  });

  it("una passkey fallita lo dice e non aggiunge niente", async () => {
    const user = userEvent.setup();
    markReauthenticated(LAURA);
    renderRoute("/preferences/security", LAURA);
    await user.click(await screen.findByRole("button", { name: "Add passkey" }));
    await user.type(screen.getByLabelText("Name this passkey"), "Broken");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Simulate a failed passkey" }));
    expect(await screen.findByText("The passkey wasn't created. Try again.")).toBeVisible();
    expect(state.passkeys.filter((k) => k.personId === LAURA)).toHaveLength(1);
  });

  it("codici di backup: si vedono una volta; dopo la navigazione il DOM non li contiene", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", LAURA);
    await user.click(await screen.findByRole("button", { name: "Make new codes" }));
    expect(screen.getByText("The current codes stop working right away.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Make new codes — sure?" }));
    await confirmItsYou(user);
    const block = await screen.findByTestId("secret-once");
    expect(within(block).getByRole("heading", { name: "Your new backup codes" })).toHaveFocus();
    const codes = within(block)
      .getAllByRole("listitem")
      .map((li) => li.textContent!);
    expect(codes).toHaveLength(10);
    expect(screen.getByText(/Copy it now\. It's shown only this time/)).toBeVisible();

    await goTo(user, "Tokens");
    await goTo(user, "Security");
    await screen.findByRole("heading", { name: "Backup codes" });
    for (const code of codes) expect(document.body.textContent).not.toContain(code);
  });

  it("Done toglie i codici dal DOM", async () => {
    const user = userEvent.setup();
    markReauthenticated(LAURA);
    renderRoute("/preferences/security", LAURA);
    await user.click(await screen.findByRole("button", { name: "Make new codes" }));
    await user.click(screen.getByRole("button", { name: "Make new codes — sure?" }));
    const block = await screen.findByTestId("secret-once");
    const first = within(block).getAllByRole("listitem")[0]!.textContent!;
    await user.click(within(block).getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("secret-once")).toBeNull();
    expect(document.body.textContent).not.toContain(first);
  });

  it("sessioni: questa e le altre; Sign out ne chiude una", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/security", GIULIA);
    expect(await screen.findByText("this device")).toBeVisible();
    const out = screen.getAllByRole("button", { name: /^Sign out of / });
    expect(out).toHaveLength(2);
    await user.click(out[0]!);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Sign out of / })).toHaveLength(1),
    );
  });
});

describe("Tokens", () => {
  it("creato (con riconferma) e copiato; alla riapertura c'è solo il nome; revoca", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/tokens", LAURA);
    await heading("Tokens");
    await user.click(await screen.findByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "my-laptop MCP");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await confirmItsYou(user);
    const block = await screen.findByTestId("secret-once");
    const value = within(block).getByText(/^stw_pat_/).textContent!;
    expect(within(block).getByRole("heading", { name: "Token “my-laptop MCP”" })).toHaveFocus();
    await user.click(within(block).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(value);
    expect(within(block).getByRole("button", { name: "Copied" })).toBeVisible();

    await goTo(user, "Claude Code");
    await goTo(user, "Tokens");
    expect(await screen.findByText("my-laptop MCP")).toBeVisible();
    expect(document.body.textContent).not.toContain(value);
    expect(document.body.textContent).not.toContain("stw_pat_");

    await user.click(screen.getByRole("button", { name: "Revoke my-laptop MCP" }));
    await user.click(screen.getByRole("button", { name: "Revoke — sure?" }));
    await waitFor(() => expect(screen.queryByText("my-laptop MCP")).toBeNull());
    expect(state.tokens.some((t) => t.name === "my-laptop MCP")).toBe(false);
  });

  it("il valore non passa a un'altra persona col «vedi come»", async () => {
    const user = userEvent.setup();
    markReauthenticated(LAURA);
    renderRoute("/preferences/tokens", LAURA);
    await user.click(await screen.findByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "laptop");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const value = within(await screen.findByTestId("secret-once")).getByText(
      /^stw_pat_/,
    ).textContent!;

    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name: /Marco Bellini/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("secret-once")).toBeNull());
    expect(document.body.textContent).not.toContain(value);
  });

  it("una scadenza nel passato si dice sotto il campo", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/tokens", LAURA);
    await user.click(await screen.findByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "old");
    await user.type(screen.getByLabelText("Expires"), "2020-01-01");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByText("Pick a date in the future.")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
  });
});

describe("Claude Code", () => {
  it("il comando col token, una volta (con riconferma); il token compare in Tokens", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/claude-code", MARCO);
    await heading("Claude Code");
    expect(screen.getByRole("link", { name: "nodejs.org" })).toHaveAttribute(
      "href",
      "https://nodejs.org",
    );
    await user.click(screen.getByRole("button", { name: "Create the command" }));
    await confirmItsYou(user);
    const block = await screen.findByTestId("secret-once");
    const command = block.querySelector("[data-secret-value]")!.textContent!;
    expect(command).toContain("npx -y @stubwise/mcp@latest setup");
    expect(command).toMatch(/--token stw_pat_\w+/);
    const token = command.match(/stw_pat_\w+/)![0];
    expect(screen.getByText(/It also created the token “Claude Code · /)).toBeVisible();

    await goTo(user, "Tokens");
    expect(await screen.findAllByText(/^Claude Code · /)).toHaveLength(2);
    expect(document.body.textContent).not.toContain(token);
    await goTo(user, "Claude Code");
    expect(document.body.textContent).not.toContain(token);
  });

  it("le quattro domande da fare a Claude, ognuna copiabile", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/claude-code", MARCO);
    await heading("Claude Code");
    await user.click(screen.getByRole("button", { name: "Copy “Where are my requests at?”" }));
    expect(await navigator.clipboard.readText()).toBe("Where are my requests at?");
    expect(screen.getAllByRole("button", { name: /^Copy “/ })).toHaveLength(4);
  });
});

describe("Language & theme", () => {
  it("lingua e tema cambiano davvero, con gli stessi controlli del menu del profilo", async () => {
    const user = userEvent.setup();
    renderRoute("/preferences/look", GIULIA);
    await heading("Language & theme");
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("radio", { name: "Italiano" }));
    expect(await heading("Lingua e tema")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Italiano" })).toBeChecked();
  });
});
