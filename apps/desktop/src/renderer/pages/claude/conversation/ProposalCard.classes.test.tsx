import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import type { ClassReason, ProposedAction } from "../../../data/types";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import i18n from "../../../i18n";
import { ReauthHost } from "../../../layout/ReauthDialog";
import { resetReauthForTest } from "../../../layout/useReauth";
import { clearToasts, ToastRegion } from "../../../tasks-ui/Toast";
import { renderWithData } from "../../../test/renderWithData";
import { Conversation } from "./Conversation";

// Le schede B e C nella conversazione (area 10a, Task 9; shape
// `claude-actions.md`): le righe dei motivi lette da `reasons` (la scheda
// non le deduce), «Can't be undone», il segno della riconferma e il suo
// dialogo, i bottoni per classe e il Confirm rosso di un'eliminazione.

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ROBERTA = "p-roberta";
const MATTEO = "p-matteo";
const LAURA = "p-laura";
const MKX = "prj-mkx";
const AUD = "prj-aud";
const OLV = "prj-olv";

beforeEach(async () => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetReauthForTest();
  clearToasts();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  clearToasts();
  await i18n.changeLanguage("en");
});

const as = (personId: string) => setSessionPersonId(personId);

function mount(id: string, personId: string) {
  return renderWithData(
    <div style={{ height: 800 }}>
      <Conversation id={id} />
      <ReauthHost />
      <ToastRegion />
    </div>,
    { personId },
  );
}

async function sent(text: string, personId = GIULIA, contextProjectId: string | null = null) {
  as(personId);
  const c = await api.createConversation(contextProjectId ? { contextProjectId } : {});
  const view = mount(c.id, personId);
  await screen.findByRole("combobox", { name: /message to claude/i });
  as(personId);
  await act(() => api.sendMessage(c.id, { text }));
  return { id: c.id, ...view };
}

/** Una scheda aperta iniettata nel flusso, con classe e motivi già calcolati. */
async function injected(
  personId: string,
  actions: ProposedAction[],
  cls: "B" | "C",
  reasons: ClassReason[],
): Promise<string> {
  as(personId);
  const c = await api.createConversation();
  await api.runScript(c.id, [
    {
      step: "event",
      event: {
        type: "proposal",
        proposalId: "prop-t9",
        requesterId: personId,
        actions,
        status: "open",
        cls,
        reasons,
      },
    },
  ]);
  return c.id;
}

const cardOf = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-proposal]");
    expect(el).not.toBeNull();
    return el!;
  });

const reasonRow = (card: HTMLElement, kind: string) =>
  card.querySelector<HTMLElement>(`[data-reason="${kind}"]`);

describe("scheda B: le righe dei motivi", () => {
  it("in AUD «I'm asking first: …» e «Notifies Matteo Conti»", async () => {
    const { container } = await sent('create "Prova" in AUD');
    const card = await cardOf();
    await waitFor(() =>
      expect(reasonRow(card, "notifies")?.textContent).toBe("Notifies Matteo Conti"),
    );
    const said = [...container.querySelectorAll("[data-assistant]")].at(-1)!.textContent ?? "";
    expect(said).toMatch(/^I'm asking first: /);
    expect(said).toContain("Matteo Conti");
  });

  it("con un'automazione attiva su task_created: la sua riga", async () => {
    as(ROBERTA);
    const a = await api.automations.createAutomation({
      name: "Su task_created",
      projectId: MKX,
      flow: {
        trigger: { kind: "stubwise", event: "task_created" },
        steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
        titleTemplate: "{{task.codice}}",
      },
    });
    await api.automations.activate(a.id);
    await sent('create "Prova" in MKX', GIULIA, MKX);
    const card = await cardOf();
    await waitFor(() =>
      expect(reasonRow(card, "automation")?.textContent).toBe(
        "An automation in MKX starts when a task is created",
      ),
    );
  });

  it("(maintainer) assegnare OLV-<n> a Marco: «Notifies Marco Bellini» (task.assigned)", async () => {
    const task = state.tasks.find((t) => t.projectId === OLV && t.assigneeId === GIULIA)!;
    await sent(`Assign ${task.code} to Marco`);
    const card = await cardOf();
    await waitFor(() =>
      expect(reasonRow(card, "notifies")?.textContent).toBe("Notifies Marco Bellini"),
    );
  });

  it("deleteTask: «Can't be undone», Confirm rosso «Delete», e nessun «Undo» dopo", async () => {
    const user = userEvent.setup();
    await sent("Delete ACQ-3", MARCO);
    const card = await cardOf();
    await waitFor(() =>
      expect(reasonRow(card, "irreversible")?.textContent).toBe("Can't be undone"),
    );
    const del = within(card).getByRole("button", { name: "Delete" });
    expect(del.className).toMatch(/bg-critical/);
    expect(within(card).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    await user.click(del);
    await waitFor(() => expect(card.textContent).toContain("Done"));
    expect(state.tasksById.has("t-acq-3")).toBe(false);
    await waitFor(() => expect(within(card).getByText("Can't be undone")).toBeInTheDocument());
    expect(within(card).queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("[CA 4] «Notifies» con persone che chi chiede non vede: mai un numero", () => {
  const create: ProposedAction = {
    fn: "createTask",
    args: { projectId: AUD, title: "Prova" },
    summary: "Create in AUD: “Prova”",
  };
  const CASES = [
    {
      reason: { kind: "notifies", personIds: [MATTEO], more: true, projectId: AUD } as ClassReason,
      en: "Notifies Matteo Conti and others who follow this in AUD",
      it: "Avvisa Matteo Conti e altri che lo seguono in AUD",
    },
    {
      reason: { kind: "notifies", personIds: [], more: true, projectId: AUD } as ClassReason,
      en: "Notifies people who follow this in AUD",
      it: "Avvisa chi lo segue in AUD",
    },
  ];

  for (const c of CASES) {
    for (const lang of ["en", "it"] as const) {
      it(`${lang}: «${c[lang]}»`, async () => {
        await i18n.changeLanguage(lang);
        const id = await injected(GIULIA, [create], "B", [c.reason]);
        mount(id, GIULIA);
        const card = await cardOf();
        await waitFor(() => expect(reasonRow(card, "notifies")?.textContent).toBe(c[lang]));
        expect(reasonRow(card, "notifies")!.textContent).not.toMatch(/\d/);
      });
    }
  }
});

describe("i bottoni per classe (maintainer)", () => {
  const CARDS: { fn: ProposedAction["fn"]; args: Record<string, unknown>; edit: boolean }[] = [
    { fn: "createTask", args: { projectId: MKX, title: "Prova" }, edit: true },
    { fn: "createRequest", args: { projectId: MKX, title: "Prova" }, edit: true },
    { fn: "deleteTask", args: { id: "t-mkx-7" }, edit: false },
    { fn: "archiveProject", args: { projectId: OLV }, edit: false },
    {
      fn: "addMember",
      args: { projectId: OLV, personId: LAURA, roleId: "role-developer" },
      edit: false,
    },
    { fn: "saveWebhook", args: { url: "https://example.com/hook" }, edit: false },
  ];

  for (const c of CARDS) {
    it(`${c.fn}: ${c.edit ? "Edit, Cancel, Confirm" : "solo Cancel e Confirm"}`, async () => {
      const id = await injected(ROBERTA, [{ fn: c.fn, args: c.args, summary: c.fn }], "B", []);
      mount(id, ROBERTA);
      const card = await cardOf();
      const names = within(card)
        .getAllByRole("button")
        .map((b) => b.textContent);
      const confirm = c.fn === "deleteTask" ? "Delete" : "Confirm";
      expect(names).toEqual(c.edit ? ["Edit", "Cancel", confirm] : ["Cancel", confirm]);
    });
  }
});

describe("scheda C: la riconferma", () => {
  const add: ProposedAction = {
    fn: "addMember",
    args: { projectId: OLV, personId: LAURA, roleId: "role-developer" },
    summary: "Add Laura Costa to OLV as Developer",
  };

  it("Confirm → dialogo sopra il riquadro → 123456 → «Done» senza un secondo clic", async () => {
    const user = userEvent.setup();
    const id = await injected(ROBERTA, [add], "C", [{ kind: "reauth" }]);
    mount(id, ROBERTA);
    const card = await cardOf();
    expect(reasonRow(card, "reauth")?.textContent).toBe("Asks for your two-step code");
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(dialog).toHaveAccessibleDescription(
      "To add Laura Costa to OLV as Developer, enter a code from your authenticator app.",
    );
    expect(state.projectsById.get(OLV)!.memberIds).not.toContain(LAURA);
    await user.type(within(dialog).getByLabelText("Code"), "123456");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(card.textContent).toContain("Done"));
    expect(state.projectsById.get(OLV)!.memberIds).toContain(LAURA);
  });

  it("chiuso il dialogo: la scheda resta aperta, «Nothing was changed.», il fuoco torna su Confirm", async () => {
    const user = userEvent.setup();
    const id = await injected(ROBERTA, [add], "C", [{ kind: "reauth" }]);
    mount(id, ROBERTA);
    const card = await cardOf();
    const confirm = within(card).getByRole("button", { name: "Confirm" });
    await user.click(confirm);
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Nothing was changed.")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(state.projectsById.get(OLV)!.memberIds).not.toContain(LAURA);
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Confirm" })).toHaveFocus(),
    );
  });
});
