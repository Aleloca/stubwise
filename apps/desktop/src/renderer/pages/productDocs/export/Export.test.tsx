import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import * as docx from "./docx";

// Esportare in PDF e Word (area 11a, Task 12; shape product-space.md §3.8):
// «Export ▾» nella barra della pagina (e sull'indice, con il solo WHOLE
// SPACE), «Preparing…» spento ma col fuoco, gli esiti (salvato, annullato
// senza avviso, «Couldn't export · Retry»), il PDF con la vista di stampa
// montata solo durante la chiamata, e il `preview:web` senza `window.stubwise`.

vi.mock("./docx", async (original) => {
  const real = await original<typeof import("./docx")>();
  return { ...real, buildDocx: vi.fn(real.buildDocx) };
});

const LAURA = "p-laura";
const SARA = "p-sara";
const codeOf = (title: string) => state.productPages.find((p) => p.projectId === "prj-acq" && p.title === title)!.code;
const printRoot = () => document.getElementById("print-root");

type Save = (req: StubwiseSaveFileRequest) => Promise<StubwiseSaveFileResult>;
let saveFile: ReturnType<typeof vi.fn<Save>>;

function withBridge(impl: Save = async () => ({ saved: true })) {
  saveFile = vi.fn<Save>(impl);
  window.stubwise = { platform: "darwin", saveFile };
}

async function openPage(title: string, person = LAURA) {
  renderRoute(`/p/ACQ/docs/product/${codeOf(title)}`, person);
  await screen.findByRole("heading", { level: 1, name: title });
  return screen.findByRole("button", { name: /^Export/ });
}

async function choose(group: "This page" | "Whole space", item: "PDF" | "Word (.docx)") {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Export/ }));
  const menu = await screen.findByRole("menu", { name: "Export" });
  await user.click(within(within(menu).getByRole("group", { name: group })).getByRole("menuitem", { name: item }));
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  vi.mocked(docx.buildDocx).mockClear();
});
afterEach(() => {
  delete window.stubwise;
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

describe("il menu", () => {
  it("sulla pagina: THIS PAGE e WHOLE SPACE × PDF / Word, «9 pages, in tree order», «Comments aren't included.»", async () => {
    withBridge();
    const button = await openPage("Sign-in");
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.setup().click(button);
    const menu = await screen.findByRole("menu", { name: "Export" });
    for (const group of ["This page", "Whole space"]) {
      const items = within(within(menu).getByRole("group", { name: group })).getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual(expect.arrayContaining(["PDF", "Word (.docx)"]));
    }
    expect(menu).toHaveTextContent("9 pages, in tree order");
    expect(menu).toHaveTextContent("Comments aren't included.");
    // Esc chiude e il fuoco torna su «Export ▾».
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Export" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("sull'indice dello spazio: solo WHOLE SPACE", async () => {
    withBridge();
    renderRoute("/p/ACQ/docs/product", LAURA);
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Export/ }));
    const menu = await screen.findByRole("menu", { name: "Export" });
    expect(within(menu).queryByRole("group", { name: "This page" })).toBeNull();
    expect(within(menu).getByRole("group", { name: "Whole space" })).toBeInTheDocument();
  });
});

describe("con la finestra di salvataggio (window.stubwise.saveFile)", () => {
  it("PDF di Sign-in: una chiamata col nome, #print-root pieno durante e vuoto dopo; «Saved the PDF»; il fuoco su Export", async () => {
    const during: { text: string; printing: boolean }[] = [];
    withBridge(async () => {
      during.push({ text: printRoot()?.textContent ?? "", printing: document.body.dataset.printing !== undefined });
      return { saved: true };
    });
    await openPage("Sign-in");
    await choose("This page", "PDF");
    await screen.findByText("Saved the PDF");
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith({ format: "pdf", name: `${codeOf("Sign-in")} Sign-in` });
    expect(during[0]!.printing).toBe(true);
    expect(during[0]!.text).toContain("Sign-in");
    expect(during[0]!.text).toContain("Customers sign in with their Google account.");
    expect(printRoot()?.textContent ?? "").toBe("");
    expect(document.body.dataset.printing).toBeUndefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Export/ }));
  });

  it("la vista di stampa di Overview: <strong>, <em> e <a> con l'https del seme; nessun commento", async () => {
    let html = "";
    withBridge(async () => {
      html = printRoot()!.innerHTML;
      const root = printRoot()!;
      expect(root.querySelector("strong")).toHaveTextContent("pay their bills");
      expect(root.querySelector("em")).toHaveTextContent("service charter");
      expect(root.querySelector("a")).toHaveAttribute("href", "https://www.acquedottocolline.example/carta-dei-servizi");
      expect(root).toHaveTextContent("File: Client brief.pdf (ACQ-F1)");
      return { saved: true };
    });
    await openPage("Overview");
    await choose("This page", "PDF");
    await screen.findByText("Saved the PDF");
    expect(html).not.toBe("");
    const comments = state.productComments.map((c) => c.body.toLowerCase());
    for (const c of comments) expect(html.toLowerCase()).not.toContain(c);
  });

  it("Word dello spazio: format docx, byte Uint8Array di uno zip, nome «ACQ Product» («ACQ Prodotto» in italiano)", async () => {
    withBridge();
    await openPage("Sign-in");
    await choose("Whole space", "Word (.docx)");
    await screen.findByText("Saved the Word file");
    const req = saveFile.mock.calls[0]![0];
    expect(req).toMatchObject({ format: "docx", name: "ACQ Product" });
    const data = (req as { data: Uint8Array }).data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect([data[0], data[1]]).toEqual([0x50, 0x4b]);

    act(() => setLanguage("it"));
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Esporta/ }));
    const menu = await screen.findByRole("menu", { name: "Esporta" });
    await userEvent
      .setup()
      .click(within(within(menu).getByRole("group", { name: "Tutto lo spazio" })).getByRole("menuitem", { name: "Word (.docx)" }));
    await screen.findByText("File Word salvato");
    expect(saveFile.mock.calls[1]![0]).toMatchObject({ format: "docx", name: "ACQ Prodotto" });
  });

  it("una WebP resta fuori dal Word e l'avviso lo dice", async () => {
    const screens = state.productPages.find((p) => p.title === "Screens")!;
    screens.blocks = [...screens.blocks, { id: "blk-webp", type: "image", src: "data:image/webp;base64,UklGRg==", caption: "WebP", alt: "" }];
    withBridge();
    await openPage("Screens");
    await choose("This page", "Word (.docx)");
    await screen.findByText("Saved the Word file. 1 image was left out (WebP).");
  });

  it("finestra annullata: nessun avviso", async () => {
    withBridge(async () => ({ saved: false, reason: "canceled" }));
    await openPage("Sign-in");
    await choose("This page", "PDF");
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Export/ })).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Saved the/)).toBeNull();
  });

  it("failed: «Couldn't export · Retry», e Retry rifà la stessa chiamata", async () => {
    withBridge(async () => ({ saved: false, reason: "failed" }));
    await openPage("Sign-in");
    await choose("This page", "PDF");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't export");
    // Durante il Retry (il suo bottone è già sparito) il fuoco è su «Preparing…», non sul body.
    let focusDuring: Element | null = null;
    saveFile.mockImplementation(async () => {
      focusDuring = document.activeElement;
      return { saved: true };
    });
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Saved the PDF");
    expect(focusDuring).toBe(screen.getByRole("button", { name: /^Export/ }));
    expect(saveFile.mock.calls).toEqual([
      [{ format: "pdf", name: `${codeOf("Sign-in")} Sign-in` }],
      [{ format: "pdf", name: `${codeOf("Sign-in")} Sign-in` }],
    ]);
    // Il fuoco non è finito sul body quando il Retry è sparito.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Export/ }));
  });

  it("il Word che non si costruisce (P37): «Couldn't export · Retry», e Retry ricostruisce", async () => {
    withBridge();
    vi.mocked(docx.buildDocx).mockRejectedValueOnce(new Error("boom"));
    await openPage("Sign-in");
    await choose("This page", "Word (.docx)");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't export");
    expect(saveFile).not.toHaveBeenCalled();
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Saved the Word file");
    expect(docx.buildDocx).toHaveBeenCalledTimes(2);
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("in corso: «Preparing…» spento ma col fuoco; un secondo clic non fa una seconda esportazione", async () => {
    let finish: (r: StubwiseSaveFileResult) => void = () => {};
    withBridge(() => new Promise((r) => (finish = r)));
    await openPage("Sign-in");
    await choose("This page", "PDF");
    const busy = await screen.findByRole("button", { name: /Preparing…/ });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(busy);
    // Un clic (e un doppio clic) sul bottone spento non apre il menu.
    await userEvent.setup().click(busy);
    expect(screen.queryByRole("menu", { name: "Export" })).toBeNull();
    await userEvent.setup().dblClick(busy);
    expect(screen.queryByRole("menu", { name: "Export" })).toBeNull();
    expect(saveFile).toHaveBeenCalledTimes(1);
    await act(async () => finish({ saved: true }));
    await screen.findByText("Saved the PDF");
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("come Sara, col file nascosto: nel PDF «File: ACQ-F1 (not available)», nessun nome del file né titolo di AUD-8", async () => {
    state.driveFiles.find((f) => f.id === "drv-acq-1")!.hidden = true;
    const texts: string[] = [];
    withBridge(async () => {
      texts.push((printRoot()?.textContent ?? "").toLowerCase());
      return { saved: true };
    });
    await openPage("Overview", SARA);
    await choose("Whole space", "PDF");
    await screen.findByText("Saved the PDF");
    const text = texts[0]!;
    expect(text).toContain("file: acq-f1 (not available)");
    expect(text).not.toContain("client brief.pdf");
    expect(text).toContain("aud-8");
    expect(text).not.toContain(state.tasks.find((t) => t.code === "AUD-8")!.title.toLowerCase());
  });
});

describe("senza window.stubwise (preview:web)", () => {
  it("il PDF apre la stampa del browser con la vista montata; nessun avviso", async () => {
    let during = "";
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      during = printRoot()?.textContent ?? "";
    });
    await openPage("Sign-in");
    await choose("This page", "PDF");
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(during).toContain("Customers sign in with their Google account.");
    await waitFor(() => expect(printRoot()?.textContent ?? "").toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("il Word si scarica come file .docx", async () => {
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await openPage("Sign-in");
    await choose("This page", "Word (.docx)");
    await screen.findByText("Saved the Word file");
    expect(names).toEqual([`${codeOf("Sign-in")} Sign-in.docx`]);
  });
});
