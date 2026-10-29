import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decidePlan, resetApi, servers, setLatency, setStreamLatency, stop } from "../../data/api";
import { whenFixesIdle } from "../../data/servers/fix";
import { setSessionPersonId } from "../../data/session";
import { eventsOf, state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// La task di un server (Task 9 del piano 8b, shape server-task.md): la
// sezione «Server» in testa al pannello, l'avvio con le due condizioni
// sempre scritte, la scheda del piano della correzione (mai in anticipo,
// approvazione spenta col motivo), il registro dei comandi con l'uscita
// lunga in finestra, il controllo finale in parole; la sessione d'analisi
// nella destinazione Claude; «Link SSH access» sull'avviso senza accesso.

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

const fixCommands = () =>
  state.conversations
    .flatMap((c) => eventsOf(c.id))
    .filter((e) => e.type === "action" && e.access === "fix").length;

describe("sezione Server", () => {
  it("dice server, episodio, stato e proposta, prima della descrizione", async () => {
    const section = await openTask("p-roberta");
    expect(section).toHaveTextContent("SRV-1");
    expect(section).toHaveTextContent("acq-prod-01");
    expect(section).toHaveTextContent("Healthy");
    expect(section).toHaveTextContent(/Memory above 90% · .*18:00 → 20:00 \(back to normal\)/);
    expect(section).toHaveTextContent("Diagnosis ready");
    expect(section).toHaveTextContent("Suggested fix:");
    expect(section).toHaveTextContent(/Limit the portale-import container to 2 GB/);
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
        "2. Claude writes a plan first. Nothing runs on SRV-1 until someone who can approve plans in ACQ approves it — even you.",
      );
      document.body.innerHTML = "";
    }
    const laura = await openTask("p-laura");
    expect(within(laura).queryByRole("button", { name: /Start fix/ })).toBeNull();
    expect(laura).toHaveTextContent("Someone allowed to operate ACQ's servers can start the fix.");
    expect(laura).toHaveTextContent(
      "1. Only people allowed to operate ACQ's servers can start it.",
    );
    expect(laura).toHaveTextContent(/2\. Claude writes a plan first/);
  });

  it("Roberta avvia dal dialogo: piano da approvare anche per lei, nessun anticipo, nessun comando", async () => {
    const user = userEvent.setup();
    const section = await openTask("p-roberta");
    await user.click(within(section).getByRole("button", { name: "Start fix on the server" }));
    const dialog = await screen.findByRole("dialog", { name: "Start a fix on SRV-1?" });
    expect(dialog).toHaveTextContent("stubwise-fix, which can do anything on SRV-1");
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
    const plan = await within(claudeSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(plan).toHaveTextContent("Runs as stubwise-fix: it can do anything on SRV-1.");
    expect(plan).toHaveTextContent(
      "A plan that releases — pull, image update, deploy — must be rejected. Releases go through Releases.",
    );
    expect(plan).toHaveTextContent("You started this fix. Approving runs the commands on SRV-1.");
    expect(within(plan).getByRole("button", { name: "Approve the plan" })).toBeEnabled();
    expect(within(plan).getByRole("button", { name: "Reject with instructions" })).toBeEnabled();
    expect(claudeSection()).toHaveTextContent("Fix on SRV-1 · waiting for your approval");
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

  it("Marco avvia e legge chi deve approvare; nessun bottone d'approvazione", async () => {
    await startAs("p-marco");
    await openTask("p-marco");
    const plan = await within(claudeSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(within(plan).queryByRole("button", { name: "Approve the plan" })).toBeNull();
    expect(plan).toHaveTextContent("Waiting for someone who can approve plans in ACQ.");
    expect(serverSection()).toHaveTextContent("Fix plan waiting for approval");
  });

  it("server cancellato: «SRV-1 · deleted» a chi vede la task; non visibile: «A server you can't see»", async () => {
    state.servers = state.servers.filter((s) => s.code !== "SRV-1");
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

  it("il piano mostra i comandi previsti uno per uno, col perché, senza aprire niente", async () => {
    const id = await startAs("p-marco");
    const event = eventsOf(id).find((e) => e.type === "plan") as Extract<
      ConversationEvent,
      { type: "plan" }
    >;
    expect(event.commands?.length).toBeGreaterThan(0);
    await openTask("p-laura");
    const plan = await within(claudeSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    const list = within(plan).getByRole("list", { name: "Commands to run on SRV-1" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(event.commands!.length);
    event.commands!.forEach((c, i) => {
      expect(items[i]).toHaveTextContent(c.input);
      expect(items[i]).toHaveTextContent(c.why);
    });
    // Il piano intero resta chiuso: i comandi si leggono senza clic.
    expect(within(plan).getByRole("button", { name: "Read the full plan" })).toBeInTheDocument();
  });

  it("accesso revocato col piano in attesa: Approve spento col motivo, Reject attivo", async () => {
    await startAs("p-marco");
    setSessionPersonId("p-roberta");
    await servers.revokeSshAccess("SRV-1");
    await openTask("p-laura");
    const plan = await within(claudeSection()).findByRole("region", { name: "Fix plan for SRV-1" });
    expect(plan).toHaveTextContent(
      "Fix access to SRV-1 was revoked. Link it again to approve this plan.",
    );
    expect(within(plan).getByRole("button", { name: "Approve the plan" })).toBeDisabled();
    expect(within(plan).getByRole("button", { name: "Reject with instructions" })).toBeEnabled();
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
    const log = within(claudeSection()).getByRole("button", { name: /Commands on SRV-1/ });
    // Chiuso dopo la correzione.
    expect(log).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(log);
    const list = within(claudeSection()).getByRole("list", { name: "Commands on SRV-1" });
    expect(within(list).getAllByText("fix").length).toBeGreaterThan(0);
    expect(within(list).getAllByText("read").length).toBeGreaterThan(0);
    expect(claudeSection()).toHaveTextContent(/Check after the fix: resolved/);
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
    expect(claudeSection()).toHaveTextContent(/Check after the fix: not resolved/);
  });

  it("d3: in italiano l'intestazione del controllo finale è tradotta; il dettaglio di Claude resta", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    act(() => setLanguage("it"));
    try {
      renderRoute(`/p/ACQ/tasks?task=${CODE}`, "p-laura");
      const check = await waitFor(() => {
        const el = document.querySelector("[data-server-check]");
        expect(el).not.toBeNull();
        return el!;
      });
      expect(check).toHaveTextContent(/^Controllo dopo la correzione: risolto — /);
      expect(check).not.toHaveTextContent("Check after the fix");
      const row = document.querySelector("[data-work-result='server_check']");
      if (row) expect(row).toHaveTextContent(/^Controllo dopo la correzione: risolto/);
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
    id = await haltAfterFirstCommand(() => stop(fixConversation()));
    expect(id).toBeTruthy();
    const section = await openTask("p-roberta");
    await waitFor(() => expect(section).toHaveTextContent(/Fix stopped by Roberta/));
    expect(within(section).getByRole("button", { name: "Start fix again" })).toBeInTheDocument();
    await userEvent.click(
      within(claudeSection()).getByRole("button", { name: /Commands on SRV-1/ }),
    );
    expect(claudeSection()).toHaveTextContent(/Stopped by Roberta .* No commands after this\./);
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

  it("una revoca durante l'esecuzione dice il motivo, mai «stopped by»", async () => {
    await haltAfterFirstCommand(() => servers.revokeSshAccess("SRV-1"));
    const section = await openTask("p-roberta");
    await waitFor(() => expect(section).toHaveTextContent("Fix stopped: fix access was revoked"));
    expect(section).not.toHaveTextContent(/stopped by/i);
    await userEvent.click(
      within(claudeSection()).getByRole("button", { name: /Commands on SRV-1/ }),
    );
    expect(claudeSection()).toHaveTextContent("Stopped: fix access was revoked.");
    expect(claudeSection()).not.toHaveTextContent(/stopped by/i);
  });

  it("RF 5: un'uscita di 5000 righe si apre con le ultime 40, «Show all» disegna una finestra", async () => {
    const id = await startAs("p-marco");
    setSessionPersonId("p-laura");
    await decidePlan(id, "approve");
    await whenFixesIdle();
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const fix = eventsOf(id).find(
      (e): e is Extract<ConversationEvent, { type: "action" }> =>
        e.type === "action" && e.access === "fix",
    )!;
    fix.result = long;
    fix.truncated = true;
    const user = userEvent.setup();
    await openTask("p-laura");
    await user.click(within(claudeSection()).getByRole("button", { name: /Commands on SRV-1/ }));
    const row = within(claudeSection()).getByRole("button", {
      name: new RegExp(fix.input!.slice(0, 20)),
    });
    await user.click(row);
    const out = await within(claudeSection()).findByRole("region", { name: /Output of/ });
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
    const fix = eventsOf(id).find(
      (e): e is Extract<ConversationEvent, { type: "action" }> =>
        e.type === "action" && e.access === "fix",
    )!;
    fix.result = "NAME   CPU %   MEM USAGE\nportale   12.0%   210MiB / 1GiB";
    const user = userEvent.setup();
    await openTask("p-laura");
    await user.click(within(claudeSection()).getByRole("button", { name: /Commands on SRV-1/ }));
    await user.click(
      within(claudeSection()).getByRole("button", { name: new RegExp(fix.input!.slice(0, 20)) }),
    );
    const out = await within(claudeSection()).findByRole("region", { name: /Output of/ });
    expect(out).toHaveTextContent("2 lines");
    expect(out).not.toHaveTextContent(/Showing the last/);
    expect(out.querySelector("[data-log-line]")!.className).toMatch(/(^| )whitespace-pre( |$)/);
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
    expect(within(list).getAllByText("read").length).toBe(6);
    expect(within(list).queryByText("fix")).toBeNull();
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
      .find((li) => li.textContent!.includes("no SSH access"))!;
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
      expect(within(notifications).getAllByText(/can't look into it/).length).toBeGreaterThan(0),
    );
    expect(within(notifications).queryByRole("button", { name: "Link SSH access" })).toBeNull();
    // Controllo positivo: lo stesso avviso, a Roberta, lo offre.
    document.body.innerHTML = "";
    const roberta = await openPanel("p-roberta");
    const srv1 = (await within(roberta.panel).findAllByText("SRV-1"))
      .map((el) => el.closest("[data-notification]")!)
      .find((li) => li.textContent!.includes("can't look into it"))!;
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
