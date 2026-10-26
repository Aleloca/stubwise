import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations as automationsApi, resetApi, setLatency } from "../../data/api";
import { AUTOMATION_CASES } from "../../data/seed/automations";
import { NEW_CONTRACT_MILESTONE_ID } from "../../data/seed/automations/created";
import { state } from "../../data/store";
import { setSessionPersonId } from "../../data/session";
import type { Step } from "../../data/types";
import { grantProjectRole, resetViewerGrants } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearPendingAnswers, setUndoWindow } from "../home/pendingAnswers";

// I punti d'ingresso delle Automations (Task 8, shape automations.md §6):
// «Decide» con l'«Undo», il blocco Home, la sezione del progetto,
// «Created by automation…» su task e traguardi, ⌘K. Persone: Matteo
// (proprietario di AUT-1 e AUD-A1, approva l'email di AUD-A1 #1), Giulia
// (membro di AUD, nessun permesso sulle automazioni), Sara (non vede AUD,
// membro di CBV), Roberta (admin).

const R = AUTOMATION_CASES.runs;
const MATTEO = "p-matteo";
const run = (id: string) => state.automationRuns.find((r) => r.id === id)!;
const idle = () => act(() => automationsApi.whenAutomationsIdle());
const decideBlock = () => screen.findByRole("region", { name: "Decide" });
const approvalItem = async () => {
  const decide = await decideBlock();
  await waitFor(() =>
    expect(
      decide.querySelector(`[data-automation-decision="${R.waitingApproval}"]`),
    ).not.toBeNull(),
  );
  return decide.querySelector(`[data-automation-decision="${R.waitingApproval}"]`) as HTMLElement;
};

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  // Le altre voci di «Decide» non contano qui: restano le automazioni.
  state.mailProposals.length = 0;
  setUndoWindow(0);
});
afterEach(() => {
  clearPendingAnswers();
  clearToasts();
  setUndoWindow(null);
  resetViewerGrants();
});

describe("«Decide»: approvazioni e progetto da scegliere", () => {
  it("l'approvazione con l'origine, la domanda e l'email in anteprima; Approve la manda", async () => {
    renderRoute("/home", MATTEO);
    const item = await approvalItem();
    expect(item).toHaveTextContent("From automation");
    expect(within(item).getByRole("link", { name: /AUD-A1/ })).toHaveAttribute(
      "href",
      "/automations/AUD-A1",
    );
    expect(within(item).getByRole("link", { name: "run #1" })).toHaveAttribute(
      "href",
      "/automations/AUD-A1/runs/1",
    );
    expect(item).toHaveTextContent("Send this email to amministrazione@cantinabellavista.example?");
    expect(item.querySelector("[data-preview-email]")).toHaveTextContent(
      "Mancano ancora alcuni dati per Centralino AI",
    );
    await userEvent.click(within(item).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(run(R.waitingApproval).status).not.toBe("waiting_approval"));
    await idle();
    expect(
      run(R.waitingApproval).log.some((e) => e.outcome === "approved" && e.byId === MATTEO),
    ).toBe(true);
  });

  it("«Edit» corregge l'email prima di approvarla", async () => {
    renderRoute("/home", MATTEO);
    const item = await approvalItem();
    await userEvent.click(within(item).getByRole("button", { name: "Edit" }));
    const subject = within(item).getByRole("textbox", { name: "Subject" });
    await userEvent.clear(subject);
    await userEvent.type(subject, "Ultimi dati");
    await userEvent.click(within(item).getByRole("button", { name: "Approve with changes" }));
    await waitFor(() =>
      expect(run(R.waitingApproval).log.find((e) => e.outcome === "approved")?.byId).toBe(MATTEO),
    );
    await idle();
    const sent = [...run(R.waitingApproval).log]
      .reverse()
      .find((e) => e.kind === "sendEmail" && e.outcome === "ok");
    expect(sent?.input.subject).toBe("Ultimi dati");
  });

  it("«Undo» entro la finestra: niente parte e la voce torna", async () => {
    setUndoWindow(5000);
    renderRoute("/home", MATTEO);
    const item = await approvalItem();
    await userEvent.click(within(item).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(item.closest("[data-closed]")).not.toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(item.closest("[data-closed]")).toBeNull());
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
  });

  it("cambiare persona durante l'«Undo» manda la risposta come chi l'ha data, non come l'altra", async () => {
    setUndoWindow(5000);
    renderRoute("/home", MATTEO);
    const item = await approvalItem();
    await userEvent.click(within(item).getByRole("button", { name: "Approve" }));
    await switchPersona(/Roberta/);
    await idle();
    await waitFor(() =>
      expect(run(R.waitingApproval).log.find((e) => e.outcome === "approved")?.byId).toBe(MATTEO),
    );
    expect(run(R.waitingApproval).log.some((e) => e.byId === "p-roberta")).toBe(false);
  });

  it("un approvatore che non vede più il progetto non riceve la richiesta", async () => {
    const aud = state.projectsById.get("prj-aud")!;
    aud.memberIds = aud.memberIds.filter((id) => id !== MATTEO);
    renderRoute("/home", MATTEO);
    const decide = await decideBlock();
    // Resta il progetto da scegliere di AUT-1 #2, di cui è il proprietario.
    await waitFor(() =>
      expect(
        decide.querySelector(`[data-automation-decision="${R.waitingProject}"]`),
      ).not.toBeNull(),
    );
    expect(decide.querySelector(`[data-automation-decision="${R.waitingApproval}"]`)).toBeNull();
  });

  it("«scegli il progetto» (il proprietario): sceglie sul posto, senza «Remember» senza integrations.manage", async () => {
    renderRoute("/home", MATTEO);
    const decide = await decideBlock();
    await waitFor(() =>
      expect(
        decide.querySelector(`[data-automation-decision="${R.waitingProject}"]`),
      ).not.toBeNull(),
    );
    const item = decide.querySelector(
      `[data-automation-decision="${R.waitingProject}"]`,
    ) as HTMLElement;
    expect(item).toHaveTextContent("Which project for client “Forneria Rossi & Lari”?");
    expect(within(item).queryByRole("checkbox")).toBeNull();
    await userEvent.selectOptions(
      within(item).getByRole("combobox", { name: "Project" }),
      "prj-aud",
    );
    await userEvent.click(within(item).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(run(R.waitingProject).status).not.toBe("waiting_project"));
  });
});

describe("R-J8 con l'«Undo»: due approvatori, il passo cambia nella finestra", () => {
  const ask = { mode: "ask", who: { projectRole: "project_lead" } } as const;
  const email = (id: string, subject: string): Step => ({
    id,
    kind: "sendEmail",
    to: "cliente@example.com",
    subject,
    body: "Ciao",
    attachRefs: [],
    approval: ask,
  });

  it("la decisione rimandata (con le modifiche) non cade sul passo nuovo, e il messaggio dice chi ha deciso", async () => {
    // Due email da approvare in fila; decide chi è Project Lead di AUD: Laura e (qui) Giulia.
    grantProjectRole("p-giulia", "prj-aud", "project_lead");
    setSessionPersonId(MATTEO);
    const a = await automationsApi.createAutomation({
      name: "Due email",
      projectId: "prj-aud",
      flow: {
        trigger: { kind: "manual" },
        steps: [email("first", "Prima"), email("second", "Seconda")],
        titleTemplate: "Due email",
      },
    });
    await automationsApi.activate(a.id);
    const runId = await automationsApi.startManual(a.id);
    await automationsApi.whenAutomationsIdle();
    expect(run(runId)).toMatchObject({ status: "waiting_approval", cursor: "0" });

    setSessionPersonId("p-giulia");
    expect((await automationsApi.listMyApprovals()).map((d) => d.runId)).toContain(runId);
    setUndoWindow(300);
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    // La voce più recente può stare oltre le prime cinque di «Decide».
    const more = await within(decide).findByRole("button", { name: /^Show \d+ more$/ });
    await userEvent.click(more);
    const item = await waitFor(() => {
      const el = decide.querySelector(`[data-automation-decision="${runId}"]`);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await userEvent.click(within(item).getByRole("button", { name: "Edit" }));
    const subject = within(item).getByRole("textbox", { name: "Subject" });
    await userEvent.clear(subject);
    await userEvent.type(subject, "Corretta da Giulia");
    await userEvent.click(within(item).getByRole("button", { name: "Approve with changes" }));
    expect(
      await screen.findByText(`Approved with changes · ${a.code} #1 goes on`),
    ).toBeInTheDocument();

    // Nella finestra Laura approva la prima: l'esecuzione passa alla seconda.
    setSessionPersonId("p-laura");
    await automationsApi.approve(runId);
    setSessionPersonId("p-giulia");
    await idle();
    expect(run(runId)).toMatchObject({ status: "waiting_approval", cursor: "1" });

    // Scaduta la finestra, la decisione di Giulia non tocca il passo nuovo.
    expect(
      await screen.findByText("Already decided by Laura Costa", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    await idle();
    expect(run(runId)).toMatchObject({ status: "waiting_approval", cursor: "1" });
    expect(run(runId).log.some((e) => e.byId === "p-giulia")).toBe(false);
    expect(run(runId).pending?.preview.subject).toBe("Seconda");
    // La voce torna per il passo nuovo, senza la bozza di prima.
    await waitFor(() => expect(item.closest("[data-closed]")).toBeNull());
    expect(within(item).queryByRole("textbox")).toBeNull();
    expect(item).toHaveTextContent("Seconda");
  });
});

describe("il riquadro «Now» usa la stessa anteprima e lo stesso «Undo»", () => {
  it("Approve nel dettaglio dell'esecuzione aspetta la finestra e si annulla", async () => {
    setUndoWindow(5000);
    renderRoute("/automations/AUD-A1/runs/1", MATTEO);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now.querySelector("[data-preview-email]")).not.toBeNull();
    await userEvent.click(within(now).getByRole("button", { name: "Approve" }));
    expect(now).toHaveTextContent("Your answer goes out in a few seconds");
    expect(within(now).queryByRole("button", { name: "Approve" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await within(now).findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(run(R.waitingApproval).status).toBe("waiting_approval");
  });
});

describe("blocco Home «Automations» [A 25]", () => {
  const withBlock = (personId: string) =>
    state.personalHomes.push({
      personId,
      blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "automations" }],
      seenDepartmentUpdates: {},
    });

  it("elenca solo le esecuzioni che mi riguardano, quelle che aspettano me per prime", async () => {
    withBlock(MATTEO);
    renderRoute("/home", MATTEO);
    const block = await screen.findByRole("region", { name: "Automations" });
    await waitFor(() => expect(block.querySelectorAll("[data-run-row]")).toHaveLength(3));
    const codes = [...block.querySelectorAll("[data-run-row]")].map((r) =>
      r.getAttribute("data-run-row"),
    );
    expect(codes).toEqual(["AUT-1 #2", "AUD-A1 #1", "AUD-A1 #2"]);
    // Nessun bottone: le decisioni stanno in «Decide».
    expect(within(block).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("chi vede le automazioni ma non è coinvolto ha il blocco vuoto", async () => {
    withBlock("p-giulia");
    renderRoute("/home", "p-giulia");
    const block = await screen.findByRole("region", { name: "Automations" });
    expect(await within(block).findByText("No runs that need you")).toBeInTheDocument();
  });

  it("non è nelle Home di default", async () => {
    renderRoute("/home", MATTEO);
    await decideBlock();
    expect(screen.queryByRole("region", { name: "Automations" })).toBeNull();
  });
});

describe("«Created by automation…» su task e traguardi [A 24]", () => {
  it("chi vede l'automazione ha codice, nome e l'esecuzione coi link", async () => {
    renderRoute("/p/CBV/tasks?task=CBV-6", MATTEO);
    const line = await waitFor(() => {
      const el = document.querySelector("[data-automation-origin]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(line).toHaveTextContent("Created by automation AUT-1 Nuovo contratto · run #1");
    expect(within(line).getByRole("link", { name: /AUT-1/ })).toHaveAttribute(
      "href",
      "/automations/AUT-1",
    );
    expect(within(line).getByRole("link", { name: "run #1" }).getAttribute("href")).toMatch(
      /^\/automations\/AUT-1\/runs\/1\?entry=/,
    );
  });

  it("chi non la vede legge solo «Created by an automation», senza link", async () => {
    renderRoute("/p/CBV/tasks?task=CBV-6", "p-sara");
    const line = await waitFor(() => {
      const el = document.querySelector("[data-automation-origin]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(line).toHaveTextContent("Created by an automation");
    expect(line).not.toHaveTextContent("AUT-1");
    expect(within(line).queryByRole("link")).toBeNull();
  });

  it("il traguardo nel dialogo dei traguardi ha la stessa riga", async () => {
    renderRoute("/p/CBV/overview", "p-roberta");
    await userEvent.click(await screen.findByRole("button", { name: "Manage milestones" }));
    const row = await waitFor(() => {
      const el = document.querySelector(`[data-manage-milestone="${NEW_CONTRACT_MILESTONE_ID}"]`);
      expect(el?.querySelector("[data-automation-origin]")).not.toBeNull();
      return el as HTMLElement;
    });
    expect(row).toHaveTextContent("Created by automation AUT-1");
  });
});

describe("sezione «Automations» del progetto [A 22] [A 23]", () => {
  it("in AUD la voce c'è dopo Chat, col conteggio delle esecuzioni in corso", async () => {
    renderRoute("/p/AUD/automations", "p-giulia");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Automations" }),
    ).toBeInTheDocument();
    const link = await waitFor(() => {
      const el = document.querySelector('[data-section="automations"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const sections = [...document.querySelectorAll("[data-section]")].map((l) =>
      l.getAttribute("data-section"),
    );
    expect(sections.indexOf("automations")).toBe(sections.indexOf("chat") + 1);
    expect(link).toHaveTextContent("2");
    expect(await screen.findByRole("list", { name: "Runs in progress" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Automations of AUD" })).toHaveTextContent("AUD-A1");
    // Giulia non gestisce: niente «New automation».
    expect(screen.queryByRole("button", { name: /New automation/ })).toBeNull();
  });

  it("una generale che ha agito qui: chi non la vede ha la riga senza link", async () => {
    run(R.waitingProject).projectIds = ["prj-cbv"];
    renderRoute("/p/CBV/automations", "p-sara");
    const runs = await screen.findByRole("list", { name: "Runs in progress" });
    const row = runs.querySelector('[data-run-row-plain="AUT-1 #2"]');
    expect(row).not.toBeNull();
    expect(within(runs).queryByRole("link")).toBeNull();
    expect(screen.queryByText("General automations that acted here")).toBeNull();
  });

  it("senza automazioni né esecuzioni la voce manca a chi non può crearne", async () => {
    state.automations = state.automations.filter((a) => a.projectId !== "prj-stw");
    renderRoute("/p/STW/tasks", "p-giulia");
    await waitFor(() => expect(document.querySelector('[data-section="chat"]')).not.toBeNull());
    await idle();
    expect(document.querySelector('[data-section="automations"]')).toBeNull();
  });
});

describe("⌘K: gruppo Automations e «New automation»", () => {
  async function search(text: string) {
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), text);
    return dialog;
  }

  it("trova un'automazione per codice, con lo stato in parola", async () => {
    renderRoute("/home", "p-giulia");
    await screen.findByRole("region", { name: "Decide" });
    const dialog = await search("AUD-A1");
    const group = await within(dialog).findByRole("group", { name: "Automations" });
    expect(within(group).getAllByRole("option")[0]).toHaveTextContent("Richiesta dati al cliente");
    expect(group).toHaveTextContent("Active");
  });

  it("R-G5: chi non vede l'automazione non la trova", async () => {
    renderRoute("/home", "p-sara");
    await screen.findByRole("region", { name: "Decide" });
    const dialog = await search("AUD-A1");
    await waitFor(() => expect(within(dialog).queryByText(/Search all messages/)).not.toBeNull());
    expect(within(dialog).queryByRole("group", { name: "Automations" })).toBeNull();
  });

  it("«New automation» apre il dialogo di creazione, solo a chi può crearne", async () => {
    renderRoute("/home", MATTEO);
    await screen.findByRole("region", { name: "Decide" });
    const dialog = await search("new automation");
    await userEvent.click(within(dialog).getByRole("option", { name: "New automation" }));
    expect(await screen.findByRole("dialog", { name: "New automation" })).toBeInTheDocument();
  });

  it("chi non ha automations.manage non ha il comando", async () => {
    renderRoute("/home", "p-sara");
    await screen.findByRole("region", { name: "Decide" });
    const dialog = await search("new automation");
    expect(within(dialog).queryByRole("option", { name: "New automation" })).toBeNull();
  });
});
