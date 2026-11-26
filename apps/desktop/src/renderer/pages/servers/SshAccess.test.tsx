import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state, visibleProjectIds } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// L'accesso SSH nel dettaglio di un server (Task 8 del piano 8b, shape
// server-access.md; area 8, F4b: UNO, di sola lettura, `stubwise-read`): i
// tre passi, l'esito della verifica (login, sudo, docker, journal),
// Rigenera, Revoca col comando di rimozione, l'ultimo uso, chi guarda senza
// azioni, nessuna chiave privata, i «Simula» solo nel riquadro «Prototype
// only», ⌘K. Nessuna traccia di un accesso di correzione.

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

async function open(path: string, person: string) {
  const router = renderRoute(path, person);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

const access = () => screen.getByRole("region", { name: "SSH access" });
const proto = () => screen.getByRole("region", { name: "Prototype only: SSH verification" });

async function simulate(user: ReturnType<typeof userEvent.setup>, outcome: string) {
  await user.selectOptions(
    within(proto()).getByRole("combobox", { name: "Next verification:" }),
    outcome,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.click(
    within(access()).getByRole("button", { name: `More SSH access actions for ${code}` }),
  );
  return screen.findByRole("menu");
}

describe("i tre passi (Roberta, servers.ssh.manage)", () => {
  it("collega → comando in monospace con Copy, un solo utente di lettura → Verify chiude la procedura", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-4", "p-roberta");
    expect(access()).toHaveTextContent(
      "One read-only access lets Claude look into SRV-4. Fixes don't use SSH: they go through the monitoring agent.",
    );
    expect(access()).toHaveTextContent("The private key is encrypted and never shown.");
    await user.click(within(access()).getByRole("button", { name: "Link SSH access" }));

    const step2 = await within(access()).findByRole("heading", {
      name: "Run this command on SRV-4",
    });
    await waitFor(() => expect(step2).toHaveFocus());
    // Chi crea cosa, PRIMA del comando: un utente solo, di sola lettura.
    const users = within(access()).getByRole("table", { name: "The user the command creates" });
    expect(within(users).getAllByRole("rowheader")).toHaveLength(1);
    expect(within(users).getByRole("row", { name: /stubwise-read/ })).toHaveTextContent(
      "Reads processes, disk, memory, load, listening ports and failed services. Can't change anything.",
    );
    expect(users).toHaveTextContent("No sudo, not in the docker group.");
    const command = await within(access()).findByRole("region", { name: "Command for SRV-4" });
    const code = command.querySelector("pre")!;
    expect(code.className).toContain("font-code");
    expect(code.textContent).toContain("stubwise-read@SRV-4");
    expect(code.textContent).toContain(
      "# Stubwise: read-only SSH access for SRV-4 (public key only).",
    );
    expect(code.textContent).not.toMatch(/accesso|sola lettura|soltanto|pronto/);
    expect(users.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(access()).toHaveTextContent(
      "Run it as root on SRV-4. Read it first: it contains only a public key.",
    );
    expect(access()).toHaveTextContent(/Fingerprint SHA256:[^…\s]{8}…\S{4}/);
    expect(access()).toHaveTextContent("Prototype: this key is made up by the prototype.");
    await user.click(within(command).getByRole("button", { name: "Copy the command" }));
    expect(await screen.findByText("Command copied")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toContain("stubwise-read@SRV-4");

    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    const result = await within(access()).findByRole("status", { name: "Verification result" });
    expect(result).toHaveTextContent("Signs in as stubwise-read.");
    expect(result).toHaveTextContent("No sudo.");
    expect(result).toHaveTextContent("Not in the docker group.");
    expect(result).toHaveTextContent("Reads the system journal (group systemd-journal).");
    // La procedura si chiude: resta la riga di stato, una.
    await waitFor(() =>
      expect(within(access()).queryByRole("region", { name: "Command for SRV-4" })).toBeNull(),
    );
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-4" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
    expect(rows).toHaveTextContent(/Read-only access.*stubwise-read.*Verified/);
    // Nessuna traccia di un accesso di correzione.
    expect(access()).not.toHaveTextContent(/stubwise-fix|Fix access|can do anything/i);
  });

  it("ogni esito simulato in parole: chiave rifiutata, irraggiungibile, senza journal", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    // SRV-3: chiave generata, comando mai eseguito → passo 2 aperto.
    expect(
      await within(access()).findByRole("heading", { name: "Run this command on SRV-3" }),
    ).toBeInTheDocument();

    await simulate(user, "Key refused");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    const result = await within(access()).findByRole("status", { name: "Verification result" });
    await waitFor(() =>
      expect(result).toHaveTextContent("The server refused the key. Was the command run on SRV-3?"),
    );
    // Resta aperta sul passo 3, con «Verify again» e il comando da rivedere.
    expect(within(access()).getByRole("button", { name: "Verify again" })).toBeInTheDocument();

    await simulate(user, "Server unreachable");
    await user.click(within(access()).getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(access()).toHaveTextContent(
        "Couldn't reach SRV-3 over SSH (port 22). Nothing was checked.",
      ),
    );

    await simulate(user, "Works, without the journal group");
    await user.click(within(access()).getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(
        within(access()).getByRole("status", { name: "Verification result" }),
      ).toHaveTextContent(
        "Can't read the system journal, so Claude won't read it. Add stubwise-read to systemd-journal or adm to let it.",
      ),
    );
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-3" });
    expect(rows).toHaveTextContent(/Verified/);
    expect(rows).toHaveTextContent("Doesn't read the system journal");
  });

  it.each([
    ["stubwise-read has sudo", "It can run sudo."],
    [
      "stubwise-read is in the docker group",
      "It's in the docker group: it can control every container.",
    ],
  ])("«%s» è un errore, mai un successo: l'accesso è spento", async (outcome, line) => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    await within(access()).findByRole("heading", { name: "Run this command on SRV-3" });
    await simulate(user, outcome);
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    const alert = await within(access()).findByRole("alert");
    expect(alert).toHaveTextContent(
      "stubwise-read can do more than read. That's an error: the access is off until a verification passes.",
    );
    expect(alert).toHaveTextContent(
      "Take stubwise-read out of the sudo and docker groups (running the command again does it), then verify again.",
    );
    expect(access()).toHaveTextContent(line);
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-3" });
    expect(within(rows).getAllByText("Off: stubwise-read can do more than read")).toHaveLength(1);
    expect(within(access()).getByRole("button", { name: "Verify again" })).toBeInTheDocument();
  });

  it("errore della verifica (livello dati): «Couldn't verify» con «Retry»", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    await within(access()).findByRole("heading", { name: "Run this command on SRV-3" });
    failNext("servers.verifySshAccess");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("Couldn't verify. Try again.");
    await user.click(within(toast).getByRole("button", { name: "Retry" }));
    expect(
      await within(access()).findByRole("status", { name: "Verification result" }),
    ).toHaveTextContent("Signs in as stubwise-read.");
  });
});

describe("Rigenera e Revoca", () => {
  it("Rigenera (decisione del maintainer, 15 nov 2026): la vecchia smette subito, si torna al comando", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate key…" }));
    const dialog = await screen.findByRole("dialog", { name: "Regenerate SRV-1's key?" });
    expect(dialog).toHaveTextContent(
      "You get a new key and a new command. The current key stops working now: until the new one passes verification, Claude looks into problems without SSH reads.",
    );
    expect(dialog).not.toHaveTextContent(/keeps working/);
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    // Come un collegamento nuovo: il comando con la sola chiave nuova, poi la verifica.
    await within(access()).findByRole("region", { name: "Command for SRV-1" });
    expect(
      within(access()).queryByRole("heading", { name: "New key — not in use yet" }),
    ).toBeNull();
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    expect(
      await within(access()).findByRole("list", { name: "SSH access of SRV-1" }),
    ).toBeInTheDocument();
  });

  it("Revoca con conferma, poi il comando di rimozione fino a «Done», poi «Link again»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Revoke access…" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke SSH access to SRV-1?" });
    for (const line of [
      "Claude can't look into SRV-1's problems any more.",
      "A fix on SRV-1 isn't affected: it goes through the monitoring agent.",
      "Stubwise forgets the key. The user stays on the server until you remove it.",
    ])
      expect(dialog).toHaveTextContent(line);
    expect(dialog).not.toHaveTextContent(/stops|can't be approved/);
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));

    const title = await within(access()).findByRole("heading", {
      name: /^Access revoked .*To remove stubwise-read from SRV-1, run:$/,
    });
    await waitFor(() => expect(title).toHaveFocus());
    const removal = within(access()).getByRole("region", { name: "Removal command for SRV-1" });
    expect(removal).toHaveTextContent("userdel stubwise-read");
    expect(removal).not.toHaveTextContent("stubwise-fix");
    expect(removal).toHaveTextContent("Stubwise: SRV-1 access removed.");
    expect(removal.textContent).not.toMatch(/accesso|rimoss|rimozione/);
    expect(within(removal).getByRole("button", { name: "Copy the command" })).toBeInTheDocument();
    expect(access()).not.toHaveTextContent("The private key is encrypted and never shown.");
    expect(screen.queryByText(/Next verification/)).toBeNull();
    await user.click(within(access()).getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(
        within(access()).queryByRole("region", { name: "Removal command for SRV-1" }),
      ).toBeNull(),
    );
    expect(access()).toHaveTextContent(/Revoked \w+ \d+/);
    const again = await openMenu(user, "SRV-1");
    expect(
      within(again).getByRole("menuitem", { name: "Show removal command" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(within(access()).getByRole("button", { name: "Link again" }));
    expect(within(access()).getByRole("button", { name: "Link SSH access" })).toBeInTheDocument();
    expect(screen.getByText(/Next verification/)).toBeInTheDocument();
  });
});

describe("chi guarda e l'ultimo uso", () => {
  it("ultimo uso: l'analisi con «Open session»", async () => {
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-1" });
    const [read] = within(rows).getAllByRole("listitem");
    expect(read).toHaveTextContent("Used yesterday by the analysis of SRV-1");
    expect(within(read!).getByRole("link", { name: "Open session" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/claude\//),
    );
  });

  it("una task che chi guarda vede è un link; una che non vede non si nomina", async () => {
    const acq = state.projects.find((p) => p.code === "ACQ")!;
    const seen = state.tasks.find((t) => t.projectId === acq.id)!;
    const visible = visibleProjectIds("p-laura");
    const hidden = state.tasks.find((t) => !visible.has(t.projectId))!;
    const a = state.serverAccess.get("SRV-1")!;
    const at = new Date(Date.now() - 3_600_000).toISOString();
    a.lastUse = { at, ref: { kind: "task", taskId: seen.id } };
    await open("/p/ACQ/servers/SRV-1", "p-laura");
    let read = within(
      within(access()).getByRole("list", { name: "SSH access of SRV-1" }),
    ).getAllByRole("listitem")[0]!;
    expect(within(read).getByRole("link", { name: new RegExp(seen.code) })).toBeInTheDocument();
    document.body.innerHTML = "";

    a.lastUse = { at, ref: { kind: "task", taskId: hidden.id } };
    await open("/p/ACQ/servers/SRV-1", "p-laura");
    read = within(within(access()).getByRole("list", { name: "SSH access of SRV-1" })).getAllByRole(
      "listitem",
    )[0]!;
    expect(read).toHaveTextContent("by a task you can't see");
    expect(read).not.toHaveTextContent(hidden.code);
  });

  it("Laura: stato e ultimo uso, nessuna azione, nessun comando né impronta", async () => {
    await open("/p/ACQ/servers/SRV-1", "p-laura");
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-1" });
    expect(rows).toHaveTextContent(/Verified/);
    expect(rows).toHaveTextContent("Used yesterday by the analysis of SRV-1");
    expect(within(access()).queryByRole("button")).toBeNull();
    expect(access()).not.toHaveTextContent("SHA256");
    expect(access().querySelector("pre")).toBeNull();
    expect(screen.queryByRole("region", { name: "Prototype only: SSH verification" })).toBeNull();
    document.body.innerHTML = "";

    await open("/p/AUD/servers/SRV-4", "p-laura");
    expect(access()).toHaveTextContent(
      "Not linked. Claude can't look into this server's problems.",
    );
    expect(access()).toHaveTextContent("An admin who manages SSH access can link it.");
    // Nessuna azione sull'accesso: c'è solo «Who?», che dice a chi chiedere (area 9a).
    expect(
      within(access())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Who?"]);
    document.body.innerHTML = "";

    await open("/p/AUD/servers/SRV-3", "p-laura");
    expect(access()).toHaveTextContent("Waiting for the command");
    expect(access().querySelector("pre")).toBeNull();
  });

  it("cambiare persona con la procedura aperta: restano solo le righe di stato", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    await within(access()).findByRole("heading", { name: "Run this command on SRV-3" });
    await user.click(screen.getByRole("button", { name: /^Profile and settings/ }));
    await user.click(screen.getByRole("radio", { name: /Laura Costa/ }));
    await waitFor(() =>
      expect(
        within(access()).queryByRole("heading", { name: "Run this command on SRV-3" }),
      ).toBeNull(),
    );
    expect(access()).toHaveTextContent("Waiting for the command");
  });
});

describe("verità del prototipo", () => {
  it("nessuna chiave privata nel DOM (testo, attributi, title), in ogni stato del pannello", async () => {
    const user = userEvent.setup();
    const noPrivate = () => {
      expect(document.body.textContent).not.toContain("PRIVATE KEY");
      expect(document.body.innerHTML).not.toContain("PRIVATE KEY");
    };
    await open("/p/AUD/servers/SRV-4", "p-roberta");
    noPrivate(); // non collegato: passo 1
    await user.click(within(access()).getByRole("button", { name: "Link SSH access" }));
    await within(access()).findByRole("region", { name: "Command for SRV-4" });
    noPrivate(); // in attesa del comando: passo 2 con comando e impronte
    await simulate(user, "Key refused");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    await within(access()).findByRole("button", { name: "Verify again" });
    noPrivate(); // verifica non riuscita
    await user.click(within(access()).getByRole("button", { name: "Verify again" }));
    await within(access()).findByRole("list", { name: "SSH access of SRV-4" });
    noPrivate(); // verificato
    let menu = await openMenu(user, "SRV-4");
    await user.click(within(menu).getByRole("menuitem", { name: "Show command again" }));
    await within(access()).findByRole("region", { name: "Command for SRV-4" });
    noPrivate(); // comando rivisto dal «⋯»
    menu = await openMenu(user, "SRV-4");
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate key…" }));
    noPrivate(); // dialogo di Rigenera
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Regenerate" }),
    );
    await within(access()).findByRole("region", { name: "Command for SRV-4" });
    noPrivate(); // rigenerata: comando con la sola nuova pubblica
    menu = await openMenu(user, "SRV-4");
    await user.click(within(menu).getByRole("menuitem", { name: "Revoke access…" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke access" }),
    );
    await within(access()).findByRole("region", { name: "Removal command for SRV-4" });
    noPrivate(); // revocato: comando di rimozione
    await user.click(within(access()).getByRole("button", { name: "Done" }));
    await within(access()).findByRole("button", { name: "Link again" });
    noPrivate(); // revocato, chiuso
  });

  it("ogni «Simula» dell'accesso sta nel riquadro «Prototype only»", async () => {
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    const box = proto();
    expect(box).toHaveAttribute("data-prototype-only");
    expect(box).toHaveTextContent(
      "This decides what the next Verify answers. Nothing connects to a server.",
    );
    const select = within(box).getByRole("combobox", { name: "Next verification:" });
    expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Works (reads the journal)",
      "Works, without the journal group",
      "Key refused",
      "stubwise-read has sudo",
      "stubwise-read is in the docker group",
      "Server unreachable",
    ]);
    expect(within(access()).queryByRole("combobox")).toBeNull();
  });

  it("⌘K «Link SSH access» sul server aperto, solo con servers.ssh.manage", async () => {
    const user = userEvent.setup();
    const router = await open("/p/AUD/servers/SRV-4", "p-roberta");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("link ssh");
    await user.click(
      await within(palette).findByRole("option", { name: /Link SSH access to SRV-4/ }),
    );
    await waitFor(() => expect(router.state.location.search).toMatchObject({ section: "access" }));
  });

  it("⌘K: senza servers.ssh.manage (Laura) il comando non c'è; con Roberta, sullo stesso server, sì", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-4", "p-laura");
    await user.keyboard("{Control>}k{/Control}");
    let palette = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("link ssh");
    // Controllo positivo: la palette ha già filtrato per «link ssh».
    await within(palette).findByRole("option", { name: "Ask Claude: “link ssh”" });
    expect(within(palette).queryByRole("option", { name: /Link SSH access/ })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: /^Profile and settings/ }));
    await user.click(screen.getByRole("radio", { name: /Roberta Fontana/ }));
    await user.keyboard("{Escape}");
    await within(access()).findByRole("button", { name: "Link SSH access" });
    await user.keyboard("{Control>}k{/Control}");
    palette = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("link ssh");
    expect(
      await within(palette).findByRole("option", { name: /Link SSH access to SRV-4/ }),
    ).toBeInTheDocument();
  });

  it("⌘K: su un server già verificato «Link SSH access» non c'è", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("link ssh");
    await within(palette).findByRole("option", { name: "Ask Claude: “link ssh”" });
    expect(within(palette).queryByRole("option", { name: /Link SSH access/ })).toBeNull();
  });
});
