import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, instance, resetApi, servers, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ServerService } from "../../data/types";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { bandLabelSide } from "./Chart";
import { sparkScale } from "./glyphs";
import { niceCeil } from "./MetricsCharts";
import { setMatchMedia } from "../../test/setup";

// Il dettaglio di un server (Task 7 del piano 8b, shape servers.md §3):
// R-G5, il riquadro «Now» (motivi, lavoro di Claude, ora del rientro),
// grafici con intervallo e controllo selezionato (R-L1), RF 5 sui servizi,
// le parti di gestione solo con monitor.manage, gli stati per parte.

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

const server = (code: string) => state.servers.find((s) => s.code === code)!;
const NOT_FOUND = "This server doesn't exist, or you can't see it.";

async function open(path: string, person: string) {
  const router = renderRoute(path, person);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

const part = (name: string) => screen.getByRole("region", { name });

describe("R-G5: inesistente, invisibile o di un altro progetto rispondono uguale", () => {
  it("SRV-99, SRV-3 per Sara (invisibile) e SRV-2 da ACQ (altro progetto)", async () => {
    await open("/p/ACQ/servers/SRV-99", "p-sara");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(NOT_FOUND);
    const missing = document.querySelector("main")!.innerHTML;
    document.body.innerHTML = "";

    await open("/p/ACQ/servers/SRV-3", "p-sara");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(NOT_FOUND);
    expect(document.querySelector("main")!.innerHTML).toBe(missing);
    expect(screen.queryByText(/aud-app-01/)).toBeNull();
    document.body.innerHTML = "";

    await open("/p/ACQ/servers/SRV-2", "p-roberta");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(NOT_FOUND);
    expect(screen.getByRole("link", { name: "← Servers" })).toBeInTheDocument();
  });

  it("caricamento e errore della pagina con «Retry»", async () => {
    setLatency(30);
    failNext("servers.getServer");
    renderRoute("/p/ACQ/servers/SRV-1", "p-marco");
    expect(await screen.findByRole("status")).toHaveTextContent("Loading");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this server");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: /acq-prod-01/ }),
    ).toBeInTheDocument();
  });
});

describe("testata e «Now»", () => {
  it("SRV-1: nome e codice, hostname e agente; il rientro nel fuso di chi guarda e la diagnosi pronta", async () => {
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("acq-prod-01");
    expect(h1).toHaveTextContent("SRV-1");
    expect(screen.getByText("acq-prod-01.colline.internal")).toBeInTheDocument();
    expect(screen.getByText("agent 1.8.2")).toBeInTheDocument();
    expect(screen.getByText("last report 30 s ago")).toBeInTheDocument();
    const now = await screen.findByRole("region", { name: "Now" });
    // I test girano in UTC: l'episodio è rientrato due giorni fa alle 20:00, dopo 2 ore.
    expect(now).toHaveTextContent(/Back to normal on \w+ \d+ at 20:00 · after 2 h/);
    expect(now).toHaveTextContent("Memory at 94%, above 90%");
    expect(now).toHaveTextContent("Diagnosis ready");
    expect(await within(now).findByRole("link", { name: /ACQ-6 Memory leak/ })).toBeInTheDocument();
  });

  it("M4: col budget raggiunto all'allarme, «Now» dice perché Claude non guarda, col «Who?»", async () => {
    setSessionPersonId("p-roberta");
    await instance.simulateBudgetReached(true);
    await servers.simulateServerRecovery("SRV-1").catch(() => undefined);
    await servers.simulateServerAlert("SRV-1", "memory");
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent(
      "Claude can't look into it: the monthly AI budget is used up. Who?",
    );
    expect(now.querySelector("[data-who-can='manageSettings']")).not.toBeNull();
  });

  it("residuo m3: alzato il budget, «Now» non dice più che è esaurito", async () => {
    setSessionPersonId("p-roberta");
    await instance.simulateBudgetReached(true);
    await servers.simulateServerRecovery("SRV-1").catch(() => undefined);
    await servers.simulateServerAlert("SRV-1", "memory");
    await instance.simulateBudgetReached(false);
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const now = await screen.findByRole("region", { name: "Now" });
    await waitFor(() => expect(now).toHaveTextContent("Memory at 94%"));
    expect(now).not.toHaveTextContent("the monthly AI budget is used up");
  });

  it("SRV-2: in difficoltà dalle 09:40, i motivi in frase, senza accesso e il rimando a chi lo collega", async () => {
    await open("/p/STW/servers/SRV-2", "p-roberta");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("In trouble since 09:40");
    expect(within(now).getByText("Disk at 93%, above 90% for 2 h 20 min")).toBeInTheDocument();
    expect(
      within(now).getByText("Check “Replica port” is down: connection refused"),
    ).toBeInTheDocument();
    expect(within(now).getByText("Claude can't look into it: no SSH access.")).toBeInTheDocument();
    expect(within(now).getByRole("link", { name: "Link SSH access" })).toBeInTheDocument();
    // Nella riga del controllo il bersaglio resta accanto all'errore (T7 m9).
    const replica = part("Checks").querySelector("[data-check='Replica port'] [data-check-target]");
    expect(replica).toHaveTextContent("10.0.4.12:5433— connection refused");
    // Roberta gestisce gli accessi: la parte si apre sul primo passo (Task 8).
    expect(
      within(part("SSH access")).getByRole("button", { name: "Link SSH access" }),
    ).toBeInTheDocument();
  });

  it("l'analisi fermata o fallita si dice in parole", async () => {
    state.serverAnalyses[0]!.outcome = "stopped";
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    expect(await screen.findByRole("region", { name: "Now" })).toHaveTextContent(
      "Claude stopped before a diagnosis",
    );
    document.body.innerHTML = "";
    resetApi();
    state.serverAnalyses[0]!.outcome = "failed";
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("Claude's analysis failed: the task couldn't be opened");
    expect(within(now).getByRole("link", { name: "Open session" })).toBeInTheDocument();
  });

  it("nessun bottone agisce sul server: niente Restart, Deploy, Pull", async () => {
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    await screen.findByRole("region", { name: "Services" });
    for (const el of [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")]) {
      expect(el.textContent ?? "").not.toMatch(/^(restart|deploy|pull|riavvia|rilascia)\b/i);
    }
  });
});

describe("grafici", () => {
  it("intervallo 1h · 24h · 7d (24h di base), la nota dei punti ridotti, i riassunti in parole", async () => {
    const user = userEvent.setup();
    const router = await open("/p/ACQ/servers/SRV-1", "p-marco");
    const range = await screen.findByRole("group", { name: "Time range" });
    expect(within(range).getByRole("button", { name: "24h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const charts = part("Charts");
    expect(await within(charts).findByRole("group", { name: "CPU" })).toHaveAccessibleDescription(
      /^Average \d+% · peak \d+% at \d\d:\d\d$/,
    );
    expect(within(charts).getByRole("group", { name: "Memory" })).toHaveTextContent("Alert at 90%");
    expect(
      within(charts).getByText(/^Showing 300 averaged points of 2,880 samples\.$/),
    ).toBeInTheDocument();

    await user.click(within(range).getByRole("button", { name: "7d" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: "7d" }));
    expect(within(range).getByRole("button", { name: "7d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await within(charts).findByText("Showing 300 averaged points of 20,160 samples."),
    ).toBeInTheDocument();

    await user.click(within(range).getByRole("button", { name: "1h" }));
    await waitFor(() =>
      expect(within(charts).queryByText(/^Showing .* averaged points/)).toBeNull(),
    );
    // Da tastiera, fuori dai campi: 2 = 24h.
    await user.keyboard("2");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: "24h" }));
  });

  it("selezionare un controllo aggiunge il suo tempo di risposta; il ✕ e di nuovo il clic lo tolgono", async () => {
    const user = userEvent.setup();
    const router = await open("/p/ACQ/servers/SRV-1", "p-marco");
    const checks = part("Checks");
    const api = within(checks).getByRole("button", { name: /^API health, Up/ });
    expect(api).toHaveAttribute("aria-pressed", "false");
    await user.click(api);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ check: "chk-srv-1-api" }),
    );
    expect(api).toHaveAttribute("aria-pressed", "true");
    const chart = await within(part("Charts")).findByRole("group", {
      name: "Response time · API health",
    });
    expect(chart).toHaveAccessibleDescription(/^Average \d+ ms · slowest \d+ ms at \d\d:\d\d$/);
    await user.click(screen.getByRole("button", { name: "Stop showing API health in the charts" }));
    await waitFor(() =>
      expect(within(part("Charts")).queryByRole("group", { name: /^Response time/ })).toBeNull(),
    );
    await user.click(api);
    await within(part("Charts")).findByRole("group", { name: "Response time · API health" });
    await user.click(api);
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("check"));
  });

  it("tempo di risposta ridotto: la nota dei campioni c'è anche lì; asse su un passo tondo", async () => {
    await open("/p/ACQ/servers/SRV-1?check=chk-srv-1-api", "p-marco");
    await within(part("Charts")).findByRole("group", { name: "Response time · API health" });
    expect(part("Charts")).toHaveTextContent(
      /Response time: \d+ averaged points of [\d,]+ samples\./,
    );
  });

  it("l'etichetta del cursore si annuncia da tastiera, non al passaggio del mouse", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const cpu = await within(part("Charts")).findByRole("group", { name: /^CPU/ });
    const label = () => cpu.querySelector("[data-cursor-label]");
    // Un cursore che non viene dalle frecce (fuoco, o il passaggio del mouse) tace.
    act(() => cpu.focus());
    await waitFor(() => expect(label()).not.toBeNull());
    expect(label()).toHaveAttribute("aria-live", "off");
    await user.keyboard("{ArrowLeft}");
    expect(label()).toHaveAttribute("aria-live", "polite");
  });

  it("l'etichetta dell'episodio non copre la linea: fuori dai dati sulla fascia stretta di SRV-1 a 7d, sotto il disco al 92% di SRV-2", async () => {
    await open("/p/ACQ/servers/SRV-1?range=7d", "p-marco");
    // Due ore su sette giorni: l'etichetta sta sotto il riassunto, solo sul grafico Memory.
    const memory = await within(part("Charts")).findByRole("group", { name: /^Memory/ });
    await waitFor(() => expect(memory.querySelector("[data-band-label]")).not.toBeNull());
    expect(memory.querySelector("[data-band-label]")).toHaveAttribute("data-side", "outside");
    const cpu = within(part("Charts")).getByRole("group", { name: /^CPU/ });
    expect(cpu.querySelector("[data-band-label]")).toBeNull();
    document.body.innerHTML = "";
    await open("/p/STW/servers/SRV-2", "p-roberta");
    const disk = await within(part("Charts")).findByRole("group", { name: /^Disk/ });
    await waitFor(() => expect(disk.querySelector("[data-band-label]")).not.toBeNull());
    expect(disk.querySelector("[data-band-label]")).toHaveAttribute("data-side", "bottom");
  });

  it("bandLabelSide: dalla parte con più spazio, sopra senza valori", () => {
    const band = { from: 10, to: 20 };
    const times = [0, 10, 15, 20, 30];
    expect(bandLabelSide(band, times, [{ values: [90, 20, 25, 30, 90] }], 100)).toBe("top");
    expect(bandLabelSide(band, times, [{ values: [10, 92, 93, 92, 10] }], 100)).toBe("bottom");
    expect(bandLabelSide(band, times, [{ values: [1, null, null, null, 1] }], 100)).toBe("top");
  });

  it("sparkScale: il mini-grafico si scala sul campo dei valori, almeno 10 punti", () => {
    expect(sparkScale([15, 22, 30])).toEqual({ lo: 15, hi: 30 });
    expect(sparkScale([20, 21, 20])).toEqual({ lo: 15.5, hi: 25.5 });
    expect(sparkScale([0, 1])).toEqual({ lo: 0, hi: 10 });
    expect(sparkScale([99, 100])).toEqual({ lo: 90, hi: 100 });
  });

  it("niceCeil: 1–2–5 × 10ⁿ", () => {
    expect([610, 180, 50, 1000, 1001, 0.4].map(niceCeil)).toEqual([1000, 200, 50, 1000, 2000, 0.5]);
  });

  it("Esc col pannello della task aperto non deseleziona il controllo", async () => {
    const user = userEvent.setup();
    const router = await open("/p/ACQ/servers/SRV-1?check=chk-srv-1-api&task=ACQ-6", "p-marco");
    await screen.findByLabelText("Task ACQ-6");
    await user.keyboard("{Escape}");
    expect(router.state.location.search).toMatchObject({ check: "chk-srv-1-api" });
  });

  it("un errore dei grafici non abbatte il resto: «Retry» nella parte", async () => {
    failNext("servers.getServerMetrics");
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const alert = await within(part("Charts")).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the charts");
    expect(part("Services")).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(part("Charts")).findByRole("group", { name: "CPU" })).toBeInTheDocument();
  });

  it("mai collegato: «No data in this range»", async () => {
    server("SRV-4").status = "never_connected";
    state.serverMetrics.delete("SRV-4");
    await open("/p/AUD/servers/SRV-4", "p-laura");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("aud-admin-01");
    expect((await within(part("Charts")).findAllByText("No data in this range")).length).toBe(5);
    expect(within(part("Charts")).getByRole("group", { name: "CPU" })).toHaveAccessibleDescription(
      "No data in this range",
    );
  });
});

describe("servizi (RF 5)", () => {
  it("200 servizi: tabella intera, filtro, nome lunghissimo con ellissi e titolo intero", async () => {
    const long = `worker-${"x".repeat(180)}`;
    const many: ServerService[] = Array.from({ length: 200 }, (_, i) => ({
      name: i === 0 ? long : `svc-${String(i).padStart(3, "0")}`,
      source: i % 2 ? "pm2" : "docker",
      state: i === 5 ? "exited (1)" : "running",
      cpuPct: i / 10,
      memBytes: i * 1024 * 1024,
      restarts: i % 3,
      image: `registry/svc:${i}`,
    }));
    server("SRV-1").services = many;
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-marco");
    const services = part("Services");
    const table = within(services).getByRole("table", { name: "Services" });
    expect(within(table).getAllByRole("row")).toHaveLength(201);
    const cell = within(table).getByText(long);
    expect(cell).toHaveClass("truncate");
    expect(cell).toHaveAttribute("title", `${long} · registry/svc:0`);
    // Uno stato non «running» ha il glifo accanto alla parola.
    expect(within(table).getByText("exited (1)").previousSibling).not.toBeNull();
    await user.type(within(services).getByRole("searchbox", { name: "Filter services" }), "svc-19");
    // svc-190 … svc-199: dieci righe più l'intestazione.
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    // Ordinabile, con aria-sort.
    const header = within(table).getByRole("columnheader", { name: "Restarts" });
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "descending");
  });
});

describe("gestione: solo con monitor.manage", () => {
  it("Laura: soglie come frasi, nessun campo, nessun «Add check», nessuna Settings", async () => {
    await open("/p/AUD/servers/SRV-3", "p-laura");
    const thresholds = part("Thresholds");
    expect(thresholds).toHaveTextContent("An alert starts when CPU stays above 95% for 5 minutes.");
    expect(thresholds).toHaveTextContent(
      "An alert starts when memory stays above 90% for 5 minutes.",
    );
    expect(thresholds).toHaveTextContent("Someone who manages monitoring can change these.");
    expect(within(thresholds).queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add check" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    const index = screen.getByRole("navigation", { name: "Parts of SRV-3" });
    expect(within(index).queryByRole("button", { name: "Settings" })).toBeNull();
    expect(within(index).getByRole("button", { name: "Thresholds" })).toBeInTheDocument();
  });

  it("Roberta: le soglie in campi; «Save» solo con modifiche, «Saved» dopo la conferma e via alla modifica", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const thresholds = part("Thresholds");
    const save = within(thresholds).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const cpu = within(thresholds).getByRole("spinbutton", { name: /CPU stays above/ });
    await user.clear(cpu);
    await user.type(cpu, "0");
    expect(
      within(thresholds).getByText("Use a number from 1 to 100, or leave it empty."),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(cpu);
    await user.type(cpu, "80");
    await user.click(save);
    await waitFor(() => expect(within(thresholds).getByRole("status")).toHaveTextContent("Saved"));
    expect(server("SRV-1").thresholds.cpuPct).toBe(80);
    await user.type(cpu, "5");
    expect(within(thresholds).getByRole("status")).toHaveTextContent("");
  });

  it("Roberta: progetto principale solo fra le produzioni; con una sola, la frase fissa", async () => {
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    expect(part("Settings")).toHaveTextContent("ACQ — the only production using this server");
    document.body.innerHTML = "";
    resetApi();
    // SRV-1 anche nella produzione di STW e nello staging di AUD.
    const row = { repositoryId: null, serverCode: "SRV-1", reportedSha: null, reportedAt: null };
    state.environments.find((e) => e.id === "env-stw-prod")!.servers.push({ ...row });
    state.environments.find((e) => e.id === "env-aud-staging")!.servers.push({ ...row });
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const select = within(part("Settings")).getByRole("combobox", { name: "Primary project" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["STW · Stubwise", "ACQ · Portale utenti Acquedotto delle Colline"]);
  });

  it("salvare solo il nome non scrive il principale se non è cambiato (principale non impostato)", async () => {
    const row = { repositoryId: null, serverCode: "SRV-1", reportedSha: null, reportedAt: null };
    state.environments.find((e) => e.id === "env-stw-prod")!.servers.push({ ...row });
    server("SRV-1").primaryProjectId = null;
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const name = within(part("Settings")).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "acq-prod-renamed");
    await user.click(within(part("Settings")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server("SRV-1").name).toBe("acq-prod-renamed"));
    expect(server("SRV-1").primaryProjectId).toBeNull();
  });

  it("Roberta: aggiunge un controllo dal dialogo, lo sospende, lo cancella a due tempi", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    await user.click(within(part("Checks")).getByRole("button", { name: "Add check" }));
    const dialog = await screen.findByRole("dialog", { name: "Add check" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Portal");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Target" }),
      "https://portale.test",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add check" }));
    const portal = await within(part("Checks")).findByRole("button", { name: /^Portal, Unknown/ });
    expect(portal).toBeInTheDocument();
    await user.click(within(part("Checks")).getByRole("button", { name: "Pause Portal" }));
    await within(part("Checks")).findByRole("button", { name: /^Portal, Paused/ });
    await user.click(within(part("Checks")).getByRole("button", { name: "Delete Portal" }));
    const confirm = within(part("Checks")).getByRole("button", { name: "Delete check" });
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    await waitFor(() =>
      expect(within(part("Checks")).queryByRole("button", { name: /^Portal,/ })).toBeNull(),
    );
  });

  it("Roberta: rigenerare la chiave la mostra una volta, dopo la conferma", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    await user.click(within(part("Settings")).getByRole("button", { name: "Regenerate key" }));
    const confirm = await screen.findByRole("dialog", { name: "Regenerate the key of SRV-1?" });
    expect(confirm).toHaveAccessibleDescription(
      "The agent on SRV-1 stops reporting until you update it with the new key.",
    );
    await user.click(within(confirm).getByRole("button", { name: "Regenerate key" }));
    const panel = await screen.findByRole("dialog", { name: "New key for SRV-1" });
    const key = (within(panel).getByRole("textbox", { name: "Agent key" }) as HTMLInputElement)
      .value;
    expect(key).toMatch(/^sk_[0-9a-f]{40}$/);
    await user.click(within(panel).getByRole("button", { name: "Copy the key" }));
    await user.click(within(panel).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("cambiare persona col dettaglio aperto: le parti di gestione spariscono sul posto", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    expect(part("Settings")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Profile and settings/ }));
    await user.click(screen.getByRole("radio", { name: /Laura Costa/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Settings" })).toBeNull());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("aud-app-01");
  });
});
