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

// Gli accessi SSH nel dettaglio di un server (Task 8 del piano 8b, shape
// server-access.md): i tre passi, gli esiti per accesso, Rigenera, Revoca
// col comando di rimozione, l'ultimo uso, chi guarda senza azioni, nessuna
// chiave privata, i «Simula» solo nel riquadro «Prototype only», ⌘K.

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
  it("collega → comando in monospace con Copy e la frase su stubwise-fix → Verify chiude la procedura", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-4", "p-roberta");
    expect(access()).toHaveTextContent(
      "Two accesses let Claude look into SRV-4, and fix it from a task.",
    );
    expect(access()).toHaveTextContent("Private keys are encrypted and never shown.");
    await user.click(within(access()).getByRole("button", { name: "Link SSH access" }));

    const step2 = await within(access()).findByRole("heading", {
      name: "Run this command on SRV-4",
    });
    await waitFor(() => expect(step2).toHaveFocus());
    // Chi crea cosa, PRIMA del comando: la frase accanto a stubwise-fix, non in un tooltip.
    const users = within(access()).getByRole("table", {
      name: "The two users the command creates",
    });
    const fixRow = within(users).getByRole("row", { name: /stubwise-fix/ });
    expect(fixRow).toHaveTextContent("Can do anything on the server");
    expect(within(users).getByRole("row", { name: /stubwise-read/ })).toHaveTextContent(
      "Reads logs, processes, disk and memory. Can't change anything.",
    );
    const command = await within(access()).findByRole("region", { name: "Command for SRV-4" });
    const code = command.querySelector("pre")!;
    expect(code.className).toContain("font-code");
    expect(code.textContent).toContain("stubwise-read@SRV-4");
    // Interfaccia in inglese: nessun commento né echo in italiano.
    expect(code.textContent).toContain("# Stubwise: SSH accesses for SRV-4 (public keys only).");
    expect(code.textContent).not.toMatch(/accessi|sola lettura|soltanto|può fare|pronti/);
    expect(users.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(access()).toHaveTextContent(
      "Run it as root on SRV-4. Read it first: it contains only public keys.",
    );
    expect(access()).toHaveTextContent(
      /read SHA256:[^…\s]{8}…\S{4}\s*·\s*fix SHA256:[^…\s]{8}…\S{4}/,
    );
    expect(access()).toHaveTextContent("Prototype: these keys are made up by the prototype.");
    await user.click(within(command).getByRole("button", { name: "Copy the command" }));
    expect(await screen.findByText("Command copied")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toContain("stubwise-fix@SRV-4");

    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    const result = await within(access()).findByRole("status", { name: "Verification result" });
    expect(result).toHaveTextContent("Read access works, and it can't write.");
    expect(result).toHaveTextContent("Fix access works.");
    // La procedura si chiude: restano le due righe di stato.
    await waitFor(() =>
      expect(within(access()).queryByRole("region", { name: "Command for SRV-4" })).toBeNull(),
    );
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-4" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(2);
    expect(rows).toHaveTextContent(/Read access.*stubwise-read.*Verified/);
    expect(rows).toHaveTextContent(/Fix access.*stubwise-fix.*Verified/);
    // A procedura chiusa la frase su stubwise-fix resta.
    expect(rows).toHaveTextContent("Can do anything on the server.");
  });

  it("ogni esito simulato in parole: quale accesso e perché", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    // SRV-3: chiavi generate, comando mai eseguito → passo 2 aperto.
    expect(
      await within(access()).findByRole("heading", { name: "Run this command on SRV-3" }),
    ).toBeInTheDocument();

    await simulate(user, "Read access fails");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    let result = await within(access()).findByRole("status", { name: "Verification result" });
    await waitFor(() =>
      expect(result).toHaveTextContent(
        "Read access failed: the server refused the key. Was the command run on SRV-3?",
      ),
    );
    expect(result).toHaveTextContent("Fix access works.");
    // Resta aperta sul passo 3, con «Verify again» e il comando da rivedere.
    expect(within(access()).getByRole("button", { name: "Verify again" })).toBeInTheDocument();

    await simulate(user, "Fix access fails");
    await user.click(within(access()).getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(
        within(access()).getByRole("status", { name: "Verification result" }),
      ).toHaveTextContent(
        "Fix access failed: the server refused the key. Was the command run on SRV-3?",
      ),
    );
    result = within(access()).getByRole("status", { name: "Verification result" });
    expect(result).toHaveTextContent("Read access works, and it can't write.");

    await simulate(user, "Server unreachable");
    await user.click(within(access()).getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(access()).toHaveTextContent(
        "Couldn't reach SRV-3 over SSH (port 22). Neither access could be checked.",
      ),
    );
  });

  it("«lettura scrive» è un errore, mai un successo: entrambi spenti", async () => {
    const user = userEvent.setup();
    await open("/p/AUD/servers/SRV-3", "p-roberta");
    await within(access()).findByRole("heading", { name: "Run this command on SRV-3" });
    await simulate(user, "Read access can write");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    const alert = await within(access()).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Read access can write. That's an error: both accesses are off until a verification passes.",
    );
    expect(alert).toHaveTextContent(
      "Check that stubwise-read isn't in the sudo or docker group, then verify again.",
    );
    expect(access()).not.toHaveTextContent("Read access works");
    expect(access().querySelector("[data-outcome='ok'][data-access='read']")).toBeNull();
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-3" });
    expect(within(rows).getAllByText("Off: read access can write")).toHaveLength(2);
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
    ).toHaveTextContent("Fix access works.");
  });
});

describe("Rigenera e Revoca", () => {
  it("Rigenera: le vecchie restano valide fino alla verifica delle nuove", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate keys…" }));
    const dialog = await screen.findByRole("dialog", { name: "Regenerate SRV-1's keys?" });
    expect(dialog).toHaveTextContent(
      "You get new keys and a new command. The current keys keep working until the new ones pass verification.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    expect(
      await within(access()).findByRole("heading", { name: "New keys — not in use yet" }),
    ).toBeInTheDocument();
    expect(access()).toHaveTextContent("The command authorizes the current keys and the new ones.");
    // Le righe in uso restano, con il loro ultimo uso.
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-1" });
    expect(within(rows).getAllByText("In use")).toHaveLength(2);
    expect(rows).toHaveTextContent("by the analysis of SRV-1");

    // Le nuove non passano: le vecchie (che funzionavano) restano in uso.
    await simulate(user, "Fix access fails");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(access()).toHaveTextContent(
        "The new keys didn't pass. The current ones are still in use.",
      ),
    );
    expect(within(rows).getAllByText("In use")).toHaveLength(2);

    await user.click(within(access()).getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(access()).toHaveTextContent("The new keys are in use. Stubwise forgot the old ones."),
    );
    expect(
      within(access()).queryByRole("heading", { name: "New keys — not in use yet" }),
    ).toBeNull();
  });

  it("Rigenera con la sola lettura funzionante: si promette solo quella (R-L8)", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    // Verificato, poi «Verify again» con la correzione rifiutata.
    await simulate(user, "Fix access fails");
    let menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Verify again" }));
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-1" });
    await waitFor(() =>
      expect(within(rows).getAllByRole("listitem")[1]).toHaveTextContent(
        "Check failed: the server refused the key",
      ),
    );

    menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate keys…" }));
    const dialog = await screen.findByRole("dialog", { name: "Regenerate SRV-1's keys?" });
    expect(dialog).toHaveTextContent(
      "The current read key keeps working until the new ones pass verification; the current fix key isn't working now.",
    );
    expect(dialog).not.toHaveTextContent("The current keys keep working");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    await within(access()).findByRole("heading", { name: "New keys — not in use yet" });
    expect(access()).toHaveTextContent(
      "Until they pass, Stubwise keeps using the current read key. The current fix key isn't working.",
    );
    expect(access()).not.toHaveTextContent("keeps using the current keys");
    const now = within(access()).getByRole("list", { name: "SSH access of SRV-1" });
    expect(within(now).getAllByRole("listitem")[0]).toHaveTextContent("In use");
    expect(within(now).getAllByRole("listitem")[1]).toHaveTextContent("Check failed");

    await simulate(user, "Read access fails");
    await user.click(within(access()).getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(access()).toHaveTextContent(
        "The new keys didn't pass. The current read key is still in use; the fix key isn't working.",
      ),
    );
    expect(access()).not.toHaveTextContent("The current ones are still in use");
  });

  it("Laura durante la rigenerazione: nessuna promessa sulle chiavi attuali (R-L8)", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    await simulate(user, "Fix access fails");
    let menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Verify again" }));
    await waitFor(() => expect(access()).toHaveTextContent("Check failed"));
    menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate keys…" }));
    const dialog = await screen.findByRole("dialog", { name: "Regenerate SRV-1's keys?" });
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await within(access()).findByRole("heading", { name: "New keys — not in use yet" });

    await user.click(screen.getByRole("button", { name: /^Profile and settings/ }));
    await user.click(screen.getByRole("radio", { name: /Laura Costa/ }));
    await waitFor(() => expect(access()).toHaveTextContent("New keys being set up."));
    expect(access()).not.toHaveTextContent("stay in use");
    expect(within(access()).queryByRole("button")).toBeNull();
  });

  it("Revoca con conferma, poi il comando di rimozione fino a «Done», poi «Link again»", async () => {
    const user = userEvent.setup();
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const menu = await openMenu(user, "SRV-1");
    await user.click(within(menu).getByRole("menuitem", { name: "Revoke access…" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke SSH access to SRV-1?" });
    for (const line of [
      "Claude can't look into SRV-1's problems any more.",
      "A fix running on SRV-1 stops.",
      "A fix plan waiting for approval can't be approved.",
      "Stubwise forgets the keys. The users stay on the server until you remove them.",
    ])
      expect(dialog).toHaveTextContent(line);
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));

    const title = await within(access()).findByRole("heading", {
      name: /^Access revoked .*To remove the two users from SRV-1, run:$/,
    });
    await waitFor(() => expect(title).toHaveFocus());
    const removal = within(access()).getByRole("region", { name: "Removal command for SRV-1" });
    expect(removal).toHaveTextContent("userdel stubwise-read");
    expect(removal).toHaveTextContent("userdel stubwise-fix");
    // Con l'interfaccia in inglese, commenti ed echo dello script sono in inglese.
    expect(removal).toHaveTextContent("Stubwise: SRV-1 accesses removed.");
    expect(removal.textContent).not.toMatch(/accessi|rimoss|rimozione/);
    expect(within(removal).getByRole("button", { name: "Copy the command" })).toBeInTheDocument();
    // Il comando di rimozione non ha chiavi: niente frase sulle chiavi pubbliche,
    // e revocato non c'è niente da verificare (niente «Next verification»).
    expect(access()).not.toHaveTextContent("Private keys are encrypted and never shown.");
    expect(screen.queryByText(/Next verification/)).toBeNull();
    await user.click(within(access()).getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(
        within(access()).queryByRole("region", { name: "Removal command for SRV-1" }),
      ).toBeNull(),
    );
    expect(access()).toHaveTextContent(/Revoked \w+ \d+/);
    // Il comando di rimozione resta raggiungibile dal «⋯».
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
  it("ultimo uso per accesso: l'analisi con «Open session», la task col link, mai usato", async () => {
    await open("/p/ACQ/servers/SRV-1", "p-roberta");
    const rows = within(access()).getByRole("list", { name: "SSH access of SRV-1" });
    const [read, fix] = within(rows).getAllByRole("listitem");
    expect(read).toHaveTextContent("Used yesterday by the analysis of SRV-1");
    expect(within(read!).getByRole("link", { name: "Open session" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/claude\//),
    );
    expect(fix).toHaveTextContent("Not used yet");
  });

  it("una task che chi guarda vede è un link; una che non vede non si nomina", async () => {
    const acq = state.projects.find((p) => p.code === "ACQ")!;
    const seen = state.tasks.find((t) => t.projectId === acq.id)!;
    const visible = visibleProjectIds("p-laura");
    const hidden = state.tasks.find((t) => !visible.has(t.projectId))!;
    const a = state.serverAccess.get("SRV-1")!;
    a.lastUse.fix = {
      at: new Date(Date.now() - 3_600_000).toISOString(),
      ref: { kind: "task", taskId: seen.id },
    };
    await open("/p/ACQ/servers/SRV-1", "p-laura");
    let fix = within(
      within(access()).getByRole("list", { name: "SSH access of SRV-1" }),
    ).getAllByRole("listitem")[1]!;
    expect(within(fix).getByRole("link", { name: new RegExp(seen.code) })).toBeInTheDocument();
    document.body.innerHTML = "";

    a.lastUse.fix = { at: a.lastUse.fix.at, ref: { kind: "task", taskId: hidden.id } };
    await open("/p/ACQ/servers/SRV-1", "p-laura");
    fix = within(within(access()).getByRole("list", { name: "SSH access of SRV-1" })).getAllByRole(
      "listitem",
    )[1]!;
    expect(fix).toHaveTextContent("by a task you can't see");
    expect(fix).not.toHaveTextContent(hidden.code);
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
    expect(within(access()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Who?"]);
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
    await simulate(user, "Fix access fails");
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
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate keys…" }));
    noPrivate(); // dialogo di Rigenera
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Regenerate" }),
    );
    await within(access()).findByRole("heading", { name: "New keys — not in use yet" });
    await within(access()).findByRole("region", { name: "Command for SRV-4" });
    noPrivate(); // in rigenerazione: comando con vecchie e nuove pubbliche
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
      "Works",
      "Read access fails",
      "Fix access fails",
      "Read access can write",
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
