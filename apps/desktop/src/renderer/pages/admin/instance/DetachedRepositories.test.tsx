import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, projectSettings, resetApi, setLatency } from "../../../data/api";
import { markReauthenticated } from "../../../data/auth/reauth";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import i18n from "../../../i18n";
import { resetReauthForTest } from "../../../layout/useReauth";
import { formatDate } from "../../../notifications/time";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";

// Amministrazione → Repositories, il gruppo «Not in any project» (area 9c,
// Task 11, shape project-archive.md; maintainer, 31 ott 2026, domande 2 (b)
// e 4 (b)). Ogni prova parte da RNC eliminato da Roberta: `shop-frontend`
// resta senza progetto, su «GitHub Shop». Roberta (full admin) e chi era
// membro di RNC leggono da dove viene; Laura (`repos.manage` in ACQ, mai
// membro di RNC) no, in nessun punto del DOM (R-G5).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const REPO = "repo-shop";

beforeEach(async () => {
  setLatency(0);
  resetApi();
  setSessionPersonId(ROBERTA);
  markReauthenticated(ROBERTA);
  expect(await projectSettings.deleteProject("prj-rnc", { confirmCode: "RNC" })).toEqual({
    ok: true,
  });
  state.reauth.delete(ROBERTA);
});
afterEach(async () => {
  clearToasts();
  resetReauthForTest();
  resetApi();
  await i18n.changeLanguage("en");
});

const detachedOn = () => formatDate(state.detachedRepositories[0]!.detachedAt, "en");
const group = () => screen.findByRole("region", { name: "Not in any project" });
const h1 = () => screen.getByRole("heading", { level: 1, name: "Repositories" });

async function open(personId: string) {
  const router = renderRoute("/admin/repositories", personId);
  await screen.findByRole("heading", { level: 1, name: "Repositories" });
  return router;
}

/** La riconferma del prototipo: il codice, poi l'azione riparte da sola. */
async function reauth(user: UserEvent) {
  const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(confirm).getByLabelText("Code"), "123456");
}

/** Un secondo repository senza progetto, accanto a `shop-frontend`. */
function secondDetached() {
  const first = state.detachedRepositories[0]!;
  state.detachedRepositories.push({
    ...first,
    repository: {
      ...first.repository,
      id: "repo-zz",
      name: "zz-landing",
      fullName: "ronchi/zz-landing",
    },
  });
}

describe("il gruppo «Not in any project»", () => {
  it("Roberta legge shop-frontend «from RNC», dopo i gruppi dei progetti", async () => {
    await open(ROBERTA);
    const g = await group();
    expect(g).toHaveTextContent("1 repository");
    const row = within(g).getByRole("listitem");
    expect(row).toHaveTextContent("shop-frontend");
    expect(row).toHaveTextContent("GitHub Shop");
    expect(row).toHaveTextContent(
      `From RNC · Vetrina online Tenuta Ronchi, deleted ${detachedOn()}`,
    );
    // La riga non è un link: non c'è un progetto in cui aprirla.
    expect(within(row).queryByRole("link")).toBeNull();
    // È l'ultimo gruppo della pagina.
    const regions = within(h1().closest("section")!).getAllByRole("region");
    expect(regions.at(-1)).toBe(g);
  });

  it("Laura legge la riga senza «from», e il DOM non nomina RNC (RF 3)", async () => {
    // Un workspace che nomina il cliente (I3, ruling T11): a Laura solo il nome.
    secondDetached();
    await open(LAURA);
    const g = await group();
    const [row, zz] = within(g).getAllByRole("listitem");
    expect(row).toHaveTextContent(`Without a project since ${detachedOn()}`);
    expect(row).not.toHaveTextContent(/From/);
    // Laura non ha il «⋯»: la sua sola azione è Link.
    expect(within(row!).queryByRole("button", { name: /More/ })).toBeNull();
    // L'ultimo segmento è il nome: la riga lo dice una volta sola.
    expect(within(zz!).getAllByText("zz-landing")).toHaveLength(1);
    expect(document.body.innerHTML).not.toMatch(/rnc|ronchi|vetrina/i);
  });

  it("senza repository senza progetto il gruppo non c'è", async () => {
    resetApi();
    await open(ROBERTA);
    await screen.findAllByRole("region");
    expect(screen.queryByRole("region", { name: "Not in any project" })).toBeNull();
  });
});

describe("Link to a project…", () => {
  it("Laura: il menu ha solo i suoi progetti con repos.manage; collegato ad ACQ, il fuoco va all'h1", async () => {
    const user = userEvent.setup();
    setSessionPersonId(LAURA);
    const targets = (await instance.listDetachedRepositories())[0]!.linkTargets;
    const router = await open(LAURA);
    const g = await group();
    const link = within(g).getByRole("button", { name: "Link to a project…" });
    await user.click(link);
    const dialog = await screen.findByRole("dialog", { name: "Link shop-frontend to a project" });
    expect(dialog).toHaveTextContent(
      "It joins with its address, git account, commands and protected branches.",
    );
    expect(dialog).toHaveTextContent(
      "Its webhook starts not configured, and it has no environment files.",
    );
    const select = within(dialog).getByRole("combobox", { name: "Project" });
    const options = within(select)
      .getAllByRole("option")
      .filter((o) => (o as HTMLOptionElement).value !== "")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(targets.map((t) => t.projectId));
    await user.selectOptions(select, "prj-acq");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));

    expect(await screen.findByText("shop-frontend is now in ACQ.")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Not in any project" })).toBeNull(),
    );
    await waitFor(() => expect(h1()).toHaveFocus());
    expect(state.repositories.find((r) => r.id === REPO)!.projectId).toBe("prj-acq");

    // Il repository è in ACQ → Settings → Repositories («Open» del toast).
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/p/ACQ/settings/repositories"),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "shop-frontend" })).toBeVisible();
  });

  it("con un altro repository nel gruppo, il fuoco va al Link della riga dopo; Cancel lo rende al bottone", async () => {
    const user = userEvent.setup();
    secondDetached();
    await open(LAURA);
    const g = await group();
    const buttons = within(g).getAllByRole("button", { name: "Link to a project…" });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[0]!);
    let dialog = await screen.findByRole("dialog", { name: "Link shop-frontend to a project" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(buttons[0]).toHaveFocus();

    await user.click(buttons[0]!);
    dialog = await screen.findByRole("dialog", { name: "Link shop-frontend to a project" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "prj-acq");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await screen.findByText("shop-frontend is now in ACQ.");
    await waitFor(() =>
      expect(within(g).getAllByRole("button", { name: "Link to a project…" })).toHaveLength(1),
    );
    const next = within(g).getByRole("button", { name: "Link to a project…" });
    await waitFor(() => expect(next).toHaveFocus());
    expect(next.closest("li")).toHaveTextContent("zz-landing");
  });

  it("un nome già usato nel progetto scelto si dice nel dialogo, che resta aperto", async () => {
    const user = userEvent.setup();
    state.repositories.find((r) => r.projectId === "prj-acq")!.name = "shop-frontend";
    await open(LAURA);
    await user.click(within(await group()).getByRole("button", { name: "Link to a project…" }));
    const dialog = await screen.findByRole("dialog", { name: "Link shop-frontend to a project" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "prj-acq");
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    expect(
      await within(dialog).findByText(
        "ACQ already has a repository called shop-frontend. Choose another project.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Link shop-frontend to a project" })).toBe(dialog);
    expect(state.detachedRepositories).toHaveLength(1);
  });

  it("senza progetti in cui collegarlo: Link spento con la frase e «Who?»", async () => {
    // Il full admin di un'istanza con ogni progetto archiviato: nessun progetto
    // attivo può prenderlo (`linkTargets` vuoto).
    const at = new Date().toISOString();
    for (const p of state.projects) p.archived ??= { at, byId: ROBERTA };
    setSessionPersonId(ROBERTA);
    expect((await instance.listDetachedRepositories())[0]!.linkTargets).toEqual([]);
    await open(ROBERTA);
    const row = within(await group()).getByRole("listitem");
    const button = within(row).getByRole("button", { name: "Link to a project…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveTextContent(
      "None of your projects can take it: you need to manage repositories in an active project.",
    );
    expect(within(row).getByRole("button", { name: /Who/ })).toHaveAttribute(
      "data-who-can",
      "manageRepos",
    );
  });
});

describe("Delete… (full admin)", () => {
  it("Roberta: la conferma rossa, la frase sull'account, la riconferma; la riga sparisce e l'account non lo conta più", async () => {
    const user = userEvent.setup();
    await open(ROBERTA);
    const g = await group();
    const more = within(g).getByRole("button", { name: "More for shop-frontend" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete shop-frontend for good?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(dialog).toHaveTextContent(
      "Stubwise forgets its address, commands and protected branches. The repository on GitHub isn't touched.",
    );
    expect(dialog).toHaveTextContent("GitHub Shop stops counting it as in use.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await reauth(user);

    expect(await screen.findByText("shop-frontend deleted.")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Not in any project" })).toBeNull(),
    );
    await waitFor(() => expect(h1()).toHaveFocus());
    expect(state.detachedRepositories).toHaveLength(0);

    cleanup();
    renderRoute("/admin/git-accounts", ROBERTA);
    const shop = await screen.findByRole("listitem", { name: "GitHub Shop" });
    expect(shop).toHaveTextContent("Not used yet");
    expect(shop).not.toHaveTextContent("shop-frontend");
  });

  it("riconferma annullata: «Nothing was deleted.», il repository resta (M11)", async () => {
    const user = userEvent.setup();
    await open(ROBERTA);
    const more = within(await group()).getByRole("button", { name: "More for shop-frontend" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete shop-frontend for good?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Nothing was deleted.")).toBeVisible();
    expect(screen.queryByText("Nothing was changed.")).toBeNull();
    expect(state.detachedRepositories).toHaveLength(1);
  });

  it("Cancel: il fuoco torna al «⋯»", async () => {
    const user = userEvent.setup();
    await open(ROBERTA);
    const more = within(await group()).getByRole("button", { name: "More for shop-frontend" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete shop-frontend for good?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(more).toHaveFocus();
    expect(state.detachedRepositories).toHaveLength(1);
  });
});

describe("Git accounts", () => {
  it("un repository senza progetto si legge «not in any project», senza codice", async () => {
    renderRoute("/admin/git-accounts", ROBERTA);
    const shop = await screen.findByRole("listitem", { name: "GitHub Shop" });
    expect(shop).toHaveTextContent("Used by shop-frontend (not in any project)");
    expect(shop).not.toHaveTextContent(/ in $| in \./);
    // Il rifiuto `in_use` di Delete lo elenca allo stesso modo.
    const user = userEvent.setup();
    await user.click(within(shop).getByRole("button", { name: "More for GitHub Shop" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "GitHub Shop is still in use" });
    expect(dialog).toHaveTextContent("shop-frontend (not in any project)");
    expect(dialog).not.toHaveTextContent(/RNC/);
  });
});
