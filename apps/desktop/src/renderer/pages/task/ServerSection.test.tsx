import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProject,
  decidePlan,
  releases,
  resetApi,
  servers,
  setLatency,
  setStreamLatency,
} from "../../data/api";
import { createTaskAs } from "../../data/api-mutations";
import { CLAUDE_ID } from "../../data/seed/people";
import { whenFixesIdle } from "../../data/servers/fix";
import { setSessionPersonId } from "../../data/session";
import { eventsOf, state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// La task di un server (Task 9 del piano 8b, shape server-task.md; area 8,
// F4b): la sezione «Server» in testa al pannello, l'avvio con le due
// condizioni sempre scritte, la scheda del piano della correzione — SOLO
// azioni dell'insieme chiuso, tradotte, nessun campo libero, mai in
// anticipo, approvazione spenta col motivo, l'avviso su un server condiviso
// PRIMA di approvare «libera spazio» — il registro dei comandi con l'uscita
// lunga in finestra e NON fidata (testo, mai link), il controllo finale in
// parole; la sessione d'analisi nella destinazione Claude; «Link SSH access»
// sull'avviso senza accesso.

const TASK = "t-acq-srv-1"; // ACQ-6, la diagnosi di SRV-1 (seme)
const CODE = "ACQ-6";

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});
afterEach(async () => {
  await whenFixesIdle();
  resetApi();
});

const panel = () => screen.getByRole("dialog", { name: `Task ${CODE}` });
const serverSection = () => within(panel()).getByRole("region", { name: "Server" });
const claudeSection = () => within(panel()).getByRole("region", { name: "Claude" });

/** Apre ACQ-6 come `me` e aspetta la sezione Server già letta. */
async function openTask(me: string) {
  renderRoute(`/p/ACQ/tasks?task=${CODE}`, me);
  await screen.findByRole("dialog", { name: `Task ${CODE}` });
  await waitFor(() => expect(serverSection()).toHaveTextContent("SRV-1"));
  return serverSection();
}

/** Avvia la correzione dal livello dati come `me` e aspetta il piano. */
async function startAs(me: string): Promise<string> {
  setSessionPersonId(me);
  const c = await servers.startServerFix(TASK);
  await whenFixesIdle();
  return c.id;
}

const fixConversation = () => state.conversations.find((c) => c.serverFix)!.id;

const isChange = (e: ConversationEvent): e is Extract<ConversationEvent, { type: "action" }> =>
  e.type === "action" && e.serverCommand?.kind === "change";
const fixCommands = () =>
  state.conversations.flatMap((c) => eventsOf(c.id)).filter(isChange).length;
const srv1 = () => state.servers.find((s) => s.code === "SRV-1")!;

describe("sezione Server: il budget del mese (area 9b, shape instance-effects)", () => {
  it("«Start fix on the server» spento con la frase del budget e «Who?» (a chi non ha plans.approve)", async () => {
    state.instance.simulate.budgetReached = true;
    // D-7.1: Roberta (full admin) scavalcherebbe il budget; Marco (Developer in ACQ) no.
    const section = await openTask("p-marco");
    const start = section.querySelector<HTMLButtonElement>("[data-start-fix]")!;
    await waitFor(() => expect(start).toBeDisabled());
    expect(section.querySelector('[data-ai-block="monthly_budget"]')).toHaveTextContent(
      "The monthly AI budget is used up. New work waits until someone raises it. Who?",
    );
  });
});

describe("sezione Server", () => {
  it("dice server, episodio, stato e proposta, prima della descrizione", async () => {
    const section = await openTask("p-roberta");
    expect(section).toHaveTextContent("SRV-1");
    expect(section).toHaveTextContent("acq-prod-01");
    expect(section).toHaveTextContent("Healthy");
    expect(section).toHaveTextContent(/Memory above 90% · .*18:00 → 20:00 \(back to normal\)/);
    expect(section).toHaveTextContent("Diagnosis ready");
    expect(section).toHaveTextContent("Suggested fix:");
    expect(section).toHaveTextContent(/Restart the `portale-import` container/);
    expect(within(section).getByRole("link", { name: /Read the analysis/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/claude/cv-srv-1-analysis"),
    );
    expect(within(section).getByRole("link", { name: /Open/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/p/ACQ/servers/SRV-1"),
    );
    // In testa: prima della descrizione.
    const regions = within(panel())
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-labelledby") && r.querySelector("h3")?.textContent);
    expect(regions.indexOf("Server")).toBeLessThan(regions.indexOf("Description"));
  });

  it("«Start fix on the server» per Marco e Roberta; Laura legge chi può farlo, le condizioni restano scritte", async () => {
    for (const me of ["p-marco", "p-roberta"]) {
      const section = await openTask(me);
      expect(
        within(section).getByRole("button", { name: "Start fix on the server" }),
      ).toBeInTheDocument();
      expect(section).toHaveTextContent(
        "1. Only people allowed to operate ACQ's servers can start it.",
      );
      expect(section).toHaveTextContent(
        "2. Claude writes a plan of allowed actions first. Nothing runs on SRV-1 until someone who can approve plans in ACQ approves it — even you.",
      );
      document.body.innerHTML = "";
    }
    const laura = await openTask("p-laura");
    expect(within(laura).queryByRole("button", { name: /Start fix/ })).toBeNull();
    expect(laura).toHaveTextContent("Someone allowed to operate ACQ's servers can start the fix.");
    expect(laura).toHaveTextContent(
      "1. Only people allowed to operate ACQ's servers can start it.",
    );
    expect(laura).toHaveTextContent(/2\. Claude writes a plan of allowed actions first/);
  });

  it("Roberta avvia dal dialogo: piano da approvare anche per lei, nessun anticipo, nessun comando", async () => {
    const user = userEvent.setup();
    const section = await openTask("p-roberta");
    await user.click(within(section).getByRole("button", { name: "Start fix on the server" }));
    const dialog = await screen.findByRole("dialog", { name: "Start a fix on SRV-1?" });
    expect(dialog).toHaveTextContent(
      "The agent runs only the allowed actions, one at a time — restart, stop or start a container, free up space — and only after the plan is approved.",
    );
    expect(dialog).not.toHaveTextContent(/stubwise-fix|can do anything/);
    // Il campo facoltativo «Notes for Claude» (shape server-task §2).
    await user.type(
      within(dialog).getByRole("textbox", { name: "Notes for Claude" }),
      "Restart only, no config change.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Start fix" }));
    await whenFixesIdle();
    expect(
      eventsOf(fixConversation()).some(
        (e) => e.type === "plan" && e.planText.includes("Restart only, no config change."),
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(serverSection()).toHaveTextContent("Fix plan waiting for your approval"),
    );
    const plan = await within(serverSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(plan).toHaveTextContent(
      "The monitoring agent on SRV-1 runs these actions, one at a time. Nothing else can run.",
    );
    expect(plan).toHaveTextContent(
      "A plan that releases — pull, image update, deploy — must be rejected. Releases go through Releases.",
    );
    expect(plan).toHaveTextContent("You started this fix. Approving runs the actions on SRV-1.");
    expect(within(plan).getByRole("button", { name: "Approve the plan" })).toBeEnabled();
    expect(within(plan).getByRole("button", { name: "Reject with instructions" })).toBeEnabled();
    expect(claudeSection()).toHaveTextContent("Fix on SRV-1 · waiting for your approval");
    // Decisione del maintainer (15 nov 2026): nella sezione Claude il piano si
    // legge, ma si decide nella sezione Server.
    const readOnly = within(claudeSection()).getByRole("region", { name: "Fix plan for SRV-1" });
    expect(within(readOnly).queryByRole("button", { name: "Approve the plan" })).toBeNull();
    expect(readOnly).toHaveTextContent("You decide this plan in the task's Server section");
    // Nel «⋯» nessuna approvazione in anticipo.
    await user.click(
      within(claudeSection()).getByRole("button", { name: "More actions for Claude" }),
    );
    const menu = await screen.findByRole("menu");
    // Controllo positivo: il menu è quello vero (c'è «Open session»).
    expect(within(menu).getByRole("menuitem", { name: "Open session" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /advance|Pre-approve/i })).toBeNull();
    expect(fixCommands()).toBe(0);
  });

  it("review F4b: la proposta di Claude è testo, mai un link", async () => {
    const a = state.serverAnalyses.find((x) => x.taskId === TASK)!;
    a.proposal = "Restart it, see [the runbook](https://evil.example.com).";
    await openTask("p-roberta");
    await waitFor(() => expect(serverSection()).toHaveTextContent("see [the runbook]"));
    expect(within(serverSection()).queryByRole("link", { name: "the runbook" })).toBeNull();
  });

  it("decisione 3: Approva dalla sezione Server fa partire i comandi; Stop la ferma da lì", async () => {
    const user = userEvent.setup();
    await startAs("p-marco");
    // Lo stream rallentato: lo Stop arriva a correzione in corso.
    setStreamLatency(40);
    await openTask("p-laura");
    const plan = await within(serverSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(fixCommands()).toBe(0);
    await user.click(within(plan).getByRole("button", { name: "Approve the plan" }));
    await waitFor(() => expect(fixCommands()).toBeGreaterThan(0));
    // Nella sessione nessuno Stop né «Ferma e scrivi»: si ferma dalla task.
    const stop = await within(serverSection()).findByRole("button", { name: "Stop the fix" });
    await user.click(stop);
    await whenFixesIdle();
    // Fermata da Laura, non finita da sola.
    await waitFor(() =>
      expect(
        eventsOf(fixConversation())
          .filter((e) => e.type === "phase" && e.outcome === "stopped")
          .at(-1),
      ).toMatchObject({ stoppedById: "p-laura" }),
    );
  });

  it("Marco avvia e legge chi deve approvare; nessun bottone d'approvazione", async () => {
    await startAs("p-marco");
    await openTask("p-marco");
    const plan = await within(serverSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(within(plan).queryByRole("button", { name: "Approve the plan" })).toBeNull();
    expect(plan).toHaveTextContent("Waiting for someone who can approve plans in ACQ.");
    expect(serverSection()).toHaveTextContent("Fix plan waiting for approval");
  });

  it("server cancellato: «SRV-1 · deleted» a chi vede la task; non visibile: «A server you can't see»", async () => {
    setSessionPersonId("p-roberta");
    await servers.deleteServer("SRV-1");
    renderRoute(`/p/ACQ/tasks?task=${CODE}`, "p-marco");
    await screen.findByRole("dialog", { name: `Task ${CODE}` });
    await waitFor(() => expect(serverSection()).toHaveTextContent("SRV-1·deleted"));
    expect(serverSection()).not.toHaveTextContent("A server you can't see");
  });

  it("server tolto dal progetto (orfano): chi non lo vede legge «A server you can't see»", async () => {
    for (const env of state.environments)
      env.servers = env.servers.filter((s) => s.serverCode !== "SRV-1");
    renderRoute(`/p/ACQ/tasks?task=${CODE}`, "p-marco");
    await screen.findByRole("dialog", { name: `Task ${CODE}` });
    await waitFor(() => expect(serverSection()).toHaveTextContent("A server you can't see"));
    expect(serverSection()).not.toHaveTextContent("deleted");
  });

  it("il piano mostra SOLO le azioni dell'insieme chiuso, tradotte, col perché; nessun comando né campo libero", async () => {
    const id = await startAs("p-marco");
    const event = eventsOf(id).find((e) => e.type === "plan") as Extract<
      ConversationEvent,
      { type: "plan" }
    >;
    expect(event.serverPlan?.steps.length).toBeGreaterThan(0);
    await openTask("p-laura");
    const plan = await within(claudeSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    const list = within(plan).getByRole("list", { name: "Actions on SRV-1" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(event.serverPlan!.steps.length);
    expect(items[0]).toHaveTextContent("Restart portale-import (stopping it waits up to 30 s)");
    event.serverPlan!.steps.forEach((step, i) => expect(items[i]).toHaveTextContent(step.why));
    // Nessuna riga di comando a vista, nessun campo per scriverne una.
    expect(list.querySelector("code")).toBeNull();
    expect(list).not.toHaveTextContent(/container\.restart|sudo|docker /);
    expect(within(plan).queryByRole("textbox")).toBeNull();
    // Il piano intero resta chiuso: le azioni si leggono senza clic.
    expect(within(plan).getByRole("button", { name: "Read the full plan" })).toBeInTheDocument();
    // In italiano le azioni sono tradotte.
    act(() => setLanguage("it"));
    try {
      await waitFor(() =>
        expect(
          within(claudeSection()).getByRole("list", { name: "Azioni su SRV-1" }),
        ).toHaveTextContent("Riavvia portale-import (per fermarlo aspetta fino a 30 s)"),
      );
    } finally {
      act(() => setLanguage("en"));
    }
  });

  it("server condiviso: l'avviso su «libera spazio» c'è PRIMA di approvare, coi progetti che chi guarda vede", async () => {
    setSessionPersonId("p-roberta");
    const other = await createProject({ code: "SHOP", name: "Shop", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    const ep = {
      id: "ep-ui-disk",
      serverCode: "SRV-1",
      severity: "trouble" as const,
      reasons: [{ kind: "disk" as const, valuePct: 96, thresholdPct: 90 }],
      startedAt: "2026-11-14T10:00:00Z",
      recoveredAt: null,
      analysisId: null,
    };
    state.serverEpisodes.push(ep);
    const task = createTaskAs(
      CLAUDE_ID,
      { projectId: "prj-acq", title: "Disk full on acq-prod-01", type: "bug" },
      { source: "server", serverRef: { serverCode: "SRV-1", episodeId: ep.id } },
    );
    setSessionPersonId("p-roberta");
    const c = await servers.startServerFix(task.id);
    await whenFixesIdle();
    expect(eventsOf(c.id).some((e) => e.type === "plan")).toBe(true);
    renderRoute(`/p/ACQ/tasks?task=${task.code}`, "p-roberta");
    const dialog = await screen.findByRole("dialog", { name: `Task ${task.code}` });
    const plan = await waitFor(() =>
      within(within(dialog).getByRole("region", { name: "Server" })).getByRole("region", {
        name: "Fix plan for SRV-1",
      }),
    );
    const warning = within(plan).getByRole("note", { name: "SRV-1 is shared" });
    expect(warning).toHaveTextContent(
      "Freeing up space touches the whole server: SRV-1 is also used by Shop.",
    );
    // Prima dei bottoni di decisione.
    const approve = within(plan).getByRole("button", { name: "Approve the plan" });
    expect(
      warning.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(fixCommands()).toBe(0);
  });

  it("server non condiviso: nessun avviso", async () => {
    await startAs("p-roberta");
    await openTask("p-roberta");
    const plan = await within(claudeSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(within(plan).queryByRole("note", { name: /is shared/ })).toBeNull();
  });

  it("operazioni dell'agente spente col piano in attesa: Approve spento col motivo, Reject attivo", async () => {
    await startAs("p-marco");
    srv1().agentOperations = false;
    await openTask("p-laura");
    const plan = await within(serverSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(plan).toHaveTextContent(
      "The agent on SRV-1 doesn't have operations on. Re-run its install command with operations on to approve this plan.",
    );
    expect(within(plan).getByRole("button", { name: "Approve the plan" })).toBeDisabled();
    // Bloccato, il rifiuto chiude: niente indicazioni (un piano riscritto sarebbe bloccato uguale).
    const reject = within(plan).getByRole("button", { name: "Reject the plan" });
    expect(reject).toBeEnabled();
    // Minor 1: la riga di stato dice che il piano aspetta Laura, come «Waiting on me».
    expect(serverSection()).toHaveTextContent("Fix plan waiting for your approval");
    await userEvent.click(reject);
    await whenFixesIdle();
    await waitFor(() =>
      expect(state.conversations.find((c) => c.serverFix)).toMatchObject({ state: "finished" }),
    );
    expect(fixCommands()).toBe(0);
  });

  it("approvato: comandi nel registro, controllo finale risolto in parole", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    await openTask("p-laura");
    await waitFor(() =>
      expect(serverSection()).toHaveTextContent("Fixed — the check after the fix passed"),
    );
    expect(serverSection()).toHaveTextContent("Close the task if the problem is gone.");
    const log = within(serverSection()).getByRole("button", { name: /Commands on SRV-1/ });
    // Chiuso dopo la correzione.
    expect(log).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(log);
    const list = within(serverSection()).getByRole("list", { name: "Commands on SRV-1" });
    expect(within(list).getAllByText("change").length).toBe(1);
    expect(within(list).getAllByText("read").length).toBeGreaterThan(0);
    // Ogni riga dice la sua azione tradotta e per quale via: l'agente.
    expect(list).toHaveTextContent("Restarted portale-import");
    expect(within(list).getAllByText("agent").length).toBeGreaterThan(0);
    expect(within(list).queryByText("SSH")).toBeNull();
  });

  it("controllo finale non risolto: «Not fixed» in parole e «Start fix again»", async () => {
    setSessionPersonId("p-roberta");
    await servers.simulateFixCheck("SRV-1", "not_resolved");
    const id = await startAs("p-roberta");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    const section = await openTask("p-roberta");
    await waitFor(() =>
      expect(section).toHaveTextContent("Not fixed — the check after the fix failed"),
    );
    expect(within(section).getByRole("button", { name: "Start fix again" })).toBeInTheDocument();
  });

  it("d3: in italiano l'esito del controllo finale è tradotto nella sezione Server", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    act(() => setLanguage("it"));
    try {
      renderRoute(`/p/ACQ/tasks?task=${CODE}`, "p-laura");
      await waitFor(() =>
        expect(document.querySelector("[data-server-task-state]")).toHaveTextContent(
          "Risolto: il controllo dopo la correzione è passato",
        ),
      );
    } finally {
      act(() => setLanguage("en"));
    }
  });

  /** Approva come Roberta e, al primo comando, ferma con `halt`. */
  async function haltAfterFirstCommand(halt: () => Promise<unknown>) {
    const id = await startAs("p-roberta");
    setStreamLatency(20);
    await decidePlan(id, "approve");
    await expect.poll(fixCommands, { interval: 2, timeout: 2000 }).toBeGreaterThan(0);
    await halt();
    await whenFixesIdle();
    setStreamLatency(null);
    return id;
  }

  it("uno Stop di una persona dice chi: «Fix stopped by Roberta Fontana»", async () => {
    let id = "";
    id = await haltAfterFirstCommand(() => servers.stopServerFix(TASK));
    expect(id).toBeTruthy();
    const section = await openTask("p-roberta");
    await waitFor(() => expect(section).toHaveTextContent(/Fix stopped by Roberta/));
    expect(within(section).getByRole("button", { name: "Start fix again" })).toBeInTheDocument();
    await userEvent.click(
      within(serverSection()).getByRole("button", { name: /Commands on SRV-1/ }),
    );
  });

  it("«More» compare quando la proposta è tagliata davvero, anche se è corta", async () => {
    const proto = HTMLElement.prototype;
    const sh = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const ch = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 120 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 80 });
    try {
      const section = await openTask("p-roberta");
      expect(await within(section).findByRole("button", { name: "More" })).toBeInTheDocument();
    } finally {
      if (sh) Object.defineProperty(proto, "scrollHeight", sh);
      else delete (proto as { scrollHeight?: number }).scrollHeight;
      if (ch) Object.defineProperty(proto, "clientHeight", ch);
      else delete (proto as { clientHeight?: number }).clientHeight;
    }
  });

  it("le operazioni spente durante l'esecuzione dicono il motivo, mai «stopped by»", async () => {
    await haltAfterFirstCommand(async () => {
      srv1().agentOperations = false;
    });
    const section = await openTask("p-roberta");
    await waitFor(() =>
      expect(section).toHaveTextContent("Fix stopped: the agent's operations were turned off"),
    );
    expect(section).not.toHaveTextContent(/stopped by/i);
    await userEvent.click(
      within(serverSection()).getByRole("button", { name: /Commands on SRV-1/ }),
    );
  });

  it("RF 5: un'uscita di 5000 righe si apre con le ultime 40, «Show all» disegna una finestra", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const fix = eventsOf(id).find(isChange)!;
    fix.result = long;
    fix.truncated = true;
    const user = userEvent.setup();
    await openTask("p-laura");
    await user.click(within(serverSection()).getByRole("button", { name: /Commands on SRV-1/ }));
    const row = within(serverSection()).getByRole("button", { name: /Restarted portale-import/ });
    await user.click(row);
    const out = await within(serverSection()).findByRole("region", { name: /Output of/ });
    expect(out).toHaveTextContent("Showing the last 40 of 5,000 lines");
    expect(out.querySelectorAll("[data-log-line]")).toHaveLength(40);
    expect(out).toHaveTextContent("line 5000");
    await user.click(within(out).getByRole("button", { name: "Show all" }));
    const drawn = out.querySelectorAll("[data-log-line]").length;
    expect(drawn).toBeGreaterThan(40);
    expect(drawn).toBeLessThan(5000);
  });

  it("un'uscita corta dice solo quante righe ha, e le colonne restano colonne", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    const fix = eventsOf(id).find(isChange)!;
    fix.result = "NAME   CPU %   MEM USAGE\nportale   12.0%   210MiB / 1GiB";
    const user = userEvent.setup();
    await openTask("p-laura");
    await user.click(within(serverSection()).getByRole("button", { name: /Commands on SRV-1/ }));
    await user.click(
      within(serverSection()).getByRole("button", { name: /Restarted portale-import/ }),
    );
    const out = await within(serverSection()).findByRole("region", { name: /Output of/ });
    expect(out).toHaveTextContent("2 lines");
    expect(out).not.toHaveTextContent(/Showing the last/);
    expect(out.querySelector("[data-log-line]")!.className).toMatch(/(^| )whitespace-pre( |$)/);
  });

  it("l'uscita di un'azione è contenuto NON fidato: testo, mai un link o un markup", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    const fix = eventsOf(id).find(isChange)!;
    fix.result = "[Open the dashboard](https://evil.example) **now** <img src=x onerror=alert(1)>";
    const user = userEvent.setup();
    await openTask("p-laura");
    await user.click(within(serverSection()).getByRole("button", { name: /Commands on SRV-1/ }));
    await user.click(
      within(serverSection()).getByRole("button", { name: /Restarted portale-import/ }),
    );
    const out = await within(serverSection()).findByRole("region", { name: /Output of/ });
    expect(out).toHaveTextContent("[Open the dashboard](https://evil.example) **now**");
    expect(out.querySelector("a[href*='evil'], img, strong")).toBeNull();
  });

  it("cambio di persona con la task aperta: l'avvio compare e sparisce sul posto", async () => {
    const user = userEvent.setup();
    await openTask("p-roberta");
    expect(
      within(serverSection()).getByRole("button", { name: "Start fix on the server" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Profile and settings/ }));
    await user.click(screen.getByRole("radio", { name: /Laura Costa/ }));
    await waitFor(() =>
      expect(within(serverSection()).queryByRole("button", { name: /Start fix/ })).toBeNull(),
    );
    expect(serverSection()).toHaveTextContent(
      "Someone allowed to operate ACQ's servers can start the fix.",
    );
  });

  it("il segno della sorgente «Server» dice da quale avviso è nata", async () => {
    await openTask("p-roberta");
    const mark = panel().querySelector("[data-source='server']")!;
    expect(mark).toHaveTextContent("Server");
    expect(mark.getAttribute("title")).toBe("Opened by Claude after an alert on SRV-1");
  });
});

describe("la sessione d'analisi nella destinazione Claude", () => {
  it("compare fra le concluse come «Server analysis»", async () => {
    renderRoute("/claude?scope=finished", "p-roberta");
    await screen.findByRole("heading", { level: 1, name: "Finished sessions" });
    await waitFor(() =>
      expect(document.querySelector("[data-conversation-row='cv-srv-1-analysis']")).not.toBeNull(),
    );
    expect(document.querySelector("[data-conversation-row='cv-srv-1-analysis']")).toHaveTextContent(
      "Server analysis",
    );
  });

  it("la pagina dice automatica e in sola lettura; i comandi sono «read»", async () => {
    renderRoute("/claude/cv-srv-1-analysis", "p-roberta");
    expect(await screen.findByText("Automatic · read-only access to SRV-1")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This session runs on its own with read-only access to SRV-1: it can only be watched.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Message/ })).toBeNull();
    const list = await screen.findByRole("list", { name: "Commands on SRV-1" });
    expect(within(list).getAllByText("read").length).toBe(5);
    expect(within(list).queryByText("change")).toBeNull();
    // Le letture via SSH e quella del log via agente.
    expect(within(list).getAllByText("SSH").length).toBe(4);
    expect(within(list).getAllByText("agent").length).toBe(1);
  });

  it("d4: il lato oggetto mostra il server (riga ed episodio) sopra la task", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    renderRoute("/claude/cv-srv-1-analysis", "p-roberta");
    const side = await screen.findByRole("complementary", { name: /./ });
    const server = await within(side).findByTestId("server-brief");
    expect(server).toHaveTextContent("SRV-1");
    expect(server).toHaveTextContent("acq-prod-01");
    expect(server.querySelector("[data-server-episode]")).not.toBeNull();
    expect(within(side).getByText("ACQ-6")).toBeInTheDocument();
  });
});

describe("l'avviso di un server senza accesso", () => {
  async function openPanel(me: string) {
    const user = userEvent.setup();
    renderRoute("/home", me);
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    return { user, panel: await screen.findByRole("dialog", { name: /Notifications/ }) };
  }

  it("SRV-2: «Link SSH access» in chiaro a Roberta, porta alla parte SSH e chiude il pannello", async () => {
    const { user, panel: notifications } = await openPanel("p-roberta");
    const item = (await within(notifications).findAllByText("SRV-2"))
      .map((el) => el.closest("[data-notification]")!)
      // Il testo del seme dal 9e910dd3a (A2 di 46): l'analisi parte senza le letture SSH.
      .find((li) => li.textContent!.includes("without SSH reads"))!;
    const link = within(item as HTMLElement).getByRole("button", { name: "Link SSH access" });
    await user.click(link);
    await screen.findByRole("region", { name: "SSH access" });
    expect(screen.queryByRole("dialog", { name: /Notifications/ })).toBeNull();
  });

  it("Marco riceve l'avviso di SRV-1 senza accesso, ma non può collegarlo: niente «Link SSH access»", async () => {
    setSessionPersonId("p-roberta");
    await servers.revokeSshAccess("SRV-1");
    await act(async () => {
      await servers.simulateServerAlert("SRV-1", "cpu");
    });
    const { panel: notifications } = await openPanel("p-marco");
    await waitFor(() =>
      expect(within(notifications).getAllByText(/without SSH reads/).length).toBeGreaterThan(0),
    );
    expect(within(notifications).queryByRole("button", { name: "Link SSH access" })).toBeNull();
    // Controllo positivo: lo stesso avviso, a Roberta, lo offre. Il primo
    // render si smonta (non si svuota il body sotto React: rumore removeChild).
    cleanup();
    const roberta = await openPanel("p-roberta");
    const srv1 = (await within(roberta.panel).findAllByText("SRV-1"))
      .map((el) => el.closest("[data-notification]")!)
      .find((li) => li.textContent!.includes("without SSH reads"))!;
    expect(
      within(srv1 as HTMLElement).getByRole("button", { name: "Link SSH access" }),
    ).toBeInTheDocument();
  });

  it("SRV-2 a Marco: nessun «Link SSH access» in tutto il pannello", async () => {
    const { panel: notifications } = await openPanel("p-marco");
    await within(notifications).findAllByRole("button");
    expect(within(notifications).queryByRole("button", { name: "Link SSH access" })).toBeNull();
  });
});
