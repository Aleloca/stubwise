import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccess } from "../../../data/access/index";
import { __secretValuesForTest } from "../../../data/admin/secrets";
import { failNext, resetApi, setLatency } from "../../../data/api";
import { PLUGIN_STEP_MS } from "../../../data/instance/plugins";
import { state, visibleProjectIds } from "../../../data/store";
import { grantInstancePermission, type LocalInstancePermission } from "../../../data/viewer";
import i18n from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { resetReauthForTest } from "../../../layout/useReauth";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// Git accounts e Plugins dell'Amministrazione (area 9b, Task 10, shape
// admin-integrations.md). Roberta è full admin; Marco è User (il preset dà
// `git_accounts.view` a tutti, ruling 1) e legge gli account in sola
// lettura; Sara vede pochi progetti e, con la concessione di
// `git_accounts.manage`, prova il rifiuto «in uso» coi repository nascosti
// contati (ruling 21).

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const SARA = "p-sara";

const BITBUCKET_AUDIN = "git-bitbucket-audin";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApi();
  await i18n.changeLanguage("en");
});

const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const row = (name: string) => screen.getByRole("listitem", { name });
const account = (name: string) => state.instance.gitAccounts.find((g) => g.name === name);
const plugin = (slug: string) => state.instance.plugins.find((p) => p.slug === slug);

function fakeTime() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Il dialogo «Confirm it's you»: il codice del prototipo, e l'azione riparte da sola. */
async function confirmItsYou(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(dialog).getByLabelText("Code"), "123456");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
  );
}

// --- Git accounts -------------------------------------------------------------

describe("Git accounts", () => {
  it("le righe: piattaforma, revisore predefinito, ultime 4, verifica e uso", async () => {
    renderRoute("/admin/git-accounts", ROBERTA);
    expect(await heading("Git accounts")).toBeVisible();
    const list = await screen.findByRole("list", { name: "Git accounts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const bb = row("Bitbucket Audin");
    expect(within(bb).getByText("Bitbucket · audin")).toBeVisible();
    expect(within(bb).getByText("•••• k2p8")).toBeVisible();
    expect(within(bb).getByText(/^checked .* · works$/)).toBeVisible();
    expect(within(bb).getByText(/^Used by \d+ repositor(y|ies) in /)).toBeVisible();
    expect(within(bb).queryByText("Default reviewer")).toBeNull();
    const gh = row("GitHub Stubwise");
    expect(within(gh).getByText("GitHub")).toBeVisible();
    expect(within(gh).getByText("Default reviewer")).toBeVisible();
    expect(within(gh).getByRole("button", { name: "Validate" })).toBeEnabled();
    // Niente sola lettura per chi gestisce.
    expect(screen.queryByText(/You can read these accounts/)).toBeNull();
  });

  it("crea un account con il token: errori sotto i campi, riconferma, poi solo le ultime 4 (RF 1)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/git-accounts", ROBERTA);
    await screen.findByRole("list", { name: "Git accounts" });
    await user.click(screen.getByRole("button", { name: "New account" }));
    const dialog = screen.getByRole("dialog", { name: "New git account" });
    // Bitbucket di default: senza workspace e senza token, le frasi sotto i campi.
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByText("Give it a name.")).toBeVisible();
    expect(within(dialog).getByText("Bitbucket needs the workspace.")).toBeVisible();
    expect(within(dialog).getByText("Paste the token.")).toBeVisible();
    // GitHub non ha workspace.
    await user.click(within(dialog).getByRole("radio", { name: "GitHub" }));
    expect(within(dialog).queryByLabelText("Workspace")).toBeNull();
    await user.type(within(dialog).getByLabelText("Name"), "GitHub Release");
    const token = within(dialog).getByLabelText("Token");
    expect(token).toHaveAttribute("type", "password");
    const value = "ghp_release-very-secret-5c1d";
    await user.type(token, value);
    expect(within(dialog).getByText("After saving, use Validate to check it.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await confirmItsYou(user);
    expect(await screen.findByText("GitHub Release created.")).toBeVisible();
    await waitFor(() => expect(account("GitHub Release")).toBeDefined());
    const created = await screen.findByRole("listitem", { name: "GitHub Release" });
    expect(within(created).getByText("•••• 5c1d")).toBeVisible();
    expect(within(created).getByText("not checked yet")).toBeVisible();
    expect(within(created).getByText("Not used yet")).toBeVisible();
    // Via e ritorno: il token non c'è da nessuna parte.
    await act(() => router.navigate({ to: "/admin/$section", params: { section: "people" } }));
    await heading("People");
    await act(() =>
      router.navigate({ to: "/admin/$section", params: { section: "git-accounts" } }),
    );
    await screen.findByRole("listitem", { name: "GitHub Release" });
    const secrets = __secretValuesForTest().flatMap((s) => s.values);
    expect(secrets).toContain(value);
    for (const v of secrets) expect(document.body.innerHTML).not.toContain(v);
  });

  it("verifica con l'esito scelto nel riquadro «Prototype only»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/git-accounts", ROBERTA);
    await screen.findByRole("list", { name: "Git accounts" });
    const box = screen.getByRole("region", { name: "Prototype only" });
    expect(
      within(box).getByText("Nothing real is contacted. Choose what the next check answers."),
    ).toBeVisible();
    await user.selectOptions(within(box).getByLabelText("Account"), "GitHub Stubwise");
    await user.click(within(box).getByRole("radio", { name: "Unreachable" }));
    await waitFor(() =>
      expect(state.instance.simulate.nextTest[account("GitHub Stubwise")!.id]).toBe("unreachable"),
    );
    await user.click(within(row("GitHub Stubwise")).getByRole("button", { name: "Validate" }));
    expect(within(row("GitHub Stubwise")).getByText("Checking…")).toBeVisible();
    expect(
      await within(row("GitHub Stubwise")).findByText("unreachable", undefined, { timeout: 2000 }),
    ).toBeVisible();
    expect(account("GitHub Stubwise")!.lastValidation?.outcome).toBe("unreachable");
  });

  it("revisore predefinito: il dialogo e il toast dicono chi sostituisce, nessuna riconferma", async () => {
    const user = userEvent.setup();
    // Un secondo account GitHub, nello stesso ambito di GitHub Stubwise.
    state.instance.gitAccounts.push({
      ...account("GitHub Stubwise")!,
      id: "git-github-release",
      name: "GitHub Release",
      defaultReviewer: false,
    });
    renderRoute("/admin/git-accounts", ROBERTA);
    await screen.findByRole("listitem", { name: "GitHub Release" });
    await user.click(
      within(row("GitHub Release")).getByRole("button", { name: "More for GitHub Release" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Make default reviewer" }));
    const dialog = screen.getByRole("dialog", { name: "Make GitHub Release the default reviewer?" });
    expect(
      within(dialog).getByText(
        "GitHub Release reviews pull requests on GitHub for repositories that don't have a review account of their own.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText("It replaces GitHub Stubwise as the default reviewer."),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Make default" }));
    expect(
      await screen.findByText("Now the default reviewer, in place of GitHub Stubwise."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    expect(account("GitHub Release")!.defaultReviewer).toBe(true);
    expect(account("GitHub Stubwise")!.defaultReviewer).toBe(false);
    await waitFor(() =>
      expect(within(row("GitHub Release")).getByText("Default reviewer")).toBeVisible(),
    );
    expect(within(row("GitHub Stubwise")).queryByText("Default reviewer")).toBeNull();
    // E smettere di esserlo, dal «⋯».
    await user.click(
      within(row("GitHub Release")).getByRole("button", { name: "More for GitHub Release" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Stop being the default reviewer" }));
    expect(
      await screen.findByText("GitHub Release is no longer the default reviewer."),
    ).toBeVisible();
    expect(account("GitHub Release")!.defaultReviewer).toBe(false);
  });

  it("modifica e sostituisce il token (con la riconferma); elimina un account libero", async () => {
    const user = userEvent.setup();
    state.instance.gitAccounts.push({
      ...account("GitHub Stubwise")!,
      id: "git-github-old",
      name: "GitHub Old",
      defaultReviewer: false,
    });
    renderRoute("/admin/git-accounts", ROBERTA);
    await screen.findByRole("listitem", { name: "GitHub Old" });
    // Modifica: il workspace di Bitbucket.
    await user.click(
      within(row("Bitbucket Audin")).getByRole("button", { name: "More for Bitbucket Audin" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit…" }));
    const edit = screen.getByRole("dialog", { name: "Edit Bitbucket Audin" });
    await user.clear(within(edit).getByLabelText("Workspace"));
    await user.type(within(edit).getByLabelText("Workspace"), "audin-srl");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeVisible();
    expect(account("Bitbucket Audin")!.workspace).toBe("audin-srl");
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    // Sostituisci il token.
    await user.click(
      within(row("Bitbucket Audin")).getByRole("button", { name: "More for Bitbucket Audin" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Replace token…" }));
    const replace = screen.getByRole("dialog", { name: "Replace the token of Bitbucket Audin" });
    await user.type(within(replace).getByLabelText("Token"), "bb-new-token-a1b2");
    await user.click(within(replace).getByRole("button", { name: "Replace" }));
    await confirmItsYou(user);
    expect(
      await screen.findByText("Token replaced for Bitbucket Audin. Validate it to check."),
    ).toBeVisible();
    await waitFor(() =>
      expect(within(row("Bitbucket Audin")).getByText("•••• a1b2")).toBeVisible(),
    );
    expect(within(row("Bitbucket Audin")).getByText("not checked yet")).toBeVisible();
    // Elimina un account che nessun repository usa.
    await user.click(within(row("GitHub Old")).getByRole("button", { name: "More for GitHub Old" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const del = screen.getByRole("dialog", { name: "Delete GitHub Old?" });
    expect(within(del).getByText("No repository uses it.")).toBeVisible();
    await user.click(within(del).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("GitHub Old deleted.")).toBeVisible();
    expect(account("GitHub Old")).toBeUndefined();
  });

  it("elimina un account in uso, come Sara con git_accounts.manage: i suoi repository e «N in projects you can't see» (ruling 21)", async () => {
    const user = userEvent.setup();
    give(SARA, "git_accounts.manage");
    const visible = visibleProjectIds(SARA);
    const repos = state.repositories.filter((r) => r.gitAccountId === BITBUCKET_AUDIN);
    const seen = repos.filter((r) => visible.has(r.projectId));
    const hidden = repos.filter((r) => !visible.has(r.projectId));
    // Il seme è fatto apposta: Sara vede il repository di CBV, i tre di AUD no.
    expect(seen.map((r) => r.name)).toEqual(["bellavista-store"]);
    expect(hidden).toHaveLength(3);
    const hiddenWords = "and 3 in projects you can't see";

    renderRoute("/admin/git-accounts", SARA);
    await screen.findByRole("listitem", { name: "Bitbucket Audin" });
    expect(within(row("Bitbucket Audin")).getByText("Used by 1 repository in CBV")).toBeVisible();
    expect(within(row("Bitbucket Audin")).getByText(hiddenWords)).toBeVisible();
    await user.click(
      within(row("Bitbucket Audin")).getByRole("button", { name: "More for Bitbucket Audin" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Bitbucket Audin is still in use" });
    const list = within(dialog).getByRole("list", { name: "Repositories using Bitbucket Audin" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(seen.length);
    for (const r of seen) {
      const code = state.projectsById.get(r.projectId)!.code;
      const link = within(list).getByRole("link", { name: new RegExp(`^${r.name}`) });
      expect(link).toHaveAttribute("href", expect.stringContaining(`/p/${code}/settings/repositories`));
    }
    expect(within(dialog).getByText(hiddenWords)).toBeVisible();
    expect(
      within(dialog).getByText(
        "Link these repositories to another account first, in each project's settings.",
      ),
    ).toBeVisible();
    // Niente nomi né codici dei progetti nascosti, né qui né nella pagina.
    for (const r of hidden) {
      expect(document.body.textContent).not.toContain(r.name);
      expect(document.body.textContent).not.toContain(state.projectsById.get(r.projectId)!.code);
    }
    // Nessun bottone che elimini, e nessuna riconferma chiesta.
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(account("Bitbucket Audin")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
  });

  it("con il solo git_accounts.view: elenco senza azioni, bottoni spenti con «Who?»", async () => {
    renderRoute("/admin/git-accounts", MARCO);
    await screen.findByRole("list", { name: "Git accounts" });
    expect(
      screen.getByText(
        "You can read these accounts. Changing them needs someone who can manage git accounts.",
      ),
    ).toBeVisible();
    const create = screen.getByRole("button", { name: "New account" });
    expect(create).toBeDisabled();
    expect(create.parentElement!.querySelector('[data-who-can="manageGitAccounts"]')).not.toBeNull();
    for (const name of ["Bitbucket Audin", "GitHub Stubwise"]) {
      const validate = within(row(name)).getByRole("button", { name: "Validate" });
      expect(validate).toBeDisabled();
      expect(
        validate.parentElement!.querySelector('[data-who-can="manageGitAccounts"]'),
      ).not.toBeNull();
      expect(within(row(name)).queryByRole("button", { name: `More for ${name}` })).toBeNull();
    }
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
  });

  it("senza git_accounts.view né .manage la voce è «not found»", async () => {
    // Un ruolo senza nessuno dei due: si tolgono quelli del ruolo d'istanza di Marco.
    writeAccess((a) => {
      const role = a.roles.find((r) => r.id === a.people.find((p) => p.personId === MARCO)!.instanceRoleId)!;
      role.permissions = role.permissions.filter((p) => !p.startsWith("git_accounts."));
    });
    renderRoute("/admin/git-accounts", MARCO);
    expect(await screen.findByText(i18n.t("notFound.title"))).toBeVisible();
  });

  it("vuoto ed errore di lettura", async () => {
    state.instance.gitAccounts = [];
    renderRoute("/admin/git-accounts", ROBERTA);
    expect(
      await screen.findByText("No git accounts yet. A project needs one to connect a repository."),
    ).toBeVisible();
    cleanup();
    failNext("instance.listGitAccounts");
    const user = userEvent.setup();
    renderRoute("/admin/git-accounts", ROBERTA);
    expect(await screen.findByText("Couldn't load the git accounts.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("No git accounts yet. A project needs one to connect a repository."),
    ).toBeVisible();
  });
});

// --- Plugins ------------------------------------------------------------------

describe("Plugins", () => {
  it("l'elenco: stato e smoke in parole, ref e pin, inventario contato, l'errore se non riuscito", async () => {
    renderRoute("/admin/plugins", ROBERTA);
    expect(await heading("Plugins")).toBeVisible();
    expect(
      screen.getByText("Stubwise's base plugin is always on and isn't listed here."),
    ).toBeVisible();
    const sp = await screen.findByRole("listitem", { name: /^superpowers/ });
    expect(within(sp).getByText("Ready")).toBeVisible();
    expect(within(sp).getByText("Smoke test passed")).toBeVisible();
    expect(within(sp).getByText("ref v4.0.3")).toBeVisible();
    expect(within(sp).getByText("pin 3f9c2a1")).toBeVisible();
    expect(within(sp).getByText("9 skills · 1 hook")).toBeVisible();
    expect(within(sp).getByText(/^updated .* by Roberta Fontana$/)).toBeVisible();
    const lint = row("lint-helpers");
    expect(within(lint).getByText("Failed")).toBeVisible();
    expect(
      within(lint).getByText(
        "The plugin contains a symlink (hooks/run.sh): plugins with symlinks are refused.",
      ),
    ).toBeVisible();
  });

  it("registrare: l'avviso in parole prima dei campi; «Register» spento finché la casella non è spuntata", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/plugins", ROBERTA);
    await screen.findByRole("list", { name: "Plugins" });
    await user.click(screen.getByRole("button", { name: "Register plugin" }));
    const dialog = screen.getByRole("dialog", { name: "Register a plugin" });
    const warning = within(dialog).getByText("Registering runs this plugin's code.");
    expect(warning).toBeVisible();
    expect(within(dialog).getByText(/Its hooks run without asking/)).toBeVisible();
    // L'avviso viene prima del campo dell'indirizzo.
    const url = within(dialog).getByLabelText("Repository address");
    expect(warning.compareDocumentPosition(url) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.type(url, "https://github.com/acme/review-kit");
    await user.type(within(dialog).getByLabelText("Ref"), "v1.2.0");
    const register = within(dialog).getByRole("button", { name: "Register" });
    expect(register).toBeDisabled();
    expect(
      within(dialog).getByText("Tick “I trust this repository and this commit” first."),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "I trust this repository and this commit" }),
    );
    expect(register).toBeEnabled();
    // Un indirizzo con le credenziali: la frase sotto il campo, niente riconferma.
    await user.clear(url);
    await user.type(url, "https://me:pw@github.com/acme/review-kit");
    await user.click(register);
    expect(
      await within(dialog).findByText(
        "Remove the username and password: the repository must be public.",
      ),
    ).toBeVisible();
    await user.clear(url);
    await user.type(url, "https://github.com/obra/superpowers");
    await user.click(register);
    expect(
      await within(dialog).findByText("This address is already registered as superpowers."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    expect(state.instance.plugins).toHaveLength(2);
  });

  it("dopo la riconferma la riga è «Materializing…», poi «Ready» e lo smoke superato (timer finti)", async () => {
    const user = fakeTime();
    renderRoute("/admin/plugins", ROBERTA);
    await screen.findByRole("list", { name: "Plugins" });
    await user.click(screen.getByRole("button", { name: "Register plugin" }));
    const dialog = screen.getByRole("dialog", { name: "Register a plugin" });
    await user.type(within(dialog).getByLabelText("Repository address"), "https://github.com/acme/review-kit");
    await user.type(within(dialog).getByLabelText("Ref"), "v1.2.0");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "I trust this repository and this commit" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Register" }));
    await confirmItsYou(user);
    expect(await screen.findByText("review-kit registered.")).toBeVisible();
    const kit = await screen.findByRole("listitem", { name: /^review-kit/ });
    expect(within(kit).getByText("Materializing…")).toBeVisible();
    await advance(PLUGIN_STEP_MS + 400);
    await waitFor(() => expect(within(kit).getByText("Ready")).toBeVisible());
    expect(within(kit).getByText("Smoke test running…")).toBeVisible();
    expect(await screen.findByText("review-kit is ready.")).toBeInTheDocument();
    await advance(PLUGIN_STEP_MS + 400);
    await waitFor(() => expect(within(kit).getByText("Smoke test passed")).toBeVisible());
    expect(within(kit).getByText("2 skills · 1 hook")).toBeVisible();
  });

  it("la pagina del plugin: skill con la frase, hook col comando, le note", async () => {
    renderRoute("/admin/plugins/plg-superpowers", ROBERTA);
    expect(await heading("superpowers")).toBeVisible();
    const back = document.querySelector<HTMLElement>("[data-back-link]")!;
    expect(back).toHaveAccessibleName("Plugins");
    expect(back).toHaveAttribute("href", expect.stringContaining("/admin/plugins"));
    for (const part of [
      "github.com/obra/superpowers",
      "ref v4.0.3",
      "pin 3f9c2a1",
      "registered by Roberta Fontana",
    ])
      expect(screen.getByText(part)).toBeVisible();
    const skills = screen.getByRole("list", { name: "Skills" });
    expect(within(skills).getAllByRole("listitem")).toHaveLength(9);
    expect(within(skills).getByText("brainstorming")).toBeVisible();
    expect(
      within(skills).getByText("Turns a rough idea into a design before any code."),
    ).toBeVisible();
    const hooks = screen.getByRole("list", { name: "Hooks" });
    expect(within(hooks).getByText("SessionStart#0")).toBeVisible();
    expect(
      within(hooks).getByText("${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"),
    ).toBeVisible();
    expect(
      screen.getByText("A plugin's own MCP servers (.mcp.json) are never loaded."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Each project chooses which of these to use, in Project → Settings → Plugins.",
      ),
    ).toBeVisible();
  });

  it("aggiorna a un ref (casella e riconferma), rifà lo smoke test, rimuove", async () => {
    const user = fakeTime();
    const router = renderRoute("/admin/plugins/plg-superpowers", ROBERTA);
    await heading("superpowers");
    // Aggiorna a un ref: la stessa casella di fiducia.
    await user.click(screen.getByRole("button", { name: "Update to ref…" }));
    const dialog = screen.getByRole("dialog", { name: "Update superpowers to a ref" });
    expect(
      within(dialog).getByText(
        "Updating runs the new commit's code the same way: install and test with everything on.",
      ),
    ).toBeVisible();
    await user.type(within(dialog).getByLabelText("Ref"), "v4.1.0");
    const update = within(dialog).getByRole("button", { name: "Update" });
    expect(update).toBeDisabled();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "I trust this repository and this commit" }),
    );
    await user.click(update);
    await confirmItsYou(user);
    expect(await screen.findByText("superpowers is updating to v4.1.0.")).toBeVisible();
    expect(await screen.findByText("Materializing…")).toBeVisible();
    await advance(PLUGIN_STEP_MS * 2 + 800);
    await waitFor(() => expect(screen.getByText("Smoke test passed")).toBeVisible());
    expect(plugin("superpowers")!.ref).toBe("v4.1.0");
    // Rifai lo smoke test: nessuna riconferma.
    await user.click(screen.getByRole("button", { name: "More for superpowers" }));
    await user.click(screen.getByRole("menuitem", { name: "Run the smoke test again" }));
    expect(await screen.findByText("Smoke test running…")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
    await advance(PLUGIN_STEP_MS + 400);
    await waitFor(() => expect(screen.getByText("Smoke test passed")).toBeVisible());
    // Rimuovi.
    await user.click(screen.getByRole("button", { name: "More for superpowers" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove…" }));
    const remove = screen.getByRole("dialog", { name: "Remove superpowers?" });
    expect(
      within(remove).getByText(
        "Projects lose its skills and hooks from their next run. Runs in progress finish with it.",
      ),
    ).toBeVisible();
    await user.click(within(remove).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("superpowers removed.")).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/plugins"));
    expect(plugin("superpowers")).toBeUndefined();
  });

  it("con «failed» simulato: la riga e la pagina dicono l'errore in parole", async () => {
    const user = fakeTime();
    renderRoute("/admin/plugins", ROBERTA);
    await screen.findByRole("list", { name: "Plugins" });
    const box = screen.getByRole("region", { name: "Prototype only" });
    await user.click(within(box).getByRole("radio", { name: "Failed" }));
    await waitFor(() => expect(state.instance.simulate.nextPluginOutcome).toBe("failed"));
    await user.click(screen.getByRole("button", { name: "Register plugin" }));
    const dialog = screen.getByRole("dialog", { name: "Register a plugin" });
    await user.type(within(dialog).getByLabelText("Repository address"), "https://github.com/acme/review-kit");
    await user.type(within(dialog).getByLabelText("Ref"), "v1.2.0");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "I trust this repository and this commit" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Register" }));
    await confirmItsYou(user);
    const kit = await screen.findByRole("listitem", { name: /^review-kit/ });
    await advance(PLUGIN_STEP_MS + 400);
    await waitFor(() => expect(within(kit).getByText("Failed")).toBeVisible());
    const error = plugin("review-kit")!.error!;
    expect(within(kit).getByText(error)).toBeVisible();
    // Il riquadro torna su «Ready»: l'esito valeva una volta.
    await waitFor(() =>
      expect(within(box).getByRole("radio", { name: "Ready" })).toHaveAttribute("aria-checked", "true"),
    );
    await user.click(kit.querySelector("a")!);
    expect(await heading("review-kit")).toBeVisible();
    expect(screen.getByText("Couldn't prepare review-kit.")).toBeVisible();
    expect(screen.getByText(error)).toBeVisible();
    expect(screen.getByText("Try another ref with Update to ref.")).toBeVisible();
    expect(screen.getByText("No inventory yet.")).toBeVisible();
  });

  it("un plugin che non c'è: «not found» col ritorno a Plugins; senza plugins.manage la voce non c'è", async () => {
    renderRoute("/admin/plugins/plg-nope", ROBERTA);
    expect(
      await screen.findByText("This plugin isn't registered, or it was removed."),
    ).toBeVisible();
    expect(document.querySelector("[data-back-link]")).toHaveAccessibleName("Plugins");
    cleanup();
    renderRoute("/admin/plugins/plg-superpowers", MARCO);
    expect(await screen.findByText(i18n.t("notFound.title"))).toBeVisible();
  });

  it("nel registro, il nome del plugin apre la sua pagina", async () => {
    const user = userEvent.setup();
    state.changelog.splice(0);
    renderRoute("/admin/plugins/plg-superpowers", ROBERTA);
    await heading("superpowers");
    await user.click(screen.getByRole("button", { name: "More for superpowers" }));
    await user.click(screen.getByRole("menuitem", { name: "Run the smoke test again" }));
    await waitFor(() => expect(state.changelog).toHaveLength(1));
    cleanup();
    renderRoute("/admin/changelog", ROBERTA);
    const entry = await screen.findByText(/ran the smoke test of/);
    const link = within(entry.closest("[data-change-entry]")!).getByRole("link", {
      name: "superpowers",
    });
    expect(link).toHaveAttribute("href", expect.stringContaining("/admin/plugins/plg-superpowers"));
  });

  it("in italiano: stato, smoke e la casella", async () => {
    await i18n.changeLanguage("it");
    const user = userEvent.setup();
    renderRoute("/admin/plugins", ROBERTA);
    expect(await heading("Plugin")).toBeVisible();
    const sp = await screen.findByRole("listitem", { name: /^superpowers/ });
    expect(within(sp).getByText("Pronto")).toBeVisible();
    expect(within(sp).getByText("Smoke test superato")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Registra plugin" }));
    const dialog = screen.getByRole("dialog", { name: "Registra un plugin" });
    expect(within(dialog).getByText("Registrare esegue il codice del plugin.")).toBeVisible();
    expect(
      within(dialog).getByRole("checkbox", { name: "Mi fido di questo repository e di questo commit" }),
    ).not.toBeChecked();
  });
});
