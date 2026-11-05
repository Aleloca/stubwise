import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import type { ProductBlock, ProductBlockOp, RichText } from "../../../data/types";
import { failNext, state } from "../../../data/store";
import { plain, setLink, toggleMark } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { offsetOf, placeCaret } from "./domRange";
import { RichView, paintRich } from "./RichView";

// L'editor a blocchi (area 11a, Task 8; shape product-editor.md). I test
// guidano l'editor con `beforeinput` (inputType, data) sul blocco e la
// selezione messa con `placeCaret`: non dipendono dalla selezione nativa di
// happy-dom oltre a quella. Laura (Project Lead di ACQ) scrive, Marco
// (Developer) scrive da un copione, Sara (Contributor) legge soltanto.

const LAURA = "p-laura";
const SARA = "p-sara";
const MARCO = "p-marco";
const SIGNIN = "ACQ-D5";
const LOGIN_ID = "blk-acq-signin-4";
const LOGIN = "Login only with Google";

const signIn = () => state.productPages.find((p) => p.code === SIGNIN)!;
/** Mette il paragrafo di prova al posto dell'ultimo di Sign-in (stesso id). */
function seedBlock(content: RichText | string, type: "paragraph" = "paragraph") {
  const page = signIn();
  page.blocks = page.blocks.map((b) =>
    b.id === LOGIN_ID ? ({ id: LOGIN_ID, type, content: typeof content === "string" ? plain(content) : content } as ProductBlock) : b,
  );
}
const loginBlock = () => signIn().blocks.find((b) => b.id === LOGIN_ID) as Extract<ProductBlock, { content: RichText }>;

async function openSignIn(person = LAURA) {
  renderRoute(`/p/ACQ/docs/product/${SIGNIN}`, person);
  await screen.findByRole("heading", { level: 1, name: "Sign-in" });
}

/** Il corpo della pagina (per chi scrive e per chi legge, in ogni lingua). */
const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
/** Il titolo 2 del blocco di prova. */
const rulesHeading = () => body().querySelector(`[data-block-id="${LOGIN_ID}"] h3`);
/** Lo stato del salvataggio nella barra dello spazio. */
const saveStatus = () =>
  within(screen.getByRole("navigation", { name: /^(Product pages of|Pagine di prodotto di) ACQ$/ })).findByRole("status");
/** Il blocco di testo che dice `text` (fuori o dentro il fuoco). */
const textbox = (text: string) =>
  within(body())
    .getAllByRole("textbox")
    .find((el) => el.textContent === text)!;
/** Il blocco col fuoco (`contenteditable`). */
const editing = () => document.querySelector<HTMLElement>("[data-editing]")!;

/** Entra nel blocco che dice `text`, col cursore a `at` (o la selezione at–to). */
async function enter(text: string, at: number, to = at) {
  const user = userEvent.setup();
  await user.click(textbox(text));
  await waitFor(() => expect(editing()).toHaveTextContent(text));
  act(() => placeCaret(editing(), at, to));
  return editing();
}

function input(el: HTMLElement, inputType: string, data: string | null = null) {
  act(() => {
    el.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }));
  });
}
const leave = (el: HTMLElement) => act(() => el.blur());
const press = (el: HTMLElement, key: string, mods: Partial<Record<"metaKey" | "shiftKey" | "altKey", boolean>> = {}) => {
  let result = true;
  act(() => {
    result = fireEvent.keyDown(el, { key, ...mods });
  });
  return result;
};

let saves: MockInstance<typeof api.productDocs.saveProductBlocks>;
const savedOps = () => saves.mock.calls.map((c) => c[1] as ProductBlockOp[]);

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  saves = vi.spyOn(api.productDocs, "saveProductBlocks");
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

describe("offsetOf / placeCaret", () => {
  // «Pay with ACQ-7 or the bank»: «with» in grassetto (4–8), il codice 9–14.
  const content = toggleMark(plain("Pay with ACQ-7 or the bank"), 4, 8, "bold");

  it("su un RichView: lo scarto 12 cade nella stessa lettera all'andata e al ritorno", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <div data-testid="root">
          <RichView content={content} />
        </div>
      </QueryClientProvider>,
    );
    const root = within(container).getByTestId("root");
    expect(root.querySelector("strong")).toHaveTextContent("with");
    for (const n of [0, 6, 12, 14, 26]) {
      placeCaret(root, n);
      const sel = document.getSelection()!;
      expect(sel.anchorNode!.textContent!.length).toBeGreaterThan(0);
      expect(offsetOf(root, sel.anchorNode!, sel.anchorOffset)).toBe(n);
    }
    // Il 12 sta dentro il codice: «ACQ-7», dopo «ACQ».
    placeCaret(root, 12);
    expect(document.getSelection()!.anchorNode!.textContent).toBe("ACQ-7");
    expect(document.getSelection()!.anchorOffset).toBe(3);
  });

  it("su paintRich (il blocco col fuoco): lo stesso DOM, e una selezione 6–20 torna 6–20", () => {
    const root = document.createElement("div");
    document.body.append(root);
    paintRich(root, content);
    placeCaret(root, 6, 20);
    const range = document.getSelection()!.getRangeAt(0);
    expect(offsetOf(root, range.startContainer, range.startOffset)).toBe(6);
    expect(offsetOf(root, range.endContainer, range.endOffset)).toBe(20);
    root.remove();
  });
});

describe("scrivere e salvare", () => {
  it("Laura scrive in un paragrafo di Sign-in ed esce: un set con la sessionId dell'editor, «Saved»", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 22);
    input(el, "insertText", "!");
    expect(el).toHaveTextContent(`${LOGIN}!`);
    expect(saves).not.toHaveBeenCalled();
    leave(el);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const [pageId, ops, opts] = saves.mock.calls[0]!;
    expect(pageId).toBe(signIn().id);
    expect(ops).toEqual([{ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain(`${LOGIN}!`) } }]);
    expect((opts as { sessionId: string }).sessionId).toMatch(/^ses-/);
    expect(await saveStatus()).toHaveTextContent("Saved");
    expect(loginBlock().content.text).toBe(`${LOGIN}!`);
  });

  it("si salva anche dopo 800 ms senza tasti", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      input(el, "insertText", "A ");
      act(() => vi.advanceTimersByTime(799));
      expect(saves).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(2));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(savedOps()[0]![0]).toMatchObject({ op: "set", block: { content: { text: `A ${LOGIN}` } } });
  });

  it("il salvataggio fallito: «Couldn't save · Retry»; Retry (anche con un doppio clic) rimanda le stesse operazioni, «Saved»", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    failNext("productDocs.saveProductBlocks");
    const el = await enter(LOGIN, 22);
    input(el, "insertText", ".");
    leave(el);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save");
    const retry = within(alert).getByRole("button", { name: "Retry" });
    const user = userEvent.setup();
    await user.dblClick(retry);
    await waitFor(async () => expect(await saveStatus()).toHaveTextContent("Saved"));
    expect(saves).toHaveBeenCalledTimes(2);
    expect(savedOps()[1]).toEqual(savedOps()[0]);
    expect(loginBlock().content.text).toBe(`${LOGIN}.`);
  });

  it("un nodo estraneo infilato nel contenteditable sparisce al primo ridisegno e non arriva nel testo salvato", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 22);
    const foreign = document.createElement("span");
    foreign.setAttribute("style", "color: red");
    foreign.textContent = "INJECTED";
    el.append(foreign);
    input(el, "insertText", "!");
    expect(el.querySelector("[style]")).toBeNull();
    expect(el.textContent).toBe(`${LOGIN}!`);
    leave(el);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(savedOps()[0])).not.toContain("INJECTED");
  });
});

describe("i segni nella frase", () => {
  it("«only with Google», ⌘B: <strong>, un bold 6–22 nel set, il testo invariato; ⌘B di nuovo lo toglie", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 6, 22);
    // P18: il keydown è annullato, così Chromium non manda anche `formatBold`.
    // Qui il test fa ciò che farebbe il browser: se il keydown non fosse
    // annullato, arriverebbe il `beforeinput` e i due cambi si annullerebbero.
    const notPrevented = press(el, "b", { metaKey: true });
    if (notPrevented) input(el, "formatBold");
    expect(notPrevented).toBe(false);
    expect(el.querySelector("strong")).toHaveTextContent("only with Google");
    leave(el);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(savedOps()[0]).toEqual([
      {
        op: "set",
        block: { id: LOGIN_ID, type: "paragraph", content: { text: LOGIN, marks: [{ type: "bold", start: 6, end: 22 }] } },
      },
    ]);
    const again = await enter(LOGIN, 6, 22);
    press(again, "b", { metaKey: true });
    expect(again.querySelector("strong")).toBeNull();
    leave(again);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(savedOps()[1]![0]).toMatchObject({ block: { content: { text: LOGIN, marks: [] } } });
  });

  it("la barra della selezione: Bold con aria-pressed; Link con javascript: rifiutato senza scrivere, https: diventa <a>", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    await enter(LOGIN, 6, 22);
    const bar = await screen.findByRole("toolbar", { name: "Format the selection" });
    expect(within(bar).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false");
    const user = userEvent.setup();
    await user.click(within(bar).getByRole("button", { name: "Link" }));
    const field = await screen.findByRole("textbox", { name: "Paste or type a link" });
    await user.type(field, "javascript:alert(1){Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Only http and https links");
    expect(within(body()).queryByRole("link")).toBeNull();
    await user.clear(field);
    await user.type(field, "https://acq.example{Enter}");
    await waitFor(() => expect(editing().querySelector("a")).toHaveAttribute("href", "https://acq.example"));
    expect(editing().querySelector("a")).toHaveTextContent("only with Google");
    // Nessun <a> del corpo ha un altro schema.
    for (const a of body().querySelectorAll("a")) expect(a.getAttribute("href")).toMatch(/^https?:\/\//i);
    leave(editing());
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(savedOps()[0]![0]).toMatchObject({
      block: { content: { marks: [{ type: "link", start: 6, end: 22, href: "https://acq.example" }] } },
    });
    // Fuori dal fuoco il link si apre col browser di sistema (nuova finestra → setWindowOpenHandler).
    const link = await within(body()).findByRole("link", { name: "only with Google" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("title", "https://acq.example");
  });

  it("il rifiuto in italiano: «Solo link http e https»", async () => {
    act(() => setLanguage("it"));
    seedBlock(LOGIN);
    await openSignIn();
    await enter(LOGIN, 6, 22);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Link" }));
    await user.type(await screen.findByRole("textbox", { name: "Incolla o scrivi un link" }), "file:///etc{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Solo link http e https");
    expect(saves).not.toHaveBeenCalled();
  });
});

describe("la tastiera", () => {
  it("Invio a metà: due blocchi, il primo con l'id di prima, il fuoco sul secondo in testa; Backspace in testa li riunisce con un merge, fuoco a 10", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 10);
    expect(press(el, "Enter")).toBe(false);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const [set, insert] = savedOps()[0]!;
    expect(set).toEqual({ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain("Login only") } });
    expect(insert).toMatchObject({ op: "insert", afterId: LOGIN_ID, block: { type: "paragraph", content: plain(" with Google") } });
    const secondId = (insert as Extract<ProductBlockOp, { op: "insert" }>).block.id;
    expect(secondId).not.toBe(LOGIN_ID);
    await waitFor(() => expect(editing()).toHaveTextContent("with Google"));
    expect(editing().getAttribute("data-block-text")).toBe(secondId);
    expect(document.activeElement).toBe(editing());
    const range = document.getSelection()!.getRangeAt(0);
    expect(offsetOf(editing(), range.startContainer, range.startOffset)).toBe(0);

    press(editing(), "Backspace");
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(savedOps()[1]).toEqual([{ op: "merge", firstId: LOGIN_ID, secondId }]);
    await waitFor(() => expect(editing()).toHaveTextContent(LOGIN));
    expect(editing().getAttribute("data-block-text")).toBe(LOGIN_ID);
    const back = document.getSelection()!.getRangeAt(0);
    expect(offsetOf(editing(), back.startContainer, back.startOffset)).toBe(10);
    expect(signIn().blocks.filter((b) => b.id === secondId)).toHaveLength(0);
  });

  it("Invio su un elemento d'elenco vuoto lo riporta a paragrafo (P41)", async () => {
    const page = signIn();
    page.blocks = page.blocks.map((b) => (b.id === LOGIN_ID ? { id: LOGIN_ID, type: "bullet", content: plain(""), indent: 0 } : b));
    await openSignIn();
    const user = userEvent.setup();
    await user.click(within(body()).getByRole("textbox", { name: "Bulleted list item, level 1" }));
    press(editing(), "Enter");
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(savedOps()[0]).toEqual([{ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain("") } }]);
  });

  it("«/» poi «tab» poi Invio: una tabella 2×2 al posto del blocco vuoto (il set salvato)", async () => {
    seedBlock("");
    await openSignIn();
    const user = userEvent.setup();
    await user.click(textbox(""));
    input(editing(), "insertText", "/");
    const menu = await screen.findByRole("listbox", { name: "Blocks" });
    expect(within(menu).getByRole("group", { name: "Text" })).toBeInTheDocument();
    input(editing(), "insertText", "tab");
    await waitFor(() => expect(within(menu).getAllByRole("option").map((o) => o.textContent)).toEqual(["Table"]));
    expect(editing()).toHaveAttribute("aria-activedescendant", within(menu).getByRole("option").id);
    press(editing(), "Enter");
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const ops = savedOps()[0]!;
    expect(ops).toHaveLength(1);
    const table = (ops[0] as Extract<ProductBlockOp, { op: "set" }>).block;
    expect(table).toMatchObject({ id: LOGIN_ID, type: "table" });
    if (table.type !== "table") throw new Error("not a table");
    expect(table.rows).toHaveLength(2);
    expect(table.rows.every((r) => r.cells.length === 2 && r.cells.every((c) => c.content.text === ""))).toBe(true);
    const ids = table.rows.flatMap((r) => [r.id, ...r.cells.map((c) => c.id)]);
    expect(new Set(ids).size).toBe(6);
    // Il segnaposto della tabella prende il fuoco come oggetto (mai il body).
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-block-id", LOGIN_ID));
  });

  it("«/» poi Esc: il menu si chiude e «/» resta nel blocco; nessun blocco per «xyz» lo dice", async () => {
    seedBlock("");
    await openSignIn();
    const user = userEvent.setup();
    await user.click(textbox(""));
    input(editing(), "insertText", "/");
    await screen.findByRole("listbox", { name: "Blocks" });
    input(editing(), "insertText", "xyz");
    expect(screen.getByRole("listbox")).toHaveTextContent("No blocks match “xyz”");
    press(editing(), "Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(editing()).toHaveTextContent("/xyz");
  });

  it("«## Rules» → un titolo 2 «Rules»; nessun «#» in nessun punto del corpo, né scrivendo né leggendo", async () => {
    seedBlock("");
    await openSignIn();
    const user = userEvent.setup();
    await user.click(textbox(""));
    input(editing(), "insertText", "## Rules");
    await waitFor(() => expect(rulesHeading()).toHaveTextContent("Rules"));
    expect(body().textContent).not.toContain("#");
    expect(editing()).toHaveAccessibleName("Heading 2");
    leave(editing());
    await waitFor(() => expect(loginBlock()).toMatchObject({ type: "heading", level: 2, content: plain("Rules") }));
    expect(body().textContent).not.toContain("#");
    expect(rulesHeading()).toHaveTextContent("Rules");
  });

  it("Tab fuori da un elenco non fa niente e il fuoco non esce", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 3);
    expect(press(el, "Tab")).toBe(false);
    expect(document.activeElement).toBe(el);
  });
});

describe("incollare", () => {
  it("una riga sola entra al cursore coi suoi segni; più righe diventano paragrafi dopo il blocco", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    // «only» selezionato, incollato «solely» in grassetto (da HTML): al suo posto, coi suoi segni.
    const el = await enter(LOGIN, 6, 10);
    act(() => {
      fireEvent.paste(el, {
        clipboardData: {
          getData: (type: string) => (type === "text/html" ? "<p><strong>solely</strong></p>" : "solely"),
        },
      });
    });
    expect(editing().querySelector("strong")).toHaveTextContent("solely");
    expect(editing()).toHaveTextContent("Login solely with Google");
    act(() => {
      fireEvent.paste(editing(), {
        clipboardData: { getData: (type: string) => (type === "text/plain" ? "One\n\n- Two" : "") },
      });
    });
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(savedOps()[1]).toMatchObject([
      { op: "insert", afterId: LOGIN_ID, block: { type: "paragraph", content: plain("One") } },
      { op: "insert", block: { type: "paragraph", content: plain("- Two") } },
    ]);
  });
});

describe("⌘Z e ⇧⌘Z (shape [PE 21])", () => {
  it("Laura scrive «x» ed esce, ⌘Z: un secondo save col testo di prima e la stessa sessionId; ⇧⌘Z lo rimette", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 22);
    input(el, "insertText", "x");
    leave(el);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const again = await enter(`${LOGIN}x`, 3);
    press(again, "z", { metaKey: true });
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(2));
    expect(savedOps()[1]).toEqual([{ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain(LOGIN) } }]);
    const [first, second] = saves.mock.calls.map((c) => c[2] as { sessionId: string; undoOf?: string });
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(second!.undoOf).toEqual(expect.any(String));
    await waitFor(() => expect(loginBlock().content.text).toBe(LOGIN));
    await waitFor(() => expect(editing()).toHaveTextContent(LOGIN));
    press(editing(), "z", { metaKey: true, shiftKey: true });
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(3));
    expect(savedOps()[2]).toEqual([{ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain(`${LOGIN}x`) } }]);
    await waitFor(() => expect(loginBlock().content.text).toBe(`${LOGIN}x`));
  });

  it("Marco cambia lo stesso blocco dopo Laura: ⌘Z non scrive, «Changed by someone else, not undone», e il passo esce dalla pila", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 22);
    input(el, "insertText", "x");
    leave(el);
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    const laura = (saves.mock.calls[0]![2] as { sessionId: string }).sessionId;
    // Marco, dal suo copione: un'altra sessione.
    act(() => {
      api.productDocs.writeProductBlocksAs(
        MARCO,
        signIn().id,
        [{ op: "set", block: { id: LOGIN_ID, type: "paragraph", content: plain("Marco was here") } }],
        { sessionId: "script-marco" },
      );
    });
    expect(laura).not.toBe("script-marco");
    await waitFor(() => expect(textbox("Marco was here")).toBeTruthy());
    const block = await enter("Marco was here", 0);
    press(block, "z", { metaKey: true });
    await waitFor(async () => expect(await saveStatus()).toHaveTextContent("Changed by someone else, not undone"));
    expect(saves).toHaveBeenCalledTimes(1);
    expect(loginBlock().content.text).toBe("Marco was here");
    // Il passo non c'è più: un altro ⌘Z non fa niente.
    press(editing(), "z", { metaKey: true });
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it("⌘Z di un'eliminazione rimette il blocco con lo STESSO id (i suoi commenti tornano)", async () => {
    seedBlock(LOGIN);
    await openSignIn();
    const el = await enter(LOGIN, 0);
    // Esc seleziona il blocco come oggetto; Backspace lo elimina.
    press(el, "Escape");
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-block-id", LOGIN_ID));
    press(document.activeElement as HTMLElement, "Backspace");
    await waitFor(() => expect(signIn().blocks.some((b) => b.id === LOGIN_ID)).toBe(false));
    expect(document.activeElement).not.toBe(document.body);
    press(document.activeElement as HTMLElement, "z", { metaKey: true });
    await waitFor(() => expect(signIn().blocks.some((b) => b.id === LOGIN_ID)).toBe(true));
    expect(loginBlock().content.text).toBe(LOGIN);
    expect(savedOps()[1]).toEqual([
      { op: "insert", afterId: "blk-acq-signin-3", block: { id: LOGIN_ID, type: "paragraph", content: plain(LOGIN) } },
    ]);
  });
});

describe("il titolo", () => {
  it("modificato e uscito: renameProductPage; vuoto, torna a quello di prima con la frase", async () => {
    const rename = vi.spyOn(api.productDocs, "renameProductPage");
    await openSignIn();
    const h1 = screen.getByRole("heading", { level: 1 });
    act(() => h1.focus());
    act(() => {
      h1.textContent = "Signing in";
      fireEvent.input(h1);
    });
    act(() => h1.blur());
    await waitFor(() => expect(rename).toHaveBeenCalledWith(signIn().id, "Signing in"));
    await waitFor(() => expect(signIn().title).toBe("Signing in"));
    act(() => h1.focus());
    act(() => {
      h1.textContent = "   ";
      fireEvent.input(h1);
    });
    expect(h1).toHaveAttribute("title", "A page needs a title");
    act(() => h1.blur());
    expect(h1).toHaveTextContent("Signing in");
    expect(h1).toHaveAttribute("title", "A page needs a title");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("Invio nel titolo porta al primo blocco", async () => {
    await openSignIn();
    const h1 = screen.getByRole("heading", { level: 1 });
    act(() => h1.focus());
    press(h1, "Enter");
    await waitFor(() => expect(editing()).toHaveTextContent("How customers sign in"));
    expect(document.activeElement).toBe(editing());
  });
});

describe("chi legge soltanto", () => {
  it("Sara: nessun contenteditable, nessuna barra; grassetto, corsivo e link si leggono; i codici sono link o tenui", async () => {
    const content = setLink(
      toggleMark(toggleMark(plain("Login only with Google, see ACQ-7 and AUD-8 here"), 6, 10, "bold"), 11, 15, "italic"),
      16,
      22,
      "https://acq.example",
    );
    seedBlock(content);
    await openSignIn(SARA);
    await waitFor(() => expect(screen.getByText("Google")).toBeInTheDocument());
    // La pagina intera, titolo compreso: nessun contenteditable.
    expect(document.querySelector("[contenteditable]")).toBeNull();
    expect(within(body()).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /block menu/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add a block/i })).toBeNull();
    const block = body().querySelector<HTMLElement>(`[data-block-id="${LOGIN_ID}"]`)!;
    expect(block.querySelector("strong")).toHaveTextContent("only");
    expect(block.querySelector("em")).toHaveTextContent("with");
    const link = within(block).getByRole("link", { name: "Google" });
    expect(link).toHaveAttribute("href", "https://acq.example");
    expect(link).toHaveAttribute("target", "_blank");
    await waitFor(() => expect(block.querySelector('[data-code-link="open"]')).toHaveTextContent("ACQ-7"));
    const hidden = [...block.querySelectorAll('[data-code-link="hidden"]')].map((n) => n.textContent);
    expect(hidden).toEqual(["AUD-8"]);
    // Del codice che Sara non vede (AUD, non ne è membro), nessun nome: il blocco dice solo le sue lettere (R-G5).
    expect(block.textContent).toBe("Login only with Google, see ACQ-7 and AUD-8 here");
  });
});
