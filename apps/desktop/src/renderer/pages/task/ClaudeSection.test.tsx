import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { getConversation, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { grantProjectRole } from "../../data/viewer";
import { renderRoute } from "../../test/renderRoute";

// La sezione «Claude» del dettaglio task: stato, scheda aperta (la stessa
// della conversazione), PR e correzioni, una sola azione in evidenza con i
// permessi di oggi, la storia del lavoro chiusa di default.

const CLAUDE = "p-claude";
const task = (id: string) => state.tasks.find((t) => t.id === id)!;

/** La sezione com'è adesso (letta di nuovo: cambiando stato si ridisegna). */
const current = () => within(screen.getByRole("dialog")).getByRole("region", { name: "Claude" });

/** Apre la task come `me` e aspetta la sezione già letta (niente scheletro). */
async function claudeSection(taskId: string, me: string) {
  renderRoute(`/home?task=${task(taskId).code}`, me);
  await screen.findByRole("dialog", { name: `Task ${task(taskId).code}` });
  return waitFor(() => {
    const section = current();
    expect(section.querySelector("[data-claude-status]")).not.toBeNull();
    return section;
  });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("sezione Claude", () => {
  it("non dice più che le sessioni arriveranno", async () => {
    const section = await claudeSection("t-stw-1", "p-marco");
    expect(section).not.toHaveTextContent("Opens when live sessions are available");
    expect(within(section).getByRole("link", { name: "Open session" })).toHaveAttribute(
      "href",
      expect.stringContaining("/claude/cv-run-stw-1"),
    );
  });

  it("la domanda si risponde qui e si chiude nella conversazione", async () => {
    const section = await claudeSection("t-aud-3", "p-laura");
    const card = within(section).getByRole("region", { name: "Claude asks" });
    await userEvent.click(within(card).getByRole("button", { name: /Create a new contact/ }));
    await waitFor(async () => {
      const detail = await getConversation("cv-run-aud-3");
      const q = detail!.events.find((e) => e.type === "question");
      expect(q?.type === "question" && q.answer?.byId).toBe("p-laura");
    });
    await waitFor(() =>
      expect(within(section).queryByRole("region", { name: "Claude asks" })).toBeNull(),
    );
  });

  it("chi non può rispondere legge la domanda e chi può farlo", async () => {
    state.conversations.find((c) => c.id === "cv-run-aud-3")!.ownerId = "p-laura";
    const section = await claudeSection("t-aud-3", "p-marco");
    const card = within(section).getByRole("region", { name: "Claude asks" });
    expect(within(card).queryByRole("button", { name: /Create a new contact/ })).toBeNull();
    expect(card).toHaveTextContent(/can answer/i);
  });

  it("il piano si approva solo con plans.approve", async () => {
    const dev = await claudeSection("t-stw-13", "p-marco");
    const plan = within(dev).getByRole("region", { name: "Plan · waiting for approval" });
    expect(within(plan).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(plan).toHaveTextContent(/approve plans in STW/);
  });

  it("chi ha plans.approve approva il piano dalla sezione", async () => {
    const section = await claudeSection("t-stw-13", "p-laura");
    const plan = within(section).getByRole("region", { name: "Plan · waiting for approval" });
    await userEvent.click(within(plan).getByRole("button", { name: "Approve" }));
    await waitFor(async () => {
      const detail = await getConversation("cv-run-stw-13");
      const p = detail!.events.find((e) => e.type === "plan");
      expect(p?.type === "plan" && p.status).toBe("approved");
    });
  });

  it("«Assign to Claude» con tickets.edit, e non avvia il lavoro", async () => {
    const t = state.tasks.find(
      (x) => x.projectId === "prj-mkx" && x.claude === "none" && x.closedAt === null,
    )!;
    const section = await claudeSection(t.id, "p-giulia");
    await userEvent.click(within(section).getByRole("button", { name: "Assign to Claude" }));
    await waitFor(() => expect(task(t.id).assigneeId).toBe(CLAUDE));
    expect(state.conversations.some((c) => c.taskId === t.id)).toBe(false);
    await waitFor(() => within(current()).getByRole("button", { name: "Start" }));
  });

  it("«Start» solo con runs.start", async () => {
    const t = state.tasks.find(
      (x) => x.projectId === "prj-stw" && x.claude === "none" && x.closedAt === null,
    )!;
    t.assigneeId = CLAUDE;
    const contributor = await claudeSection(t.id, "p-sara");
    expect(within(contributor).queryByRole("button", { name: "Start" })).toBeNull();
    expect(contributor).toHaveTextContent(/start runs in STW/);
  });

  it("«Start» avvia la sessione della task", async () => {
    const t = state.tasks.find(
      (x) => x.projectId === "prj-stw" && x.claude === "none" && x.closedAt === null,
    )!;
    t.assigneeId = CLAUDE;
    const section = await claudeSection(t.id, "p-marco");
    await userEvent.click(within(section).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(state.conversations.some((c) => c.kind === "task_run" && c.taskId === t.id)).toBe(
        true,
      ),
    );
  });

  it("fallita: «Relaunch with instructions» con runs.start, a chi no lo dice", async () => {
    grantProjectRole("p-sara", "prj-stw", "viewer");
    const contributor = await claudeSection("t-stw-7", "p-sara");
    expect(contributor).toHaveTextContent(/can relaunch it/);
    expect(
      within(contributor).queryByRole("button", { name: "Relaunch with instructions" }),
    ).toBeNull();
  });

  it("fallita: il rilancio parte dalle indicazioni scritte nella sezione", async () => {
    const section = await claudeSection("t-stw-7", "p-marco");
    expect(section.querySelector("[data-claude-status]")).toHaveTextContent(/Failed/);
    await userEvent.click(
      within(section).getByRole("button", { name: "Relaunch with instructions" }),
    );
    await userEvent.type(
      within(section).getByRole("textbox", { name: "Instructions for Claude" }),
      "Keep the order of the plan",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Relaunch" }));
    await waitFor(() =>
      expect(state.conversations.filter((c) => c.taskId === "t-stw-7")).toHaveLength(2),
    );
  });

  it("PR aperta: «Request changes» con corrections.request", async () => {
    // La PR #405 di STW-1 non è ancora mergiata.
    state.pullRequests = state.pullRequests.filter(
      (pr) => !(pr.taskId === "t-stw-1" && pr.kind === "pr_merged"),
    );
    grantProjectRole("p-sara", "prj-stw", "viewer");
    const contributor = await claudeSection("t-stw-1", "p-sara");
    expect(within(contributor).queryByRole("button", { name: "Request changes" })).toBeNull();
    expect(contributor).toHaveTextContent(/PR #405/);
  });

  it("PR aperta: la richiesta di modifiche diventa una correzione", async () => {
    state.pullRequests = state.pullRequests.filter(
      (pr) => !(pr.taskId === "t-stw-1" && pr.kind === "pr_merged"),
    );
    const section = await claudeSection("t-stw-1", "p-marco");
    await userEvent.click(within(section).getByRole("button", { name: "Request changes" }));
    await userEvent.type(
      within(section).getByRole("textbox", { name: "What should change" }),
      "Rename the hook",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Send to Claude" }));
    await waitFor(() =>
      expect(state.conversations.filter((c) => c.kind === "task_run" && c.taskId === "t-stw-1")).toHaveLength(3),
    );
  });

  it("PR mergiata: lo dice, e nessuna azione", async () => {
    const section = await claudeSection("t-stw-1", "p-marco");
    expect(section).toHaveTextContent(/Merged/);
    expect(within(section).queryByRole("button", { name: "Request changes" })).toBeNull();
  });

  it("correzione ferma: «Resume correction» con corrections.request", async () => {
    const run = state.conversations.find((c) => c.id === "cv-run-aud-4")!;
    state.conversationEvents.get(run.id)!.push({
      id: "x-corr",
      at: "2026-10-23T10:00:00Z",
      type: "phase",
      phase: "correction",
      outcome: "stopped",
    });
    const section = await claudeSection("t-aud-4", "p-marco");
    await userEvent.click(within(section).getByRole("button", { name: "Resume correction" }));
    await waitFor(() => expect(run.state).not.toBe("paused"));
  });

  it("la storia del lavoro è chiusa, e aperta va dalla più vecchia", async () => {
    const section = await claudeSection("t-stw-1", "p-marco");
    const toggle = within(section).getByRole("button", { name: /Work story/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const items = within(within(section).getByRole("list", { name: "Work story" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(items[0]).toMatch(/Run started by Marco Bellini/);
    expect(items[1]).toMatch(/Stopped by Marco Bellini/);
    expect(items.findIndex((s) => /Plan approved by Laura Costa/.test(s))).toBeLessThan(
      items.findIndex((s) => /Pull request #405 opened/.test(s)),
    );
    expect(items.at(-1)).toMatch(/PR #405 merged/);
  });
});
