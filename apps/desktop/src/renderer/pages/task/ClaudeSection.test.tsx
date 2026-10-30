import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getConversation,
  instance,
  resetApi,
  setLatency,
  setStreamLatency,
  subscribe,
  whenIdle,
} from "../../data/api";
import { setSessionPersonId } from "../../data/session";
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
  setStreamLatency(null);
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

  it("il piano si approva solo con plans.approve; lo stato si dice una volta sola", async () => {
    const dev = await claudeSection("t-stw-13", "p-marco");
    // La riga di stato dice che aspetta; la scheda si intitola solo «Plan».
    const plan = within(dev).getByRole("region", { name: "Plan" });
    expect(within(plan).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(plan).toHaveTextContent(/Someone who can approve plans in STW decides/);
    expect(dev.textContent!.match(/waiting for/gi) ?? []).toHaveLength(1);
    // Con la scheda in attesa l'ultimo messaggio di Claude non si ripete sotto.
    expect(dev).not.toHaveTextContent(/Once the plan is approved/);
  });

  it("chi ha plans.approve approva il piano dalla sezione", async () => {
    const section = await claudeSection("t-stw-13", "p-laura");
    const plan = within(section).getByRole("region", { name: "Plan" });
    await userEvent.click(within(plan).getByRole("button", { name: "Approve" }));
    await waitFor(async () => {
      const detail = await getConversation("cv-run-stw-13");
      const p = detail!.events.find((e) => e.type === "plan");
      expect(p?.type === "plan" && p.status).toBe("approved");
    });
    // La storia dice quando il piano è arrivato e, a parte, quando è stato
    // approvato (la data del registro decisioni), non la stessa ora per tutt'e due.
    await userEvent.click(within(current()).getByRole("button", { name: /Work story/ }));
    const items = within(within(current()).getByRole("list", { name: "Work story" })).getAllByRole(
      "listitem",
    );
    const written = items.find((li) => /^.*Plan written$/.test(li.textContent ?? ""))!;
    const approved = items.find((li) => /Plan approved by Laura Costa/.test(li.textContent ?? ""))!;
    expect(written.querySelector("time")!.dateTime).not.toBe(
      approved.querySelector("time")!.dateTime,
    );
    const row = state.decisionLog.find((d) => d.taskId === "t-stw-13" && d.source === "plan_review")!;
    expect(approved.querySelector("time")!.dateTime).toBe(row.decidedAt);
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
    // Il registro non ha la data di questa decisione: sta nella voce del piano, senza un'ora sua.
    expect(items.findIndex((s) => /Plan written · approved by Laura Costa/.test(s))).toBeLessThan(
      items.findIndex((s) => /Pull request #405 opened/.test(s)),
    );
    expect(items.at(-1)).toMatch(/PR #405 merged/);
  });

  it("task chiusa con la PR mergiata: nessuna azione, nemmeno nel menu", async () => {
    const section = await claudeSection("t-stw-1", "p-laura");
    expect(within(section).queryByRole("button", { name: "Relaunch with instructions" })).toBeNull();
    await userEvent.click(within(section).getByRole("button", { name: "More actions for Claude" }));
    const menu = await screen.findByRole("menu", { name: "More actions for Claude" });
    expect(within(menu).queryByRole("menuitem", { name: "Relaunch with instructions" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Open session" })).toBeInTheDocument();
  });

  it("senza tickets.edit niente «Assign to Claude»", async () => {
    grantProjectRole("p-sara", "prj-stw", "viewer");
    const t = state.tasks.find(
      (x) => x.projectId === "prj-stw" && x.claude === "none" && x.closedAt === null && x.assigneeId !== CLAUDE,
    )!;
    const section = await claudeSection(t.id, "p-sara");
    expect(section).toHaveTextContent("Claude isn't on this task.");
    expect(within(section).queryByRole("button", { name: "Assign to Claude" })).toBeNull();
  });

  it("senza corrections.request niente «Resume correction», ma chi può farlo", async () => {
    state.conversationEvents.get("cv-run-aud-4")!.push({
      id: "x-corr",
      at: "2026-10-23T10:00:00Z",
      type: "phase",
      phase: "correction",
      outcome: "stopped",
    });
    grantProjectRole("p-giulia", "prj-aud", "viewer");
    const section = await claudeSection("t-aud-4", "p-giulia");
    expect(within(section).queryByRole("button", { name: "Resume correction" })).toBeNull();
    expect(section).toHaveTextContent(/request corrections in AUD can resume it/);
  });

  it("l'approvazione in anticipo è nel menu solo con plans.approve", async () => {
    // Una sessione che sta scrivendo il piano (nessun piano ancora).
    const t = state.tasks.find(
      (x) => x.projectId === "prj-stw" && x.claude === "none" && x.closedAt === null,
    )!;
    state.conversations.push({
      ...state.conversations.find((c) => c.id === "cv-run-stw-13")!,
      id: "cv-planning",
      taskId: t.id,
      state: "working",
      createdAt: "2026-10-24T08:00:00Z",
    });
    state.conversationEvents.set("cv-planning", [
      { id: "p1", at: "2026-10-24T08:00:00Z", type: "phase", phase: "plan", outcome: null },
    ]);
    const dev = await claudeSection(t.id, "p-marco");
    await userEvent.click(within(dev).getByRole("button", { name: "More actions for Claude" }));
    const devMenu = await screen.findByRole("menu", { name: "More actions for Claude" });
    expect(within(devMenu).queryByRole("menuitem", { name: "Approve the plan in advance" })).toBeNull();
  });

  it("chi ha plans.approve approva in anticipo dal menu", async () => {
    const t = state.tasks.find(
      (x) => x.projectId === "prj-stw" && x.claude === "none" && x.closedAt === null,
    )!;
    state.conversations.push({
      ...state.conversations.find((c) => c.id === "cv-run-stw-13")!,
      id: "cv-planning",
      taskId: t.id,
      state: "working",
      createdAt: "2026-10-24T08:00:00Z",
    });
    state.conversationEvents.set("cv-planning", [
      { id: "p1", at: "2026-10-24T08:00:00Z", type: "phase", phase: "plan", outcome: null },
    ]);
    const lead = await claudeSection(t.id, "p-laura");
    await userEvent.click(within(lead).getByRole("button", { name: "More actions for Claude" }));
    const menu = await screen.findByRole("menu", { name: "More actions for Claude" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Approve the plan in advance" }));
    await waitFor(() => expect(state.preApprovedPlans.has("cv-planning")).toBe(true));
  });

  it("sessioni che chi guarda non vede: stato neutro, nessuna sessione né azione", async () => {
    const section = await claudeSection("t-aud-3", "p-giulia");
    expect(section.querySelector("[data-claude-status]")).toHaveAttribute(
      "data-claude-status",
      "neutral",
    );
    expect(within(section).queryByRole("link", { name: "Open session" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Follow here" })).toBeNull();
    expect(within(section).queryByRole("region", { name: "Claude asks" })).toBeNull();
    expect(section).toHaveTextContent(/can see the code in AUD/);
  });

  it("progetto senza repository: niente PR, il lavoro si segue lo stesso", async () => {
    const section = await claudeSection("t-mkx-11", "p-giulia");
    expect(section).not.toHaveTextContent(/PR #/);
    expect(within(section).queryByRole("button", { name: "Request changes" })).toBeNull();
    expect(within(section).getByRole("button", { name: "Follow here" })).toBeInTheDocument();
  });

  it("«Follow here»: la sessione nel pannello, e «← Task» riporta il fuoco dov'era", async () => {
    const section = await claudeSection("t-aud-3", "p-laura");
    await userEvent.click(within(section).getByRole("button", { name: "Follow here" }));
    const panel = screen.getByRole("dialog");
    const heading = await within(panel).findByRole("heading", { name: /AUD-3.*Claude/ });
    expect(heading).toHaveFocus();
    expect(panel.querySelector('[data-conversation="cv-run-aud-3"]')).not.toBeNull();
    expect(within(panel).queryByRole("region", { name: "Description" })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: "Back to AUD-3" }));
    await waitFor(() =>
      expect(within(current()).getByRole("button", { name: "Follow here" })).toHaveFocus(),
    );
  });

  it("Claude che aspetta chi guarda: la testata lo dice", async () => {
    await claudeSection("t-aud-3", "p-laura");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Claude is waiting on you/ }),
    ).toBeInTheDocument();
  });

  it("leggere la sezione non fa partire la sessione del seed", async () => {
    const before = state.conversationEvents.get("cv-run-aud-5")!.length;
    await claudeSection("t-aud-5", "p-laura");
    await new Promise((r) => setTimeout(r, 300));
    expect(state.conversationEvents.get("cv-run-aud-5")!.length).toBe(before);
  });
});

describe("sezione Claude: attività AI, cicli delle PR, consumi", () => {
  it("con quale account gira la sessione: sotto lo stato e nella storia, solo il nome", async () => {
    const section = await claudeSection("t-stw-7", "p-laura");
    expect(section.querySelector("[data-run-provider]")).toHaveTextContent(
      "Provider: Team Max (account)",
    );
    await userEvent.click(within(section).getByRole("button", { name: /Work story/ }));
    const story = within(section).getByRole("list", { name: "Work story" });
    expect(story).toHaveTextContent("Run started by Federico Sartori · Team Max (account)");
  });

  it("fallita: il riassunto del fallimento e «Show log» con le azioni della fase", async () => {
    const section = await claudeSection("t-stw-7", "p-laura");
    const failure = section.querySelector<HTMLElement>("[data-run-failure]")!;
    expect(failure).toHaveTextContent(/filters page tests failed twice/);
    // Il riassunto è testo generato, e lo dice (come «In brief» del web).
    expect(failure).toHaveTextContent(/^In brief\s*Generated text/);
    expect(within(failure).queryByRole("list")).toBeNull();
    await userEvent.click(within(failure).getByRole("button", { name: "Show log" }));
    const log = within(failure).getByRole("list", { name: "Log of the Execution phase" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(3);
    expect(log).toHaveTextContent("Edited apps/desktop/src/renderer/data/api-mutations.ts");
    expect(log).toHaveTextContent(/Ran the desktop tests\s*failed/);
    await userEvent.click(within(failure).getByRole("button", { name: "Hide log" }));
    expect(within(failure).queryByRole("list")).toBeNull();
  });

  it("una sessione riuscita non ha né riassunto né log", async () => {
    const section = await claudeSection("t-stw-1", "p-laura");
    expect(section.querySelector("[data-run-failure]")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Show log" })).toBeNull();
  });

  it("PR su due repository: «2 repos», e sotto ogni PR il suo ciclo (giro, tetto)", async () => {
    const section = await claudeSection("t-stw-3", "p-laura");
    expect(section.querySelector("[data-repo-count]")).toHaveTextContent("2 repos");
    const pr411 = section.querySelector<HTMLElement>('[data-pr="411"]')!;
    expect(pr411).toHaveTextContent("stubwise/stubwise");
    expect(pr411).toHaveTextContent("Round 1 of 3 · correction in progress");
    const pr58 = section.querySelector<HTMLElement>('[data-pr="58"]')!;
    expect(pr58).toHaveTextContent("stubwise/guide");
    expect(pr58).toHaveTextContent("Cycle stopped after 3 automatic corrections");
    // Il ciclo dice già a che giro è: niente seconda riga «Correction 1 · in progress».
    expect(section).not.toHaveTextContent("Correction 1 · in progress");
  });

  it("branch protetto e review approvata vengono dai fatti esterni della PR", async () => {
    const [first, second] = state.prFacts;
    first!.branchProtected = true;
    second!.review = { verdict: "approved", at: new Date().toISOString(), byId: null, on: null };
    const section = await claudeSection("t-stw-3", "p-laura");
    expect(section.querySelector('[data-pr="411"] [data-pr-blocked]')).toHaveTextContent(
      "Blocked: this branch is protected, Stubwise doesn't push to it.",
    );
    expect(section.querySelector('[data-pr="58"]')).toHaveTextContent(
      "Approved by the review · ready to merge",
    );
  });

  it("le parole del ciclo in coda e in attesa della review (tutti gli stati: `prCycles` nel dominio)", async () => {
    state.prFacts[0]!.queued = true;
    state.prFacts[1]!.review = { verdict: "pending", at: new Date().toISOString(), byId: null, on: null };
    const section = await claudeSection("t-stw-3", "p-laura");
    expect(section.querySelector('[data-pr="411"]')).toHaveTextContent(
      "Correction queued · it starts when the current work on the task finishes",
    );
    expect(section.querySelector('[data-pr="58"]')).toHaveTextContent("Waiting for the review");
  });

  it("il ciclo si deriva: finita la correzione aspetta la review; «Request changes» apre il giro 2", async () => {
    // La sessione dell'app finisce il suo copione: la correzione 1 è inviata alla #411.
    // La coda di STW del seme è in pausa (area 9b): qui si prova il ciclo, la coda gira.
    state.instance.queuePauses = [];
    setSessionPersonId("p-laura");
    subscribe("cv-run-stw-3", () => {});
    await whenIdle("cv-run-stw-3");
    const section = await claudeSection("t-stw-3", "p-laura");
    const pr411 = () => section.querySelector<HTMLElement>('[data-pr="411"]')!;
    await waitFor(() => expect(pr411()).toHaveTextContent("Waiting for the review"));
    expect(pr411()).not.toHaveTextContent("correction in progress");

    setStreamLatency(40);
    await userEvent.click(within(section).getByRole("button", { name: "Request changes" }));
    await userEvent.type(
      within(section).getByRole("textbox", { name: "What should change" }),
      "Announce the column name too",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Send to Claude" }));
    await waitFor(() =>
      expect(current().querySelector('[data-pr="411"]')).toHaveTextContent(
        "Round 2 of 3 · correction in progress",
      ),
    );
    // La #58 sulla guida non c'entra: resta ferma al tetto.
    expect(current().querySelector('[data-pr="58"]')).toHaveTextContent(
      "Cycle stopped after 3 automatic corrections",
    );
  });

  it("una PR sola: niente «N repos»; senza ciclo resta la riga della correzione", async () => {
    const section = await claudeSection("t-stw-1", "p-laura");
    expect(section.querySelector("[data-repo-count]")).toBeNull();
    expect(section.querySelector("[data-pr-cycle]")).toBeNull();
    expect(section).toHaveTextContent(/Correction 1 · sent/);
  });

  it("consumi AI: chiusi il totale, aperti una riga per modello", async () => {
    const section = await claudeSection("t-stw-1", "p-laura");
    const toggle = within(section).getByRole("button", { name: /AI usage/ });
    // Le due sessioni di STW-1, sommate per modello.
    expect(toggle).toHaveTextContent("427.7K tokens · $4.19");
    await userEvent.click(toggle);
    const list = within(section).getByRole("list", { name: "AI usage by model" });
    expect(within(list).getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      "claude-sonnet-4-5$4.15In 363.3K · out 39K · cache 918.4K",
      "claude-haiku-4-5$0.04In 22.8K · out 2.6K · cache 0",
    ]);
  });

  it("i consumi li vede chi vede la task, anche senza vederne le sessioni (come il web)", async () => {
    const section = await claudeSection("t-aud-3", "p-giulia");
    expect(within(section).getByRole("button", { name: /AI usage/ })).toHaveTextContent(
      "66.2K tokens · $0.52",
    );
  });

  it("senza consumi nessuna riga dei consumi", async () => {
    state.conversations.find((c) => c.id === "cv-run-mkx-11")!.usage = [];
    const section = await claudeSection("t-mkx-11", "p-giulia");
    expect(section.querySelector("[data-ai-usage]")).toBeNull();
  });
});

describe("sezione Claude: le impostazioni d'istanza (area 9b, shape instance-effects)", () => {
  /** Una task aperta del progetto, assegnata a Claude, che non ha mai girato. */
  const readyTask = (projectId: string) => {
    const t = state.tasks.find(
      (x) => x.projectId === projectId && x.claude === "none" && x.closedAt === null,
    )!;
    t.assigneeId = CLAUDE;
    return t;
  };
  const block = (section: HTMLElement) => section.querySelector<HTMLElement>("[data-ai-block]");

  it("budget raggiunto: «Start» spento con la frase e «Who?»; alzato il budget torna acceso", async () => {
    const t = readyTask("prj-acq");
    state.instance.simulate.budgetReached = true;
    const section = await claudeSection(t.id, "p-laura");
    const start = within(section).getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();
    expect(block(section)).toHaveTextContent(
      "The monthly AI budget is used up. New work waits until someone raises it. Who?",
    );
    expect(within(block(section)!).getByRole("button", { name: /Who/ })).toBeEnabled();

    setSessionPersonId("p-roberta");
    await instance.simulateBudgetReached(false);
    setSessionPersonId("p-laura");
    await waitFor(() => expect(within(current()).getByRole("button", { name: "Start" })).toBeEnabled());
    expect(block(current())).toBeNull();
  });

  it("coda di STW in pausa: «Start» acceso con la frase; premuto aspetta, e alla ripresa arriva il piano", async () => {
    const t = readyTask("prj-stw");
    const section = await claudeSection(t.id, "p-roberta");
    expect(block(section)).toHaveTextContent(
      "STW's queue is paused by Roberta Fontana since yesterday at 18:00. If you start now, Claude waits for it to resume.",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(current().querySelector("[data-claude-status]")).toHaveTextContent(
        "Waiting: queue paused by Roberta Fontana",
      ),
    );
    expect(current().querySelector("[data-claude-status]")).toHaveAttribute(
      "data-claude-status",
      "waiting",
    );
    expect(within(current()).queryByRole("button", { name: "Start" })).toBeNull();
    // La storia: partita in attesa della coda, col modello e l'account.
    await userEvent.click(within(current()).getByRole("button", { name: /Work story/ }));
    const story = () => within(current()).getByRole("list", { name: "Work story" });
    expect(story()).toHaveTextContent(
      "Run started by Roberta Fontana · Opus · Team Max (account) · waiting for the queue",
    );

    await instance.resumeQueue("prj-stw");
    await waitFor(
      () =>
        expect(current().querySelector("[data-claude-status]")).not.toHaveTextContent("Waiting"),
      { timeout: 3000 },
    );
    // L'annuncio della ripresa, e la riga della storia con chi ha ripreso la coda.
    await waitFor(() =>
      expect(current().querySelector("[data-claude-started]")).toHaveTextContent(
        `Claude started on ${t.code}.`,
      ),
    );
    expect(story()).toHaveTextContent("Queue resumed by Roberta Fontana · run started");
  });

  it("l'esecuzione con un modello diverso dal piano: la storia lo dice", async () => {
    const t = readyTask("prj-acq");
    state.instance.models.fix_plan = "opus";
    state.instance.models.fix_execute = "sonnet";
    const section = await claudeSection(t.id, "p-laura");
    await userEvent.click(within(section).getByRole("button", { name: "Start" }));
    await waitFor(
      () => expect(current().querySelector("[data-claude-status]")).toHaveAttribute("data-claude-status", "done"),
      { timeout: 8000 },
    );
    await userEvent.click(within(current()).getByRole("button", { name: /Work story/ }));
    const story = () => within(current()).getByRole("list", { name: "Work story" });
    expect(story()).toHaveTextContent("Run started by Laura Costa · Opus · Team Max (account)");
    await waitFor(() => expect(story()).toHaveTextContent("Execution started · Sonnet"));
  });

  it("modello e account con cui la sessione è partita, sotto lo stato", async () => {
    const t = readyTask("prj-acq");
    state.instance.models.fix_plan = "haiku";
    const section = await claudeSection(t.id, "p-laura");
    await userEvent.click(within(section).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(current().querySelector("[data-run-provider]")).toHaveTextContent(
        "Model: Haiku · Account: Team Max (subscription)",
      ),
    );
  });
});
