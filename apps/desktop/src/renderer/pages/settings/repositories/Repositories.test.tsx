import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import { resetViewerGrants, revokeProjectPermission } from "../../../data/viewer";
import { setLanguage } from "../../../i18n";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";

// Progetto → Settings → Repositories (area 9c, Task 8, shape
// project-repositories.md): l'elenco, la creazione guidata in quattro passi,
// la pagina del repository e il webhook. Laura è Project Lead in ACQ
// (`repos.manage`); Marco è Developer in ACQ: `repos.view` senza
// `repos.manage` (ruling (T4): lo scenario «da Sara» si fa con lui). OLV
// non ha il modulo Releases; Giulia ne è Project Lead.

const LAURA = "p-laura";
const MARCO = "p-marco";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  clearToasts();
  resetViewerGrants();
  act(() => setLanguage("en"));
});

const repo = (id: string) => state.repositories.find((r) => r.id === id)!;
const h1 = (name: string) => screen.findByRole("heading", { level: 1, name });

async function openList(person: string, code = "ACQ") {
  renderRoute(`/p/${code}/settings/repositories`, person);
  await h1("Repositories");
  return await screen.findByRole("list", { name: `Repositories of ${code}` });
}

async function openRepository(person: string, id: string, name: string, code = "ACQ") {
  renderRoute(`/p/${code}/settings/repositories?repo=${id}`, person);
  return await h1(name);
}

const wizard = () => screen.findByRole("dialog", { name: "Add a repository to ACQ" });
const stepHeading = (dialog: HTMLElement, name: string) =>
  within(dialog).findByRole("heading", { level: 3, name });

describe("l'elenco", () => {
  it("una riga per repository: nome, nome completo, piattaforma, webhook in parole, ramo e test", async () => {
    const list = await openList(LAURA);
    const row = within(list).getByRole("link", { name: /portale-utenti/ });
    expect(row).toHaveTextContent("audin/portale-utenti");
    expect(row).toHaveTextContent("Bitbucket");
    expect(row).toHaveTextContent("Webhook not configured");
    expect(row).toHaveTextContent("main · Bitbucket Audin · tests detected from the lockfile");
    expect(
      screen.getByText("A repository leaves a project only when the project is deleted."),
    ).toBeInTheDocument();
  });
});

describe("la creazione guidata, da Laura in ACQ", () => {
  it("account, repository, ramo, verifica (invalid_credentials poi ok), comandi, Create", async () => {
    const user = userEvent.setup();
    await openList(LAURA);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = await wizard();

    // 1 · Git account: il fuoco al titolo del passo; Next spento finché non si sceglie.
    await waitFor(async () => expect(await stepHeading(dialog, "Git account")).toHaveFocus());
    const next = () => within(dialog).getByRole("button", { name: "Next" });
    expect(next()).toHaveAttribute("aria-disabled", "true");
    expect(next()).toHaveAccessibleDescription("Choose a git account.");
    await user.click(within(dialog).getByRole("radio", { name: /Bitbucket Audin/ }));
    await user.click(next());

    // 2 · Repository: da listRemoteRepositories; quello già in ACQ non si sceglie.
    await waitFor(async () => expect(await stepHeading(dialog, "Repository")).toHaveFocus());
    const find = within(dialog).getByRole("searchbox", { name: "Find a repository" });
    await user.type(find, "portale");
    const taken = await within(dialog).findByRole("radio", { name: /audin\/portale-utenti/ });
    expect(taken).toBeDisabled();
    expect(taken.closest("label")).toHaveTextContent("Already in ACQ");
    await user.clear(find);
    await user.type(find, "zzz");
    expect(
      await within(dialog).findByText(
        "No repository matches. If it's missing, Bitbucket Audin can't see it: check the account's access.",
      ),
    ).toBeInTheDocument();
    await user.clear(find);
    await user.type(find, "fatture");
    await user.click(await within(dialog).findByRole("radio", { name: /audin\/fatture-api/ }));
    expect(within(dialog).getByRole("textbox", { name: "Name in Stubwise" })).toHaveValue(
      "fatture-api",
    );
    await user.click(next());

    // 3 · Branch: il predefinito scelto e marcato.
    await waitFor(async () => expect(await stepHeading(dialog, "Branch")).toHaveFocus());
    const branch = within(dialog).getByRole("combobox", { name: "Branch" });
    expect(branch).toHaveValue("main");
    expect(within(branch).getByRole("option", { name: "main (default)" })).toBeInTheDocument();
    await user.click(next());

    // 4 · Access: l'esito scelto nel riquadro.
    await waitFor(async () => expect(await stepHeading(dialog, "Access")).toHaveFocus());
    const box = within(dialog).getByRole("region", { name: "Prototype only" });
    await user.click(within(box).getByRole("radio", { name: "Invalid credentials" }));
    await user.click(within(dialog).getByRole("button", { name: "Verify access" }));
    expect(await within(dialog).findByText("Checking…")).toBeInTheDocument();
    expect(
      await within(dialog).findByText(
        "Bitbucket Audin's credentials don't work. Replace its token in Administration → Git accounts, then verify again.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Next" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Test command" })).toBeNull();
    const create = () => within(dialog).getByRole("button", { name: "Create" });
    expect(create()).toHaveAttribute("aria-disabled", "true");
    expect(create()).toHaveAccessibleDescription("Verify access first: it has to work.");

    await user.click(within(box).getByRole("radio", { name: "Works" }));
    await user.click(within(dialog).getByRole("button", { name: "Verify access" }));
    expect(await within(dialog).findByText("Access works.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Test command" }), "npm test");
    expect(within(dialog).getByRole("textbox", { name: "Install command" })).toHaveValue("");
    expect(create()).not.toHaveAttribute("aria-disabled");
    await user.click(create());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const list = screen.getByRole("list", { name: "Repositories of ACQ" });
    const row = await within(list).findByRole("link", { name: /fatture-api/ });
    expect(row).toHaveTextContent("main · Bitbucket Audin · tests: npm test");
    await waitFor(() => expect(row).toHaveFocus());
    expect(
      screen.getByText(
        "fatture-api added to ACQ. Configure its webhook so Stubwise hears about new commits.",
      ),
    ).toBeInTheDocument();
    const created = state.repositories.find((r) => r.name === "fatture-api")!;
    expect(created).toMatchObject({ releaseBranch: "main", testCommand: "npm test" });
  });

  it("cambiare una scelta già verificata azzera la verifica", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/settings/repositories?new=1", LAURA);
    const dialog = await wizard();
    await user.click(await within(dialog).findByRole("radio", { name: /Bitbucket Audin/ }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(await within(dialog).findByRole("radio", { name: /audin\/fatture-api/ }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Verify access" }));
    expect(await within(dialog).findByText("Access works.")).toBeInTheDocument();
    // Riapre il passo 3 (fatto: si riapre col clic) e cambia il ramo.
    await user.click(within(dialog).getByRole("button", { name: /^3 Branch/ }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Branch" }), "develop");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(
      await within(dialog).findByText("The choice changed: verify again."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Access works.")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Create" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("Esc chiude e il fuoco torna ad «Add repository»", async () => {
    const user = userEvent.setup();
    await openList(LAURA);
    const add = screen.getByRole("button", { name: "Add repository" });
    await user.click(add);
    await wizard();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(add).toHaveFocus();
  });

  it("con una scelta fatta, Esc chiede prima di scartare", async () => {
    const user = userEvent.setup();
    await openList(LAURA);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = await wizard();
    await user.click(await within(dialog).findByRole("radio", { name: /Bitbucket Audin/ }));
    await user.keyboard("{Escape}");
    expect(within(dialog).getByText("Discard this repository?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Add repository" })).toHaveFocus();
  });
});

describe("la pagina del repository, da Laura", () => {
  it("il ramo predefinito si legge come testo, senza campo (P27)", async () => {
    await openRepository(LAURA, "repo-acq", "portale-utenti");
    const details = screen.getByRole("region", { name: "Details" });
    expect(within(details).queryByRole("combobox", { name: "Default branch" })).toBeNull();
    expect(within(details).queryByRole("textbox", { name: "Default branch" })).toBeNull();
    expect(within(details).getByText("Default branch").closest("div")).toHaveTextContent("main");
  });

  it("account di revisione uguale al principale → la frase del livello dati sotto il campo", async () => {
    const user = userEvent.setup();
    const audin = state.instance.gitAccounts.find((g) => g.id === "git-bitbucket-audin")!;
    state.instance.gitAccounts.push({
      ...audin,
      id: "git-bitbucket-review",
      name: "Bitbucket Review",
    });
    repo("repo-acq").reviewGitAccountId = "git-bitbucket-review";
    await openRepository(LAURA, "repo-acq", "portale-utenti");
    const details = screen.getByRole("region", { name: "Details" });
    const review = await within(details).findByRole("combobox", { name: "Review account" });
    // Le scelte che non valgono restano, spente, con la ragione.
    expect(
      within(review).getByRole("option", { name: /GitHub Stubwise · Not on Bitbucket/ }),
    ).toBeDisabled();
    await user.selectOptions(
      within(details).getByRole("combobox", { name: "Git account" }),
      "git-bitbucket-review",
    );
    expect(
      within(review).getByRole("option", { name: /Bitbucket Review · It's the main account/ }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await within(details).findByText("Choose an account on Bitbucket other than the main one."),
    ).toBeInTheDocument();
    expect(review).toHaveAccessibleDescription(
      /Choose an account on Bitbucket other than the main one\./,
    );
    expect(repo("repo-acq").gitAccountId).toBe("git-bitbucket-audin");
  });

  it("rami protetti uno per riga; la riga sbagliata la dice il livello dati; poi «Saved»", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-acq", "portale-utenti");
    const field = screen.getByRole("textbox", { name: "Protected branches" });
    expect(field).toHaveValue("main");
    await user.type(field, "{Enter}{Enter}release/*");
    expect(screen.getByText("1 change")).toBeInTheDocument();
    const save = () => screen.getByRole("button", { name: "Save" });
    await user.click(save());
    expect(
      await screen.findByText("Line 2: a branch can't be empty or contain spaces."),
    ).toBeInTheDocument();
    expect(repo("repo-acq").protectedBranches).toEqual(["main"]);
    // Scrivendo si ripassa da «main» (nessuna modifica): la barra va e torna.
    await user.clear(field);
    await user.type(field, "main{Enter}release/*");
    await user.click(save());
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(repo("repo-acq").protectedBranches).toEqual(["main", "release/*"]);
    // Dopo Save il fuoco non finisce sul body (nemmeno quando la barra se ne va).
    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull(), { timeout: 3000 });
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("heading", { level: 1, name: "portale-utenti" })).toHaveFocus();
  });

  it("le parti dell'8a stanno sotto i campi nuovi, col modulo Releases", async () => {
    await openRepository(LAURA, "repo-aud", "audin-app", "AUD");
    const releases = screen.getByRole("region", { name: "Releases" });
    expect(
      within(releases).getByRole("group", { name: /Colleagues' pull requests/ }),
    ).toBeInTheDocument();
    const order = [screen.getByRole("region", { name: "Details" }), releases];
    expect(
      order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("il webhook", () => {
  it("Configure automatically → Configured; il secondo → Updated; failed → la frase, mai Configured", async () => {
    const user = userEvent.setup();
    await openRepository(LAURA, "repo-acq", "portale-utenti");
    const webhook = screen.getByRole("region", { name: "Webhook" });
    expect(webhook).toHaveTextContent(
      "Not configured: Stubwise doesn't hear about new commits, so the nightly Docs, the reports and the code graph don't see them.",
    );
    await user.click(within(webhook).getByRole("button", { name: "Configure automatically" }));
    expect(await within(webhook).findByText("Configuring…")).toBeInTheDocument();
    expect(await screen.findByText("Webhook configured.")).toBeInTheDocument();
    expect(await within(webhook).findByText(/^Configured on /)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1 }).parentElement!.parentElement,
    ).toHaveTextContent("Webhook configured");

    clearToasts();
    await user.click(within(webhook).getByRole("button", { name: "Configure again" }));
    expect(await screen.findByText("Webhook updated.")).toBeInTheDocument();

    clearToasts();
    const box = within(webhook).getByRole("region", { name: "Prototype only" });
    await user.click(within(box).getByRole("radio", { name: "Failed" }));
    await user.click(within(webhook).getByRole("button", { name: "Configure again" }));
    expect(
      await within(webhook).findByText(
        /^Couldn't configure it on .+\. Check that Bitbucket Audin can manage webhooks, then try again\.$/,
      ),
    ).toBeInTheDocument();
    expect(within(webhook).queryByText(/^Configured on /)).toBeNull();
    expect(screen.queryByText("Webhook configured.")).toBeNull();
    expect(screen.queryByText("Webhook updated.")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1 }).parentElement!.parentElement,
    ).toHaveTextContent("Webhook setup failed");
  });
});

describe("in sola lettura (Marco: repos.view, non repos.manage)", () => {
  // Nel seme Marco gestisce anche i repository di ACQ: qui gli resta la sola
  // lettura, senza toccare il seme (ruling (T4)).
  beforeEach(() => revokeProjectPermission(MARCO, ACQ, "repos.manage" as never));

  it("l'elenco: «Add repository» spento con la sua frase e «Who?»", async () => {
    await openList(MARCO);
    const add = screen.getByRole("button", { name: "Add repository" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(
      /Changing them needs someone who can manage ACQ's repositories\./,
    );
    const line = document.querySelector('[data-view-only-line="manageRepos"]')!;
    expect(
      within(line as HTMLElement).getByRole("button", { name: /^Who can/ }),
    ).toBeInTheDocument();
  });

  it("la pagina: i campi come testo, Configure spento con «Who?», nessun riquadro", async () => {
    await openRepository(MARCO, "repo-acq", "portale-utenti");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    const details = screen.getByRole("region", { name: "Details" });
    expect(within(details).getByText("Protected branches").closest("div")).toHaveTextContent(
      "main",
    );
    const webhook = screen.getByRole("region", { name: "Webhook" });
    const configure = within(webhook).getByRole("button", { name: "Configure automatically" });
    expect(configure).toHaveAttribute("aria-disabled", "true");
    expect(configure).toHaveAccessibleDescription(/manage ACQ's repositories/);
    expect(within(webhook).getByRole("button", { name: /^Who can/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Prototype only" })).toBeNull();
  });
});

describe("OLV, senza il modulo Releases", () => {
  it("la sezione c'è, senza le parti dell'8a", async () => {
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
    expect(screen.getByRole("region", { name: "Details" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Releases" })).toBeNull();
    expect(screen.queryByText("Colleagues' pull requests")).toBeNull();
  });
});
