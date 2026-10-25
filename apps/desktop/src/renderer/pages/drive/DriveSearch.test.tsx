import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { closePreview } from "./FilePreview";
import { closeWhichProject } from "./WhichProjectDialog";

// La ricerca nei file (Task 8, shape drive-search.md): nel Drive e da ⌘K.
// Review Focus 1: chi non vede il progetto non trova il file, nemmeno per
// contenuto. Mostrare un risultato non conta un'apertura, aprirlo sì.

const opensOf = (fileId: string) => state.driveOpens.filter((o) => o.fileId === fileId).length;
const result = (code: string) =>
  document.querySelector<HTMLElement>(`[data-drive-result="${code}"]`);
const location = (router: ReturnType<typeof renderRoute>) => router.state.location;

async function openDrive(url: string, personId = "p-laura") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: "Drive" });
  return router;
}

async function searchFor(q: string) {
  const user = userEvent.setup();
  const field = screen.getByRole("searchbox", { name: "Search files" });
  await user.clear(field);
  await user.type(field, q);
  return user;
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Search and commands" });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  closePreview();
  act(() => closeWhichProject());
});

describe("Ricerca nel Drive", () => {
  it("per contenuto: i risultati prendono il posto dell'elenco, con riassunto e passaggio evidenziato; mostrarli non conta", async () => {
    const router = await openDrive("/p/AUD/drive");
    await screen.findByRole("grid", { name: /Files of Audin/ });
    const before = opensOf("drv-aud-7");
    await searchFor("penalty");
    await waitFor(() => expect(result("AUD-F7")).toBeTruthy());
    expect(screen.queryByRole("grid")).toBeNull();
    expect(location(router).search).toMatchObject({ q: "penalty" });
    expect(await screen.findByText(/1 file matches “penalty”/)).toBeInTheDocument();
    expect(screen.getByText(/Sorted by relevance/)).toBeInTheDocument();
    const hit = result("AUD-F7")!;
    expect(hit).toHaveAccessibleName(/AUD-F7, Contratto quadro Audin 2025, Google document, AUD\. Summary: .+ Matched: .*penalty.* 23 opens in the last 90 days/);
    expect(hit.querySelector("[data-drive-passage] mark")).toHaveTextContent("penalty");
    // Il menu dell'ordinamento sparisce: l'ordine è la pertinenza.
    expect(screen.queryByRole("button", { name: /Sort/ })).toBeNull();
    expect(opensOf("drv-aud-7")).toBe(before);
  });

  it("Enter apre il file e conta; ⌥Enter apre solo il dettaglio e non conta", async () => {
    const router = await openDrive("/p/AUD/drive");
    const user = await searchFor("penalty");
    await waitFor(() => expect(result("AUD-F7")).toBeTruthy());
    const before = opensOf("drv-aud-7");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(result("AUD-F7")).toHaveFocus());
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    await waitFor(() => expect(location(router).search).toMatchObject({ file: "AUD-F7" }));
    expect(opensOf("drv-aud-7")).toBe(before);
    result("AUD-F7")!.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(opensOf("drv-aud-7")).toBe(before + 1));
    expect(await screen.findByText(/Opened in Google Drive/)).toBeInTheDocument();
  });

  it("per nome: «Matched the name»; non disponibile si trova solo per nome e lo dice", async () => {
    await openDrive("/p/AUD/drive");
    await searchFor("Requisiti integrazione");
    await waitFor(() => expect(result("AUD-F11")).toBeTruthy());
    expect(result("AUD-F11")).toHaveTextContent("Not available · found by name");
    await searchFor("contacts sync");
    expect(await screen.findByText("No files match “contacts sync”")).toBeInTheDocument();
    expect(screen.getByText("Try other words: search looks inside files too.")).toBeInTheDocument();
    await searchFor("Contratto quadro");
    await waitFor(() => expect(result("AUD-F7")).toHaveTextContent("Matched the name"));
  });

  it("Review Focus 1: chi non vede AUD non trova il contratto, né per contenuto né per codice", async () => {
    await openDrive("/drive", "p-sara");
    await searchFor("penalty");
    expect(await screen.findByText("No files match “penalty”")).toBeInTheDocument();
    await searchFor("AUD-F7");
    expect(await screen.findByText("No files match “AUD-F7”")).toBeInTheDocument();
    expect(result("AUD-F7")).toBeNull();
  });

  it("Esc svuota e riporta l'elenco; i filtri restano", async () => {
    const router = await openDrive("/p/AUD/drive?type=pdf");
    const user = await searchFor("audin");
    await waitFor(() => expect(document.querySelector("[data-drive-result]")).toBeTruthy());
    const codes = [...document.querySelectorAll<HTMLElement>("[data-drive-result]")].map(
      (el) => el.dataset.driveResult,
    );
    expect(codes.every((c) => ["AUD-F1", "AUD-F2", "AUD-F15"].includes(c!))).toBe(true);
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("grid", { name: /Files of Audin/ })).toBeInTheDocument();
    expect(location(router).search).toMatchObject({ type: "pdf" });
    expect(location(router).search).not.toHaveProperty("q");
  });

  it("i file del proprio Google Drive in coda, senza codice; «Open» chiede il progetto", async () => {
    await openDrive("/drive", "p-giulia");
    await searchFor("wine club");
    const group = await screen.findByRole("region", { name: "In your Google Drive" });
    expect(group).toHaveTextContent("Not in a project yet. Only you can see these results.");
    const row = group.querySelector<HTMLElement>('[data-drive-outside="gfile-out-bellavista-offer"]')!;
    expect(row).toHaveTextContent("Offerta Cantina Bellavista – bozza");
    expect(row).not.toHaveTextContent(/[A-Z]{2,4}-F\d+/);
    await userEvent.click(row);
    expect(
      await screen.findByRole("dialog", { name: /Offerta Cantina Bellavista – bozza.*to a project\?/ }),
    ).toBeInTheDocument();
  });

  it("senza account Google: niente gruppo, l'invito a collegarlo resta sotto", async () => {
    await openDrive("/drive", "p-marco");
    await searchFor("wine club");
    expect(
      await screen.findByText("Connect your Google account to also search files in your Google Drive"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "In your Google Drive" })).toBeNull();
  });
});

describe("⌘K: il gruppo Files", () => {
  it("dopo Pages e prima di People/Channels/Messages/Actions; Enter apre e conta", async () => {
    const user = userEvent.setup();
    await openDrive("/p/AUD/drive");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "penalty");
    const files = await within(dialog).findByRole("group", { name: "Files" });
    const option = within(files).getByRole("option", { name: /AUD-F7 Contratto quadro Audin 2025/ });
    expect(option.querySelector("mark")).toHaveTextContent("penalty");
    const order = within(dialog)
      .getAllByRole("group")
      .map((g) => g.querySelector(".heading-group")?.textContent);
    const at = (name: string) => order.indexOf(name);
    expect(at("Files")).toBeGreaterThanOrEqual(0);
    for (const later of ["People", "Channels", "Messages", "Actions", "More"]) {
      if (at(later) >= 0) expect(at("Files")).toBeLessThan(at(later));
    }
    expect(within(dialog).getByRole("option", { name: "Search all files for “penalty”" })).toBeInTheDocument();
    const before = opensOf("drv-aud-7");
    while (option.getAttribute("aria-selected") !== "true") await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(opensOf("drv-aud-7")).toBe(before + 1));
    expect(screen.queryByRole("dialog", { name: "Search and commands" })).toBeNull();
  });

  it("⌥Enter apre il dettaglio senza contare; «Search all files» porta al Drive con la query", async () => {
    const user = userEvent.setup();
    const router = await openDrive("/p/AUD/drive");
    let dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "penalty");
    const files = await within(dialog).findByRole("group", { name: "Files" });
    const option = within(files).getByRole("option", { name: /AUD-F7/ });
    const before = opensOf("drv-aud-7");
    while (option.getAttribute("aria-selected") !== "true") await user.keyboard("{ArrowDown}");
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    await waitFor(() => expect(location(router).search).toMatchObject({ file: "AUD-F7" }));
    expect(opensOf("drv-aud-7")).toBe(before);

    dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "penalty");
    const all = await within(dialog).findByRole("option", { name: "Search all files for “penalty”" });
    while (all.getAttribute("aria-selected") !== "true") await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(location(router).pathname).toBe("/drive"));
    expect(location(router).search).toMatchObject({ q: "penalty" });
    expect(await screen.findByRole("searchbox", { name: "Search files" })).toHaveValue("penalty");
    await waitFor(() => expect(result("AUD-F7")).toBeTruthy());
  });

  it("Review Focus 1: chi non vede AUD non ha il contratto fra i File", async () => {
    const user = userEvent.setup();
    await openDrive("/drive", "p-sara");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "penalty");
    expect(await within(dialog).findByText("No results for “penalty”")).toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "Files" })).toBeNull();
  });

  it("un file che si chiama come un comando: Enter esegue ancora il comando", async () => {
    state.driveFiles.find((f) => f.id === "drv-aud-2")!.name = "New task checklist.pdf";
    const user = userEvent.setup();
    const router = await openDrive("/p/AUD/drive");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "new task");
    const files = await within(dialog).findByRole("group", { name: "Files" });
    expect(within(files).getByRole("option", { name: /New task checklist/ })).toBeInTheDocument();
    await within(dialog).findByRole("option", { name: /^New task$/, selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(String(location(router).search.newTask)).toBe("1"));
  });
});

describe("Ricerca nel Drive — fix round 1", () => {
  /** Toglie un file dallo stato senza ricaricare i risultati: è sparito fra la ricerca e il clic. */
  const vanish = (id: string) => {
    const at = state.driveFiles.findIndex((f) => f.id === id);
    state.driveFiles.splice(at, 1);
  };

  it("un risultato sparito prima del clic: l'avviso, nessuna apertura, si resta sui risultati", async () => {
    const router = await openDrive("/p/AUD/drive");
    await searchFor("penalty");
    await waitFor(() => expect(result("AUD-F7")).toBeTruthy());
    const before = state.driveOpens.length;
    vanish("drv-aud-7");
    await userEvent.click(result("AUD-F7")!);
    expect(await screen.findByText("This file is no longer available")).toBeInTheDocument();
    expect(state.driveOpens.length).toBe(before);
    expect(location(router).search).not.toHaveProperty("file");
    expect(location(router).search).toMatchObject({ q: "penalty" });
  });

  it("⌘K: un file sparito prima di Invio dà lo stesso avviso e non conta", async () => {
    const user = userEvent.setup();
    await openDrive("/p/AUD/drive");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "penalty");
    const files = await within(dialog).findByRole("group", { name: "Files" });
    const option = within(files).getByRole("option", { name: /AUD-F7/ });
    const before = state.driveOpens.length;
    vanish("drv-aud-7");
    while (option.getAttribute("aria-selected") !== "true") await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("This file is no longer available")).toBeInTheDocument();
    expect(state.driveOpens.length).toBe(before);
  });

  it("⌘K: un file non disponibile o in lettura dice il suo stato come nel Drive", async () => {
    const user = userEvent.setup();
    await openDrive("/p/AUD/drive");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "Requisiti integrazione");
    const files = await within(dialog).findByRole("group", { name: "Files" });
    expect(within(files).getByRole("option", { name: /AUD-F11/ })).toHaveTextContent(
      "Not available · found by name",
    );
    // Il seme ha già finito di leggerlo: lo si rimette in lettura.
    state.driveFiles.find((f) => f.id === "drv-aud-14")!.content = "processing";
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "Calendario consegne");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /AUD-F14/ })).toHaveTextContent(
        "Reading the content… found by name",
      ),
    );
  });

  it("cambiare persona svuota la ricerca: niente query nell'indirizzo, niente risultati di prima", async () => {
    const router = await openDrive("/drive?q=penalty");
    await waitFor(() => expect(result("AUD-F7")).toBeTruthy());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name: /Marco Bellini/ }));
    await waitFor(() => expect(location(router).search).not.toHaveProperty("q"));
    expect(await screen.findByRole("searchbox", { name: "Search files" })).toHaveValue("");
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(document.querySelector("[data-drive-results]")).toBeNull();
  });

  it("«nessun file» sta nella regione annunciata; coi risultati di prima resta la loro query", async () => {
    await openDrive("/p/AUD/drive");
    await searchFor("zzqx");
    const status = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-drive-results] [role=status]");
      expect(el).toHaveTextContent("No files match “zzqx”");
      return el!;
    });
    expect(status).toBeInTheDocument();
    await searchFor("penalty");
    await waitFor(() => expect(result("AUD-F7")).toBeTruthy());
    setLatency(400);
    const field = screen.getByRole("searchbox", { name: "Search files" });
    await userEvent.type(field, " week");
    await act(() => new Promise((r) => setTimeout(r, 260)));
    const live = document.querySelector("[data-drive-results] [role=status]")!;
    expect(live).toHaveTextContent("1 file matches “penalty”");
    expect(live).not.toHaveTextContent("penalty week");
    await waitFor(() => expect(live).toHaveTextContent("1 file matches “penalty week”"), {
      timeout: 2000,
    });
  });
});
