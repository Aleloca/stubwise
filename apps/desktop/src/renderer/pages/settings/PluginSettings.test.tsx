import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { projectSettings, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n from "../../i18n";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";
import { renderWithData } from "../../test/renderWithData";
import { Conversation } from "../claude/conversation/Conversation";

// Progetto → Settings → Plugins (area 9c, Task 10, shape project-plugins.md).
// Laura è Project Lead di STW (cambia i plugin); Sara è in STW senza
// `project.settings.manage` (legge e basta); Roberta è full admin, e nei
// test del conflitto salva «dall'altra finestra» fra la lettura e il
// salvataggio di Laura (RF 5).

const STW = "prj-stw";
const LAURA = "p-laura";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const PRESET = [
  "using-git-worktrees",
  "finishing-a-development-branch",
  "dispatching-parallel-agents",
  "subagent-driven-development",
];

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  clearToasts();
  resetApi();
  await i18n.changeLanguage("en");
});

const choicesOf = (projectId: string) => state.projectSettings.get(projectId)!.plugins;

async function open(personId: string) {
  const router = renderRoute("/p/STW/settings/plugins", personId);
  await screen.findByRole("heading", { level: 1, name: "Plugins" });
  return router;
}

const block = (name: string) => screen.findByRole("region", { name });
const skill = (name: string) => screen.getByRole("checkbox", { name: `Use the skill ${name}` });
const rowOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-plugin-row]")!;
const saveBar = () => document.querySelector<HTMLElement>("[data-save-bar]");

/** Una scrittura dall'altra finestra: Roberta salva le sue scelte, poi chi guarda torna Laura. */
async function robertaSaves(
  disabled: { plugin: string; skills: string[]; hookGroups: string[] }[],
) {
  setSessionPersonId(ROBERTA);
  const version = (await projectSettings.getProjectPlugins(STW))!.version;
  expect(await projectSettings.saveProjectPlugins(STW, { version, disabled })).toMatchObject({
    ok: true,
  });
  setSessionPersonId(LAURA);
}

describe("Plugins: la pagina", () => {
  it("il plugin base si legge acceso, senza caselle, con la sua frase; lint-helpers non entra nei run", async () => {
    await open(LAURA);
    const base = await block("stubwise");
    expect(base).toHaveTextContent("Stubwise's base plugin");
    expect(base).toHaveTextContent("Always on");
    expect(base).toHaveTextContent(
      "It carries the rules of every run and Stubwise's own commands. It can't be turned off.",
    );
    expect(within(base).getByText("/stubwise:start")).toBeInTheDocument();
    expect(within(base).queryByRole("checkbox")).toBeNull();

    const superpowers = await block("superpowers");
    expect(superpowers).toHaveTextContent("Ready");
    expect(superpowers).toHaveTextContent("9 of 9 skills · 1 of 1 hooks in runs");
    expect(
      within(superpowers).getByRole("checkbox", { name: "Use superpowers in STW's runs" }),
    ).toBeChecked();

    const notInRuns = screen.getByRole("region", { name: "Not in runs" });
    const lint = within(notInRuns).getByRole("region", { name: "lint-helpers" });
    expect(lint).toHaveTextContent(
      "Failed: it doesn't enter runs until someone fixes it in Administration → Plugins.",
    );
    expect(lint).toHaveTextContent("Choices saved for it are kept and apply when it's ready.");
    expect(within(lint).queryByRole("checkbox")).toBeNull();
    expect(
      screen.getByText("A plugin's own MCP servers (.mcp.json) are never loaded."),
    ).toBeInTheDocument();
  });

  it("Laura spegne una skill e un gruppo di hook → «Saved»; «/» con STW come contesto non elenca la skill", async () => {
    const user = userEvent.setup();
    await open(LAURA);
    await block("superpowers");
    await user.click(skill("brainstorming"));
    await user.click(screen.getByRole("checkbox", { name: "Use the hook group SessionStart#0" }));
    expect(rowOf(skill("brainstorming"))).toHaveTextContent("Off");
    expect(saveBar()).toHaveTextContent("2 changes");
    expect(await block("superpowers")).toHaveTextContent("8 of 9 skills · 0 of 1 hooks in runs");

    const save = within(saveBar()!).getByRole("button", { name: "Save" });
    await user.click(save);
    expect(
      await screen.findByText(
        "Saved. From the next session: sessions already started keep their skills.",
      ),
    ).toBeInTheDocument();
    // Il fuoco non cade sul body.
    expect(document.activeElement).not.toBe(document.body);
    expect(choicesOf(STW).disabled).toEqual([
      { plugin: "superpowers", skills: ["brainstorming"], hookGroups: ["SessionStart#0"] },
    ]);
    expect(choicesOf(STW).version).toBe(2);

    cleanup();
    setSessionPersonId(LAURA);
    const c = await api.createConversation({ contextProjectId: STW });
    renderWithData(
      <div style={{ height: 800 }}>
        <Conversation id={c.id} />
      </div>,
      { personId: LAURA },
    );
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    const group = within(menu).getByRole("group", { name: "superpowers" });
    expect(within(group).getByText("/superpowers:writing-plans")).toBeInTheDocument();
    expect(within(group).queryByText("/superpowers:brainstorming")).toBeNull();
  });

  it("«Apply recommended preset» spegne le quattro skill di superpowers e nient'altro", async () => {
    const user = userEvent.setup();
    await open(LAURA);
    const superpowers = await block("superpowers");
    const apply = within(superpowers).getByRole("button", { name: "Apply recommended preset" });
    expect(apply).toHaveAttribute(
      "title",
      "Turns off the 4 skills that redo the pipeline's work: worktrees, finishing a branch, parallel agents, subagents.",
    );
    await user.click(apply);
    expect(await screen.findByText("4 skills turned off. Save to apply.")).toBeInTheDocument();
    for (const name of PRESET) {
      expect(skill(name)).not.toBeChecked();
      expect(rowOf(skill(name))).toHaveTextContent(/Off.*Preset/);
    }
    for (const name of ["brainstorming", "writing-plans", "test-driven-development"])
      expect(skill(name)).toBeChecked();
    expect(
      within(superpowers).getByRole("checkbox", { name: "Use the hook group SessionStart#0" }),
    ).toBeChecked();
    expect(saveBar()).toHaveTextContent("4 changes");
    expect(superpowers).toHaveTextContent("5 of 9 skills · 1 of 1 hooks in runs");
    // Spento per regola: «Preset applied», nessun «Who?».
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(superpowers).toHaveTextContent("Preset applied");
    expect(superpowers.querySelector("[data-who-can]")).toBeNull();

    await user.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await screen.findByText(/^Saved\./);
    expect(choicesOf(STW).disabled).toEqual([
      { plugin: "superpowers", skills: [...PRESET].sort(), hookGroups: [] },
    ]);
  });

  it("la casella del plugin spegne tutte le sue righe, e il conteggio lo dice", async () => {
    const user = userEvent.setup();
    await open(LAURA);
    const superpowers = await block("superpowers");
    const all = within(superpowers).getByRole("checkbox", {
      name: "Use superpowers in STW's runs",
    });
    await user.click(skill("brainstorming"));
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    // In parte → tutto acceso; tutto acceso → tutto spento.
    await user.click(all);
    expect(skill("brainstorming")).toBeChecked();
    expect(saveBar()).toBeNull();
    await user.click(all);
    expect(superpowers).toHaveTextContent("Not in runs: everything is off");
    expect(saveBar()).toHaveTextContent("10 changes");
  });
});

describe("Plugins: il conflitto (RF 5, [PG 5])", () => {
  it("una versione vecchia → la frase del conflitto; la bozza resta; le scelte di Roberta restano; «Keep my changes on theirs»", async () => {
    const user = userEvent.setup();
    await open(LAURA);
    await block("superpowers");
    await user.click(skill("brainstorming"));
    await user.click(skill("writing-plans"));
    // Roberta salva dall'altra finestra: spegne brainstorming e test-driven-development.
    await robertaSaves([
      {
        plugin: "superpowers",
        skills: ["brainstorming", "test-driven-development"],
        hookGroups: [],
      },
    ]);
    const theirs = structuredClone(choicesOf(STW));

    await user.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    const box = await screen.findByRole("region", { name: "Your changes weren't saved" });
    expect(box).toHaveTextContent(
      "Someone changed these plugins while you were editing. Nothing of yours has been saved.",
    );
    expect(await within(box).findByText("You both changed: brainstorming.")).toBeInTheDocument();
    // Niente scritto: le scelte di Roberta restano.
    expect(choicesOf(STW)).toEqual(theirs);
    // La bozza resta sullo schermo, e la riga toccata da entrambi lo dice.
    expect(skill("brainstorming")).not.toBeChecked();
    expect(skill("writing-plans")).not.toBeChecked();
    expect(rowOf(skill("brainstorming"))).toHaveTextContent("Both changed");
    expect(within(box).queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(within(box).getByRole("button", { name: "Keep my changes on theirs" }));
    // Nessuna delle due strade salva da sola.
    expect(choicesOf(STW)).toEqual(theirs);
    expect(screen.queryByRole("region", { name: "Your changes weren't saved" })).toBeNull();
    // Sopra le loro (test-driven-development spenta) solo le mie: writing-plans.
    expect(skill("test-driven-development")).not.toBeChecked();
    expect(skill("writing-plans")).not.toBeChecked();
    expect(skill("brainstorming")).not.toBeChecked();
    expect(saveBar()).toHaveTextContent("1 change");
    const save = within(saveBar()!).getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toHaveFocus());
    await user.click(save);
    await screen.findByText(/^Saved\./);
    expect(choicesOf(STW).disabled).toEqual([
      {
        plugin: "superpowers",
        skills: ["brainstorming", "test-driven-development", "writing-plans"],
        hookGroups: [],
      },
    ]);
  });

  it("«Use theirs» scarta la bozza e legge la versione nuova; il fuoco va all'h1", async () => {
    const user = userEvent.setup();
    await open(LAURA);
    await block("superpowers");
    await user.click(skill("writing-plans"));
    await robertaSaves([
      { plugin: "superpowers", skills: ["systematic-debugging"], hookGroups: [] },
    ]);
    await user.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    const box = await screen.findByRole("region", { name: "Your changes weren't saved" });
    expect(within(box).queryByText(/You both changed/)).toBeNull();
    await user.click(within(box).getByRole("button", { name: "Use theirs" }));
    expect(skill("writing-plans")).toBeChecked();
    expect(skill("systematic-debugging")).not.toBeChecked();
    expect(saveBar()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Plugins" })).toHaveFocus();
    expect(choicesOf(STW).disabled).toEqual([
      { plugin: "superpowers", skills: ["systematic-debugging"], hookGroups: [] },
    ]);
  });

  it("[PG 4]: un salvataggio non tocca le scelte di un plugin non pronto", async () => {
    const user = userEvent.setup();
    choicesOf(STW).disabled.push({
      plugin: "lint-helpers",
      skills: ["fix-imports"],
      hookGroups: [],
    });
    await open(LAURA);
    await block("superpowers");
    await user.click(skill("brainstorming"));
    await user.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await screen.findByText(/^Saved\./);
    expect(choicesOf(STW).disabled).toEqual([
      { plugin: "lint-helpers", skills: ["fix-imports"], hookGroups: [] },
      { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
    ]);
  });
});

describe("Plugins: giro di correzione 1", () => {
  it("I1 (ruling T10): una scelta salvata fuori inventario non blocca il salvataggio, e sparisce", async () => {
    const user = userEvent.setup();
    choicesOf(STW).disabled.push({ plugin: "superpowers", skills: ["old-skill"], hookGroups: [] });
    await open(LAURA);
    await block("superpowers");
    await user.click(skill("brainstorming"));
    await user.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await screen.findByText(/^Saved\./);
    expect(choicesOf(STW).disabled).toEqual([
      { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
    ]);
  });

  it("I2: lasciare la sezione durante il conflitto chiede «Discard 1 change?»", async () => {
    const user = userEvent.setup();
    const router = await open(LAURA);
    await block("superpowers");
    await user.click(skill("writing-plans"));
    await robertaSaves([
      { plugin: "superpowers", skills: ["systematic-debugging"], hookGroups: [] },
    ]);
    await user.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await screen.findByRole("region", { name: "Your changes weren't saved" });
    const general = screen
      .getByRole("list", { name: "Settings of STW" })
      .querySelector<HTMLElement>('[data-settings-section="general"]')!;
    await user.click(general.querySelector("a") ?? general);
    expect(await screen.findByText("Discard 1 change?")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/STW/settings/plugins");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await screen.findByRole("heading", { level: 1, name: "General" });
  });
});

describe("Plugins: sola lettura", () => {
  it("Sara: la riga ○ con «Who?», caselle spente nello stato salvato, il preset spento con «Who?», nessuna barra", async () => {
    await open(SARA);
    const line = (
      await screen.findByText(
        /^You can read these settings\. Changing them needs someone who can change STW's settings\./,
      )
    ).closest<HTMLElement>("[data-view-only-line]")!;
    expect(line.querySelector('[data-who-can="manageProjectSettings"]')).toBeInTheDocument();
    const superpowers = await block("superpowers");
    for (const box of within(superpowers).getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
      expect(box).toHaveAccessibleDescription(/Changing them needs someone/);
    }
    expect(skill("brainstorming")).toBeChecked();
    const apply = within(superpowers).getByRole("button", { name: "Apply recommended preset" });
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(apply).toHaveAccessibleDescription(/Changing them needs someone/);
    expect(superpowers.querySelector('[data-who-can="manageProjectSettings"]')).toBeInTheDocument();
    expect(saveBar()).toBeNull();
  });
});
