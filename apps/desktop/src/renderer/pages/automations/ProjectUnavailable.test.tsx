import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  automations as automationsApi,
  projectSettings,
  resetApi,
  setLatency,
} from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { AutomationFlow } from "../../data/types";
import { grantInstancePermission, resetViewerGrants } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// Un'automazione generale che agisce su un progetto non più disponibile
// (area 9c, Task 6, [PX 5] confermata, P18): il costruttore dice «A project
// that's no longer available» con «Choose another project», senza codice,
// uguale per archiviato, eliminato e invisibile; l'esecuzione finisce non
// riuscita con «Step 2 not done: the project isn't available anymore.» e
// compare in «Needs attention».

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const PAOLO = "p-paolo";

const flowInto = (projectId: string): AutomationFlow => ({
  trigger: { kind: "manual" },
  steps: [
    { id: "n", kind: "notify", who: { personId: ROBERTA }, text: "Before", approval: { mode: "auto" } },
    {
      id: "t",
      kind: "createTask",
      title: "From the general one",
      description: "",
      assignee: null,
      dueInDays: null,
      project: { mode: "fixed", projectId },
      milestoneRef: null,
      approval: { mode: "auto" },
    },
  ],
  titleTemplate: "Into the project",
});

/** Un'automazione generale di Roberta, attiva, col passo 2 su `projectId`; il suo codice. */
async function generalInto(projectId: string): Promise<{ id: string; code: string }> {
  setSessionPersonId(ROBERTA);
  const a = await automationsApi.createAutomation({
    name: "Into the project",
    projectId: null,
    flow: flowInto(projectId),
  });
  await automationsApi.activate(a.id);
  return { id: a.id, code: state.automations.find((x) => x.id === a.id)!.code };
}

async function builder(code: string, personId = ROBERTA) {
  renderRoute(`/automations/${code}/edit?step=t`, personId);
  await screen.findByRole("tree");
  return screen.findByRole("radiogroup", { name: "Where" });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("costruttore: il progetto del passo non è più disponibile", () => {
  async function expectUnavailable(group: HTMLElement, hidden: RegExp) {
    expect(group).toHaveTextContent("A project that's no longer available");
    expect(group).not.toHaveTextContent(hidden);
    // La frase resta intera (text-balance) e il link sta su una riga sua, senza «·».
    const line = group.querySelector<HTMLElement>("[data-project-unavailable]")!;
    expect(line.firstElementChild).toHaveTextContent(/^A project that's no longer available$/);
    expect(line.firstElementChild).toHaveClass("text-balance");
    expect(line).not.toHaveTextContent("·");
    const choose = within(group).getByRole("button", { name: "Choose another project" });
    await userEvent.click(choose);
    expect(within(group).getByRole("combobox", { name: "Project" })).toHaveFocus();
    // La riga del passo nell'albero dice lo stesso, senza codice.
    expect(screen.getByRole("tree")).toHaveTextContent("in a project that's no longer available");
    expect(screen.getByRole("tree")).not.toHaveTextContent(hidden);
  }

  it("archiviato (ACQ)", async () => {
    const { code } = await generalInto("prj-acq");
    setSessionPersonId(LAURA);
    await projectSettings.archiveProject("prj-acq");
    await expectUnavailable(await builder(code), /ACQ|Acquedotto/);
  });

  it("eliminato (RNC)", async () => {
    const { id, code } = await generalInto("prj-acq");
    for (const v of state.automations.find((a) => a.id === id)!.versions)
      (v.flow.steps[1] as { project: { projectId: string } }).project.projectId = "prj-rnc";
    markReauthenticated(ROBERTA);
    expect(await projectSettings.deleteProject("prj-rnc", { confirmCode: "RNC" })).toEqual({
      ok: true,
    });
    await expectUnavailable(await builder(code), /rnc|ronchi/i);
  });

  it("invisibile a chi legge (STW per Paolo)", async () => {
    const { code } = await generalInto("prj-stw");
    grantInstancePermission(PAOLO, "automations.manage");
    await expectUnavailable(await builder(code, PAOLO), /STW/);
  });

  it("un passo scelto e disponibile non ha la frase", async () => {
    const { code } = await generalInto("prj-stw");
    const group = await builder(code);
    expect(group).not.toHaveTextContent("no longer available");
  });
});

describe("esecuzione: il passo non si fa, non riuscita, in «Needs attention»", () => {
  it("ACQ archiviato: «✕ Step 2 not done: the project isn't available anymore.»", async () => {
    const { id, code } = await generalInto("prj-acq");
    setSessionPersonId(LAURA);
    await projectSettings.archiveProject("prj-acq");
    setSessionPersonId(ROBERTA);
    await automationsApi.startManual(id);
    await automationsApi.whenAutomationsIdle();
    renderRoute(`/automations/${code}/runs/1`, ROBERTA);
    const failed = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-outcome="failed"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(failed).toHaveTextContent("Step 2 not done: the project isn't available anymore.");
    expect(document.body).not.toHaveTextContent(/Permission lost|ACQ/);

    cleanup();
    renderRoute("/automations?view=attention", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Needs attention" });
    expect(
      await screen.findByRole("link", { name: new RegExp(`^${code} #1`) }),
    ).toBeInTheDocument();
  });
});
