import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, servers, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// La sezione Servers (Task 7 del piano 8b, shape servers.md): l'elenco a
// gruppi con la salute in parole, «New server» col pannello della chiave,
// la voce della colonna col punto di stato, ⌘K per codice, e l'avviso
// degli ambienti che lasciano un server orfano. Il dettaglio di un server
// sta in `ServerDetail.test.tsx`.

const KEY_RE = /sk_[0-9a-f]{40}/;

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

const row = (code: string) => document.querySelector<HTMLElement>(`[data-server-row="${code}"]`)!;

async function openSection(person: string, code: string) {
  const router = renderRoute(`/p/${code}/servers`, person);
  await screen.findByRole("heading", { level: 1, name: "Servers" });
  return router;
}

describe("Servers — l'elenco", () => {
  it("ACQ (Marco): SRV-1 in «Running fine», in salute, con la diagnosi pronta e il progetto principale", async () => {
    await openSection("p-marco", "ACQ");
    expect(
      screen.getByText(
        "Where ACQ runs, and how it's doing. Servers join a project through its environments.",
      ),
    ).toBeInTheDocument();
    const fine = await screen.findByRole("list", { name: "Running fine" });
    expect(within(fine).getAllByRole("listitem")).toHaveLength(1);
    expect(row("SRV-1")).toHaveTextContent("acq-prod-01");
    expect(row("SRV-1")).toHaveTextContent("Healthy");
    expect(row("SRV-1")).toHaveTextContent("Production · ACQ (primary)");
    expect(row("SRV-1")).toHaveTextContent("Diagnosis ready · ACQ-6");
    expect(screen.queryByRole("list", { name: "Needs attention" })).toBeNull();
    // Il mini-grafico è decorativo: la salute è già in parole.
    expect(row("SRV-1").querySelector("[data-sparkline]")).toHaveAttribute("aria-hidden", "true");
    // Niente hostname nella riga (sta nel dettaglio).
    expect(row("SRV-1")).not.toHaveTextContent("colline.internal");
  });

  it("AUD (Laura): SRV-3 e SRV-4, lo stato dell'accesso in parole; nessun «New server»", async () => {
    await openSection("p-laura", "AUD");
    const fine = await screen.findByRole("list", { name: "Running fine" });
    expect(
      within(fine)
        .getAllByRole("listitem")
        .map((li) => li.dataset.serverRow),
    ).toEqual(["SRV-3", "SRV-4"]);
    expect(row("SRV-3")).toHaveTextContent("SSH access waiting for the command");
    expect(row("SRV-4")).toHaveTextContent("No SSH access");
    expect(screen.queryByRole("button", { name: "New server" })).toBeNull();
  });

  it("STW: SRV-2 in «Needs attention», in parole e non solo in colore", async () => {
    await openSection("p-roberta", "STW");
    const attention = await screen.findByRole("list", { name: "Needs attention" });
    expect(
      within(attention).getByRole("link", { name: /^SRV-2 db-stw-01, In trouble · since 09:40\. / }),
    ).toBeInTheDocument();
    // Il nome della riga dice anche la seconda riga: accesso, ambienti (T7 m1).
    expect(within(attention).getByRole("link", { name: /^SRV-2 / })).toHaveAccessibleName(
      /No SSH access: Claude can't look into it\. .*STW/,
    );
    expect(row("SRV-2")).toHaveTextContent("In trouble");
    expect(row("SRV-2")).toHaveTextContent("No SSH access: Claude can't look into it");
    // Il glifo colorato non parla da solo.
    for (const svg of row("SRV-2").querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("R-L4: un server mai collegato sta in un gruppo a sé, non fra quelli che vanno bene", async () => {
    setSessionPersonId("p-roberta");
    await servers.createServer({ name: "stw-worker-01", environmentId: "env-stw-staging" });
    await openSection("p-roberta", "STW");
    const waiting = await screen.findByRole("list", { name: "Waiting for the agent" });
    expect(
      within(waiting).getByRole("link", {
        name: /^SRV-5 stw-worker-01, Never connected · waiting for the agent\. .*Staging · STW/,
      }),
    ).toBeInTheDocument();
    expect(row("SRV-5")).toHaveTextContent("Staging · STW");
    expect(screen.queryByRole("list", { name: "Running fine" })).toBeNull();
  });

  it("J/K scorrono le righe e Invio apre il dettaglio", async () => {
    setSessionPersonId("p-roberta");
    await servers.createServer({ name: "stw-worker-01", environmentId: "env-stw-staging" });
    const user = userEvent.setup();
    const router = await openSection("p-roberta", "STW");
    await screen.findByRole("list", { name: "Needs attention" });
    await user.keyboard("j");
    expect(within(row("SRV-2")).getByRole("link")).toHaveFocus();
    await user.keyboard("j");
    expect(within(row("SRV-5")).getByRole("link")).toHaveFocus();
    await user.keyboard("k{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/STW/servers/SRV-2"));
  });

  it("caricamento con la forma vera, poi errore con «Retry»", async () => {
    setLatency(30);
    failNext("servers.listProjectServers");
    await openSection("p-marco", "ACQ");
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the servers of ACQ");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Running fine" })).toBeInTheDocument();
  });

  it("vuoto: chi gestisce il monitoraggio può aggiungere, gli altri leggono chi può", async () => {
    await openSection("p-roberta", "TLM");
    expect(
      await screen.findByRole("heading", { name: "No servers in TLM yet" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New server" }).length).toBeGreaterThan(0);
  });

  it("vuoto senza monitor.manage: la frase dice chi può aggiungerne uno", async () => {
    state.environments = state.environments.filter((e) => e.projectId !== "prj-acq");
    await openSection("p-marco", "ACQ");
    expect(
      await screen.findByRole("heading", { name: "No servers in ACQ yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Someone who manages monitoring can add one\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New server" })).toBeNull();
  });
});

describe("New server e la chiave dell'agente", () => {
  it("crea SRV-5 nello staging di STW: la chiave si vede una volta, si copia, poi il dettaglio «Never connected»", async () => {
    const user = userEvent.setup();
    const router = await openSection("p-roberta", "STW");
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog", { name: "New server in STW" });
    expect(within(dialog).getByRole("combobox", { name: "Environment" })).toHaveDisplayValue(
      "Staging · Staging",
    );
    expect(
      within(dialog).getByText("The server joins STW through this environment."),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "stw-worker-01");
    await user.click(within(dialog).getByRole("button", { name: "Create server" }));

    const panel = await screen.findByRole("dialog", { name: "SRV-5 is ready for its agent" });
    expect(within(panel).getByText("This key is shown only now.")).toBeInTheDocument();
    const key = within(panel).getByRole("textbox", { name: "Agent key" }) as HTMLInputElement;
    expect(key.value).toMatch(KEY_RE);
    expect(within(panel).getByText(/docker run -d --name stubwise-agent/)).toHaveTextContent(
      key.value,
    );
    // Chiave e comando nel monospace dei comandi (`font-code`), non nella sans.
    expect(key).toHaveClass("font-code");
    const command = within(panel).getByRole("region", { name: "Install the agent on the server" });
    expect(command.querySelector("pre")).toHaveClass("font-code");
    expect(
      within(panel).getByText("Prototype: this key is made up and no agent can use it."),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Copy the key" }));
    expect(await navigator.clipboard.readText()).toBe(key.value);
    expect(within(panel).getByRole("button", { name: "Copy the key" })).toHaveTextContent("Copied");
    await user.click(within(panel).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/p/STW/servers/SRV-5"));
    expect(
      await screen.findByRole("heading", { level: 1, name: /stw-worker-01/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Never connected").length).toBeGreaterThan(0);
    // La chiave non c'è più da nessuna parte.
    expect(document.body.textContent).not.toMatch(KEY_RE);
    expect(document.body.innerHTML).not.toContain(key.value);
  });

  it("chiudere senza aver copiato chiede; riaprendo «New server» la chiave non c'è più", async () => {
    // Un secondo ambiente libero, per riaprire il modulo dopo la creazione.
    state.environments.push({
      id: "env-stw-test",
      projectId: "prj-stw",
      name: "Test",
      kind: "test",
      url: null,
      servers: [],
    });
    const user = userEvent.setup();
    await openSection("p-roberta", "STW");
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog", { name: "New server in STW" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "stw-worker-01");
    await user.click(within(dialog).getByRole("button", { name: "Create server" }));
    const panel = await screen.findByRole("dialog", { name: "SRV-5 is ready for its agent" });
    const key = (within(panel).getByRole("textbox", { name: "Agent key" }) as HTMLInputElement)
      .value;
    await user.click(within(panel).getByRole("button", { name: "Done" }));
    expect(
      within(panel).getByText(
        "Close without copying the key? You can regenerate it later from Settings.",
      ),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Keep it open" }));
    expect(within(panel).getByRole("textbox", { name: "Agent key" })).toHaveValue(key);
    await user.click(within(panel).getByRole("button", { name: "Done" }));
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    await screen.findByRole("heading", { level: 1, name: /stw-worker-01/ });
    // Di nuovo nella sezione, un altro «New server»: il modulo è vuoto, nessuna chiave.
    await user.click(screen.getByRole("link", { name: "← Servers" }));
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const again = await screen.findByRole("dialog", { name: "New server in STW" });
    expect(within(again).getByRole("textbox", { name: "Name" })).toHaveValue("");
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("nessun ambiente libero: il dialogo rimanda a Releases → Environments", async () => {
    const user = userEvent.setup();
    await openSection("p-roberta", "ACQ");
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog", { name: "New server in ACQ" });
    expect(
      await within(dialog).findByText(
        "Every environment of ACQ already has a server. Add an environment in Releases → Environments first.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open Environments" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Create server" })).toBeNull();
  });
});

describe("La colonna e ⌘K", () => {
  it("il punto sulla voce Servers quando un server è in difficoltà, con la frase; altrimenti il numero", async () => {
    await openSection("p-roberta", "STW");
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const link = within(nav).getByRole("link", { name: /^Servers/ });
    await waitFor(() => expect(link.querySelector("[data-servers-dot]")).not.toBeNull());
    expect(link.querySelector("[data-servers-dot]")).toHaveAttribute("data-servers-dot", "trouble");
    expect(link.querySelector("[data-servers-dot]")).toHaveClass("bg-warning");
    expect(link).toHaveTextContent("1 server in trouble");
  });

  it("un server che non risponde fa il punto rosso; in salute resta il numero", async () => {
    setSessionPersonId("p-roberta");
    await servers.simulateServerAlert("SRV-1", "agent_silent");
    await openSection("p-roberta", "ACQ");
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const link = within(nav).getByRole("link", { name: /^Servers/ });
    await waitFor(() => expect(link).toHaveTextContent("1 server not responding"));
    expect(link.querySelector("[data-servers-dot]")).toHaveClass("bg-critical");
  });

  it("in salute: il numero dei server, nessun punto", async () => {
    await openSection("p-laura", "AUD");
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const link = within(nav).getByRole("link", { name: /^Servers/ });
    await waitFor(() => expect(link).toHaveTextContent("2 servers"));
    expect(link.querySelector("[data-servers-dot]")).toBeNull();
  });

  it("⌘K «SRV-1» porta al dettaglio nel progetto principale", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", "p-marco");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "SRV-1");
    const group = await within(dialog).findByRole("group", { name: "Servers" });
    const option = within(group).getByRole("option", { name: /SRV-1/ });
    expect(option).toHaveTextContent("acq-prod-01");
    expect(option).toHaveTextContent("ACQ");
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/ACQ/servers/SRV-1"));
  });

  it("⌘K: chi non vede il server non lo trova (R-G5)", async () => {
    const user = userEvent.setup();
    renderRoute("/home", "p-sara");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    // Controllo positivo nella stessa ricerca: il server che vede (SRV-2, di
    // STW) compare, quindi la ricerca dei server ha risposto; SRV-3 no.
    await user.type(within(dialog).getByRole("combobox"), "SRV-");
    const group = await within(dialog).findByRole("group", { name: "Servers" });
    expect(within(group).getByRole("option", { name: /SRV-2/ })).toBeInTheDocument();
    expect(within(group).queryByRole("option", { name: /SRV-3/ })).toBeNull();
    expect(within(group).queryByRole("option", { name: /SRV-4/ })).toBeNull();
  });
});

describe("Ambienti (8a): togliere l'ultima riga di un server", () => {
  it("il dialogo avvisa che poi lo ricollega solo chi gestisce il monitoraggio", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/releases", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "Releases" });
    const envs = await screen.findByRole("list", { name: "Environments" });
    const production = within(envs)
      .getAllByRole("listitem")
      .find((li) => li.dataset.environment === "Production")!;
    await user.click(within(production).getByRole("button", { name: "More for Production" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "SRV-3, SRV-4 won't be in any environment anymore. Only someone who manages monitoring can link them again.",
      ),
    ).toBeInTheDocument();
  });
});
