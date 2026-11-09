import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { disconnectGoogle, whenDriveIdle } from "../../data/drive/writes";
import { PEOPLE } from "../../data/seed/people";
import { PROJECTS } from "../../data/seed/projects";
import { setSessionPersonId } from "../../data/session";
import { state, visibleProjectIds } from "../../data/store";
import { ViewerProvider, resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { readDraft } from "../chat/drafts";
import { GoogleConnectInvite } from "./DriveBanners";
import { closePreview } from "./FilePreview";
import { closeGoogleAccount } from "./GoogleAccountCard";
import { closeLinkFolder } from "./LinkFolderDialog";
import { closeWhichProject, openGoogleOutsideFile } from "./WhichProjectDialog";

// Google nel Drive (Task 7, shape drive-google.md): account dal menu
// profilo, collegare e scollegare una cartella, «Add from Google Drive»,
// «a quale progetto?», non disponibile, collegamento scaduto, nascosti.

const row = (code: string) => document.querySelector<HTMLElement>(`[data-drive-row="${code}"]`);

async function openDrive(url: string, personId = "p-laura") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: "Drive" });
  return router;
}

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

async function moreDriveActions() {
  await userEvent.click(await screen.findByRole("button", { name: "More Drive actions" }));
  return screen.findByRole("menu");
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  try {
    window.localStorage.clear();
  } catch {
    // niente storage
  }
});
afterEach(() => {
  resetViewerGrants();
  closePreview();
  closeGoogleAccount();
  closeWhichProject();
  closeLinkFolder();
});

describe("Collegare una cartella", () => {
  it("dice chi leggerà cosa e con quale account, poi porta i file della cartella nel progetto", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    const menu = await moreDriveActions();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Link a Google folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Link a Google folder to MKX" });
    // Le briciole: si parte da My Drive e si entra nelle cartelle.
    const crumbs = within(dialog).getByRole("navigation", { name: "Folder path" });
    expect(crumbs).toHaveTextContent("My Drive");
    const list = within(dialog).getByRole("listbox", { name: "Folders" });
    await userEvent.dblClick(await within(list).findByRole("option", { name: /^Clienti/ }));
    expect(crumbs).toHaveTextContent("My Drive›Clienti");
    const bellavista = within(list).getByRole("option", { name: /Cantina Bellavista – materiali/ });
    await userEvent.click(bellavista);
    expect(bellavista).toHaveAttribute("aria-selected", "true");
    const link = within(dialog).getByRole("button", { name: "Link folder" });
    // La frase di visibilità è letta anche da chi va dritto al bottone.
    expect(link).toHaveAccessibleDescription(
      /Everyone in MKX \(\d+ people\) will be able to read every file in “Cantina Bellavista – materiali” and its subfolders, even people who can't open it on Google\. Stubwise reads it with your account, giulia\.ferri@example\.com\./,
    );
    await userEvent.click(link);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link a Google folder to MKX" })).toBeNull(),
    );
    const group = await waitFor(() => {
      const g = [...document.querySelectorAll<HTMLElement>("[data-drive-folder]")].find((el) =>
        el.textContent?.includes("Cantina Bellavista – materiali"),
      );
      expect(g).toBeDefined();
      return g!;
    });
    await waitFor(() => expect(group.querySelectorAll("[data-drive-row]")).toHaveLength(3));
    expect(
      state.driveFiles.filter((f) => f.projectId === "prj-mkx" && f.folderLinkId?.startsWith("fl-") && f.addedById === "p-giulia").length,
    ).toBeGreaterThanOrEqual(3);
    await act(whenDriveIdle);
  });

  it("le cartelle già collegate sono disattivate con «Already linked»; la ricerca trova per nome", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(within(await moreDriveActions()).getByRole("menuitem", { name: "Link a Google folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Link a Google folder to MKX" });
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search folders" }), "primavera");
    const option = await within(dialog).findByRole("option", { name: /MKX – Campagna primavera/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent("Already linked");
    await userEvent.clear(within(dialog).getByRole("searchbox", { name: "Search folders" }));
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search folders" }), "zzz");
    expect(await within(dialog).findByText("No folders match “zzz”")).toBeInTheDocument();
  });

  it("senza account Google il dialogo parte da «Connect your Google account first»", async () => {
    state.googleAccounts = state.googleAccounts.filter((a) => a.personId !== "p-roberta");
    await openDrive("/p/UFF/drive", "p-roberta");
    await userEvent.click(within(await moreDriveActions()).getByRole("menuitem", { name: "Link a Google folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Link a Google folder to UFF" });
    expect(within(dialog).getByText("Connect your Google account first")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect Google account" }));
    // Collegato, il dialogo prosegue da solo: il navigatore (il Drive di Roberta è vuoto).
    expect(await within(dialog).findByRole("navigation", { name: "Folder path" })).toBeInTheDocument();
    expect(within(dialog).getByText("This folder is empty")).toBeInTheDocument();
    expect(within(dialog).queryByText("Connect your Google account first")).toBeNull();
  });

  it("chi non gestisce il Drive non vede «Link a Google folder» né «Unlink»", async () => {
    await openDrive("/p/AUD/drive", "p-marco");
    await screen.findByRole("grid");
    expect(screen.queryByRole("button", { name: "More Drive actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions for AUD – Cliente" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Unlink/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Sync now" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Open in Google Drive" })).toBeInTheDocument();
  });

  it("scollegare conta i file che escono e avvisa che le aperture si perdono", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: "Actions for AUD – Cliente" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Unlink folder…" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink “AUD – Cliente” from AUD?" });
    expect(dialog).toHaveTextContent(/Its \d+ files leave AUD, with their opens/);
    expect(dialog).toHaveTextContent("Nothing changes on Google.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(row("AUD-F7")).toBeNull());
    expect(state.folderLinks.some((l) => l.id === "fl-aud-cliente")).toBe(false);
    expect(row("AUD-F2")).not.toBeNull();
  });
});

describe("Nascondere", () => {
  it("nascosto + «Sync now» non lo rimette; il filtro Hidden lo mostra e «Show again» lo riporta col suo conteggio", async () => {
    const opens = state.driveOpens.filter((o) => o.fileId === "drv-aud-7").length;
    const router = await openDrive("/p/AUD/drive?file=AUD-F7");
    const panel = await screen.findByLabelText("File AUD-F7");
    await userEvent.click(await within(panel).findByRole("button", { name: "Hide from project" }));
    await waitFor(() => expect(row("AUD-F7")).toBeNull());
    expect(await screen.findByText("AUD-F7 hidden from the project")).toBeInTheDocument();
    // Risincronizzare la cartella non lo rimette.
    await userEvent.click(screen.getByRole("button", { name: "Actions for AUD – Cliente" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Sync now" }));
    await act(whenDriveIdle);
    await screen.findByText("Synced AUD – Cliente");
    expect(row("AUD-F7")).toBeNull();
    // Il filtro Hidden, solo per chi gestisce, col conteggio (AUD-F8 era già nascosto).
    const chip = screen.getByRole("button", { name: /Hidden files: 2/ });
    await userEvent.click(chip);
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).hidden).toBe("1"));
    await waitFor(() => expect(row("AUD-F7")).not.toBeNull());
    expect(row("AUD-F2")).toBeNull();
    expect(row("AUD-F7")).toHaveTextContent(/Hidden by Laura Costa/);
    await userEvent.click(within(row("AUD-F7")!).getByRole("button", { name: "Show AUD-F7 again" }));
    await waitFor(() => expect(row("AUD-F7")).toBeNull());
    const file = state.driveFiles.find((f) => f.id === "drv-aud-7")!;
    expect(file.hidden).toBe(false);
    expect(file.code).toBe("AUD-F7");
    expect(state.driveOpens.filter((o) => o.fileId === "drv-aud-7").length).toBe(opens);
  });

  it("chi non gestisce non ha il filtro Hidden, e `?hidden=1` non mostra niente di nascosto", async () => {
    await openDrive("/p/AUD/drive?hidden=1", "p-marco");
    await screen.findByRole("grid");
    expect(screen.queryByRole("button", { name: /Hidden files/ })).toBeNull();
    expect(row("AUD-F8")).toBeNull();
    expect(row("AUD-F7")).not.toBeNull();
  });
});

describe("Non disponibile e collegamento scaduto", () => {
  it("chi ha collegato la cartella scaduta vede la fascia con «Reconnect»", async () => {
    await openDrive("/p/STW/drive");
    const banner = await screen.findByRole("region", { name: "Folder link expired" });
    expect(banner).toHaveTextContent(/The link to “STW – Brand assets” expired on/);
    await userEvent.click(within(banner).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Folder link expired" })).toBeNull());
    expect(state.folderLinks.find((l) => l.id === "fl-stw-brand")!.status).toBe("ok");
  });

  it("un altro gestore: «Ask Laura Costa to reconnect» (DM precompilato) e la conseguenza di scollegare", async () => {
    const router = await openDrive("/p/STW/drive", "p-roberta");
    const banner = await screen.findByRole("region", { name: "Folder link expired" });
    expect(banner).toHaveTextContent(/Only Laura Costa can reconnect it/);
    expect(banner).toHaveTextContent(/resets its files' codes and opens/);
    expect(within(banner).queryByRole("button", { name: "Reconnect" })).toBeNull();
    await userEvent.click(within(banner).getByRole("button", { name: "Ask Laura Costa to reconnect" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/chat\//));
    const channelId = router.state.location.pathname.split("/").at(-1)!;
    expect(readDraft("p-roberta", channelId)).toMatch(/STW – Brand assets/);
  });

  it("chi non gestisce non vede la fascia: il gruppo dice «Not updating since»", async () => {
    await openDrive("/p/STW/drive", "p-marco");
    await screen.findByRole("grid");
    expect(screen.queryByRole("region", { name: "Folder link expired" })).toBeNull();
    expect(screen.getByText(/Not updating since/)).toBeInTheDocument();
  });

  it("il dettaglio di un file non disponibile dice la causa in parole", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F11");
    const panel = await screen.findByLabelText("File AUD-F11");
    expect(await within(panel).findByText("Deleted on Google")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Remove from project" })).toBeInTheDocument();
  });
});

describe("Add from Google Drive", () => {
  it("selezione multipla, già nel progetto disattivati, «Add 2 files»", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: "Add from Google Drive" }));
    const dialog = await screen.findByRole("dialog", { name: "Add from Google Drive to MKX" });
    const list = within(dialog).getByRole("listbox", { name: "Your Google Drive files" });
    expect(list).toHaveAttribute("aria-multiselectable", "true");
    const options = await within(list).findAllByRole("option");
    const already = options.filter((o) => o.getAttribute("aria-disabled") === "true");
    expect(already.length).toBeGreaterThan(0);
    expect(already[0]).toHaveTextContent("Already in MKX");
    const free = options.filter((o) => o.getAttribute("aria-disabled") !== "true").slice(0, 2);
    for (const o of free) await userEvent.click(o);
    expect(within(dialog).getByText("Everyone in MKX will be able to read these files.")).toBeInTheDocument();
    const before = state.driveFiles.filter((f) => f.projectId === "prj-mkx").length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 2 files" }));
    await waitFor(() =>
      expect(state.driveFiles.filter((f) => f.projectId === "prj-mkx").length).toBe(before + 2),
    );
    await act(whenDriveIdle);
  });
});

describe("«Which project?»", () => {
  const outside = { googleFileId: "gfile-out-bellavista-offer", name: "Offerta Cantina Bellavista – bozza" };

  it("con progetti idonei: si apre su Google, poi chiede il progetto; «Add to project» crea il riferimento", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    act(() => openGoogleOutsideFile(outside));
    expect(await screen.findByText(/Opened in Google Drive/)).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "Add “Offerta Cantina Bellavista – bozza” to a project?" });
    expect(within(dialog).getByText("Everyone in the project will be able to read it.")).toBeInTheDocument();
    const list = within(dialog).getByRole("listbox", { name: "Projects" });
    // Solo i progetti dove ho `drive.upload`; i fissati in testa.
    expect(within(list).getAllByRole("option")[0]).toHaveTextContent("MKX");
    await userEvent.click(within(list).getByRole("option", { name: /^AUD/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add to project" }));
    expect(await screen.findByText(/Added to AUD as AUD-F\d+/)).toBeInTheDocument();
    expect(
      state.driveFiles.some((f) => f.projectId === "prj-aud" && f.googleFileId === outside.googleFileId),
    ).toBe(true);
    await act(whenDriveIdle);
  });

  it("«Not now» chiude senza collegare", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    act(() => openGoogleOutsideFile(outside));
    const dialog = await screen.findByRole("dialog", { name: /to a project\?/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /to a project\?/ })).toBeNull());
    expect(state.driveFiles.some((f) => f.googleFileId === outside.googleFileId)).toBe(false);
  });

  it("senza progetti idonei il dialogo non compare: l'avviso dice che si è aperto e perché non si chiede", async () => {
    for (const p of PROJECTS) revokeProjectPermission("p-sara", p.id, "drive.upload");
    await openDrive("/p/STW/drive", "p-sara");
    act(() => openGoogleOutsideFile(outside));
    expect(
      await screen.findByText(/Opened in Google Drive.*You can't add files to any of your projects/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /to a project\?/ })).toBeNull();
  });
});

describe("Account Google", () => {
  it("dal menu profilo: collegato, scollegare conta le cartelle che smettono di aggiornarsi", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Google account" }));
    const dialog = await screen.findByRole("dialog", { name: "Google account" });
    expect(dialog).toHaveTextContent("Connected as giulia.ferri@example.com");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(dialog).toHaveTextContent(/1 folder you linked will stop updating: MKX – Campagna primavera/);
    expect(dialog).toHaveTextContent(/Only you can reconnect/);
    // L'account è uno solo (area 9a): la conferma dice che spariscono anche Posta e Calendario.
    expect(
      within(dialog).getByRole("group", { name: "Disconnect" }),
    ).toHaveTextContent("Mail and Calendar will stop showing giulia.ferri@example.com too.");
    // La nota generica non si ripete sotto la conseguenza.
    expect(dialog).not.toHaveTextContent("Mail and Calendar will use the same account.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect account" }));
    expect(await within(dialog).findByRole("button", { name: "Connect Google account" })).toBeInTheDocument();
    expect(state.googleAccounts.some((a) => a.personId === "p-giulia")).toBe(false);
  });

  it("scaduto: la data e «Reconnect»", async () => {
    await openDrive("/p/STW/drive", "p-laura");
    await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Google account" }));
    const dialog = await screen.findByRole("dialog", { name: "Google account" });
    expect(dialog).toHaveTextContent(/Your Google connection expired on/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    expect(await within(dialog).findByText("Connected as laura.costa@example.com")).toBeInTheDocument();
  });

  it("senza account, la ricerca invita a collegarlo", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ViewerProvider initialPersonId="p-marco">
          <GoogleConnectInvite />
        </ViewerProvider>
      </QueryClientProvider>,
    );
    const invite = await screen.findByText(
      "Connect your Google account to also search files in your Google Drive",
    );
    expect(invite).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(state.googleAccounts.some((a) => a.personId === "p-marco")).toBe(true));
  });
});

describe("Review Focus 3: cambio di persona con un dialogo aperto", () => {
  it("il dialogo di collegamento si chiude, e niente dell'account di prima resta a schermo", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(within(await moreDriveActions()).getByRole("menuitem", { name: "Link a Google folder" }));
    await screen.findByRole("dialog", { name: "Link a Google folder to MKX" });
    await switchPersona(/Laura Costa/);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link a Google folder to MKX" })).toBeNull(),
    );
    expect(screen.queryByText(/giulia\.ferri@example\.com/)).toBeNull();
  });

  it("«Which project?» e la scheda account si chiudono", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    act(() => openGoogleOutsideFile(outside()));
    await screen.findByRole("dialog", { name: /to a project\?/ });
    await switchPersona(/Marco Bellini/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /to a project\?/ })).toBeNull());

    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Google account" }));
    await screen.findByRole("dialog", { name: "Google account" });
    await switchPersona(/Giulia Ferri/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Google account" })).toBeNull());
  });

  function outside() {
    return { googleFileId: "gfile-out-bellavista-offer", name: "Offerta Cantina Bellavista – bozza" };
  }
});

describe("Fix round 1", () => {
  async function openPalette() {
    await userEvent.keyboard("{Control>}k{/Control}");
    return screen.findByRole("dialog", { name: "Search and commands" });
  }

  it("⌘K «Link a Google folder to AUD»: porta al Drive del progetto e apre il dialogo", async () => {
    const router = renderRoute("/p/AUD/tasks", "p-laura");
    await screen.findByRole("heading", { level: 1 });
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("combobox"), "link a google");
    const option = await within(palette).findByRole("option", { name: /Link a Google folder to AUD/ });
    await userEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/drive"));
    expect(await screen.findByRole("dialog", { name: "Link a Google folder to AUD" })).toBeInTheDocument();
  });

  it("⌘K: il comando non c'è senza `drive.manage`, né fuori da un progetto", async () => {
    renderRoute("/p/AUD/tasks", "p-marco");
    await screen.findByRole("heading", { level: 1 });
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("combobox"), "link a google");
    await within(palette).findByRole("option", { name: /Ask Claude/ });
    expect(within(palette).queryByRole("option", { name: /Link a Google folder/ })).toBeNull();
  });

  it("⌘K: fuori da un progetto il comando non c'è", async () => {
    renderRoute("/home", "p-laura");
    await screen.findByRole("heading", { level: 1 });
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("combobox"), "link a google");
    await within(palette).findByRole("option", { name: /Ask Claude/ });
    expect(within(palette).queryByRole("option", { name: /Link a Google folder/ })).toBeNull();
  });

  it("il «⋯» della riga nasconde, con «Undo» per riportarlo", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await userEvent.click(within(row("AUD-F7")!).getByRole("button", { name: "More actions for AUD-F7" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Hide from project" }));
    await waitFor(() => expect(row("AUD-F7")).toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(row("AUD-F7")).not.toBeNull());
    // Un file caricato non si nasconde: niente «⋯».
    expect(within(row("AUD-F2")!).queryByRole("button", { name: "More actions for AUD-F2" })).toBeNull();
  });

  it("chi non gestisce non ha il «⋯» della riga", async () => {
    await openDrive("/p/AUD/drive", "p-marco");
    await screen.findByRole("grid");
    expect(within(row("AUD-F7")!).queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("la fascia dice la causa: dopo uno scollegamento i file sono non disponibili, non «quello che aveva letto»", async () => {
    setSessionPersonId("p-giulia");
    await disconnectGoogle();
    await openDrive("/p/MKX/drive", "p-roberta");
    const banner = await screen.findByRole("region", { name: "Folder link expired" });
    expect(banner).toHaveTextContent(/Giulia Ferri's Google account was disconnected/);
    expect(banner).toHaveTextContent(/show as not available/);
    expect(banner).not.toHaveTextContent(/what Stubwise read until then/);
  });

  it("il numero di chi leggerà segue la regola del Drive: anche i full admin impliciti", async () => {
    const readers = PEOPLE.filter(
      (p) => !p.isClaude && visibleProjectIds(p.id).has("prj-mkx"),
    ).length;
    const members = PROJECTS.find((p) => p.code === "MKX")!.memberIds.filter(
      (id) => !PEOPLE.find((p) => p.id === id)?.isClaude,
    ).length;
    expect(readers).toBeGreaterThan(members);
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(within(await moreDriveActions()).getByRole("menuitem", { name: "Link a Google folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Link a Google folder to MKX" });
    await userEvent.dblClick(await within(dialog).findByRole("option", { name: /^Clienti/ }));
    await userEvent.click(within(dialog).getByRole("option", { name: /Cantina Bellavista/ }));
    expect(within(dialog).getByRole("button", { name: "Link folder" })).toHaveAccessibleDescription(
      new RegExp(`Everyone in MKX \\(${readers} people\\)`),
    );
  });

  it("i selettori tengono sempre un posto nella tastiera, anche quando la scelta esce dalla ricerca", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(within(await moreDriveActions()).getByRole("menuitem", { name: "Link a Google folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Link a Google folder to MKX" });
    await userEvent.dblClick(await within(dialog).findByRole("option", { name: /^Clienti/ }));
    await userEvent.click(within(dialog).getByRole("option", { name: /Cantina Bellavista/ }));
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search folders" }), "brand");
    const options = await within(dialog).findAllByRole("option");
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Link a Google folder/ })).toBeNull());

    // «Which project?»: scelto MKX, poi una ricerca che lo esclude.
    act(() =>
      openGoogleOutsideFile({ googleFileId: "gfile-out-bellavista-offer", name: "Offerta" }),
    );
    const which = await screen.findByRole("dialog", { name: /to a project\?/ });
    await userEvent.click(within(which).getByRole("option", { name: /^MKX/ }));
    await userEvent.type(within(which).getByRole("searchbox", { name: "Search projects" }), "audin");
    const projects = within(which).getAllByRole("option");
    expect(projects.some((o) => o.textContent?.startsWith("MKX"))).toBe(false);
    expect(projects.filter((o) => o.tabIndex === 0)).toHaveLength(1);
  });

  it("«Clear filters» non conta `?hidden=1` per chi non gestisce", async () => {
    await openDrive("/p/AUD/drive?hidden=1", "p-marco");
    await screen.findByRole("grid");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("cambio di persona con «Add from Google Drive» aperto: si chiude", async () => {
    await openDrive("/p/MKX/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: "Add from Google Drive" }));
    await screen.findByRole("dialog", { name: "Add from Google Drive to MKX" });
    await switchPersona(/Laura Costa/);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add from Google Drive to MKX" })).toBeNull(),
    );
  });
});
