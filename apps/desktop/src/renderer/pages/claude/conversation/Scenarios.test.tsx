import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type {
  CapabilityId,
  ConversationEvent,
  EventDraft,
  ProposedAction,
} from "../../../data/types";
import i18n from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { renderRoute } from "../../../test/renderRoute";
import { renderWithData } from "../../../test/renderWithData";
import { setMatchMedia } from "../../../test/setup";
import { BackRow } from "../../../layout/claudePanel/ClaudePanel";
import { __forgetStartedForTest } from "../../../layout/claudePanel/pageActions";
import { resetPanelToggle } from "../../../layout/claudePanel/panelEvents";
import { clearDrafts } from "../../chat/drafts";
import { Conversation } from "./Conversation";

// Gli scenari nella conversazione (area 10b, Task 11; shape
// `claude-scenarios.md`): «Hypothesis» e «Details», la risposta onesta S0 che
// scrive nella casella senza inviare, la scheda in blocco S4 (perché per
// riga, «Show N more», le righe a parte con «Who?»), la scheda bloccata di
// S5, la scheda di scelta nella libera, e le stesse risposte nella Chat.

const LAURA = "p-laura";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";

beforeEach(async () => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  resetPanelToggle();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  await i18n.changeLanguage("en");
});

const as = (personId: string) => setSessionPersonId(personId);
const userEvents = (id: string) =>
  (state.conversationEvents.get(id) ?? []).filter((e) => e.type === "user");

function mount(id: string, personId: string) {
  as(personId);
  return renderWithData(
    <div style={{ height: 900 }}>
      <Conversation id={id} />
    </div>,
    { personId },
  );
}

/** Eventi iniettati in una libera di `personId` (con il contesto di un progetto, se c'è). */
async function injected(
  personId: string,
  events: EventDraft[],
  contextProjectId: string | null = null,
): Promise<string> {
  as(personId);
  const c = await api.createConversation(contextProjectId ? { contextProjectId } : {});
  await api.runScript(
    c.id,
    events.map((event) => ({ step: "event" as const, event })),
  );
  mount(c.id, personId);
  return c.id;
}

describe("I1: le righe dell'elenco di S2/S3 (shape §3.1)", () => {
  it("niente punto elenco: il codice fa da segno ed è un link; «Other projects» resta senza codice", async () => {
    await injected(ROBERTA, [
      {
        type: "assistant",
        text: [
          "3 projects have stalled tasks",
          "",
          "- **ACQ** — 4 stalled tasks, the oldest for 12 days (no changes)",
          "- **AUD** — 3 stalled tasks, the oldest for 10 days (no one assigned)",
          "- Other projects — $40",
        ].join("\n"),
        done: true,
      },
    ]);
    const rows = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-catalog-rows]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(rows.tagName).toBe("UL");
    expect(rows.className).not.toMatch(/list-disc/);
    const items = within(rows).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    await waitFor(() =>
      expect(within(items[0]!).getByRole("link", { name: "ACQ" })).toHaveAttribute(
        "href",
        "#/p/ACQ/overview",
      ),
    );
    expect(items[0]).toHaveTextContent(
      "ACQ — 4 stalled tasks, the oldest for 12 days (no changes)",
    );
    expect(within(items[2]!).queryByRole("link")).toBeNull();
    expect(items[2]).toHaveTextContent("Other projects — $40");
    // Nessun altro elenco col punto nel messaggio.
    expect(document.querySelector("[data-assistant] ul.list-disc")).toBeNull();
  });

  it("«Used» non ripete i codici già linkati nelle righe; le altre fonti restano (Impeccable 5)", async () => {
    const acq = state.projects.find((p) => p.code === "ACQ")!;
    const aud = state.projects.find((p) => p.code === "AUD")!;
    const task = state.tasks.find((t) => t.projectId === acq.id)!;
    await injected(ROBERTA, [
      {
        type: "assistant",
        text: [
          "2 projects have stalled tasks",
          "",
          "- **ACQ** — 4 stalled tasks",
          "- **AUD** — 3 stalled tasks",
        ].join("\n"),
        done: true,
      },
      {
        type: "citation",
        refs: [
          { kind: "project", id: acq.id },
          { kind: "project", id: aud.id },
          { kind: "task", id: task.id },
        ],
      },
    ]);
    const message = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-assistant]");
      expect(el).toHaveTextContent("Used:");
      return el!;
    });
    const used = [...message.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("Used:"),
    )!;
    expect(used).toHaveTextContent(task.code);
    expect(used).not.toHaveTextContent(/\bACQ\b(?!-)|\bAUD\b/);
  });

  it("anche con «Hypothesis» e «Details» fra la risposta e le fonti, come la vera S2 (Impeccable 5)", async () => {
    const acq = state.projects.find((p) => p.code === "ACQ")!;
    const aud = state.projects.find((p) => p.code === "AUD")!;
    const task = state.tasks.find((t) => t.projectId === acq.id)!;
    await injected(ROBERTA, [
      {
        type: "assistant",
        text: "2 projects have stalled tasks\n\n- **ACQ** — 4 stalled tasks\n- **AUD** — 3 stalled tasks",
        done: true,
      },
      { type: "aside", kind: "hypothesis", text: "Maybe" },
      { type: "aside", kind: "details", text: "How it's counted" },
      {
        type: "citation",
        refs: [
          { kind: "project", id: acq.id },
          { kind: "project", id: aud.id },
          { kind: "task", id: task.id },
        ],
      },
    ]);
    const used = await waitFor(() => {
      const el = [...document.querySelectorAll("p")].find((p) =>
        p.textContent?.startsWith("Used:"),
      );
      expect(el).toBeDefined();
      return el!;
    });
    await waitFor(() => expect(used).toHaveTextContent(task.code));
    expect(used).not.toHaveTextContent(/\bACQ\b(?!-)|\bAUD\b/);
  });

  it("un elenco qualunque resta col suo punto", async () => {
    await injected(ROBERTA, [
      { type: "assistant", text: "Here:\n\n- one thing\n- another", done: true },
    ]);
    await waitFor(() =>
      expect(document.querySelector("[data-assistant] ul.list-disc")).not.toBeNull(),
    );
    expect(document.querySelector("[data-catalog-rows]")).toBeNull();
  });
});

describe("«Hypothesis» e «Details»", () => {
  it("l'ipotesi ha il suo segno e la sua parola; «Details» è chiuso e si apre da tastiera", async () => {
    const user = userEvent.setup();
    await injected(ROBERTA, [
      { type: "assistant", text: "3 projects have stalled tasks", done: true },
      {
        type: "aside",
        kind: "hypothesis",
        text: "ACQ-14 may have fallen out of planning: it has no week",
      },
      { type: "aside", kind: "details", text: "A task counts as stalled when it hasn't changed." },
    ]);
    const hypothesis = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-aside='hypothesis']");
      expect(el).not.toBeNull();
      return el!;
    });
    // Parola + filetto tratteggiato: mai solo colore; lo screen reader legge «Hypothesis:».
    expect(hypothesis).toHaveTextContent(/^Hypothesis/);
    expect(hypothesis.querySelector("[data-aside-rule='dashed']")).not.toBeNull();
    expect(within(hypothesis).getByText("Hypothesis:", { selector: ".sr-only" })).toBeTruthy();

    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("A task counts as stalled when it hasn't changed.")).toBeNull();
    details.focus();
    await user.keyboard("{Enter}");
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("A task counts as stalled when it hasn't changed.")).toBeVisible();
    await user.keyboard(" ");
    expect(details).toHaveAttribute("aria-expanded", "false");
  });
});

const NINE: CapabilityId[] = [
  "automation",
  "stalled",
  "spend",
  "archive",
  "addMember",
  "supportReply",
  "releaseNotes",
  "mailBody",
  "taskDescription",
];

describe("S0, la risposta onesta", () => {
  it("nove voci; un clic scrive la frase nella casella, il primo segnaposto selezionato, nessun invio", async () => {
    const user = userEvent.setup();
    const id = await injected(LAURA, [
      { type: "assistant", text: "In the prototype I can do these things:", done: true },
      { type: "capabilities", items: NINE },
    ]);
    const list = await screen.findByRole("list", { name: "What I can do" });
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(9);
    expect(items[0]).toHaveTextContent("Build an automation and test it");

    const sent = userEvents(id).length;
    await user.click(within(list).getByRole("button", { name: /Add someone to a project/ }));
    const box = screen.getByRole("combobox", { name: /message to claude/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Add [person] to [project] as [role]"));
    await waitFor(() => expect(box).toHaveFocus());
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe("[person]");
    // Tab passa al segnaposto successivo.
    await user.keyboard("{Tab}");
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe("[project]");
    // Nessun messaggio inviato.
    expect(userEvents(id)).toHaveLength(sent);
  });

  it("m8: Tab salta ai segnaposti solo dopo una voce di S0, mai nel testo scritto dalla persona", async () => {
    const user = userEvent.setup();
    await injected(LAURA, [{ type: "capabilities", items: NINE }]);
    await screen.findByRole("list", { name: "What I can do" });
    const box = screen.getByRole("combobox", { name: /message to claude/i }) as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "see [[this] and [[that]");
    box.setSelectionRange(0, 0);
    await user.keyboard("{Tab}");
    expect(box).not.toHaveFocus();
  });

  it("col progetto nel contesto, «[project]» è già il suo codice", async () => {
    const user = userEvent.setup();
    await injected(LAURA, [{ type: "capabilities", items: NINE }], ACQ);
    const list = await screen.findByRole("list", { name: "What I can do" });
    await user.click(within(list).getByRole("button", { name: /Add someone to a project/ }));
    const box = screen.getByRole("combobox", { name: /message to claude/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Add [person] to ACQ as [role]"));
  });

  it("nel riquadro (Laura, Support di ACQ): «scrivimi una poesia» dà le nove voci", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/overview", LAURA);
    await screen.findAllByRole("heading");
    await user.keyboard("{Control>}j{/Control}");
    const panel = () => document.getElementById("claude-panel")!;
    const box = () => within(panel()).getByRole("textbox", { name: "Message to Claude" });
    await waitFor(() => expect(box()).toHaveFocus());
    await user.type(box(), "write me a poem{Enter}");
    const list = await within(panel()).findByRole(
      "list",
      { name: "What I can do" },
      { timeout: 4000 },
    );
    expect(within(list).getAllByRole("button")).toHaveLength(9);
  });
});

describe("S4, la scheda in blocco", () => {
  /** Otto progetti aperti che Roberta può archiviare (nessun lavoro in corso). */
  const eight = () =>
    state.projects
      .filter((p) => !p.archived && api.projectSettings.busyReasonsOf(p.id, ROBERTA).length === 0)
      .slice(0, 8);

  const actions = (): ProposedAction[] =>
    eight().map((p) => ({
      fn: "archiveProject",
      args: { projectId: p.id },
      summary: `Archive ${p.code} ${p.name}`,
      summaryText: {
        key: "claude.answers.archive.summary",
        params: { code: p.code, name: p.name },
      },
      why: { key: "claude.answers.archive.why", params: { date: "2026-07-24" } },
    }));

  it("8 progetti: 5 righe e «Show 3 more»; aperto, 8; tolta una, si archiviano le altre 7", async () => {
    const user = userEvent.setup();
    const projects = eight();
    expect(projects).toHaveLength(8);
    await injected(ROBERTA, [
      {
        type: "proposal",
        proposalId: "prop-s4",
        requesterId: ROBERTA,
        actions: actions(),
        status: "open",
        cls: "B",
        reasons: [],
      },
    ]);
    const card = await screen.findByRole("region", { name: /Claude proposes · 8 changes/ });
    expect(within(card).getAllByRole("checkbox")).toHaveLength(5);
    // Il perché per riga, in un fatto.
    expect(within(card).getAllByText("last activity: Jul 24")).toHaveLength(5);
    expect(within(card).getByRole("button", { name: "Confirm all 8" })).toBeEnabled();

    await user.click(within(card).getByRole("button", { name: "Show 3 more" }));
    expect(within(card).getAllByRole("checkbox")).toHaveLength(8);
    expect(within(card).getByRole("button", { name: "Show fewer" })).toBeTruthy();

    await user.click(within(card).getAllByRole("checkbox")[7]!);
    expect(within(card).getByRole("button", { name: "Confirm 7 selected" })).toBeEnabled();
    await user.click(within(card).getByRole("button", { name: "Confirm 7 selected" }));
    await waitFor(() =>
      expect(state.projects.filter((p) => p.archived && projects.includes(p))).toHaveLength(7),
    );
    expect(state.projects.find((p) => p.id === projects[7]!.id)!.archived).toBeFalsy();
  });

  it("m10: in italiano una riga di progetto tolta si legge «Escluso»", async () => {
    await i18n.changeLanguage("it");
    const user = userEvent.setup();
    await injected(ROBERTA, [
      {
        type: "proposal",
        proposalId: "prop-s4it",
        requesterId: ROBERTA,
        actions: actions().slice(0, 2),
        status: "open",
        cls: "B",
        reasons: [],
      },
    ]);
    const card = await screen.findByRole("region", { name: /Claude propone/ });
    await user.click(within(card).getAllByRole("checkbox")[0]!);
    expect(within(card).getAllByRole("checkbox")[0]).toHaveAccessibleName(/· Escluso\b/);
  });

  it("le righe nascoste restano nella scelta; senza spunte Confirm è spento con la sua frase", async () => {
    const user = userEvent.setup();
    await injected(ROBERTA, [
      {
        type: "proposal",
        proposalId: "prop-s4b",
        requesterId: ROBERTA,
        actions: actions(),
        status: "open",
        cls: "B",
        reasons: [],
      },
    ]);
    const card = await screen.findByRole("region", { name: /Claude proposes · 8 changes/ });
    for (const box of within(card).getAllByRole("checkbox")) await user.click(box);
    // Le tre nascoste sono ancora spuntate.
    expect(within(card).getByRole("button", { name: "Confirm 3 selected" })).toBeEnabled();
    await user.click(within(card).getByRole("button", { name: "Show 3 more" }));
    for (const box of within(card).getAllByRole("checkbox").slice(5)) await user.click(box);
    const confirm = within(card).getByRole("button", { name: /^Confirm/ });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription("Choose at least one project.");
  });

  it("le righe a parte sotto la scheda: non gestibili con «Who?» per progetto, e i progetti occupati", async () => {
    const user = userEvent.setup();
    await injected(ROBERTA, [
      {
        type: "proposal",
        proposalId: "prop-s4c",
        requesterId: ROBERTA,
        actions: actions().slice(0, 2),
        status: "open",
        cls: "B",
        reasons: [],
        notes: [
          {
            kind: "not_manageable",
            count: 2,
            whoAction: "manageProjectSettings",
            codes: ["ACQ", "AUD"],
          },
          {
            kind: "busy",
            code: "BSC",
            reasons: [{ kind: "claude_session", code: "BSC-3", waiting: false } as never],
          },
        ],
      },
    ]);
    const notes = await screen.findByRole("list", { name: "Left out" });
    const [manageable, busy] = within(notes).getAllByRole("listitem");
    expect(manageable).toHaveTextContent("On 2 of these you can't archive");
    expect(busy).toHaveTextContent(
      "BSC has Claude working on BSC-3: it can be archived when that ends",
    );
    // Più progetti: «Who?» apre prima il menu dei codici, poi il «Who?» di quello scelto.
    await user.click(within(manageable!).getByRole("button", { name: "Who?" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual([expect.stringContaining("ACQ"), expect.stringContaining("AUD")]);
    cleanup();
  });

  it("un solo progetto non gestibile: il «Who?» diretto (`WhoCanLink`, `manageProjectSettings`)", async () => {
    await injected(ROBERTA, [
      {
        type: "proposal",
        proposalId: "prop-s4d",
        requesterId: ROBERTA,
        actions: actions().slice(0, 2),
        status: "open",
        cls: "B",
        reasons: [],
        notes: [
          { kind: "not_manageable", count: 1, whoAction: "manageProjectSettings", codes: ["ACQ"] },
        ],
      },
    ]);
    const notes = await screen.findByRole("list", { name: "Left out" });
    expect(notes.querySelector("[data-who-can='manageProjectSettings']")).not.toBeNull();
  });
});

describe("S4, la nota senza `codes` (fixture senza il campo nuovo)", () => {
  it("«On 2 of these you can't archive» senza menu e senza «Who?»", async () => {
    await injected(ROBERTA, [
      {
        type: "proposal",
        proposalId: "prop-s4e",
        requesterId: ROBERTA,
        actions: [{ fn: "archiveProject", args: { projectId: ACQ }, summary: "Archive ACQ" }],
        status: "open",
        cls: "B",
        reasons: [],
        notes: [{ kind: "not_manageable", count: 2, whoAction: "manageProjectSettings" }],
      },
    ]);
    const notes = await screen.findByRole("list", { name: "Left out" });
    expect(notes).toHaveTextContent("On 2 of these you can't archive");
    expect(within(notes).queryByRole("button")).toBeNull();
  });
});

describe("codici e nomi in evidenza nelle schede di S4 e S5 (Impeccable 6, shape §3.7–3.8)", () => {
  it("«Archive **ORT** Orto Social» e «Add **Luca Bianchi** to **ACQ** as Developer»", async () => {
    await injected(LAURA, [
      {
        type: "proposal",
        proposalId: "prop-bold",
        requesterId: LAURA,
        actions: [
          {
            fn: "archiveProject",
            args: { projectId: ACQ },
            summary: "Archive ORT Orto Social",
            summaryText: {
              key: "claude.answers.archive.summary",
              params: { code: "ORT", name: "Orto Social" },
            },
          },
          {
            fn: "addMember",
            args: { projectId: ACQ, personId: "p-luca", roleId: "r" },
            summary: "Add Luca Bianchi to ACQ as Developer",
            summaryText: {
              key: "claude.answers.member.summary",
              params: { name: "Luca Bianchi", code: "ACQ", role: "Developer", context: "vowel" },
            },
          },
        ],
        status: "open",
        cls: "C",
        reasons: [],
      },
    ]);
    const card = await screen.findByRole("region", { name: /Claude proposes/ });
    const strong = [...card.querySelectorAll(".font-semibold")].map((e) => e.textContent);
    expect(strong).toEqual(expect.arrayContaining(["ORT", "Luca Bianchi", "ACQ"]));
    expect(card).toHaveTextContent("Archive ORT Orto Social");
    expect(card).toHaveTextContent("Add Luca Bianchi to ACQ as Developer");
    expect(card).not.toHaveTextContent("**");
    const ort = [...card.querySelectorAll(".font-semibold")].find((e) => e.textContent === "ORT")!;
    expect(ort.className).toMatch(/\bnum\b/);
    // In italiano «ad» davanti a una vocale, anche nella forma in evidenza.
    await act(() => i18n.changeLanguage("it"));
    await waitFor(() =>
      expect(card).toHaveTextContent("Aggiungi Luca Bianchi ad ACQ come Developer"),
    );
  });
});

describe("S5, la scheda bloccata", () => {
  it("Confirm spento con la frase dell'`escalation`, senza «Who?»; Cancel resta", async () => {
    const developer = state.access.roles.find((r) => r.key === "developer")!;
    await injected(LAURA, [
      {
        type: "proposal",
        proposalId: "prop-s5",
        requesterId: LAURA,
        actions: [
          {
            fn: "addMember",
            args: { projectId: ACQ, personId: "p-luca", roleId: developer.id },
            summary: "Add Luca Bianchi to ACQ as Developer",
          },
        ],
        status: "open",
        cls: "C",
        reasons: [{ kind: "notifies", personIds: ["p-luca"], more: false }],
        blocked: { kind: "escalation", roleId: developer.id },
      },
    ]);
    const card = await screen.findByRole("region", { name: /Claude proposes/ });
    const confirm = within(card).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    const sentence = `You can't give the ${developer.name} role in ACQ: it has permissions you don't have there.`;
    expect(confirm).toHaveAccessibleDescription(sentence);
    expect(card.querySelector("[data-blocked]")).toHaveTextContent(sentence);
    expect(card.querySelector("[data-who-can]")).toBeNull();
    expect(within(card).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

describe("m9: la scheda bloccata senza il codice del progetto", () => {
  it("nessun «in :» quando il progetto non si legge", async () => {
    const developer = state.access.roles.find((r) => r.key === "developer")!;
    await injected(LAURA, [
      {
        type: "proposal",
        proposalId: "prop-s5b",
        requesterId: LAURA,
        actions: [
          {
            fn: "addMember",
            args: { projectId: "prj-gone", personId: "p-luca", roleId: developer.id },
            summary: "Add Luca Bianchi as Developer",
          },
        ],
        status: "open",
        cls: "C",
        reasons: [],
        blocked: { kind: "escalation", roleId: developer.id },
      },
    ]);
    const blocked = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-blocked]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(blocked.textContent).not.toMatch(/ in [:.]/);
    expect(blocked).toHaveTextContent(
      `You can't give the ${developer.name} role: it has permissions you don't have in that project.`,
    );
  });
});

describe("la scheda di scelta nella libera", () => {
  it("niente «can approve plans», niente «Other…»; risponde chi ha aperto, il fuoco non va sul body", async () => {
    const user = userEvent.setup();
    const id = await injected(
      LAURA,
      [
        {
          type: "question",
          questionId: "q-free",
          text: "Which department should get the task and the notice?",
          options: [{ label: "Support", recommended: true }, { label: "Development" }],
          answer: null,
          resume: "hello",
        },
      ],
      ACQ,
    );
    const card = await screen.findByRole("region", { name: "Claude asks" });
    expect(card).not.toHaveTextContent(/approve plans/);
    expect(within(card).queryByRole("button", { name: "Other…" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: /Support/ }));
    await waitFor(() =>
      expect(
        (state.conversationEvents.get(id) ?? []).find(
          (e): e is Extract<ConversationEvent, { type: "question" }> => e.type === "question",
        )!.answer,
      ).not.toBeNull(),
    );
    await waitFor(() => expect(screen.getByText(/Answered by Laura Costa/)).toBeTruthy());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("un altro lettore della pubblica: opzioni in sola lettura e «Laura Costa can answer»", async () => {
    as(LAURA);
    const c = await api.createConversation({ contextProjectId: ACQ });
    await api.runScript(c.id, [
      {
        step: "event",
        event: {
          type: "question",
          questionId: "q-free-2",
          text: "Which department should get the task and the notice?",
          options: [{ label: "Support", recommended: true }, { label: "Development" }],
          answer: null,
          resume: "hello",
        },
      },
    ]);
    const first = await api.setVisibility(c.id, "public");
    if (first.status === "needs_confirmation") {
      await api.setVisibility(c.id, "public", {
        confirmedProjectIds: first.touchedProjects.map((p) => p.id),
      });
    }
    mount(c.id, ROBERTA);
    const card = await screen.findByRole("region", { name: "Claude asks" });
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(card).toHaveTextContent("Laura Costa can answer");
    expect(card).not.toHaveTextContent(/approve plans/);
  });
});

describe("nella Chat (@Claude)", () => {
  beforeEach(() => setMatchMedia(DOCKED_PANEL_QUERY, true));

  async function callClaude(text: string) {
    setSessionPersonId("p-giulia");
    const call = await api.chat.sendMessage("ch-announcements", { text });
    const reply = state.chatMessages.find((m) => m.threadOf === call.id && m.kind === "claude")!;
    await api.chat.whenClaudeIdle(reply.id);
    return { callId: call.id, reply: state.chatMessages.find((m) => m.id === reply.id)! };
  }

  it("«Qual è la capitale del Portogallo?»: l'elenco di S0 come testo, senza bottoni né frasi", async () => {
    await i18n.changeLanguage("it");
    const { callId } = await callClaude("@Claude Qual è la capitale del Portogallo?");
    renderRoute(`/chat/ch-announcements?thread=${callId}`, "p-giulia");
    const panel = await screen.findByRole("region", { name: "Thread" });
    const list = await within(panel).findByRole("list", { name: "Cosa so fare" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(9);
    expect(within(list).queryAllByRole("button")).toEqual([]);
    expect(list).toHaveTextContent("Costruire un'automazione e provarla");
    expect(list).not.toHaveTextContent("Quando arriva una richiesta di supporto urgente");
  });

  it("«passa al tema scuro» e «scrivi la risposta ad ACQ-S2»: nessun evento in attesa, la riga che rimanda al riquadro", async () => {
    await i18n.changeLanguage("it");
    for (const text of ["@Claude passa al tema scuro", "@Claude scrivi la risposta ad ACQ-S2"]) {
      const { reply } = await callClaude(text);
      const events = reply.claudeEvents ?? [];
      expect(
        events.filter((e) => e.type === "pageAction" || e.type === "draft" || e.type === "trial"),
      ).toEqual([]);
      expect(reply.text).toMatch(/riquadro di Claude/);
    }
  });
});

// --- S1 nel riquadro: D2, «Back to», la prova adottata (claude-automations.md §3.5) ---

const panel = () => document.getElementById("claude-panel")!;
const panelBox = () => within(panel()).getByRole("textbox", { name: "Message to Claude" });
const S1_TEXT = "When an urgent support request arrives, create a task and notify the department";
const SUPPORT_PAGE = { kind: "page" as const, route: "support", projectId: ACQ };
type Trial = Extract<ConversationEvent, { type: "trial" }>;
const trials = () =>
  [...state.conversationEvents.values()].flat().filter((e): e is Trial => e.type === "trial");
const pathOf = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;

async function settled(id: string) {
  for (let i = 0; i < 10; i++) {
    await api.whenIdle(id);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Laura dalla pagina Support di ACQ: la frase di S1 nel riquadro, poi Support nella scheda. */
async function s1InPanel() {
  const user = userEvent.setup();
  const router = renderRoute("/p/ACQ/support", LAURA);
  await screen.findAllByRole("heading");
  await user.keyboard("{Control>}j{/Control}");
  await waitFor(() => expect(panelBox()).toHaveFocus());
  await user.type(panelBox(), `${S1_TEXT}{Enter}`);
  const card = await within(panel()).findByRole(
    "region",
    { name: "Claude asks" },
    { timeout: 4000 },
  );
  expect(card).toHaveTextContent("Which department should get the task and the notice?");
  // Nessun «Other…» e nessun «can approve plans»: risponde solo Laura.
  expect(within(card).queryByRole("button", { name: "Other…" })).toBeNull();
  expect(card).not.toHaveTextContent(/approve plans/);
  await user.click(within(card).getByRole("button", { name: /^Support/ }));
  await waitFor(() => expect(trials().at(-1)?.status).toBe("done"), { timeout: 4000 });
  const trial = trials().at(-1)!;
  await waitFor(() => expect(pathOf(router)).toBe(`/automations/${trial.code}/test`), {
    timeout: 4000,
  });
  return { user, router, trial };
}

describe("S1 nel riquadro: il costruttore si apre da sé (D2)", () => {
  it("la prova adottata, il riquadro aperto con «Back to ACQ · Support», «Turn on» solo nel costruttore", async () => {
    const { router, trial } = await s1InPanel();
    expect((router.state.location.search as { sim?: string }).sim).toBe(trial.openSimId);
    expect(panel()).toHaveAttribute("data-claude-panel", "open");
    expect(within(panel()).getByRole("button", { name: "Back to ACQ · Support" })).toBeTruthy();
    // La riga eseguita con «Undo», la prova coi due esiti, «It's off…».
    expect(within(panel()).getByRole("button", { name: "Undo" })).toBeTruthy();
    await waitFor(() => expect(panel().querySelectorAll("[data-trial-example]")).toHaveLength(2));
    expect(panel().querySelectorAll("[data-trial-example]")[1]).toHaveTextContent("Wouldn't start");
    expect(panel()).toHaveTextContent("It's off: turn it on from the builder when you're ready.");
    // Nel flusso nessun «Turn on» / «Activate»; nel costruttore sì, ed è di Laura.
    expect(within(panel()).queryByRole("button", { name: /turn on|activate/i })).toBeNull();
    expect(within(panel()).queryByRole("link", { name: /turn on|activate/i })).toBeNull();
    await waitFor(() =>
      expect(document.querySelector("[data-finish-action]")).toHaveTextContent("Turn on"),
    );
    // La prova adottata: niente dialogo degli esempi, la riga «chosen by Claude».
    expect(screen.queryByRole("dialog", { name: "Choose an example" })).toBeNull();
    // m7: la riga dell'esempio dice la richiesta col suo codice, scelta da Claude.
    const chosen = trial.results![0]!.label.params!;
    expect(document.querySelector("[data-test-page]")).toHaveTextContent(
      `Example: ${String(chosen.code)} ${String(chosen.title)} · chosen by Claude`,
    );
    // La navigazione non ruba il fuoco: resta nel riquadro.
    await new Promise((r) => setTimeout(r, 20));
    expect(panel().contains(document.activeElement)).toBe(true);
    // L'annuncio.
    expect(panel()).toHaveTextContent(`Opened ${trial.code} in the builder, on the test.`);
  });

  it("I2: a 1024 il flusso sta accanto al riquadro (l'area di lavoro gli lascia la sua larghezza), col «Turn on» a vista", async () => {
    const { user } = await s1InPanel();
    const width = parseInt(panel().style.width, 10);
    expect(width).toBe(360);
    // La pagina della prova lascia al riquadro la sua larghezza in coda: il
    // flusso (con «Turn on» nella testata) sta prima di quello spazio.
    const spacer = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-claude-beside]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(spacer.style.width).toBe(`${width}px`);
    const page = document.querySelector<HTMLElement>("[data-test-page]")!;
    expect(page.nextElementSibling).toBe(spacer);
    expect(page.contains(document.querySelector("[data-finish-action]"))).toBe(true);
    expect(document.querySelector("[data-column='closed']")).not.toBeNull();
    // L'anteprima sovrapposta resta chiusa (§6): niente pannello sopra il flusso.
    expect(document.querySelector("[data-detail-panel]")).toBeNull();
    // Chiuso il riquadro, la pagina torna intera.
    await user.click(within(panel()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector("[data-claude-beside]")).toBeNull());
  });

  it("I2: a 1440 l'anteprima affiancata è di 400 e il riquadro le sta a sinistra; il flusso ha il resto", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    const { user } = await s1InPanel();
    const preview = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-detail-panel]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(preview.style.width).toBe("400px");
    // L'anteprima affiancata dice il riepilogo della prova finita.
    await waitFor(() => expect(preview).toHaveTextContent("If this were real"));
    // In fila: il flusso, lo spazio del riquadro, l'anteprima al bordo destro.
    const spacer = document.querySelector<HTMLElement>("[data-claude-beside]")!;
    expect(spacer.style.width).toBe(`${parseInt(panel().style.width, 10)}px`);
    expect(document.querySelector("[data-test-page]")!.nextElementSibling).toBe(spacer);
    expect(spacer.nextElementSibling).toBe(preview);
    expect(document.querySelector("[data-column='closed']")).not.toBeNull();
    // «Back to»: la pagina di prima, la colonna torna.
    await user.click(within(panel()).getByRole("button", { name: "Back to ACQ · Support" }));
    await waitFor(() => expect(document.querySelector("[data-claude-beside]")).toBeNull());
    expect(document.querySelector("[data-column='closed']")).toBeNull();
  });

  it("una volta sola: «Back to» torna a Support, la riga sparisce, e non si naviga di nuovo", async () => {
    const { user, router } = await s1InPanel();
    await user.click(within(panel()).getByRole("button", { name: "Back to ACQ · Support" }));
    await waitFor(() => expect(pathOf(router)).toBe("/p/ACQ/support"));
    expect(within(panel()).queryByRole("button", { name: /^Back to/ })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(pathOf(router)).toBe("/p/ACQ/support");
  });

  it("la domanda del reparto: ogni opzione con la striscia 3px del suo reparto (Impeccable 4, shape §3.6)", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ACQ/support", LAURA);
    await screen.findAllByRole("heading");
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelBox()).toHaveFocus());
    await user.type(panelBox(), `${S1_TEXT}{Enter}`);
    const card = await within(panel()).findByRole(
      "region",
      { name: "Claude asks" },
      { timeout: 4000 },
    );
    const support = within(card).getByRole("button", { name: /^Support/ });
    const strip = await waitFor(() => {
      const el = support.querySelector<HTMLElement>("[data-department-strip]");
      expect(el).not.toBeNull();
      return el!;
    });
    const dep = state.departments.find((d) => d.name === "Support")!;
    expect(strip.style.background).toBe(`var(${dep.colorToken})`);
    expect(strip).toHaveAttribute("aria-hidden", "true");
  });

  it("la riga eseguita dice «Created ACQ-A… “…” · draft, off», col codice che apre il costruttore (Impeccable 1)", async () => {
    const { trial } = await s1InPanel();
    const row = await waitFor(() => {
      const el = panel().querySelector<HTMLElement>('[data-executed-action="createAutomation"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const name = state.automations.find((a) => a.code === trial.code)!.name;
    await waitFor(() =>
      expect(row).toHaveTextContent(`Created ${trial.code} “${name}” · draft, off`),
    );
    expect(row).not.toHaveTextContent(/^Done:/);
    const link = within(row).getByRole("link", { name: trial.code! });
    expect(link).toHaveAttribute("href", `#/automations/${trial.code}/edit`);
    expect(link.className).toMatch(/font-semibold/);
  });

  it("«Back to» con «Other…» aperto nel flusso: il fuoco torna nella CASELLA (review finale, 2)", async () => {
    const { user, trial } = await s1InPanel();
    const id = [...state.conversationEvents].find(([, evs]) => evs.includes(trial))![0];
    // Una domanda aperta nel flusso, con «Other…»: la sua textarea sta PRIMA della casella.
    const seeded = [...state.conversationEvents.values()]
      .flat()
      .find((e) => e.type === "question" && e.answer === null)!;
    const draft: Record<string, unknown> = { ...structuredClone(seeded), questionId: "q-back" };
    for (const k of ["id", "at", "resume"]) delete draft[k];
    await act(() => api.runScript(id, [{ step: "event", event: draft as never }]));
    // La conversazione è ferma (`idle`): la scheda si rilegge al ritorno del fuoco sulla finestra.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await user.click(await within(panel()).findByRole("button", { name: "Other…" }));
    expect(panel().querySelectorAll("textarea")[0]).not.toHaveAttribute("data-claude-box");
    await user.click(within(panel()).getByRole("button", { name: "Back to ACQ · Support" }));
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-claude-box"));
  });

  it("riaprendo la conversazione (dopo un ricaricamento del riquadro) non si naviga", async () => {
    await s1InPanel();
    cleanup();
    __forgetStartedForTest();
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/support", LAURA);
    await screen.findAllByRole("heading");
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panel().querySelector("[data-trial]")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(pathOf(router)).toBe("/p/ACQ/support");
    expect(within(panel()).queryByRole("button", { name: /^Back to/ })).toBeNull();
  });

  it("nessun esempio passa (`openSimId` `null`): D2 apre il costruttore `/edit`", async () => {
    // Una bozza di Claude in ACQ, fatta prima (il seme non ha automazioni di ACQ).
    const made = await laurasTrial();
    const automation = state.automations.find((a) => a.id === made.automationId)!;
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/support", LAURA);
    await screen.findAllByRole("heading");
    await user.keyboard("{Control>}j{/Control}");
    await waitFor(() => expect(panelBox()).toHaveFocus());
    await user.type(panelBox(), "hello{Enter}");
    let id = "";
    await waitFor(
      () => {
        const found = [...state.conversationEvents.entries()].find(([, events]) =>
          events.some((e) => e.type === "user" && e.text === "hello"),
        );
        expect(found).toBeDefined();
        id = found![0];
        expect(panel().querySelector("[data-flow='assistant']")).not.toBeNull();
      },
      { timeout: 4000 },
    );
    await act(() =>
      api.runScript(id, [
        { step: "state", state: "working" },
        {
          step: "event",
          event: {
            type: "trial",
            status: "done",
            wants: ["passes"],
            automationId: automation.id,
            code: automation.code,
            results: [],
            openSimId: null,
          },
        },
        { step: "state", state: "idle" },
      ]),
    );
    await waitFor(() => expect(pathOf(router)).toBe(`/automations/${automation.code}/edit`));
    expect(panel()).toHaveTextContent(`Opened ${automation.code} in the builder.`);
  });
});

/** La prova di S1 fatta da Laura fuori dal riquadro (livello dati). */
async function laurasTrial(text = S1_TEXT): Promise<Trial> {
  as(LAURA);
  const c = await api.createConversation();
  await api.sendMessage(c.id, { text }, { context: SUPPORT_PAGE });
  await settled(c.id);
  const q = (state.conversationEvents.get(c.id) ?? []).find(
    (e): e is Extract<ConversationEvent, { type: "question" }> => e.type === "question",
  );
  if (q) {
    await api.answerQuestion(c.id, q.questionId, {
      optionIndex: q.options.findIndex((o) => o.label === "Support"),
      text: null,
    });
    await settled(c.id);
  }
  return trials().at(-1)!;
}

describe("m11: «Back to» senza l'etichetta del chip", () => {
  it("c'è sempre una strada indietro: «Back to the previous page»", async () => {
    const user = userEvent.setup();
    let back = 0;
    renderWithData(
      <BackRow
        back={{ from: "#/home", label: null, target: "/automations/ACQ-A1/test", arrived: true }}
        onBack={() => (back += 1)}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Back to the previous page" }));
    expect(back).toBe(1);
  });
});

describe("`?sim=` nella prova", () => {
  it("di chi guarda: la prova adottata, senza dialogo", async () => {
    const trial = await laurasTrial();
    renderRoute(`/automations/${trial.code}/test?sim=${trial.openSimId}`, LAURA);
    await waitFor(() =>
      expect(document.querySelector("[data-finish-action]")).toHaveTextContent("Turn on"),
    );
    expect(screen.queryByRole("dialog", { name: "Choose an example" })).toBeNull();
  });

  it("m12: a 1440 «Open the test» senza riquadro (un `?sim=` qualunque) non chiude la colonna", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    const trial = await laurasTrial();
    renderRoute(`/automations/${trial.code}/test?sim=${trial.openSimId}`, LAURA);
    await waitFor(() =>
      expect(document.querySelector("[data-finish-action]")).toHaveTextContent("Turn on"),
    );
    expect(document.querySelector("[data-column='closed']")).toBeNull();
    expect(document.querySelector("[data-claude-beside]")).toBeNull();
    cleanup();
    // La prova aperta a mano, a 1440: la colonna resta.
    renderRoute(`/automations/${trial.code}/test`, LAURA);
    await screen.findByRole("dialog", { name: "Choose an example" });
    expect(document.querySelector("[data-column='closed']")).toBeNull();
  });

  it("di un'altra persona (vedi come): il dialogo degli esempi, come oggi", async () => {
    const trial = await laurasTrial();
    renderRoute(`/automations/${trial.code}/test?sim=${trial.openSimId}`, ROBERTA);
    expect(await screen.findByRole("dialog", { name: "Choose an example" })).toBeTruthy();
  });
});

describe("l'origine: «Created by Claude on behalf of …» (maintainer, [AU 8])", () => {
  const claudeDraft = async () => {
    const trial = await laurasTrial();
    return state.automations.find((a) => a.id === trial.automationId)!;
  };
  const origin = () => document.querySelector("[data-created-via]");

  it("la bozza di Claude lo dice nel costruttore e nel dettaglio; una fatta a mano no", async () => {
    const a = await claudeDraft();
    renderRoute(`/automations/${a.code}/edit`, LAURA);
    await waitFor(() =>
      expect(origin()).toHaveTextContent("Created by Claude on behalf of Laura Costa"),
    );
    cleanup();
    renderRoute(`/automations/${a.code}`, LAURA);
    await waitFor(() =>
      expect(origin()).toHaveTextContent("Created by Claude on behalf of Laura Costa"),
    );
    cleanup();
    // Una a mano: la fixture senza `createdVia`.
    const manual = state.automations.find((x) => !x.createdVia)!;
    renderRoute(`/automations/${manual.code}`, ROBERTA);
    await screen.findByRole("heading", { level: 1, name: manual.name });
    expect(origin()).toBeNull();
  });

  it("T2 → T11: l'inizio col filtro nel costruttore, nella prova e nel riepilogo (en/it)", async () => {
    const a = await claudeDraft();
    renderRoute(`/automations/${a.code}/edit`, LAURA);
    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "When a request arrives in ACQ · urgency is high · from support is yes",
      ),
    );
    cleanup();
    await i18n.changeLanguage("it");
    renderRoute(`/automations/${a.code}`, LAURA);
    await waitFor(() =>
      expect(document.body).toHaveTextContent(/· l'urgenza è alta · dal supporto è sì/),
    );
  });

  it("T2 minor: «Brings» del riepilogo dice i dati nella lingua di chi legge", async () => {
    const a = await claudeDraft();
    renderRoute(`/automations/${a.code}`, LAURA);
    const brings = await waitFor(() => {
      const p = [...document.querySelectorAll("[data-flow-summary] p")].find((x) =>
        x.textContent?.startsWith("Brings:"),
      );
      expect(p).toBeDefined();
      return p!;
    });
    expect(brings).toHaveTextContent("Urgency");
    expect(brings).toHaveTextContent("From support");
    expect(brings).not.toHaveTextContent(/Urgenza|Dal supporto/);
  });

  it("accesa da Laura e poi con una versione nuova pubblicata, lo dice ancora", async () => {
    const a = await claudeDraft();
    as(LAURA);
    await api.automations.activate(a.id);
    const flow = structuredClone(
      state.automations.find((x) => x.id === a.id)!.versions.at(-1)!.flow,
    );
    await api.automations.saveDraft(a.id, flow);
    await api.automations.publish(a.id);
    const now = state.automations.find((x) => x.id === a.id)!;
    expect(now.versions.filter((v) => v.publishedAt !== null).length).toBeGreaterThan(1);
    renderRoute(`/automations/${a.code}`, LAURA);
    await waitFor(() =>
      expect(origin()).toHaveTextContent("Created by Claude on behalf of Laura Costa"),
    );
    cleanup();
    renderRoute(`/automations/${a.code}/edit`, LAURA);
    await waitFor(() =>
      expect(origin()).toHaveTextContent("Created by Claude on behalf of Laura Costa"),
    );
  });
});

describe("i file della conversazione non decidono permessi", () => {
  it("nessun `can(` né `viewer` nei file toccati di `pages/claude/conversation/`", () => {
    for (const file of [
      "TrialRow.tsx",
      "AsideRow.tsx",
      "CapabilitiesList.tsx",
      "ProposalCard.tsx",
      "QuestionCard.tsx",
      "EventList.tsx",
      "flow.ts",
      "Composer.tsx",
      "Conversation.tsx",
    ]) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect(source, file).not.toMatch(/\bcan\(/);
      expect(source, file).not.toMatch(/\bviewer\b/);
    }
  });
});

void act;
