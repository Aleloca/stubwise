import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { visiblePeopleFor } from "../../../data/access/whoCan";
import type { ProposedAction } from "../../../data/types";
import { PEOPLE } from "../../../data/seed/people";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import { revokeProjectPermission } from "../../../data/viewer";
import i18n from "../../../i18n";
import { ReauthHost } from "../../../layout/ReauthDialog";
import { resetReauthForTest } from "../../../layout/useReauth";
import { clearToasts, ToastRegion } from "../../../tasks-ui/Toast";
import { expectNoDeploy } from "../../../test/noDeploy";
import { renderRoute } from "../../../test/renderRoute";
import { renderWithData } from "../../../test/renderWithData";
import { Conversation } from "./Conversation";

// Le righe delle azioni di Claude nel flusso (area 10a, Task 9; shape
// `claude-actions.md`): la riga eseguita col suo «Undo» e i suoi stati, la
// riga «Didn't run», le righe D con i loro link (dal Task 6 la riga D del
// deploy: solo resa nel DOM `expectNoDeploy()` prova qualcosa, ruling del
// controller (pre-flight), P13).

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ROBERTA = "p-roberta";
const MKX = "prj-mkx";
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

/** La conversazione montata come nel riquadro, con dialogo della riconferma e messaggi. */
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

/** Giulia scrive a Claude in una libera nuova e il flusso è montato. */
async function sent(text: string, personId = GIULIA, contextProjectId: string | null = MKX) {
  as(personId);
  const c = await api.createConversation(contextProjectId ? { contextProjectId } : {});
  const view = mount(c.id, personId);
  await screen.findByRole("combobox", { name: /message to claude/i });
  as(personId);
  await act(() => api.sendMessage(c.id, { text }));
  return { id: c.id, ...view };
}

/** Una scheda di `personId` confermata nel livello dati: il suo id di conversazione. */
async function confirmedCard(personId: string, actions: ProposedAction[]): Promise<string> {
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
        cls: "B",
        reasons: [],
      },
    },
  ]);
  expect(await api.confirmProposal(c.id, "prop-t9")).toMatchObject({ status: "confirmed" });
  return c.id;
}

const rowOf = async () =>
  waitFor(() => {
    const row = document.querySelector<HTMLElement>("[data-executed]");
    expect(row).not.toBeNull();
    return row!;
  });

const created = (projectId: string, title: string) =>
  state.tasks.find((t) => t.projectId === projectId && t.title === title)!;

describe("la riga eseguita (classe A)", () => {
  it("«Created MKX-<n> “Prova”»: il codice apre la task, Undo la elimina e la riga dice «Undone»", async () => {
    const user = userEvent.setup();
    await sent('create "Prova" in MKX');
    const row = await rowOf();
    const task = created(MKX, "Prova");
    await waitFor(() => expect(row.textContent).toContain(`Created ${task.code} “Prova”`));
    const link = within(row).getByRole("link", { name: task.code });
    expect(link).toHaveAttribute("href", `#/p/MKX/tasks?task=${task.code}`);
    await user.click(await within(row).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(row.textContent).toContain("Undone"));
    expect(state.tasksById.has(task.id)).toBe(false);
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull();
    // La task non c'è più: il codice si legge come uno inesistente, non un link.
    await waitFor(() => expect(within(row).queryByRole("link", { name: task.code })).toBeNull());
  });

  it("(maintainer) la riga nel flusso e la voce nel registro, nessun toast", async () => {
    await sent('create "Prova" in MKX');
    const row = await rowOf();
    const groupId = row.getAttribute("data-executed")!;
    expect(state.claudeActions.filter((r) => r.groupId === groupId)).toHaveLength(1);
    // Né nel riquadro né sulla pagina sotto: la regione dei messaggi resta vuota.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  it("dopo Undo il fuoco resta sulla riga, sul suo testo nuovo", async () => {
    const user = userEvent.setup();
    await sent('create "Prova" in MKX');
    const row = await rowOf();
    await user.click(await within(row).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(row.textContent).toContain("Undone"));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active).not.toBe(document.body);
      expect(row.contains(active)).toBe(true);
      expect(active.textContent).toContain("Undone");
    });
  });

  it("Undo con un primo tentativo fallito, poi Retry: la riga diventa «Undone» (il seguito dopo il Retry)", async () => {
    const user = userEvent.setup();
    await sent('create "Prova" in MKX');
    const row = await rowOf();
    const task = created(MKX, "Prova");
    api.failNext("claude.undo");
    await user.click(await within(row).findByRole("button", { name: "Undo" }));
    expect(await within(row).findByText("Couldn't undo. Try again.")).toBeInTheDocument();
    expect(state.tasksById.has(task.id)).toBe(true);
    const retry = within(row).getByRole("button", { name: "Retry" });
    // Un doppio clic non lancia due scritture.
    await user.dblClick(retry);
    await waitFor(() => expect(row.textContent).toContain("Undone"));
    expect(state.tasksById.has(task.id)).toBe(false);
    expect(within(row).queryByText("Couldn't undo. Try again.")).toBeNull();
  });

  it("dopo un commento di Marco: la frase e il link, nessun Undo (niente da scrivere)", async () => {
    const { id } = await sent('crea "Prova" in OLV', GIULIA, null);
    const task = created(OLV, "Prova");
    as(MARCO);
    await api.addComment(task.id, "Ci penso io");
    as(GIULIA);
    await act(() => api.whenIdle(id));
    const row = await rowOf();
    await waitFor(() =>
      expect(row.textContent).toContain(
        "Marco Bellini changed it afterwards · can't undo from here",
      ),
    );
    expect(within(row).getByRole("link", { name: `Open ${task.code}` })).toHaveAttribute(
      "href",
      `#/p/OLV/tasks?task=${task.code}`,
    );
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("«Didn't run» per permesso: la frase con «Who?», e nessun Undo", async () => {
    revokeProjectPermission(GIULIA, MKX, "tickets.create" as never);
    await sent('create "Prova" in MKX');
    const row = await rowOf();
    await waitFor(() =>
      expect(row.textContent).toContain("Didn't run: you can't create tasks in MKX · Who?"),
    );
    expect(row.querySelector('[data-who-can="createTasks"]')).not.toBeNull();
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(created(MKX, "Prova")).toBeUndefined();
  });
});

describe("«Undo» di una scheda confermata", () => {
  const archive = (projectId: string): ProposedAction => ({
    fn: "archiveProject",
    args: { projectId },
    summary: `Archive ${projectId}`,
  });
  const createIn = (title: string): ProposedAction => ({
    fn: "createTask",
    args: { projectId: MKX, title },
    summary: `Create in MKX: “${title}”`,
  });

  it("senza permesso: la frase e «Who?», e «Who?» non ha persone che Giulia non vede", async () => {
    const user = userEvent.setup();
    const id = await confirmedCard(GIULIA, [archive(OLV)]);
    revokeProjectPermission(GIULIA, OLV, "project.settings.manage" as never);
    // L'app intera: il riquadro di «Who?» porta a «Who can?» col router.
    as(GIULIA);
    renderRoute(`/claude/${id}`, GIULIA);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-proposal]");
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(await within(card).findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(card.textContent).toContain("You can no longer undo this in OLV. · Who?"),
    );
    expect(state.projectsById.get(OLV)!.archived).toMatchObject({ byId: GIULIA });
    await user.click(within(card).getByRole("button", { name: /who can/i }));
    const popover = await screen.findByRole("dialog");
    await waitFor(() => expect(popover.textContent ?? "").not.toMatch(/loading/i));
    const seen = visiblePeopleFor(GIULIA);
    const text = (popover.textContent ?? "").toLowerCase();
    // Il riquadro ha letto le persone (Roberta, full admin, può), non è vuoto.
    expect(text).toContain("roberta fontana");
    for (const p of PEOPLE.filter((x) => !x.isClaude && !seen.has(x.id)))
      expect(text).not.toContain(p.name.toLowerCase());
  });

  it("[CA 3] due azioni: un solo controllo «Undo both», sotto l'ultima riga; tre: «Undo all 3»", async () => {
    const two = await confirmedCard(GIULIA, [createIn("Uno"), createIn("Due")]);
    const first = mount(two, GIULIA);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-proposal]");
      expect(el).not.toBeNull();
      return el!;
    });
    const undo = await within(card).findByRole("button", { name: "Undo both" });
    expect(within(card).getAllByRole("button")).toHaveLength(1);
    const rows = card.querySelectorAll("li");
    expect(rows[rows.length - 1]!.compareDocumentPosition(undo)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    first.unmount();
    const three = await confirmedCard(GIULIA, [createIn("A1"), createIn("A2"), createIn("A3")]);
    mount(three, GIULIA);
    expect(await screen.findByRole("button", { name: "Undo all 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("una pubblica di Giulia letta da Roberta", () => {
  it("righe e schede chiuse: nessun bottone, nessuno stato di Undo", async () => {
    as(GIULIA);
    const c = await api.createConversation({ contextProjectId: MKX });
    await api.sendMessage(c.id, { text: 'create "Prova" in MKX' });
    await api.runScript(c.id, [
      {
        step: "event",
        event: {
          type: "proposal",
          proposalId: "prop-open",
          requesterId: GIULIA,
          actions: [{ fn: "deleteTask", args: { id: "t-mkx-7" }, summary: "Delete MKX-7" }],
          status: "open",
          cls: "B",
          reasons: [{ kind: "irreversible" }],
        },
      },
    ]);
    await api.setVisibility(c.id, "public", { confirmedProjectIds: [MKX] });
    const { container } = mount(c.id, ROBERTA);
    const row = await rowOf();
    await waitFor(() => expect(row.textContent).toMatch(/Created MKX-\d+/));
    const card = container.querySelector<HTMLElement>("[data-proposal]")!;
    expect(card.textContent).toContain("Proposal for Giulia Ferri");
    expect(within(row).queryAllByRole("button")).toEqual([]);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(row.textContent).not.toMatch(/undo/i);
  });
});

describe("le righe D", () => {
  it("la frase del deploy, senza link e senza un controllo che faccia il deploy", async () => {
    const { container } = await sent("Deploy MKX to production");
    const line = "Stubwise doesn't deploy: merging a pull request is as far as it goes.";
    await waitFor(() => {
      const messages = container.querySelectorAll("[data-assistant]");
      expect(messages[messages.length - 1]?.textContent ?? "").toContain(line);
    });
    const message = [...container.querySelectorAll("[data-assistant]")].at(-1)!;
    expect(message.querySelector("a")).toBeNull();
    expect(container.querySelector("[data-proposal]")).toBeNull();
    expectNoDeploy();
  });

  it("il link di una riga D si apre quando chi legge vede la meta; altrimenti resta testo", async () => {
    const { id, container } = await sent("Approve the plan of MKX-7");
    const link = await screen.findByRole("link", { name: /Open the plan of MKX-7/ });
    expect(link).toHaveAttribute("href", "#/p/MKX/tasks?task=MKX-7");
    // Un posto che Giulia non vede (ACQ): l'etichetta resta, senza link né asterischi.
    await act(() =>
      api.runScript(id, [
        {
          step: "say",
          text: "Merging is yours to do. [Open the release queue of **ACQ** →](#/p/ACQ/releases)",
        },
      ]),
    );
    const lastMessage = () =>
      [...container.querySelectorAll("[data-assistant]")].at(-1)?.textContent ?? "";
    await waitFor(() => expect(lastMessage()).toContain("Open the release queue of ACQ →"));
    expect(screen.queryByRole("link", { name: /release queue of ACQ/ })).toBeNull();
    expect(lastMessage()).not.toContain("**");
    // Con i link attivi, il deploy resta senza controlli.
    as(GIULIA);
    await act(() => api.sendMessage(id, { text: "Deploy MKX to production" }));
    await waitFor(() =>
      expect(container.textContent).toContain("Stubwise doesn't deploy: merging a pull request"),
    );
    expectNoDeploy();
  });

  it("(T6 I1) senza `decisions.record` non promette il dialogo: lo dice, con «Who?»", async () => {
    const { container } = await sent(
      "Record the decision that we use Postgres on AUD-4",
      GIULIA,
      null,
    );
    await waitFor(() =>
      expect(container.textContent).toContain("And you can't record decisions in AUD either."),
    );
    const message = [...container.querySelectorAll("[data-assistant]")].at(-1)!;
    expect(message.querySelector('[data-who-can="recordDecision"]')).not.toBeNull();
    expect(message.querySelector('a[href*="recordDecision"]')).toBeNull();
  });

  it("(ruling T9) un link all'Amministrazione solo se chi legge apre quella sezione", async () => {
    as(GIULIA);
    expect(await api.openRoutes(["#/admin/roles", "#/admin/people"])).toEqual(["#/admin/people"]);
    as(ROBERTA);
    expect(await api.openRoutes(["#/admin/roles"])).toEqual(["#/admin/roles"]);
    const { id, container } = await sent("Hello", GIULIA);
    await act(() =>
      api.runScript(id, [
        {
          step: "say",
          text: "Roles are yours to change. [Open Administration → Roles →](#/admin/roles)",
        },
      ]),
    );
    const last = () =>
      [...container.querySelectorAll("[data-assistant]")].at(-1)?.textContent ?? "";
    await waitFor(() => expect(last()).toContain("Open Administration → Roles →"));
    expect(screen.queryByRole("link", { name: /Administration → Roles/ })).toBeNull();
  });
});

describe("I2: la riga eseguita sotto il testo di Claude", () => {
  it("«Done…» prima, la riga dopo, nello stesso turno", async () => {
    const { container } = await sent('create "Prova" in MKX');
    const row = await rowOf();
    const text = await waitFor(() => {
      const el = [...container.querySelectorAll("[data-assistant]")].at(-1);
      expect(el?.textContent).toContain("Done");
      return el!;
    });
    expect(text.compareDocumentPosition(row)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("I1: una scheda non riuscita per un permesso perso", () => {
  it("«Couldn't do it: … Nothing was changed. · Who?»", async () => {
    const user = userEvent.setup();
    as(GIULIA);
    const c = await api.createConversation();
    await api.runScript(c.id, [
      {
        step: "event",
        event: {
          type: "proposal",
          proposalId: "prop-i1",
          requesterId: GIULIA,
          actions: [{ fn: "archiveProject", args: { projectId: OLV }, summary: "Archive OLV" }],
          status: "open",
          cls: "B",
          reasons: [],
        },
      },
    ]);
    revokeProjectPermission(GIULIA, OLV, "project.settings.manage" as never);
    mount(c.id, GIULIA);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-proposal]");
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(card.textContent).toContain(
        "Couldn't do it: you can no longer change the project settings in OLV. Nothing was changed. · Who?",
      ),
    );
    expect(card.querySelector('[data-who-can="manageProjectSettings"]')).not.toBeNull();
    expect(state.projectsById.get(OLV)!.archived).toBeFalsy();
  });
});

// La pagina non decide i permessi (P13 del 9c): nei file della conversazione
// toccati dal Task 9 nessuna chiamata a `can(` e nessun import di data/viewer.
const SOURCES = import.meta.glob(
  [
    "./ExecutedRow.tsx",
    "./UndoControl.tsx",
    "./ProposalCard.tsx",
    "./EventList.tsx",
    "./flow.ts",
    "./AssistantMessage.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("la conversazione non decide i permessi", () => {
  it("trova i sorgenti", () => {
    expect(Object.keys(SOURCES).sort()).toEqual([
      "./AssistantMessage.tsx",
      "./EventList.tsx",
      "./ExecutedRow.tsx",
      "./ProposalCard.tsx",
      "./UndoControl.tsx",
      "./flow.ts",
    ]);
  });

  it("nessun file chiama can( né importa data/viewer", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, src]) => /(^|[^\w.`])can\(/.test(src) || /data\/viewer["']/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
