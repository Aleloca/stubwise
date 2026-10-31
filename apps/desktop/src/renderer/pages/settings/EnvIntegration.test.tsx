import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __secretValuesForTest } from "../../data/admin/secrets";
import { failNext, projectSettings, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

// File d'ambiente e Integration (area 9c, Task 9, shape
// project-repositories.md «I file d'ambiente» e «Integration»). Laura è
// Project Lead in STW e in ACQ (`repos.manage`, `project.settings.manage`);
// Marco è Developer in ACQ, a cui si toglie `repos.manage` (ruling (T4));
// Sara è Contributor in ACQ: membro, senza nessuno dei due. I valori segreti
// non devono restare nel DOM dopo la chiusura del dialogo né dopo la
// navigazione (RF 2).

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  clearToasts();
  resetViewerGrants();
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

const h1 = (name: string) => screen.findByRole("heading", { level: 1, name });

async function openRepository(person: string, id: string, name: string, code: string) {
  renderRoute(`/p/${code}/settings/repositories?repo=${id}`, person);
  return await h1(name);
}

async function openIntegration(person: string, code = "ACQ") {
  renderRoute(`/p/${code}/settings/integration`, person);
  return await h1("Integration");
}

/** La finestra di grazia della riconferma si chiude: la prossima azione delicata la chiede di nuovo. */
const expireReauth = (person: string) => state.reauth.delete(person);

/** La riconferma, se la finestra di grazia è chiusa: il Retry passa di nuovo da lei. */
async function reauthIfAsked(user: UserEvent) {
  const confirm = await screen
    .findByRole("dialog", { name: "Confirm it's you" }, { timeout: 300 })
    .catch(() => null);
  if (confirm) await user.type(within(confirm).getByLabelText("Code"), "123456");
}

/** La riconferma del prototipo: il codice, poi l'azione riparte da sola. */
async function reauth(user: UserEvent) {
  const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(confirm).getByLabelText("Code"), "123456");
}

const envGroup = (name: RegExp) => screen.findByRole("group", { name });
const fileRow = (group: HTMLElement, path: string) =>
  within(group).getByRole("listitem", { name: path });
const body = () => document.body.innerHTML;

describe("i file d'ambiente, da Laura in STW", () => {
  it("test dice che arriva a Claude, production che no; delle variabili solo il nome e la data", async () => {
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const section = await screen.findByRole("region", { name: "Environment files" });
    expect(section).toHaveTextContent(
      "Only the test environment's files reach Claude: they're copied into its working copy before install and tests.",
    );
    const test = await envGroup(/^TEST/i);
    expect(test).toHaveTextContent("Claude reads these");
    expect(test).not.toHaveTextContent("never");
    const production = await envGroup(/^PRODUCTION/i);
    expect(production).toHaveTextContent("Claude never reads these");
    const staging = await envGroup(/^STAGING/i);
    expect(staging).toHaveTextContent("No files for Staging.");
    const env = fileRow(test, ".env");
    expect(env).toHaveTextContent("3 variables");
    const vars = within(env).getAllByRole("listitem");
    expect(vars.map((v) => v.getAttribute("aria-label"))).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "STUBWISE_TEST_TOKEN",
    ]);
    expect(vars[0]).toHaveTextContent(/set [A-Z][a-z]{2} \d{1,2}/);
    expect(within(vars[0]!).queryByRole("button", { name: /Show/ })).toBeNull();
  });

  it("nuovo file .env.local in staging; un percorso già preso lo dice", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const staging = await envGroup(/^STAGING/i);
    const newFile = within(staging).getByRole("button", { name: "New file" });
    await user.click(newFile);
    let dialog = await screen.findByRole("dialog", { name: "New file for Staging" });
    const path = within(dialog).getByRole("textbox", { name: "Path" });
    await user.type(path, "../.env");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(
      await within(dialog).findByText(
        "Use a path inside the repository, without .. or a leading /.",
      ),
    ).toBeInTheDocument();
    await user.clear(path);
    await user.type(path, ".env.local");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(staging).findByRole("listitem", { name: ".env.local" })).toHaveTextContent(
      "0 variables",
    );
    expect(newFile).toHaveFocus();

    // Lo stesso percorso nello stesso ambiente.
    await user.click(newFile);
    dialog = await screen.findByRole("dialog", { name: "New file for Staging" });
    await user.type(within(dialog).getByRole("textbox", { name: "Path" }), ".env.local");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Staging already has .env.local.")).toBeInTheDocument();
  });

  it("import incollato con una riga rotta: «2 imported, 1 replaced, line 3 skipped», mai i valori", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const test = await envGroup(/^TEST/i);
    const importButton = within(fileRow(test, ".env")).getByRole("button", { name: "Import…" });
    await user.click(importButton);
    const dialog = await screen.findByRole("dialog", { name: "Import into .env (Test)" });
    const area = within(dialog).getByRole("textbox", { name: "Variables" });
    await user.click(area);
    await user.paste(
      [
        "FEATURE_FLAG=proto-flag-value-0001",
        "DATABASE_URL=postgres://proto-db-value-0002",
        "this line is broken",
        "SMTP_PASSWORD=proto-smtp-value-0003",
      ].join("\n"),
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    // L'area si svuota subito, prima della riconferma.
    expect(area).toHaveValue("");
    await reauth(user);
    expect(
      await within(dialog).findByText("2 imported, 1 replaced, line 3 skipped."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Line 3: not in KEY=value form.")).toBeInTheDocument();
    expect(body()).not.toContain("proto-flag-value-0001");
    expect(body()).not.toContain("this line is broken");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fileRow(test, ".env")).toHaveTextContent("5 variables");
    expect(importButton).toHaveFocus();
  });

  it("niente di valido: la frase, il dialogo aperto, nessuna riconferma", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const test = await envGroup(/^TEST/i);
    await user.click(within(fileRow(test, ".env")).getByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import into .env (Test)" });
    await user.type(within(dialog).getByRole("textbox", { name: "Variables" }), "# solo commenti");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await within(dialog).findByText("Nothing to import: no line is in KEY=value form."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
  });

  it("niente di valido con la riconferma scaduta: il rifiuto arriva prima della riconferma", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    expireReauth(LAURA);
    const test = await envGroup(/^TEST/i);
    await user.click(within(fileRow(test, ".env")).getByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import into .env (Test)" });
    await user.type(within(dialog).getByRole("textbox", { name: "Variables" }), "# solo commenti");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await within(dialog).findByText("Nothing to import: no line is in KEY=value form."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
  });

  it("un errore, poi Retry: l'esito dell'import compare come al primo tentativo", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const test = await envGroup(/^TEST/i);
    await user.click(within(fileRow(test, ".env")).getByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import into .env (Test)" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Variables" }),
      "RETRY_KEY=proto-retry-0001",
    );
    failNext("projectSettings.importEnvFile");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(await within(dialog).findByText("Couldn't save. Try again.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await reauthIfAsked(user);
    expect(await within(dialog).findByText("1 imported.")).toBeInTheDocument();
  });

  it("un errore, poi Retry: Set variable si chiude col toast e il fuoco torna a Replace…", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const production = await envGroup(/^PRODUCTION/i);
    const row = () =>
      within(fileRow(production, ".env")).getByRole("listitem", { name: "DATABASE_URL" });
    await user.click(within(row()).getByRole("button", { name: "Replace…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Set a variable in .env (Production)",
    });
    await user.type(within(dialog).getByLabelText("Value"), "proto-retry-0002");
    failNext("projectSettings.setEnvVar");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Couldn't save. Try again.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await reauthIfAsked(user);
    expect(await screen.findByText("DATABASE_URL set in .env (Production).")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(within(row()).getByRole("button", { name: "Replace…" })).toHaveFocus(),
    );
  });

  it("sostituisci, rimuovi, elimina il file: ognuna con la riconferma; il fuoco torna al bottone o al New file", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const production = await envGroup(/^PRODUCTION/i);
    const newFile = within(production).getByRole("button", { name: "New file" });
    const dbRow = () =>
      within(fileRow(production, ".env")).getByRole("listitem", { name: "DATABASE_URL" });

    // Sostituisci.
    const replace = within(dbRow()).getByRole("button", { name: "Replace…" });
    await user.click(replace);
    let dialog = await screen.findByRole("dialog", { name: "Set a variable in .env (Production)" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveAttribute("readonly");
    const value = within(dialog).getByLabelText("Value");
    expect(value).toHaveAttribute("type", "password");
    // Di un valore d'ambiente non resta nemmeno la coda (RF 2), e il campo lo dice.
    expect(value).toHaveAccessibleDescription(
      "Once saved, no one can read it again, not even you: you can only replace it.",
    );
    expect(dialog).not.toHaveTextContent(/last 4/);
    await user.type(value, "postgres://proto-replaced-0009");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await reauth(user);
    expect(await screen.findByText("DATABASE_URL set in .env (Production).")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body()).not.toContain("proto-replaced-0009");
    await waitFor(() =>
      expect(within(dbRow()).getByRole("button", { name: "Replace…" })).toHaveFocus(),
    );

    // Rimuovi: la riconferma annullata non cambia niente e lascia il dialogo aperto.
    expireReauth(LAURA);
    const sentry = within(fileRow(production, ".env")).getByRole("listitem", {
      name: "SENTRY_DSN",
    });
    await user.click(within(sentry).getByRole("button", { name: "Remove…" }));
    dialog = await screen.findByRole("dialog", {
      name: "Remove SENTRY_DSN from .env (Production)?",
    });
    expect(dialog).not.toHaveTextContent("Claude's next runs won't have it.");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Nothing was changed.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /Remove SENTRY_DSN/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await reauth(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        within(fileRow(production, ".env")).queryByRole("listitem", { name: "SENTRY_DSN" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(newFile).toHaveFocus());

    // Elimina il file, dal «⋯».
    expireReauth(LAURA);
    const more = within(fileRow(production, ".env")).getByRole("button", { name: "More for .env" });
    // Cancel: il fuoco torna al «⋯» che ha aperto il dialogo.
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Delete file…" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(more).toHaveFocus();
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Delete file…" }));
    dialog = await screen.findByRole("dialog", {
      name: "Delete .env (Production) and its 1 variable?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await reauth(user);
    expect(await screen.findByText(".env deleted from Production.")).toBeInTheDocument();
    expect(await within(production).findByText("No files for Production.")).toBeInTheDocument();
    await waitFor(() => expect(newFile).toHaveFocus());
  });

  it("Remove in test dice che le prossime esecuzioni di Claude non l'avranno", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const test = await envGroup(/^TEST/i);
    const row = within(fileRow(test, ".env")).getByRole("listitem", { name: "REDIS_URL" });
    await user.click(within(row).getByRole("button", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Remove REDIS_URL from .env (Test)?",
    });
    expect(dialog).toHaveTextContent("Claude's next runs won't have it.");
  });

  it("dopo la navigazione il DOM non contiene nessun valore (RF 2)", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-stw", "stubwise", "STW");
    const test = await envGroup(/^TEST/i);
    await user.click(within(fileRow(test, ".env")).getByRole("button", { name: "Add variable…" }));
    const dialog = await screen.findByRole("dialog", { name: "Set a variable in .env (Test)" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "NEW_KEY");
    await user.type(within(dialog).getByLabelText("Value"), "proto-new-value-0042");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await reauth(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      await within(fileRow(test, ".env")).findByRole("listitem", { name: "NEW_KEY" }),
    ).toBeInTheDocument();

    await user.click(screen.getAllByRole("link", { name: "Repositories" })[0]!);
    await h1("Repositories");
    const list = await screen.findByRole("list", { name: "Repositories of STW" });
    await user.click(
      within(list)
        .getAllByRole("link")
        .find((a) => a.getAttribute("href")?.includes("repo=repo-stw"))!,
    );
    await h1("stubwise");
    await envGroup(/^TEST/i);
    expect(body()).not.toContain("proto-new-value-0042");
    // Il valore c'è, nel caveau: solo lì.
    expect(__secretValuesForTest().some((s) => s.values.includes("proto-new-value-0042"))).toBe(
      true,
    );
  });
});

describe("senza repos.manage, o senza ambienti", () => {
  beforeEach(() => revokeProjectPermission(MARCO, ACQ, "repos.manage" as never));

  it("Marco: la parte dei file non c'è, la frase lo dice con «Who?»", async () => {
    await openRepository(MARCO, "repo-acq", "portale-utenti", "ACQ");
    const section = await screen.findByRole("region", { name: "Environment files" });
    expect(section).toHaveTextContent(
      "Environment files are visible only to people who can manage ACQ's repositories.",
    );
    expect(within(section).getByRole("button", { name: /^Who can/ })).toBeInTheDocument();
    expect(within(section).queryByRole("group")).toBeNull();
    expect(within(section).queryByRole("button", { name: "New file" })).toBeNull();
  });

  it("senza il modulo Releases, e col modulo ma senza ambienti", async () => {
    state.repositories.push({
      id: "repo-olv",
      projectId: "prj-olv",
      name: "sito-vetrina",
      fullName: "audin/sito-vetrina",
      defaultBranch: "main",
      gitAccountId: "git-bitbucket-audin",
      url: "https://bitbucket.org/audin/sito-vetrina",
      protectedBranches: [],
      webhook: { state: "not_configured", configuredAt: null, secretId: null, last4: null },
    });
    await openRepository(GIULIA, "repo-olv", "sito-vetrina", "OLV");
    expect(await screen.findByRole("region", { name: "Environment files" })).toHaveTextContent(
      "Environment files belong to an environment, and environments come with the Releases module.",
    );
    cleanup();

    state.environments = state.environments.filter((e) => e.projectId !== ACQ);
    await openRepository(LAURA, "repo-acq", "portale-utenti", "ACQ");
    const section = await screen.findByRole("region", { name: "Environment files" });
    expect(await within(section).findByText(/ACQ has none yet\. Add one in/)).toBeInTheDocument();
    expect(
      within(section).getByRole("link", { name: "Releases → Environments" }),
    ).toBeInTheDocument();
  });
});

describe("Integration", () => {
  it("Sara: DSN e snippet mascherati, Copy copia il testo mascherato e lo dice; Regenerate spento con «Who?»", async () => {
    const user = userEvent.setup();
    await openIntegration(SARA);
    setSessionPersonId(SARA);
    const view = (await projectSettings.getIntegration(ACQ))!;
    const last4 = view.ingestion.last4;

    const key = await screen.findByRole("region", { name: "Ingestion key" });
    expect(key).toHaveTextContent(`•••• ${last4}`);
    expect(key).toHaveTextContent(
      "Copy gives the text with the key hidden. Paste the full key from where you saved it when it was made, or regenerate it.",
    );
    expect(within(key).getByText(view.ingestion.maskedDsn)).toBeInTheDocument();

    await user.click(within(key).getByRole("button", { name: "Copy DSN" }));
    expect(await navigator.clipboard.readText()).toBe(view.ingestion.maskedDsn);
    expect(await within(key).findByText("Copied, with the key hidden.")).toBeInTheDocument();
    await user.click(within(key).getByRole("button", { name: "Copy SDK snippet" }));
    expect(await navigator.clipboard.readText()).toBe(view.ingestion.maskedSnippet);
    expect(view.ingestion.maskedSnippet).toContain(`••••${last4}`);

    const regenerate = within(key).getByRole("button", { name: "Regenerate key…" });
    expect(regenerate).toHaveAttribute("aria-disabled", "true");
    expect(regenerate).toHaveAccessibleDescription(
      "Making a new key needs someone who can change ACQ's settings.",
    );
    expect(within(key).getByRole("button", { name: /^Who can/ })).toBeInTheDocument();
    await user.click(regenerate);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nessun webhook git per chi non vede i repository; la riga di sola lettura in testa.
    expect(screen.queryByRole("region", { name: "Git webhooks" })).toBeNull();
    expect(document.querySelector('[data-view-only-line="manageProjectSettings"]')).not.toBeNull();
  });

  it("Laura rigenera la chiave con la riconferma: SecretOnce con chiave, DSN e snippet; chiuso e riaperto, solo le ultime 4", async () => {
    const user = userEvent.setup();
    await openIntegration(LAURA);
    expect(document.querySelector("[data-view-only-line]")).toBeNull();
    const key = await screen.findByRole("region", { name: "Ingestion key" });
    const regenerate = within(key).getByRole("button", { name: "Regenerate key…" });
    await user.click(regenerate);
    const dialog = await screen.findByRole("dialog", { name: "Make a new ingestion key for ACQ?" });
    expect(dialog).toHaveTextContent(
      "The current key stops working now: errors and events sent with it are refused.",
    );
    expect(dialog).toHaveTextContent("The new key is shown only once.");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await reauth(user);

    const once = await within(dialog).findByTestId("secret-once");
    expect(once).toHaveTextContent("This key is shown only now.");
    const secret = __secretValuesForTest().find((s) => s.kind === "ingestion_key")!.values[0]!;
    const values = [...once.querySelectorAll("[data-secret-value]")].map((v) => v.textContent);
    expect(values[0]).toBe(secret);
    expect(values[1]).toBe(`https://${secret}@stubwise.example.test/ingest/ACQ`);
    expect(values[2]).toContain(`dsn: "https://${secret}@stubwise.example.test/ingest/ACQ"`);
    expect(within(once).getAllByRole("button", { name: /^Copy/ })).toHaveLength(3);

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body()).not.toContain(secret);
    expect(
      await within(key).findByText(new RegExp(`•••• ${secret.slice(-4)}`)),
    ).toBeInTheDocument();
    expect(regenerate).toHaveFocus();

    // Chiuso e riaperto: solo le ultime 4.
    cleanup();
    await openIntegration(LAURA);
    const again = await screen.findByRole("region", { name: "Ingestion key" });
    expect(again).toHaveTextContent(`•••• ${secret.slice(-4)}`);
    expect(again).toHaveTextContent(/by Laura Costa/);
    expect(body()).not.toContain(secret);
  });

  it("un errore, poi Retry: la chiave rigenerata compare in SecretOnce", async () => {
    const user = userEvent.setup();
    await openIntegration(LAURA);
    const key = await screen.findByRole("region", { name: "Ingestion key" });
    await user.click(within(key).getByRole("button", { name: "Regenerate key…" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a new ingestion key for ACQ?" });
    failNext("projectSettings.regenerateIngestionKey");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    expect(await within(dialog).findByText("Couldn't save. Try again.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await reauthIfAsked(user);
    const once = await within(dialog).findByTestId("secret-once");
    const secret = __secretValuesForTest().find((s) => s.kind === "ingestion_key")!.values[0]!;
    expect(once.querySelector("[data-secret-value]")).toHaveTextContent(secret);
  });

  it("un errore, poi Retry: il secret del webhook compare in SecretOnce", async () => {
    const user = userEvent.setup();
    await openIntegration(LAURA);
    const hooks = await screen.findByRole("region", { name: "Git webhooks" });
    const row = within(hooks).getByRole("listitem", { name: "portale-utenti" });
    await user.click(within(row).getByRole("button", { name: "Regenerate secret…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Make a new webhook secret for portale-utenti?",
    });
    failNext("projectSettings.regenerateWebhookSecret");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    expect(await within(dialog).findByText("Couldn't save. Try again.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await reauthIfAsked(user);
    const once = await within(dialog).findByTestId("secret-once");
    const secret = __secretValuesForTest().find((s) => s.kind === "git_webhook_secret")!.values[0]!;
    expect(once.querySelector("[data-secret-value]")).toHaveTextContent(secret);
  });

  it("il secret del webhook di un repository: Laura lo rigenera; Marco lo vede spento con «Who?»", async () => {
    const user = userEvent.setup();
    await openIntegration(LAURA);
    const git = await screen.findByRole("region", { name: "Git webhooks" });
    const row = within(git).getByRole("listitem", { name: "portale-utenti" });
    expect(row).toHaveTextContent("No secret yet");
    expect(row).toHaveTextContent("https://stubwise.example.test/webhooks/git/repo-acq");
    const regenerate = within(row).getByRole("button", { name: "Regenerate secret…" });
    await user.click(regenerate);
    const dialog = await screen.findByRole("dialog", {
      name: "Make a new webhook secret for portale-utenti?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await reauth(user);
    const once = await within(dialog).findByTestId("secret-once");
    const secret = __secretValuesForTest().find((s) => s.kind === "git_webhook_secret")!.values[0]!;
    expect(once.querySelector("[data-secret-value]")).toHaveTextContent(secret);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body()).not.toContain(secret);
    expect(
      within(within(git).getByRole("listitem", { name: "portale-utenti" })).getByText(
        `•••• ${secret.slice(-4)}`,
      ),
    ).toBeInTheDocument();
    expect(regenerate).toHaveFocus();
    cleanup();

    revokeProjectPermission(MARCO, ACQ, "repos.manage" as never);
    await openIntegration(MARCO);
    const marcoRow = within(await screen.findByRole("region", { name: "Git webhooks" })).getByRole(
      "listitem",
      { name: "portale-utenti" },
    );
    const off = within(marcoRow).getByRole("button", { name: "Regenerate secret…" });
    expect(off).toHaveAttribute("aria-disabled", "true");
    expect(off).toHaveAccessibleDescription(
      "Making a new secret needs someone who can manage ACQ's repositories.",
    );
    expect(within(marcoRow).getByRole("button", { name: /^Who can/ })).toBeInTheDocument();
    expect(marcoRow).toHaveTextContent(`•••• ${secret.slice(-4)}`);
  });

  it("la guida SDK: Copy guide copia il testo con la chiave mascherata; Save as file… dà un .md con lo stesso testo", async () => {
    const user = userEvent.setup();
    let saved: { name: string; blob: Blob } | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      saved = { name: "", blob: blob as Blob };
      return "blob:guide";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (saved) saved.name = this.download;
    });
    await openIntegration(SARA);
    setSessionPersonId(SARA);
    const guide = (await projectSettings.getIntegration(ACQ))!.guide;
    expect(guide).toContain("••••");

    const section = await screen.findByRole("region", { name: "SDK guide" });
    await user.click(within(section).getByRole("button", { name: "Copy guide" }));
    expect(await navigator.clipboard.readText()).toBe(guide);
    expect(await within(section).findByText("Copied, with the key hidden.")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "Save as file…" }));
    expect(saved).not.toBeNull();
    expect(saved!.name).toMatch(/\.md$/);
    expect(await saved!.blob.text()).toBe(guide);
  });
});
