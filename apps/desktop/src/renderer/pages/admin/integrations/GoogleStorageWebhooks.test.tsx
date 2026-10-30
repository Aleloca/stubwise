import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __secretValuesForTest } from "../../../data/admin/secrets";
import { resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import { grantInstancePermission, type LocalInstancePermission } from "../../../data/viewer";
import i18n from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { resetReauthForTest } from "../../../layout/useReauth";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// Google Workspace, Storage e Outgoing webhooks dell'Amministrazione (area
// 9b, Task 11, shape admin-integrations.md). Roberta è full admin e non ha
// una casella Google; Giulia, Matteo e Laura hanno una casella @example.com.
// Luca, con la concessione di `integrations.manage`, vede due di quelle tre
// persone: prova che il rifiuto «in uso» conta le altre senza nominarle
// (R-G5).

const ROBERTA = "p-roberta";
const LUCA = "p-luca";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  clearToasts();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  resetApi();
  await i18n.changeLanguage("en");
});

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const app = (name: string) => state.googleWorkspaces.find((w) => w.name === name);

/** Il dialogo «Confirm it's you»: il codice del prototipo, e l'azione riparte da sola. */
async function confirmItsYou(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(dialog).getByLabelText("Code"), "123456");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
  );
}

type Router = ReturnType<typeof renderRoute>;

/** Via (People) e ritorno alla voce: le letture ripartono da capo. */
async function awayAndBack(router: Router, section: string, title: string) {
  await act(() => router.navigate({ to: "/admin/$section", params: { section: "people" } }));
  await heading("People");
  await act(() => router.navigate({ to: "/admin/$section", params: { section } }));
  await heading(title);
}

/** RF 1: nessun segreto del caveau compare nel DOM. */
function expectNoSecretInDom(written: string) {
  const secrets = __secretValuesForTest().flatMap((s) => s.values);
  expect(secrets).toContain(written);
  for (const v of secrets) expect(document.body.innerHTML).not.toContain(v);
}

// --- Google Workspace -----------------------------------------------------------

describe("Google Workspace", () => {
  it("la riga: domini, client ID, ultime 4 e caselle collegate", async () => {
    renderRoute("/admin/google", ROBERTA);
    expect(await heading("Google Workspace")).toBeVisible();
    const list = await screen.findByRole("list", { name: "Google apps" });
    const row = within(list).getByRole("listitem", { name: "Example" });
    expect(within(row).getByText("example.com")).toBeVisible();
    expect(within(row).getByText("•••• q8vz")).toBeVisible();
    expect(within(row).getByText("3 mailboxes connected")).toBeVisible();
    expect(
      within(row).getByText("418207593361-proto4example.apps.googleusercontent.com"),
    ).toBeVisible();
  });

  it("aggiunge un'app: errori dal livello dati, riconferma, ultime 4; compare in Preferenze → Account (RF 1)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/google", ROBERTA);
    await screen.findByRole("list", { name: "Google apps" });
    await user.click(screen.getByRole("button", { name: "Add an app" }));
    const dialog = screen.getByRole("dialog", { name: "Add a Google app" });

    // I campi vuoti dicono cosa manca.
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByText("Give it a name.")).toBeVisible();
    expect(within(dialog).getByText("Add at least one domain.")).toBeVisible();

    await user.type(within(dialog).getByLabelText("Name"), "Audin Workspace");
    const domains = within(dialog).getByLabelText("Email domains");
    // Un dominio malformato: la frase lo nomina.
    await user.type(domains, "acme{Enter}");
    await user.type(within(dialog).getByLabelText("Client ID"), "1234-audin.apps.googleusercontent.com");
    const secret = within(dialog).getByLabelText("Client secret");
    expect(secret).toHaveAttribute("type", "password");
    const value = "GOCSPX-audin-very-secret-7d1e";
    await user.type(secret, value);
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText("“acme” isn't a domain: use a form like acme.com."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();

    // Un dominio già di un'altra app: la frase dice di quale.
    await user.click(within(dialog).getByRole("button", { name: "Remove acme" }));
    await user.type(domains, "audin.it,example.com,");
    expect(within(dialog).getByRole("button", { name: "Remove audin.it" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText("example.com already belongs to Example."),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Remove example.com" }));

    // La guida di Google Cloud, chiusa di default.
    const setup = within(dialog).getByText("How to set it up in Google Cloud");
    await user.click(setup);
    expect(
      within(dialog).getByText("https://stubwise.example.test/api/me/google/callback"),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await confirmItsYou(user);
    expect(
      await screen.findByText(
        "Audin Workspace added. People with an audin.it address can connect it in Preferences → Account.",
      ),
    ).toBeVisible();
    await waitFor(() => expect(app("Audin Workspace")?.domains).toEqual(["audin.it"]));
    const row = await screen.findByRole("listitem", { name: "Audin Workspace" });
    expect(within(row).getByText("•••• 7d1e")).toBeVisible();
    expect(within(row).getByText("No mailboxes connected")).toBeVisible();

    // Via e ritorno: il secret non c'è da nessuna parte (RF 1).
    await awayAndBack(router, "google", "Google Workspace");
    await screen.findByRole("listitem", { name: "Audin Workspace" });
    expectNoSecretInDom(value);

    // Roberta non ha una casella: in Preferenze → Account la nuova app è fra quelle da scegliere.
    await act(() => router.navigate({ to: "/preferences/$section", params: { section: "account" } }));
    await user.click(await screen.findByRole("button", { name: "Connect a mailbox" }));
    const connect = await screen.findByRole("dialog", { name: "Connect a mailbox" });
    expect(within(connect).getByRole("radio", { name: "Audin Workspace" })).toBeVisible();
  });

  it("sostituisce il client secret: riconferma, poi le ultime 4 nuove (RF 1)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/google", ROBERTA);
    await screen.findByRole("list", { name: "Google apps" });
    await user.click(screen.getByRole("button", { name: "More for Example" }));
    await user.click(await screen.findByRole("menuitem", { name: "Replace secret…" }));
    const dialog = screen.getByRole("dialog", { name: "Replace the client secret of Example" });
    const value = "GOCSPX-example-new-secret-3x9k";
    await user.type(within(dialog).getByLabelText("Client secret"), value);
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await confirmItsYou(user);
    expect(await screen.findByText("Client secret of Example replaced.")).toBeVisible();
    const row = await screen.findByRole("listitem", { name: "Example" });
    await waitFor(() => expect(within(row).getByText("•••• 3x9k")).toBeVisible());
    await awayAndBack(router, "google", "Google Workspace");
    await screen.findByRole("listitem", { name: "Example" });
    expectNoSecretInDom(value);
  });

  it("un'app con caselle non si elimina, e il dialogo dice perché", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/google", ROBERTA);
    await screen.findByRole("list", { name: "Google apps" });
    await user.click(screen.getByRole("button", { name: "More for Example" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", {
      name: "Example still has 3 connected mailboxes",
    });
    expect(within(dialog).getByText("Giulia Ferri, Matteo Conti and Laura Costa.")).toBeVisible();
    expect(
      within(dialog).getByText("Each person disconnects their own in Preferences → Account."),
    ).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    expect(app("Example")).toBeDefined();
  });

  it("le persone che chi guarda non vede sono solo contate (R-G5)", async () => {
    grantInstancePermission(LUCA, "integrations.manage" as LocalInstancePermission);
    const user = userEvent.setup();
    renderRoute("/admin/google", LUCA);
    await screen.findByRole("list", { name: "Google apps" });
    await user.click(screen.getByRole("button", { name: "More for Example" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", {
      name: "Example still has 3 connected mailboxes",
    });
    expect(within(dialog).getByText(/ and 1 more person\.$/)).toBeVisible();
  });

  it("togliere un dominio con caselle collegate: rifiutato, con chi le usa", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/google", ROBERTA);
    await screen.findByRole("list", { name: "Google apps" });
    await user.click(screen.getByRole("button", { name: "More for Example" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit…" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Example" });
    await user.click(within(dialog).getByRole("button", { name: "Remove example.com" }));
    await user.type(within(dialog).getByLabelText("Email domains"), "example.org{Enter}");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "Mailboxes still use a domain you removed: Giulia Ferri, Matteo Conti and Laura Costa. Each person disconnects their own in Preferences → Account.",
      ),
    ).toBeVisible();
    expect(app("Example")?.domains).toEqual(["example.com"]);
  });
});

// --- Storage --------------------------------------------------------------------

describe("Storage", () => {
  it("salva, prova con l'esito simulato, spegne gli allegati: la riga di stato lo dice", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/storage", ROBERTA);
    expect(await heading("Storage")).toBeVisible();
    expect(await screen.findByText("Uploads are on.")).toBeVisible();
    expect(screen.getByText("Files already uploaded stay where they are.")).toBeVisible();
    expect(screen.getByText("•••• w3m7")).toBeVisible();

    // Salvare senza chiave nuova: nessuna riconferma.
    const bucket = screen.getByLabelText("Bucket");
    await user.clear(bucket);
    await user.type(bucket, "stubwise-prod");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    expect(state.instance.storage.bucket).toBe("stubwise-prod");
    expect(await screen.findByText("not checked yet")).toBeVisible();

    // La prossima verifica non raggiunge il bucket: i caricamenti si spengono.
    const box = screen.getByRole("region", { name: "Prototype only" });
    await user.click(within(box).getByRole("radio", { name: "Unreachable" }));
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("unreachable")).toBeVisible();
    expect(await screen.findByText("Uploads are off: the last check failed.")).toBeVisible();

    await user.click(within(box).getByRole("radio", { name: "Works" }));
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Uploads are on.")).toBeVisible();

    // Spegnere gli allegati: conferma a due tempi, poi subito.
    await user.click(screen.getByRole("switch", { name: "Attachments" }));
    const confirm = screen.getByRole("group", { name: "Turn off uploads for everyone?" });
    expect(state.instance.storage.attachmentsEnabled).toBe(true);
    await user.click(within(confirm).getByRole("button", { name: "Turn off" }));
    expect(
      await screen.findByText("Uploads are off: attachments are turned off."),
    ).toBeVisible();
    expect(state.instance.storage.attachmentsEnabled).toBe(false);
    expect(screen.getByRole("switch", { name: "Attachments" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("una chiave nuova chiede la riconferma; poi solo le ultime 4 (RF 1)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/storage", ROBERTA);
    await screen.findByText("Uploads are on.");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    const value = "s3-secret-access-key-prod-k4q2";
    await user.type(screen.getByLabelText("Secret access key"), value);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await confirmItsYou(user);
    expect(await screen.findByText("Saved.")).toBeVisible();
    expect(await screen.findByText("•••• k4q2")).toBeVisible();
    expect(state.instance.storage.last4).toBe("k4q2");
    await awayAndBack(router, "storage", "Storage");
    await screen.findByText("•••• k4q2");
    expectNoSecretInDom(value);
  });
});

// --- Outgoing webhooks -------------------------------------------------------------

describe("Outgoing webhooks", () => {
  it("formato e indirizzo: salvati senza riconferma, riaprendo la pagina l'indirizzo si rilegge in chiaro", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/webhooks", ROBERTA);
    expect(await heading("Outgoing webhooks")).toBeVisible();
    const address = await screen.findByLabelText("Address");
    expect(address).toHaveAttribute("type", "text");
    expect(address).toHaveValue("https://hooks.slack.com/services/T01AUDIN/B07STUB/prototype");
    expect(
      screen.getByText("Anyone who can change the instance settings can read this address."),
    ).toBeVisible();

    // Gli errori sotto il campo, dal livello dati.
    await user.clear(address);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Add the address, or turn messages off.")).toBeVisible();
    await user.type(address, "http://discord.example/hook");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Use an https address.")).toBeVisible();

    const url = "https://discord.com/api/webhooks/1188/stubwise-acq";
    await user.clear(address);
    await user.type(address, url);
    await user.click(screen.getByRole("radio", { name: "Discord" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    expect(state.instance.webhook).toMatchObject({ url, format: "discord" });

    await awayAndBack(router, "webhooks", "Outgoing webhooks");
    expect(await screen.findByLabelText("Address")).toHaveValue(url);
    expect(screen.getByRole("radio", { name: "Discord" })).toHaveAttribute("aria-checked", "true");
  });

  it("un interruttore per ognuno dei 21 eventi, nei sei gruppi; nessuna riga per le risposte dei clienti", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/webhooks", ROBERTA);
    const events = await screen.findByRole("region", { name: "Events" });
    const groups = within(events).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Tasks and requests",
      "Claude's work",
      "Pull requests and releases",
      "Docs",
      "Servers",
      "Project",
    ]);
    const switches = within(events).getAllByRole("switch");
    expect(switches).toHaveLength(21);
    expect(within(events).getByText("4 of 21 on")).toBeVisible();
    expect(within(groups[1]!).getAllByRole("switch").map((s) => s.getAttribute("aria-label")))
      .toEqual([
        "Plan waiting for approval",
        "Claude asked a question",
        "Work on hold",
        "Work on hold: budget reached",
        "Claude's work failed",
      ]);
    expect(within(events).queryByText(/customer|client/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/customer repl/i);

    await user.click(within(events).getByRole("switch", { name: "Release failed" }));
    expect(within(events).getByText("5 of 21 on")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeVisible();
    expect(state.instance.webhook.events["release.failed"]).toBe(true);
  });

  it("l'anteprima segue il formato e l'evento", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/webhooks", ROBERTA);
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(within(preview).getByText("Example data")).toBeVisible();
    // Slack, «New task in ACQ»: il codice in grassetto.
    expect(within(preview).getByText(/^New task in ACQ:/)).toBeVisible();
    expect(within(preview).getByText("ACQ-42").tagName).toBe("STRONG");

    // Il fuoco su un evento cambia l'anteprima.
    const events = screen.getByRole("region", { name: "Events" });
    await user.click(within(events).getByRole("switch", { name: "Claude's work failed" }));
    expect(within(preview).getByText(/^Claude's work on/)).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "Generic JSON" }));
    const code = within(preview).getByText(/"event": "job.failed"/);
    expect(code.tagName).toBe("CODE");
    expect(code.textContent).toContain('"code": "ACQ-42"');

    await user.click(screen.getByRole("radio", { name: "Discord" }));
    expect(within(preview).getByText("ACQ-42").tagName).toBe("STRONG");
    expect(within(preview).queryByText(/\*\*/)).toBeNull();
  });

  it("manda una prova con l'esito scelto nel riquadro «Prototype only»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/webhooks", ROBERTA);
    await screen.findByLabelText("Address");
    const box = screen.getByRole("region", { name: "Prototype only" });
    expect(
      within(box).getByText("Nothing real is contacted. Choose what the next test answers."),
    ).toBeVisible();
    await user.click(within(box).getByRole("radio", { name: "Unreachable" }));
    await user.click(screen.getByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("Couldn't reach the address")).toBeVisible();
    await user.click(within(box).getByRole("radio", { name: "Error from the address" }));
    await user.click(screen.getByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("The address answered with an error")).toBeVisible();
    await user.click(within(box).getByRole("radio", { name: "Delivered" }));
    await user.click(screen.getByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("Sent · delivered")).toBeVisible();
    expect(state.instance.webhook.lastTest?.outcome).toBe("ok");
  });
});
