import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { notifyInstanceChange, state } from "../../data/store";
import type { DriveFile } from "../../data/types";
import { resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { readDraft } from "../chat/drafts";
import { forgetAllBlobs } from "./blobs";
import { closePreview } from "./FilePreview";
import { UPLOAD_PACE } from "./UploadZone";

const MB = 1024 * 1024;
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, unknown>;
const opensOf = (fileId: string, personId?: string) =>
  state.driveOpens.filter((o) => o.fileId === fileId && (!personId || o.personId === personId))
    .length;
const row = (code: string) =>
  document.querySelector<HTMLElement>(`[data-drive-row="${code}"]`);

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

async function openDrive(url: string, personId = "p-laura") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: "Drive" });
  return router;
}

/** Un file finto (caricato) per i volumi della Review Focus 5. */
function fake(n: number, over: Partial<DriveFile> = {}): DriveFile {
  return {
    id: `drv-uff-${n}`,
    code: `UFF-F${n}`,
    projectId: "prj-uff",
    source: "upload",
    name: `Pratica ${String(n).padStart(3, "0")}.pdf`,
    type: "pdf",
    mime: "application/pdf",
    sizeBytes: 200_000 + n,
    addedById: "p-roberta",
    addedAt: "2026-09-01T10:00:00Z",
    modifiedAt: "2026-09-01T10:00:00Z",
    folderLinkId: null,
    googleFileId: null,
    googleOwner: null,
    hidden: false,
    unavailable: null,
    content: "ready",
    text: "Testo",
    summary: `Summary of file ${n}.`,
    ocr: false,
    ...over,
  };
}

function pick(files: File[]) {
  const input = document.querySelector<HTMLInputElement>("[data-drive-file-input]")!;
  return userEvent.upload(input, files);
}

function sized(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  UPLOAD_PACE.ms = 0;
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  try {
    window.localStorage.clear();
  } catch {
    // niente storage: i gruppi partono aperti comunque
  }
});
afterEach(() => {
  resetViewerGrants();
  closePreview();
  forgetAllBlobs();
});

describe("Drive del progetto — elenco", () => {
  it("testata, cartella in testa coi primi 5 e «Show N more», poi i file sciolti; il più usato in alto", async () => {
    await openDrive("/p/AUD/drive");
    const grid = await screen.findByRole("grid", { name: /Files of Audin/ });
    const folder = within(grid).getByRole("button", { name: "AUD – Cliente" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(grid).toHaveTextContent(/Google folder · \d+ files · linked by Matteo Conti/);
    const folderGroup = grid.querySelector("[data-drive-folder]")!;
    expect(folderGroup.querySelectorAll("[data-drive-row]")).toHaveLength(5);
    // Il contratto è il file più usato: prima riga della cartella, col numero e il nome accessibile.
    const first = folderGroup.querySelector<HTMLElement>("[data-drive-row]")!;
    expect(first.dataset.driveRow).toBe("AUD-F7");
    expect(first).toHaveAccessibleName(
      /AUD-F7, Contratto quadro Audin 2025, Google document, added by Matteo Conti, 23 opens in the last 90 days/,
    );
    const more = within(grid).getByRole("button", { name: /Show \d+ more in AUD – Cliente/ });
    await userEvent.click(more);
    expect(folderGroup.querySelectorAll("[data-drive-row]").length).toBeGreaterThan(5);
    // I file sciolti sotto FILES, ordinati per aperture.
    const loose = grid.querySelector("[data-drive-loose]")!;
    expect(loose).toHaveTextContent("Files");
    expect(loose.querySelector<HTMLElement>("[data-drive-row]")!.dataset.driveRow).toBe("AUD-F2");
    // Chiudere il gruppo lo ricorda.
    await userEvent.click(folder);
    expect(folderGroup.querySelectorAll("[data-drive-row]")).toHaveLength(0);
  });

  it("stati del contenuto sulla seconda linea, in parole; non disponibile con la causa", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: /Show \d+ more/ }));
    expect(row("AUD-F4")).toHaveTextContent("This format can't be searched by content");
    expect(row("AUD-F11")).toHaveTextContent("Not available · Deleted on Google");
    expect(row("AUD-F15")).toHaveTextContent("Not available · Stubwise lost access");
    // Un nascosto non c'è per nessuno nell'elenco (il filtro Hidden è di Task 7).
    expect(row("AUD-F8")).toBeNull();
  });

  it("filtri e ordinamento nell'indirizzo, «Clear filters»", async () => {
    const router = await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: "Type" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "PDF" }));
    await waitFor(() => expect(search(router).type).toBe("pdf"));
    await waitFor(() => expect(row("AUD-F3")).toBeNull());
    expect(row("AUD-F2")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Sort:/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    await waitFor(() => expect(search(router).sort).toBe("name"));
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(search(router).type).toBeUndefined());
    expect(search(router).sort).toBe("name");
  });

  it("l'indirizzo riapre la stessa vista; un valore malformato si scarta", async () => {
    const router = await openDrive("/p/AUD/drive?source=google&sort=bogus");
    await screen.findByRole("grid");
    expect(search(router).sort).toBeUndefined();
    expect(row("AUD-F7")).not.toBeNull();
    expect(row("AUD-F2")).toBeNull();
  });

  it("nessun risultato dai filtri: lo dice, con «Clear filters»", async () => {
    await openDrive("/p/AUD/drive?type=slides&source=upload");
    expect(await screen.findByText("No files match these filters")).toBeInTheDocument();
  });

  it("errore di caricamento con Retry", async () => {
    failNext("drive.listDriveFiles");
    await openDrive("/p/AUD/drive");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the files");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("grid")).toBeInTheDocument();
  });

  it("vuoto: con drive.upload invita a caricare; senza dice chi lo farà", async () => {
    await openDrive("/p/UFF/drive", "p-roberta");
    expect(await screen.findByText("No files in UFF yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload a file" })).toBeInTheDocument();
    expect(screen.getByText("or drop files anywhere on this page")).toBeInTheDocument();
  });

  it("senza drive.upload niente «Upload»", async () => {
    revokeProjectPermission("p-marco", "prj-aud", "drive.upload" as never);
    await openDrive("/p/AUD/drive", "p-marco");
    await screen.findByRole("grid");
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });
});

describe("Drive — dettaglio e aperture", () => {
  it("clic su una riga apre il dettaglio; la miniatura non conta, l'anteprima intera sì, e riaprirla subito no", async () => {
    const router = await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    const before = opensOf("drv-aud-2", "p-laura");
    await userEvent.click(within(row("AUD-F2")!).getByText(/Specifiche funzionali dialer v3/));
    await waitFor(() => expect(search(router).file).toBe("AUD-F2"));
    const panel = await screen.findByRole("region", { name: "File AUD-F2" }).catch(() =>
      screen.findByLabelText("File AUD-F2"),
    );
    expect(await within(panel).findByText(/Written by Claude/)).toBeInTheDocument();
    expect(within(panel).getByText("Preview not available in this prototype session")).toBeInTheDocument();
    expect(opensOf("drv-aud-2", "p-laura")).toBe(before);

    await userEvent.click(within(panel).getAllByRole("button", { name: "Open" })[0]!);
    const preview = await screen.findByRole("dialog", { name: "Preview of AUD-F2" });
    await waitFor(() => expect(opensOf("drv-aud-2", "p-laura")).toBe(before + 1));
    await userEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog", { name: "Preview of AUD-F2" })).toBeNull();
    await userEvent.click(within(panel).getAllByRole("button", { name: "Open" })[0]!);
    await screen.findByRole("dialog", { name: "Preview of AUD-F2" });
    // Entro 30′: la stessa persona conta una volta.
    await act(async () => {});
    expect(opensOf("drv-aud-2", "p-laura")).toBe(before + 1);
  });

  it("Space sulla riga apre l'anteprima (Quick Look); Esc la chiude e torna alla riga", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    row("AUD-F2")!.focus();
    await userEvent.keyboard(" ");
    expect(await screen.findByRole("dialog", { name: "Preview of AUD-F2" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Preview/ })).toBeNull());
  });

  it("un file Google si apre su Google: avviso del prototipo, l'apertura conta", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F7");
    const panel = await screen.findByLabelText("File AUD-F7");
    const before = opensOf("drv-aud-7", "p-laura");
    await userEvent.click(await within(panel).findByRole("button", { name: /Open in Google Drive/ }));
    expect(await screen.findByText(/Opened in Google Drive/)).toBeInTheDocument();
    await waitFor(() => expect(opensOf("drv-aud-7", "p-laura")).toBe(before + 1));
  });

  it("aperture: il numero per tutti, lo storico solo con drive.history", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F7");
    const panel = await screen.findByLabelText("File AUD-F7");
    expect(await within(panel).findByText(/23 in the last 90 days · 29 in total/)).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Who opened it" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Show all 29" })).toBeInTheDocument();
  });

  it("azioni secondo il permesso: Marco (Developer) non nasconde né elimina i file degli altri", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F7", "p-marco");
    const panel = await screen.findByLabelText("File AUD-F7");
    await within(panel).findByText(/in total/);
    expect(within(panel).queryByRole("heading", { name: "Who opened it" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Hide from project" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Remove from project" })).toBeNull();
  });

  it("Laura (Project Lead) nasconde un file di cartella ed elimina un caricato, con conferma", async () => {
    const router = await openDrive("/p/AUD/drive?file=AUD-F7");
    let panel = await screen.findByLabelText("File AUD-F7");
    await userEvent.click(await within(panel).findByRole("button", { name: "Hide from project" }));
    expect(await screen.findByText("AUD-F7 hidden from the project")).toBeInTheDocument();
    await waitFor(() => expect(search(router).file).toBeUndefined());
    await waitFor(() => expect(row("AUD-F7")).toBeNull());

    await act(async () => {
      await router.navigate({ to: ".", search: { file: "AUD-F3" } as never });
    });
    panel = await screen.findByLabelText("File AUD-F3");
    await userEvent.click(await within(panel).findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete AUD-F3?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("AUD-F3 deleted")).toBeInTheDocument();
    expect(state.driveFiles.some((f) => f.id === "drv-aud-3")).toBe(false);
  });

  it("un codice che chi guarda non vede risponde come uno inesistente (R-G5)", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F8", "p-marco");
    const panel = await screen.findByLabelText("File AUD-F8");
    expect(await within(panel).findByText("This file doesn't exist or you can't see it")).toBeInTheDocument();
  });
});

describe("Drive — Review Focus 3: cambio di persona col dettaglio e l'anteprima aperti", () => {
  it("si chiudono, e dello storico di prima non resta nulla", async () => {
    const router = await openDrive("/p/AUD/drive?file=AUD-F2");
    const panel = await screen.findByLabelText("File AUD-F2");
    expect(await within(panel).findByRole("heading", { name: "Who opened it" })).toBeInTheDocument();
    await userEvent.click(within(panel).getAllByRole("button", { name: "Open" })[0]!);
    await screen.findByRole("dialog", { name: "Preview of AUD-F2" });

    await switchPersona(/Marco/);
    await waitFor(() => expect(search(router).file).toBeUndefined());
    expect(screen.queryByRole("dialog", { name: /Preview/ })).toBeNull();
    expect(screen.queryByLabelText("File AUD-F2")).toBeNull();
    expect(screen.queryByText("Who opened it")).toBeNull();
    // Marco riapre lo stesso file: il pannello è suo, senza storico.
    await act(async () => {
      await router.navigate({ to: ".", search: { file: "AUD-F2" } as never });
    });
    const again = await screen.findByLabelText("File AUD-F2");
    await within(again).findByText(/in total/);
    expect(within(again).queryByRole("heading", { name: "Who opened it" })).toBeNull();
  });
});

describe("Drive — Review Focus 5: volumi e casi limite", () => {
  it("500 file, un nome di 255 caratteri, un riassunto mancante: righe intere, niente che trabocca", async () => {
    const long = `${"Verbale assemblea straordinaria dei soci con allegati ".repeat(5)}`.slice(0, 251) + ".pdf";
    expect(long).toHaveLength(255);
    state.driveFiles.push(
      ...Array.from({ length: 498 }, (_, i) => fake(i + 1)),
      fake(499, { name: long }),
      fake(500, { summary: null }),
    );
    // Tempo di CPU del processo, non d'orologio: quello d'orologio misurava
    // anche quanto la macchina era carica (10–15 s con la suite intera in
    // corsa e altro lavoro, contro ~1 s da solo), non quanto costa l'elenco.
    const started = process.cpuUsage();
    await openDrive("/p/UFF/drive", "p-roberta");
    const grid = await screen.findByRole("grid");
    const { user, system } = process.cpuUsage(started);
    const elapsed = (user + system) / 1000;
    expect(grid.querySelectorAll("[data-drive-row]")).toHaveLength(500);
    // Lo tiene il nome intero nel `title` (l'ellissi è a metà, l'estensione resta).
    const longRow = row("UFF-F499")!;
    expect(within(longRow).getByTitle(long)).toBeInTheDocument();
    expect(longRow).toHaveTextContent(".pdf");
    expect(row("UFF-F500")).toHaveTextContent("No summary for this file");
    // Misura (happy-dom, nessun layout): resta un elenco che si apre in fretta.
    expect(elapsed).toBeLessThan(5000);
  });

  it("caricare: 101 MB non parte, un nome uguale tiene entrambi, un file nuovo prende il suo codice", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await pick([
      sized("Video demo.mp4", "video/mp4", 101 * MB),
      sized("Specifiche funzionali dialer v3.pdf", "application/pdf", 2 * MB),
    ]);
    const uploading = await screen.findByRole("region", { name: "Uploading" });
    expect(uploading).toHaveTextContent("Too large: 101 MB, the limit is 100 MB");
    // L'avviso e l'annuncio `polite` per i lettori di schermo.
    expect(
      await screen.findAllByText("Kept both: the new one is “Specifiche funzionali dialer v3 (2).pdf”"),
    ).toHaveLength(2);
    const added = state.driveFiles.find((f) => f.name === "Specifiche funzionali dialer v3 (2).pdf")!;
    expect(added.addedById).toBe("p-laura");
    expect(state.driveFiles.some((f) => f.name === "Video demo.mp4")).toBe(false);
    await waitFor(() => expect(row(added.code)).not.toBeNull());
    await userEvent.click(within(uploading).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Uploading" })).toBeNull();
  });

  it("un caricamento fallito si riprova", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    failNext("drive.uploadFiles");
    await pick([sized("note-riunione.txt", "text/plain", 1200)]);
    const uploading = await screen.findByRole("region", { name: "Uploading" });
    expect(await within(uploading).findByText("Upload failed")).toBeInTheDocument();
    await userEvent.click(within(uploading).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(state.driveFiles.some((f) => f.name === "note-riunione.txt")).toBe(true),
    );
  });
});

describe("Drive — la destinazione", () => {
  it("dopo Calendar sul binario; una riga per riferimento con la colonna del progetto e la colonna personale", async () => {
    const router = await openDrive("/drive", "p-giulia");
    const rail = screen.getByRole("link", { name: "Calendar" });
    const drive = screen.getByRole("link", { name: "Drive" });
    expect(rail.compareDocumentPosition(drive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(drive).not.toHaveAccessibleDescription();
    const grid = await screen.findByRole("grid", { name: "Files of your projects" });
    expect(within(grid).queryByRole("button", { name: "AUD – Cliente" })).toBeNull();
    // Lo stesso file Google in due progetti: due righe, due codici.
    expect(row("AUD-F5")).not.toBeNull();
    expect(row("STW-F1")).not.toBeNull();
    expect(row("AUD-F7")).toHaveTextContent("in AUD – Cliente");
    const column = screen.getByRole("navigation", { name: "Drive views" });
    await userEvent.click(within(column).getByRole("link", { name: /MKX/ }));
    await waitFor(() => expect(search(router).prj).toBe("MKX"));
    await waitFor(() => expect(row("AUD-F7")).toBeNull());
  });

  it("«Upload» chiede prima il progetto (solo quelli con drive.upload)", async () => {
    await openDrive("/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    const menu = await screen.findByRole("menu", { name: "Upload to which project?" });
    expect(within(menu).getByRole("menuitem", { name: /AUD/ })).toBeInTheDocument();
  });
});

describe("Drive — fix round 1", () => {
  it("J/K dal dettaglio sovrapposto (1024) scorrono i file della vista", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const router = await openDrive("/p/AUD/drive?file=AUD-F7");
    const panel = await screen.findByRole("dialog", { name: "File AUD-F7" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    await within(panel).findByText(/in total/);
    await userEvent.keyboard("j");
    await waitFor(() => expect(search(router).file).toBe("AUD-F9"));
    await userEvent.keyboard("k");
    await waitFor(() => expect(search(router).file).toBe("AUD-F7"));
  });

  it("«Cite in Chat» apre «Share to…» col general del progetto preselezionato; il codice va nella bozza", async () => {
    const router = await openDrive("/p/AUD/drive?file=AUD-F7");
    const panel = await screen.findByLabelText("File AUD-F7");
    await userEvent.click(await within(panel).findByRole("button", { name: "Cite in Chat" }));
    const dialog = await screen.findByRole("dialog", { name: "Share to…" });
    const general = within(dialog).getByRole("radio", { name: "AUD · general" });
    expect(general).toBeChecked();
    // Si può scegliere un altro canale in cui si scrive.
    expect(within(dialog).getAllByRole("radio").length).toBeGreaterThan(1);
    const channelId = (general as HTMLInputElement).value;
    await userEvent.click(within(dialog).getByRole("button", { name: "Open in channel" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/AUD/chat/${channelId}`),
    );
    expect(readDraft("p-laura", channelId)).toContain("AUD-F7");
    // Come una scelta dal menu «#»: il messaggio registra la citazione del
    // file col suo codice (R-H5), non solo il testo.
    const box = await screen.findByRole("combobox", { name: /^Message .*general/ });
    await waitFor(() => expect(box).toHaveValue("AUD-F7 "));
    box.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(state.chatMessages.find((m) => m.channelId === channelId && m.text === "AUD-F7"))
        .toBeTruthy(),
    );
    const sent = state.chatMessages.find((m) => m.channelId === channelId && m.text === "AUD-F7")!;
    expect(sent.citations).toEqual([{ kind: "drive", id: "drv-aud-7", code: "AUD-F7" }]);
  });

  it("nessun canale in cui scrivere: «Cite in Chat» non c'è", async () => {
    for (const c of state.channels) c.archived = true;
    await openDrive("/p/AUD/drive?file=AUD-F7");
    const panel = await screen.findByLabelText("File AUD-F7");
    await within(panel).findByText(/in total/);
    // Il menu «⋯» resta (Copy link); l'azione no, né lì né fra i bottoni.
    expect(within(panel).queryByRole("button", { name: "Cite in Chat" })).toBeNull();
  });

  it("lo scheletro ha 8 righe con la forma della riga del Drive", async () => {
    setLatency(400);
    renderRoute("/p/AUD/drive", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "Drive" });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-drive-skeleton-row]")).toHaveLength(8),
    );
    expect(document.querySelector("[data-drive-skeleton-row]")).toHaveClass("h-14");
  });

  it("le azioni rapide stanno nella colonna delle aperture, che resta anche a 1024", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    const download = within(row("AUD-F2")!).getByRole("button", { name: "Download AUD-F2" });
    expect(download.closest('[role="gridcell"]')!.querySelector("[data-opens]")).not.toBeNull();
  });

  it("la zona di rilascio copre la pagina intera, testata compresa", async () => {
    await openDrive("/p/AUD/drive");
    const h1 = screen.getByRole("heading", { level: 1, name: "Drive" });
    expect(h1.closest("[data-drop-zone]")).not.toBeNull();
  });

  it("nella destinazione un rilascio chiede sempre il progetto, anche col filtro (A5)", async () => {
    await openDrive("/drive?prj=AUD", "p-giulia");
    await screen.findByRole("grid");
    const file = sized("brief.pdf", "application/pdf", 1000);
    fireEvent.drop(document.querySelector("[data-drop-zone]")!, {
      dataTransfer: { types: ["Files"], files: [file] },
    });
    const dialog = await screen.findByRole("dialog", { name: "Upload to which project?" });
    // Il progetto filtrato è il primo (e prende il fuoco).
    const first = within(dialog).getAllByRole("button")[0]!;
    expect(first).toHaveTextContent("AUD");
    expect(state.driveFiles.some((f) => f.name === "brief.pdf")).toBe(false);
  });

  it("l'anteprima aperta dal dettaglio scorre (←/→) i file della vista", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F2");
    const panel = await screen.findByLabelText("File AUD-F2");
    await userEvent.click((await within(panel).findAllByRole("button", { name: "Open" }))[0]!);
    await screen.findByRole("dialog", { name: "Preview of AUD-F2" });
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("dialog", { name: "Preview of AUD-F3" })).toBeInTheDocument();
  });

  it("chiudendo l'anteprima sopra un dettaglio sovrapposto il fuoco torna nel pannello", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    await openDrive("/p/AUD/drive?file=AUD-F2");
    const panel = await screen.findByRole("dialog", { name: "File AUD-F2" });
    const open = (await within(panel).findAllByRole("button", { name: "Open" }))[0]!;
    await userEvent.click(open);
    await screen.findByRole("dialog", { name: "Preview of AUD-F2" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("dialog", { name: "File AUD-F2" })).toBeInTheDocument();
  });

  it("un'immagine ingrandita: le frecce non cambiano file", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await pick([sized("schema.png", "image/png", 2000)]);
    const added = await waitFor(() => {
      const f = state.driveFiles.find((x) => x.name === "schema.png");
      expect(f).toBeDefined();
      return f!;
    });
    await waitFor(() => expect(row(added.code)).not.toBeNull());
    row(added.code)!.focus();
    await userEvent.keyboard(" ");
    const preview = await screen.findByRole("dialog", { name: `Preview of ${added.code}` });
    await userEvent.click(within(preview).getByRole("button", { name: "Zoom to actual size" }));
    await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: `Preview of ${added.code}` })).toBeInTheDocument();
  });

  it("il gruppo UPLOADING sta fuori dalla griglia", async () => {
    UPLOAD_PACE.ms = 60_000;
    await openDrive("/p/AUD/drive");
    const grid = await screen.findByRole("grid");
    await pick([sized("lento.pdf", "application/pdf", 5 * MB)]);
    const uploading = await screen.findByRole("region", { name: "Uploading" });
    expect(grid.contains(uploading)).toBe(false);
    await userEvent.click(within(uploading).getByRole("button", { name: "Cancel" }));
  });

  it("il gettone «Added by» non mostra mai un id grezzo", async () => {
    await openDrive("/p/AUD/drive?addedBy=p-nessuno");
    await screen.findByText("No files match these filters");
    const toolbar = screen.getByRole("toolbar", { name: "File commands" });
    expect(toolbar).not.toHaveTextContent("p-nessuno");
    expect(toolbar).toHaveTextContent("someone");
  });

  it("Space su un file Google non disponibile dice perché", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: /Show \d+ more/ }));
    row("AUD-F11")!.focus();
    await userEvent.keyboard(" ");
    expect(
      await screen.findByText("AUD-F11 can't be opened: it was deleted on Google."),
    ).toBeInTheDocument();
  });

  it("negativo: un progetto senza drive.upload non è nel menu di Upload della destinazione", async () => {
    revokeProjectPermission("p-giulia", "prj-mkx", "drive.upload" as never);
    await openDrive("/drive", "p-giulia");
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    const menu = await screen.findByRole("menu", { name: "Upload to which project?" });
    expect(within(menu).getByRole("menuitem", { name: /AUD/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /MKX/ })).toBeNull();
  });

  it("Marco (senza drive.manage) elimina il suo caricato, non quello di un altro", async () => {
    const r = await openDrive("/p/AUD/drive?file=AUD-F2", "p-marco");
    let panel = await screen.findByLabelText("File AUD-F2");
    expect(await within(panel).findByRole("button", { name: "Delete" })).toBeInTheDocument();
    await act(async () => {
      await r.navigate({ to: ".", search: { file: "AUD-F3" } as never });
    });
    panel = await screen.findByLabelText("File AUD-F3");
    await within(panel).findByText(/in total/);
    expect(within(panel).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("il download conta un'apertura", async () => {
    await openDrive("/p/AUD/drive?file=AUD-F4");
    const panel = await screen.findByLabelText("File AUD-F4");
    const before = opensOf("drv-aud-4", "p-laura");
    await userEvent.click(await within(panel).findByRole("button", { name: "Download" }));
    await waitFor(() => expect(opensOf("drv-aud-4", "p-laura")).toBe(before + 1));
    expect(state.driveOpens.at(-1)!.via).toBe("download");
  });

  it("un PDF di 99 MB si carica", async () => {
    await openDrive("/p/AUD/drive");
    await screen.findByRole("grid");
    await pick([sized("Rilievi cantiere.pdf", "application/pdf", 99 * MB)]);
    await waitFor(() =>
      expect(state.driveFiles.some((f) => f.name === "Rilievi cantiere.pdf")).toBe(true),
    );
    expect(screen.queryByText(/Too large/)).toBeNull();
  });
});

describe("Drive con i caricamenti spenti (area 9b, shape instance-effects §3)", () => {
  it("«Upload» spento con la frase e «Who?»; «Add from Google Drive» resta acceso; riaccesi, torna", async () => {
    state.instance.storage.attachmentsEnabled = false;
    await openDrive("/p/AUD/drive", "p-laura");
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-ai-block="storage_off"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(line).toHaveTextContent(
      "Uploads are off on this instance. Files already here stay readable. Who?",
    );
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add from Google Drive/ })).toBeEnabled();

    state.instance.storage.attachmentsEnabled = true;
    act(() => notifyInstanceChange());
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled());
    expect(document.querySelector('[data-ai-block="storage_off"]')).toBeNull();
  });
});
