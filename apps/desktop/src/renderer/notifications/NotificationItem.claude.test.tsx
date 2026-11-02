import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chat,
  listNotifications,
  projectSettings,
  resetApi,
  setLatency,
  setStreamLatency,
} from "../data/api";
import { createTaskAs } from "../data/api-mutations";
import { visiblePeopleFor } from "../data/access/whoCan";
import { CLAUDE_SEED_IDS, HANDOVER_TASK } from "../data/seed/claudeActions";
import { PEOPLE } from "../data/seed/people";
import { setSessionPersonId } from "../data/session";
import { now, state } from "../data/store";
import type { AppNotification, ChatMessage } from "../data/types";
import i18n, { setLanguage } from "../i18n";
import { renderRoute } from "../test/renderRoute";
import { renderWithData } from "../test/renderWithData";
import { NotificationItem } from "./NotificationItem";

// «Claude on behalf of» nelle notifiche (area 10a, Task 11; shape
// claude-trace.md). La notifica nata da un'azione di Claude (`viaClaude`)
// comincia col prefisso; «Undone by <nome>» si deriva a lettura
// (`undoneByName`), senza data e senza una seconda notifica. Vale anche per
// le conferme di @Claude nella Chat (maintainer, 2 nov 2026), che non hanno
// «Undo» e quindi mai «Undone by».
//
// Seme (Task 7): Giulia, con Claude, dà OLV-1 a Marco (`task.assigned`), poi
// annulla.

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const OLV = "prj-olv";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const as = (personId: string) => setSessionPersonId(personId);

async function readAs(personId: string, id: string): Promise<AppNotification> {
  as(personId);
  const n = (await listNotifications()).find((x) => x.id === id);
  if (!n) throw new Error(`${id} non arriva a ${personId}`);
  return n;
}

function renderItem(n: AppNotification, personId: string) {
  return renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "OLV", name: "Olivia" }}
        onOpen={() => {}}
        onChange={() => {}}
      />
    </ul>,
    { personId },
  );
}

const itemText = () =>
  (document.querySelector("[data-notification]")?.textContent ?? "").replace(/\s+/g, " ");

describe("la notifica di Marco (seme)", () => {
  it("titolo del tipo, corpo col prefisso e «Undone by Giulia Ferri», in en e in it", async () => {
    const n = await readAs(MARCO, CLAUDE_SEED_IDS.notification);
    renderItem(n, MARCO);
    const item = document.querySelector<HTMLElement>("[data-notification]")!;
    expect(within(item).getByText(`You've been assigned ${HANDOVER_TASK.code}`)).toBeInTheDocument();
    expect(
      within(item).getByText(
        `Claude on behalf of Giulia Ferri assigned you ${HANDOVER_TASK.code}.`,
      ),
    ).toBeInTheDocument();
    expect(item.querySelector("[data-undone-by]")?.textContent).toBe("Undone by Giulia Ferri");
    // Nessuna data sulla riga ([CT 10]).
    expect(item.querySelector("[data-undone-by]")?.textContent).not.toMatch(/\d/);

    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(within(item).getByText(`Ti è stata assegnata ${HANDOVER_TASK.code}`)).toBeInTheDocument(),
    );
    expect(
      within(item).getByText(
        `Claude per conto di Giulia Ferri ti ha assegnato ${HANDOVER_TASK.code}.`,
      ),
    ).toBeInTheDocument();
    expect(item.querySelector("[data-undone-by]")?.textContent).toBe("Annullato da Giulia Ferri");
  });

  it("nel pannello di Marco: una notifica sola per l'assegnazione, non anche una per l'annullamento", async () => {
    const user = userEvent.setup();
    renderRoute("/home", MARCO);
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    await waitFor(() =>
      expect(within(panel).getAllByText(/Claude on behalf of Giulia Ferri/i)).toHaveLength(1),
    );
    expect(within(panel).getAllByText(/Undone by/i)).toHaveLength(1);
  });
});

describe("righe di prima e R-G5", () => {
  it("una notifica nata prima del 10a (senza i campi nuovi) non ha prefisso né «Undone by»", () => {
    // Apposta SENZA `viaClaude` e `undoneByName`: la forma delle righe di prima.
    const legacy = {
      id: "n-legacy",
      kind: "task.assigned",
      projectId: OLV,
      objectCode: "OLV-2",
      departmentId: null,
      recipientIds: [MARCO],
      title: "You've been assigned OLV-2",
      body: "OLV-2 · Press kit: Giulia Ferri assigned it to you.",
      createdAt: "2026-10-20T10:00:00Z",
      read: true,
      archived: false,
      snoozedUntil: null,
      link: "#/p/OLV/tasks?task=OLV-2",
    } as AppNotification;
    renderItem(legacy, MARCO);
    expect(itemText()).toContain("OLV-2 · Press kit: Giulia Ferri assigned it to you.");
    expect(itemText()).not.toMatch(/claude|undone/i);
  });

  it("chi agisce e chi annulla, se chi riceve non li vede, non si nominano", async () => {
    const hidden = PEOPLE.find((p) => !p.isClaude && !visiblePeopleFor(MARCO).has(p.id))!;
    expect(hidden).toBeDefined();
    state.claudeActions.push({
      ...state.claudeActions.find((r) => r.id === CLAUDE_SEED_IDS.brief.plan)!,
      id: "ca-hidden",
      personId: hidden.id,
      undone: { at: now(), byId: hidden.id },
    });
    state.notifications.push({
      ...state.notifications.find((x) => x.id === CLAUDE_SEED_IDS.notification)!,
      id: "n-hidden",
      body: "OLV-1 · Refresh landing page hero copy: assigned to you.",
      viaClaude: { personId: hidden.id, actionId: "ca-hidden" },
    });
    const n = await readAs(MARCO, "n-hidden");
    renderItem(n, MARCO);
    const text = itemText();
    expect(text.toLowerCase()).not.toContain(hidden.name.toLowerCase());
    expect(text).toContain("Claude on behalf of someone assigned you OLV-1.");
    expect(text).not.toMatch(/undone by/i);
  });
});

describe("@Claude nella Chat (maintainer)", () => {
  it("una proposta confermata in un thread: registro e notifica di Marco col prefisso, senza «Undone by»", async () => {
    setStreamLatency(null);
    const task = createTaskAs(GIULIA, { projectId: OLV, title: "Photos of the olive grove", assigneeId: GIULIA });
    as(GIULIA);
    const settings = (await projectSettings.getProjectSettings(OLV))!;
    const root = state.chatMessages.find((m) => m.channelId === "ch-olv-general" && m.threadOf === null)!;
    const reply: ChatMessage = {
      id: "m-test-claude",
      channelId: root.channelId,
      threadOf: root.id,
      authorId: "p-claude",
      kind: "claude",
      calledById: GIULIA,
      text: "I can move it to Marco Bellini and turn off the weekly brief: confirm below.",
      attachments: [],
      citations: [],
      reactions: [],
      asksReplyOf: [],
      linkedCodes: [],
      createdAt: now(),
      editedAt: null,
      deletedAt: null,
      deletedById: null,
      claudeEvents: [
        {
          id: "ev-test-proposal",
          at: now(),
          type: "proposal",
          proposalId: "prop-test",
          requesterId: GIULIA,
          actions: [
            {
              fn: "planTask",
              args: { id: task.id, plan: { assigneeId: MARCO, week: "2026-W45" } },
              summary: `Plan ${task.code} for Marco Bellini · W45`,
            },
            {
              fn: "saveProjectAutomations",
              args: {
                projectId: OLV,
                switches: { ...settings.switches, weeklyBrief: !settings.switches.weeklyBrief },
                pulseEveryDays: settings.pulseEveryDays,
                correctionCap: settings.correctionCap,
              },
              summary: "Weekly brief in OLV",
            },
          ],
          status: "open",
        },
      ],
    };
    state.chatMessages.push(reply);
    as(GIULIA);
    expect(await chat.confirmChatProposal(reply.id, "prop-test")).toMatchObject({
      status: "confirmed",
    });

    // La notifica di Marco.
    as(MARCO);
    const note = (await listNotifications()).find(
      (x) => x.kind === "task.assigned" && x.objectCode === task.code,
    )!;
    renderItem(note, MARCO);
    expect(itemText()).toContain(`Claude on behalf of Giulia Ferri assigned you ${task.code}.`);
    expect(itemText()).not.toMatch(/undone/i);

    // La voce del registro (Change log di OLV, Giulia): il prefisso, senza «Undid:».
    renderRoute("/p/OLV/settings/changelog", GIULIA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    const entry = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-change-entry="project.switch_changed"]');
      if (!el) throw new Error("nessuna voce");
      return el;
    });
    expect(entry.textContent).toMatch(/^\d\d:\d\dClaude on behalf of Giulia Ferri turned (on|off) the weekly brief in OLV\./);
    expect(entry.textContent).not.toMatch(/undid/i);
  });
});
