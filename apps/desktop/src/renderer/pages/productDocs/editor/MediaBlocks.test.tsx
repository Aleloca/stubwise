import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import type { ProductBlock, ProductBlockOp, ProductPage, RichText } from "../../../data/types";
import { failNext, state } from "../../../data/store";
import { plain } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { formatDate } from "../../../notifications/time";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { placeCaret } from "./domRange";

// I blocchi del design e dei collegamenti (area 11a, Task 9; shape
// product-editor.md §3.6–§3.10): immagini, file del Drive, decisioni del
// registro, codici («Link to…») e tabelle. Laura (Project Lead di ACQ)
// scrive, Sara (Contributor) legge soltanto.

const LAURA = "p-laura";
const SARA = "p-sara";

const pageOf = (title: string) => state.productPages.find((p) => p.projectId === "prj-acq" && p.title === title)!;

async function open(title: string, person = LAURA) {
  renderRoute(`/p/ACQ/docs/product/${pageOf(title).code}`, person);
  await screen.findByRole("heading", { level: 1, name: title });
}

const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
const shellOf = (id: string) => body().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const editing = () => document.querySelector<HTMLElement>("[data-editing]")!;
const textbox = (text: string) =>
  within(body())
    .getAllByRole("textbox")
    .find((el) => el.textContent === text)!;

async function enter(text: string, at: number) {
  const user = userEvent.setup();
  await user.click(textbox(text));
  await waitFor(() => expect(editing()).toHaveTextContent(text));
  act(() => placeCaret(editing(), at));
  return editing();
}
function input(el: HTMLElement, inputType: string, data: string | null = null) {
  act(() => {
    el.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }));
  });
}
const press = (el: HTMLElement, key: string, mods: Partial<Record<"metaKey" | "shiftKey" | "altKey", boolean>> = {}) =>
  act(() => {
    fireEvent.keyDown(el, { key, ...mods });
  });

/** Un blocco vuoto al posto dell'ultimo paragrafo di Sign-in, per il menu «/». */
const SIGNIN_LAST = "blk-acq-signin-4";
function emptySignInBlock() {
  const page = pageOf("Sign-in");
  page.blocks = page.blocks.map((b) =>
    b.id === SIGNIN_LAST ? ({ id: SIGNIN_LAST, type: "paragraph", content: plain("") } as ProductBlock) : b,
  );
}
/** «/» e il filtro nel blocco vuoto, poi Invio: la voce scelta. */
async function slash(query: string) {
  emptySignInBlock();
  await open("Sign-in");
  const user = userEvent.setup();
  await user.click(textbox(""));
  input(editing(), "insertText", "/");
  const menu = await screen.findByRole("listbox", { name: "Blocks" });
  input(editing(), "insertText", query);
  await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
  press(editing(), "Enter");
}

const png = (n = 10 * 1024, name = "login.png") => new File([new Uint8Array(n)], name, { type: "image/png" });
/** Un `paste` con dei file negli appunti (e nessun testo). */
function pasteFiles(el: HTMLElement, files: File[]) {
  act(() => {
    fireEvent.paste(el, { clipboardData: { files, getData: () => "", types: ["Files"] } });
  });
}

let saves: MockInstance<typeof api.productDocs.saveProductBlocks>;
const savedOps = () => saves.mock.calls.map((c) => c[1] as ProductBlockOp[]);
const lastSet = () => {
  const ops = savedOps().at(-1)!;
  expect(ops).toHaveLength(1);
  return (ops[0] as Extract<ProductBlockOp, { op: "set" }>).block;
};

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  saves = vi.spyOn(api.productDocs, "saveProductBlocks");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  act(() => setLanguage("en"));
});

// --- il menu «/» -------------------------------------------------------------

describe("il menu «/» offre ogni voce (P17)", () => {
  it("INSERT ha Table, Image, Drive file, Link to… e Decision", async () => {
    emptySignInBlock();
    await open("Sign-in");
    const user = userEvent.setup();
    await user.click(textbox(""));
    input(editing(), "insertText", "/");
    const menu = await screen.findByRole("listbox", { name: "Blocks" });
    const insert = within(menu).getByRole("group", { name: "Insert" });
    expect(within(insert).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Table",
      "Image",
      "Drive file",
      "Link to…",
      "Decision",
    ]);
  });
});

// --- immagini ----------------------------------------------------------------

const SCREENS_INTRO = "The two main screens, as they look in the first release.";

describe("immagini ([PE 9])", () => {
  it("incollare un'immagine in Screens: un blocco dopo quello col fuoco, «Add a caption»; scritta e uscita, un set", async () => {
    await open("Screens");
    const introId = pageOf("Screens").blocks[0]!.id;
    const el = await enter(SCREENS_INTRO, 5);
    pasteFiles(el, [png()]);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const [op] = savedOps()[0]!;
    expect(op).toMatchObject({ op: "insert", afterId: introId, block: { type: "image", caption: "", alt: "login" } });
    const image = (op as Extract<ProductBlockOp, { op: "insert" }>).block as Extract<ProductBlock, { type: "image" }>;
    expect(image.src.startsWith("data:image/png")).toBe(true);
    const shell = await waitFor(() => {
      const s = shellOf(image.id);
      expect(s).not.toBeNull();
      return s;
    });
    expect(shell.querySelector("img")).toHaveAttribute("src", image.src);
    const caption = within(shell).getByRole("textbox", { name: "Caption" });
    expect(caption).toHaveAttribute("placeholder", "Add a caption");
    expect(caption).toHaveValue("");
    // Il fuoco resta nel blocco dove si è incollato (mai sul body).
    expect(document.activeElement).not.toBe(document.body);

    const user = userEvent.setup();
    await user.click(caption);
    await user.type(caption, "Login screen");
    act(() => caption.blur());
    // Un secondo blur senza cambi non scrive di nuovo.
    act(() => caption.blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(lastSet()).toMatchObject({ id: image.id, type: "image", caption: "Login screen", src: image.src });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(saves).toHaveBeenCalledTimes(2);
  });

  it("un'immagine di 6 MB: «This image is larger than 5 MB», nessun blocco; Dismiss riporta il fuoco nel blocco", async () => {
    await open("Screens");
    const el = await enter(SCREENS_INTRO, 5);
    pasteFiles(el, [png(6 * 1024 * 1024, "huge.png")]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This image is larger than 5 MB");
    expect(saves).not.toHaveBeenCalled();
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest("[data-editor-body]")).not.toBeNull();
  });

  it("il rifiuto in italiano, composto in lettura: «Questa immagine supera i 5 MB»; un PDF: «Solo immagini PNG, JPEG, GIF e WebP»", async () => {
    await open("Screens");
    const el = await enter(SCREENS_INTRO, 5);
    pasteFiles(el, [png(6 * 1024 * 1024, "huge.png")]);
    await screen.findByRole("alert");
    act(() => setLanguage("it"));
    expect(screen.getByRole("alert")).toHaveTextContent("Questa immagine supera i 5 MB");
    pasteFiles(editing(), [new File(["x"], "brief.pdf", { type: "application/pdf" })]);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Solo immagini PNG, JPEG, GIF e WebP"));
    expect(saves).not.toHaveBeenCalled();
  });

  it("trascinare un file sopra un blocco: la nota «Drop to add the image»; rilasciato, l'immagine va dopo quel blocco", async () => {
    await open("Screens");
    const target = pageOf("Screens").blocks[1]!.id; // il titolo «Sign-in»
    const file = png();
    const dataTransfer = { files: [file], types: ["Files"], dropEffect: "none" };
    const inner = shellOf(target).querySelector<HTMLElement>("h3")!;
    act(() => {
      fireEvent.dragOver(inner, { dataTransfer });
    });
    expect(body()).toHaveTextContent("Drop to add the image");
    expect(shellOf(target).querySelector('[data-drop-line="bottom"]')).not.toBeNull();
    act(() => {
      fireEvent.drop(inner, { dataTransfer });
    });
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(savedOps()[0]).toMatchObject([{ op: "insert", afterId: target, block: { type: "image" } }]);
    expect(body()).not.toHaveTextContent("Drop to add the image");
  });

  it("«/image» apre la scelta del file; il file scelto prende il posto del blocco vuoto", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await slash("image");
    await waitFor(() => expect(click).toHaveBeenCalled());
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(chooser.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    act(() => {
      fireEvent.change(chooser, { target: { files: [png()] } });
    });
    await waitFor(() => expect(lastSet()).toMatchObject({ id: SIGNIN_LAST, type: "image", caption: "" }));
  });

  it("la didascalia di un'immagine del seme si cambia e si salva (il livello dati accetta la sua immagine)", async () => {
    const first = pageOf("Screens").blocks.find((b) => b.type === "image") as Extract<ProductBlock, { type: "image" }>;
    await open("Screens");
    const caption = within(shellOf(first.id)).getByRole("textbox", { name: "Caption" });
    expect(caption).toHaveValue(first.caption);
    const user = userEvent.setup();
    await user.clear(caption);
    await user.type(caption, "Sign-in");
    act(() => caption.blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    await expect(saves.mock.results[0]!.value).resolves.toBeTruthy();
    expect(pageOf("Screens").blocks.find((b) => b.id === first.id)).toMatchObject({ caption: "Sign-in" });
  });

  it("Sara legge un'immagine con didascalia; una didascalia vuota non occupa spazio", async () => {
    const screens = pageOf("Screens");
    const [first, second] = screens.blocks.filter((b) => b.type === "image") as Extract<ProductBlock, { type: "image" }>[];
    second!.caption = "";
    await open("Screens", SARA);
    const one = shellOf(first!.id);
    expect(one.querySelector("img")).toHaveAttribute("alt", first!.alt);
    expect(one.querySelector("figcaption")).toHaveTextContent(first!.caption);
    expect(within(one).queryByRole("textbox")).toBeNull();
    expect(shellOf(second!.id).querySelector("figcaption")).toBeNull();
  });
});

// --- file del Drive ----------------------------------------------------------

describe("file del Drive ([PE 10])", () => {
  const driveBlock = () => pageOf("Overview").blocks.find((b) => b.type === "drive") as Extract<ProductBlock, { type: "drive" }>;

  it("il blocco di Overview: «Client brief.pdf» e ACQ-F1; «Open» apre l'anteprima", async () => {
    await open("Overview");
    const shell = shellOf(driveBlock().id);
    await waitFor(() => expect(shell).toHaveTextContent("Client brief.pdf"));
    expect(shell).toHaveTextContent(/Client brief\.pdf\s*ACQ-F1/);
    await userEvent.setup().click(within(shell).getByRole("button", { name: "Open Client brief.pdf" }));
    expect(await screen.findByRole("dialog", { name: "Preview of ACQ-F1" })).toBeInTheDocument();
  });

  it("nascosto nel Drive: «This file is no longer available», il solo codice, nessun nome né «Open» (R-G5)", async () => {
    state.driveFiles.find((f) => f.code === "ACQ-F1")!.hidden = true;
    await open("Overview");
    const shell = shellOf(driveBlock().id);
    await waitFor(() => expect(shell).toHaveTextContent("This file is no longer available"));
    expect(shell).toHaveTextContent("ACQ-F1");
    expect(shell.textContent!.toLowerCase()).not.toContain("client brief");
    expect(shell.innerHTML.toLowerCase()).not.toContain("client brief");
    expect(within(shell).queryByRole("button", { name: /open/i })).toBeNull();
  });

  it("anche per chi legge (Sara): la stessa riga, «Open» compreso", async () => {
    await open("Overview", SARA);
    const shell = shellOf(driveBlock().id);
    await waitFor(() => expect(shell).toHaveTextContent("Client brief.pdf"));
    expect(within(shell).getByRole("button", { name: "Open Client brief.pdf" })).toBeInTheDocument();
  });

  it("«/drive»: il selettore del Drive di ACQ; Invio sceglie il file, che prende il posto del blocco", async () => {
    await slash("drive");
    const field = await screen.findByRole("combobox", { name: "Find a file in ACQ's Drive" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    const list = screen.getByRole("listbox", { name: "Find a file in ACQ's Drive" });
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveTextContent(/Client brief\.pdf.*ACQ-F1/));
    press(field, "Enter");
    await waitFor(() => expect(lastSet()).toEqual({ id: SIGNIN_LAST, type: "drive", fileId: driveBlock().fileId, code: "ACQ-F1" }));
    // Il fuoco va al blocco nuovo, come oggetto (mai sul body).
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-block-id", SIGNIN_LAST));
  });

  it("nel selettore mai un nascosto; Esc lo chiude e il fuoco torna nel blocco", async () => {
    state.driveFiles.find((f) => f.code === "ACQ-F1")!.hidden = true;
    await slash("drive");
    const field = await screen.findByRole("combobox", { name: "Find a file in ACQ's Drive" });
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Find a file in ACQ's Drive" })).toHaveTextContent("No files in ACQ's Drive yet"));
    press(field, "Escape");
    expect(screen.queryByRole("combobox", { name: "Find a file in ACQ's Drive" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(editing()));
    expect(saves).not.toHaveBeenCalled();
  });
});

// --- decisioni ---------------------------------------------------------------

describe("decisioni del registro ([PE 11])", () => {
  const decisionBlocks = () =>
    pageOf("Client decisions").blocks.filter((b) => b.type === "decision") as Extract<ProductBlock, { type: "decision" }>[];

  it("come Laura: «Sign-in only with Google», la data, chi; «Open in the register» porta alla riga", async () => {
    await open("Client decisions");
    const entry = state.decisionLog.find((d) => d.id === "dl-acq-1")!;
    const shell = shellOf(decisionBlocks()[0]!.id);
    expect(shell).toHaveTextContent("Decision · from the register");
    expect(shell).toHaveTextContent("Sign-in only with Google");
    expect(shell).toHaveTextContent(`decided by Laura Costa · ${formatDate(entry.decidedAt, "en")}`);
    const link = within(shell).getByRole("link", { name: /Open in the register/ });
    expect(link).toHaveAttribute("href", "#/p/ACQ/overview?decision=dl-acq-1");
  });

  it("una decisione che chi legge non vede: «A decision you can't see», nessun titolo, data o nome nel DOM", async () => {
    const real = api.productDocs.getProductPage;
    vi.spyOn(api.productDocs, "getProductPage").mockImplementation(async (code) => {
      const page = await real(code);
      return page ? { ...page, decisions: { ...page.decisions, "dl-acq-1": null } } : page;
    });
    await open("Client decisions");
    const entry = state.decisionLog.find((d) => d.id === "dl-acq-1")!;
    const shell = shellOf(decisionBlocks()[0]!.id);
    expect(shell).toHaveTextContent("A decision you can't see");
    const html = shell.innerHTML.toLowerCase();
    expect(html).not.toContain(entry.title.toLowerCase());
    expect(html).not.toContain("laura costa");
    expect(html).not.toContain(formatDate(entry.decidedAt, "en").toLowerCase());
    expect(within(shell).queryByRole("link")).toBeNull();
    // L'altra resta com'è.
    expect(shellOf(decisionBlocks()[1]!.id)).toHaveTextContent("Readings close on the 25th");
  });

  it("in italiano: «Decisione · dal registro», «decisa da»; nascosta: «Una decisione che non puoi vedere»", async () => {
    const real = api.productDocs.getProductPage;
    vi.spyOn(api.productDocs, "getProductPage").mockImplementation(async (code) => {
      const page = await real(code);
      return page ? { ...page, decisions: { ...page.decisions, "dl-acq-2": null } } : page;
    });
    await open("Client decisions");
    act(() => setLanguage("it"));
    const [one, two] = decisionBlocks();
    expect(shellOf(one!.id)).toHaveTextContent("Decisione · dal registro");
    expect(shellOf(one!.id)).toHaveTextContent("decisa da Laura Costa");
    expect(shellOf(two!.id)).toHaveTextContent("Una decisione che non puoi vedere");
  });

  it("«/decision»: il registro di ACQ; scelta la riga, il blocco la cita", async () => {
    await slash("decision");
    const field = await screen.findByRole("combobox", { name: "Find a decision in ACQ's register" });
    await userEvent.setup().type(field, "25th");
    const list = screen.getByRole("listbox", { name: "Find a decision in ACQ's register" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1));
    expect(within(list).getByRole("option")).toHaveTextContent(/Readings close on the 25th.*Laura Costa/);
    press(field, "Enter");
    await waitFor(() => expect(lastSet()).toEqual({ id: SIGNIN_LAST, type: "decision", decisionId: "dl-acq-2" }));
    await waitFor(() => expect(shellOf(SIGNIN_LAST)).toHaveTextContent("Readings close on the 25th"));
  });

  it("il registro apre la riga citata (Overview, `decision`)", async () => {
    renderRoute("/p/ACQ/overview?decision=dl-acq-1", LAURA);
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-decision="dl-acq-1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(document.activeElement).toBe(row));
  });
});

// --- codici («Link to…») -------------------------------------------------------

describe("«Link to…» ([PE 12])", () => {
  it("«/link» poi «ACQ-1»: il codice entra al cursore; fuori dal fuoco è un CodeLink aperto", async () => {
    await slash("link");
    const field = await screen.findByRole("combobox", { name: "Find a task, request, page or file" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    const list = screen.getByRole("listbox", { name: "Find a task, request, page or file" });
    expect(within(list).getByRole("group", { name: "Tasks" })).toBeInTheDocument();
    await userEvent.setup().type(field, "ACQ-1");
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveTextContent(/^ACQ-1(?!\d)/));
    press(field, "Enter");
    await waitFor(() => expect(editing()).toHaveTextContent("ACQ-1"));
    expect(editing().textContent).toBe("ACQ-1");
    act(() => editing().blur());
    await waitFor(() => expect(lastSet()).toMatchObject({ id: SIGNIN_LAST, content: { text: "ACQ-1" } }));
    await waitFor(() =>
      expect(shellOf(SIGNIN_LAST).querySelector('[data-code-link="open"]')).toHaveTextContent("ACQ-1"),
    );
  });

  it("le pagine di prodotto hanno il loro gruppo, i file del Drive il loro", async () => {
    await slash("link");
    const field = await screen.findByRole("combobox", { name: "Find a task, request, page or file" });
    await userEvent.setup().type(field, "ACQ");
    const list = screen.getByRole("listbox", { name: "Find a task, request, page or file" });
    await waitFor(() => expect(within(list).getByRole("group", { name: "Product pages" })).toBeInTheDocument());
    expect(within(list).getByRole("group", { name: "Files" })).toHaveTextContent("ACQ-F1");
  });
});

// --- tabelle -----------------------------------------------------------------

describe("tabelle ([PE 13])", () => {
  const TABLE = "blk-acq-meter-table";
  const table = () => pageOf("Meter reading").blocks.find((b) => b.id === TABLE) as Extract<ProductBlock, { type: "table" }>;
  const cell = (text: string) =>
    within(shellOf(TABLE))
      .getAllByRole("textbox")
      .find((el) => el.textContent === text)!;
  const allIds = (page: ProductPage) =>
    page.blocks.flatMap((b) =>
      b.type === "table" ? [b.id, ...b.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)])] : [b.id],
    );

  it("ogni cella ha il suo nome; Tab dall'ultima cella della riga va alla prima della riga dopo, ⇧Tab torna", async () => {
    await open("Meter reading");
    const user = userEvent.setup();
    expect(cell("Closes")).toHaveAccessibleName("Table cell, row 1, column 3");
    await user.click(cell("Closes"));
    await waitFor(() => expect(editing()).toHaveTextContent("Closes"));
    press(editing(), "Tab");
    await waitFor(() => expect(editing()).toHaveTextContent("Household"));
    expect(document.activeElement).toBe(editing());
    press(editing(), "Tab", { shiftKey: true });
    await waitFor(() => expect(editing()).toHaveTextContent("Closes"));
  });

  it("scritto in una cella e uscito: un set della tabella con la cella cambiata", async () => {
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(cell("Business"));
    await waitFor(() => expect(editing()).toHaveTextContent("Business"));
    act(() => placeCaret(editing(), 8));
    input(editing(), "insertText", "es");
    act(() => editing().blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const saved = lastSet() as Extract<ProductBlock, { type: "table" }>;
    expect(saved.id).toBe(TABLE);
    expect(saved.rows[2]!.cells[0]!.content.text).toBe("Businesses");
    expect(saved.rows[2]!.cells[0]!.id).toBe("blk-acq-meter-cell-3a");
  });

  it("«Remove row» toglie la riga della cella col fuoco con un set della tabella", async () => {
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(cell("Household"));
    await waitFor(() => expect(editing()).toHaveTextContent("Household"));
    await user.click(within(shellOf(TABLE)).getByRole("button", { name: "Table menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove row" }));
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const saved = lastSet() as Extract<ProductBlock, { type: "table" }>;
    expect(saved.rows.map((r) => r.id)).toEqual(["blk-acq-meter-row-1", "blk-acq-meter-row-3"]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Add row e Add column: le celle nuove hanno id diversi da tutti quelli della pagina", async () => {
    const before = new Set(allIds(pageOf("Meter reading")));
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(within(shellOf(TABLE)).getByRole("button", { name: "Table menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add row" }));
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    await user.click(within(shellOf(TABLE)).getByRole("button", { name: "Table menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add column" }));
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    const saved = lastSet() as Extract<ProductBlock, { type: "table" }>;
    expect(saved.rows).toHaveLength(4);
    expect(saved.rows.every((r) => r.cells.length === 4)).toBe(true);
    const fresh = saved.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)]).filter((id) => !before.has(id));
    expect(fresh.length).toBe(1 + 4 + 3); // la riga, le sue 4 celle, la colonna nelle altre 3 righe
    expect(new Set(fresh).size).toBe(fresh.length);
    expect(table().rows).toHaveLength(4);
  });

  it("una tabella di una riga: «Remove row» spento con la sua frase", async () => {
    const t = table();
    t.rows = [t.rows[0]!];
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(within(shellOf(TABLE)).getByRole("button", { name: "Table menu" }));
    const item = await screen.findByRole("menuitem", { name: /Remove row/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("A table keeps at least one row");
    await user.click(item);
    expect(saves).not.toHaveBeenCalled();
  });

  it("Sara legge la tabella: nessuna cella da scrivere; un codice che non vede è tenue e senza nome (P1, AUD)", async () => {
    const t = table();
    t.rows[1]!.cells[2]!.content = plain("See AUD-8") as RichText;
    await open("Meter reading", SARA);
    const shell = shellOf(TABLE);
    expect(within(shell).getByRole("table")).toBeInTheDocument();
    expect(within(shell).queryByRole("textbox")).toBeNull();
    expect(within(shell).queryByRole("button", { name: "Table menu" })).toBeNull();
    await waitFor(() => expect(shell.querySelector('[data-code-link="hidden"]')).toHaveTextContent("AUD-8"));
    const task = state.tasks.find((x) => x.code === "AUD-8")!;
    expect(shell.textContent!.toLowerCase()).not.toContain(task.title.toLowerCase());
  });
});

// --- la maniglia (rimandi della review del Task 8) ------------------------------

describe("⋮⋮: solo lui si trascina, e dice come", () => {
  it("premere una voce del menu del blocco e muoversi di 10 px non trascina", async () => {
    await open("Sign-in");
    const shell = shellOf("blk-acq-signin-4");
    const user = userEvent.setup();
    await user.click(within(shell).getByRole("button", { name: /^Block menu/ }));
    const item = await screen.findByRole("menuitem", { name: "Duplicate" });
    fireEvent.pointerDown(item, { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 30 });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const dragging = shell.className.includes("opacity-40");
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 10, clientY: 30 });
    expect(dragging).toBe(false);
  });

  it("⋮⋮ ha le istruzioni per il lettore di schermo (aria-describedby)", async () => {
    await open("Sign-in");
    const handle = within(shellOf("blk-acq-signin-4")).getByRole("button", { name: /^Block menu/ });
    const described = handle.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)).toHaveTextContent("Drag a block by its handle to move it.");
    // Il guscio del blocco non le porta (non è lui che si trascina).
    expect(shellOf("blk-acq-signin-4")).not.toHaveAttribute("aria-describedby");
  });
});

// --- Fix round 1 (review del Task 9) -------------------------------------------

describe("fix round 1: il fuoco non finisce mai sul body (punto 1)", () => {
  const TABLE = "blk-acq-meter-table";
  const cellNamed = (name: string) => within(shellOf(TABLE)).getByRole("textbox", { name });

  it("Esc in una cella non toccata: il fuoco va alla tabella come oggetto", async () => {
    await open("Meter reading");
    await userEvent.setup().click(cellNamed("Table cell, row 3, column 1"));
    await waitFor(() => expect(editing()).toHaveTextContent("Business"));
    press(editing(), "Escape");
    await waitFor(() => expect(document.activeElement).toBe(shellOf(TABLE)));
  });

  it("Tab e ↓ dall'ultima cella di una tabella che è l'ultimo blocco: la tabella, mai il body", async () => {
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(cellNamed("Table cell, row 3, column 3"));
    await waitFor(() => expect(editing()).toHaveAccessibleName("Table cell, row 3, column 3"));
    press(editing(), "Tab");
    await waitFor(() => expect(document.activeElement).toBe(shellOf(TABLE)));
    await user.click(cellNamed("Table cell, row 3, column 2"));
    await waitFor(() => expect(editing()).toHaveAccessibleName("Table cell, row 3, column 2"));
    act(() => placeCaret(editing(), editing().textContent!.length));
    press(editing(), "ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(shellOf(TABLE)));
  });

  it("Invio ed Esc nella didascalia: il fuoco va all'immagine; dopo, nessun fuoco rubato", async () => {
    await open("Screens");
    const [first, second] = pageOf("Screens").blocks.filter((b) => b.type === "image");
    const user = userEvent.setup();
    const caption = within(shellOf(first!.id)).getByRole("textbox", { name: "Caption" });
    await user.click(caption);
    press(caption, "Enter");
    await waitFor(() => expect(document.activeElement).toBe(shellOf(first!.id)));
    const other = within(shellOf(second!.id)).getByRole("textbox", { name: "Caption" });
    await user.click(other);
    press(other, "Escape");
    await waitFor(() => expect(document.activeElement).toBe(shellOf(second!.id)));
    // Un disegno qualunque dopo non riporta il fuoco a un'immagine selezionata prima.
    await user.click(textbox(SCREENS_INTRO));
    await waitFor(() => expect(editing()).toHaveTextContent(SCREENS_INTRO));
    input(editing(), "insertText", "x");
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.activeElement).toBe(editing());
  });
});

describe("fix round 1: la barra della selezione nelle celle (punto 2)", () => {
  const TABLE = "blk-acq-meter-table";
  it("B in una cella: grassetto; Link https: un <a>; uscita: un set della tabella coi segni", async () => {
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(within(shellOf(TABLE)).getByRole("textbox", { name: "Table cell, row 3, column 1" }));
    await waitFor(() => expect(editing()).toHaveTextContent("Business"));
    act(() => placeCaret(editing(), 0, 8));
    const bar = await screen.findByRole("toolbar", { name: "Format the selection" });
    await user.click(within(bar).getByRole("button", { name: "Bold" }));
    await waitFor(() => expect(editing().querySelector("strong")).toHaveTextContent("Business"));
    act(() => placeCaret(editing(), 0, 8));
    await user.click(within(await screen.findByRole("toolbar")).getByRole("button", { name: "Link" }));
    const field = await screen.findByRole("textbox", { name: "Paste or type a link" });
    await user.type(field, "https://acq.example{Enter}");
    await waitFor(() => expect(editing().querySelector("a")).toHaveAttribute("href", "https://acq.example"));
    act(() => editing().blur());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const saved = lastSet() as Extract<ProductBlock, { type: "table" }>;
    expect(saved.rows[2]!.cells[0]!.content.marks).toEqual(
      expect.arrayContaining([
        { type: "bold", start: 0, end: 8 },
        { type: "link", start: 0, end: 8, href: "https://acq.example" },
      ]),
    );
  });
});

describe("fix round 1: Fine e Inizio non fanno scorrere la colonna (punto 3)", () => {
  it("in un blocco e in una cella: il cursore va al bordo della riga (Selection.modify), il default è annullato", async () => {
    const sel = document.getSelection()!;
    const modify = vi.fn();
    (sel as unknown as { modify: typeof modify }).modify = modify;
    await open("Meter reading");
    const el = await enter("Readings close on the 25th of each month.", 3);
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(el, { key: "End" });
    });
    expect(notPrevented).toBe(false);
    expect(modify).toHaveBeenLastCalledWith("move", "forward", "lineboundary");
    act(() => {
      fireEvent.keyDown(editing(), { key: "Home", shiftKey: true });
    });
    expect(modify).toHaveBeenLastCalledWith("extend", "backward", "lineboundary");
    await userEvent
      .setup()
      .click(within(shellOf("blk-acq-meter-table")).getByRole("textbox", { name: "Table cell, row 2, column 1" }));
    await waitFor(() => expect(editing()).toHaveTextContent("Household"));
    act(() => {
      notPrevented = fireEvent.keyDown(editing(), { key: "End" });
    });
    expect(notPrevented).toBe(false);
    expect(modify).toHaveBeenLastCalledWith("move", "forward", "lineboundary");
    delete (sel as unknown as { modify?: unknown }).modify;
  });
});

describe("fix round 1: incollare (punti 4 e 5)", () => {
  it("da Word (testo e un'immagine della selezione): entra il testo, nessuna immagine", async () => {
    await open("Screens");
    const el = await enter(SCREENS_INTRO, 0);
    act(() => {
      fireEvent.paste(el, {
        clipboardData: {
          files: [png()],
          types: ["text/html", "text/plain", "Files"],
          getData: (type: string) =>
            type === "text/html" ? '<style>p{margin:0}</style><p class="MsoNormal">Totals</p>' : type === "text/plain" ? "Totals" : "",
        },
      });
    });
    await waitFor(() => expect(editing().textContent!.startsWith("Totals")).toBe(true));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(savedOps().flat().some((op) => op.op === "insert" && op.block.type === "image")).toBe(false);
  });

  it("un'immagine incollata in una cella va sotto la tabella", async () => {
    await open("Meter reading");
    await userEvent
      .setup()
      .click(within(shellOf("blk-acq-meter-table")).getByRole("textbox", { name: "Table cell, row 2, column 1" }));
    await waitFor(() => expect(editing()).toHaveTextContent("Household"));
    pasteFiles(editing(), [png()]);
    await waitFor(() =>
      expect(savedOps().flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: "insert", afterId: "blk-acq-meter-table", block: expect.objectContaining({ type: "image" }) }),
        ]),
      ),
    );
  });
});

describe("fix round 1: la tabella (punti 6 e 9)", () => {
  const TABLE = "blk-acq-meter-table";
  it("«⋯» senza una cella col fuoco agisce sulla prima cella (anche dopo che il fuoco è uscito)", async () => {
    await open("Meter reading");
    const user = userEvent.setup();
    await user.click(within(shellOf(TABLE)).getByRole("textbox", { name: "Table cell, row 3, column 1" }));
    await waitFor(() => expect(editing()).toHaveTextContent("Business"));
    await user.click(textbox("Readings close on the 25th of each month."));
    await waitFor(() => expect(editing()).toHaveTextContent("Readings close"));
    await user.click(within(shellOf(TABLE)).getByRole("button", { name: "Table menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove row" }));
    await waitFor(() => expect(saves).toHaveBeenCalled());
    const saved = lastSet() as Extract<ProductBlock, { type: "table" }>;
    expect(saved.rows.map((r) => r.id)).toEqual(["blk-acq-meter-row-2", "blk-acq-meter-row-3"]);
  });

  it("⇧Tab dalla prima cella esce al blocco prima, come Tab dall'ultima", async () => {
    await open("Meter reading");
    await userEvent.setup().click(within(shellOf(TABLE)).getByRole("textbox", { name: "Table cell, row 1, column 1" }));
    await waitFor(() => expect(editing()).toHaveTextContent("Meter"));
    press(editing(), "Tab", { shiftKey: true });
    await waitFor(() => expect(editing()).toHaveTextContent("Two meters on the same contract are read one after the other."));
  });
});

describe("fix round 1: il registro della decisione (punto 7)", () => {
  it("una decisione di AUD citata in una pagina di ACQ apre il registro di AUD", async () => {
    const page = pageOf("Client decisions");
    page.blocks = [...page.blocks, { id: "blk-aud-decision", type: "decision", decisionId: "dl-aud-1" }];
    await open("Client decisions");
    const shell = shellOf("blk-aud-decision");
    await waitFor(() =>
      expect(within(shell).getByRole("link", { name: /Open in the register/ })).toHaveAttribute(
        "href",
        "#/p/AUD/overview?decision=dl-aud-1",
      ),
    );
  });
});

describe("fix round 1: «Link to…» sa dire l'errore e il vuoto (punto 8)", () => {
  it("la ricerca non riesce: «Couldn't search», non «nessun risultato»", async () => {
    failNext("searchMentions");
    await slash("link");
    const list = await screen.findByRole("listbox", { name: "Find a task, request, page or file" });
    await waitFor(() => expect(list).toHaveTextContent("Couldn't search"));
    expect(list).not.toHaveTextContent("Nothing matches");
  });

  it("niente che corrisponde: «Nothing matches “zzqq”»", async () => {
    await slash("link");
    const field = await screen.findByRole("combobox", { name: "Find a task, request, page or file" });
    await userEvent.setup().type(field, "zzqq");
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "Find a task, request, page or file" })).toHaveTextContent(
        "Nothing matches “zzqq”",
      ),
    );
  });
});
