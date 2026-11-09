import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";

// L'albero dello spazio Prodotto (area 11a, Task 7; shape product-space.md
// §3.5, §6): aprire e chiudere, trascinare (profondità dal movimento
// orizzontale), i gesti del «⋯» da tastiera con le voci spente e la loro
// frase, la rinomina sul posto, e l'albero di chi legge soltanto.

const LAURA = "p-laura";
const SARA = "p-sara";

const pageBy = (title: string) =>
  state.productPages.find((p) => p.projectId === "prj-acq" && p.title === title)!;
const tree = () => screen.findByRole("tree", { name: "Product pages of ACQ" });
const node = (t: HTMLElement, title: string) => within(t).getByRole("treeitem", { name: title });

async function openSpace(personId = LAURA) {
  renderRoute("/p/ACQ/docs/product", personId);
  return tree();
}

/** Apre il «⋯» di un nodo da tastiera (⇧F10) e restituisce il menu. */
async function nodeMenu(t: HTMLElement, title: string) {
  const user = userEvent.setup();
  node(t, title).focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  return screen.findByRole("menu", { name: `More for ${title}` });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

describe("l'albero di ACQ", () => {
  it("Features con quattro figlie; si chiude e si riapre", async () => {
    const user = userEvent.setup();
    const t = await openSpace();
    const features = node(t, "Features");
    expect(features).toHaveAttribute("aria-expanded", "true");
    expect(features).toHaveAttribute("aria-level", "1");
    for (const title of ["Sign-in", "Bills", "Meter reading", "Fault reports"])
      expect(node(t, title)).toHaveAttribute("aria-level", "2");
    // Il codice sta nel `title` del nodo, non sul nodo.
    expect(features).not.toHaveTextContent(/ACQ-D/);
    await user.click(within(features).getByRole("button", { name: "Collapse Features" }));
    expect(within(t).queryByRole("treeitem", { name: "Bills" })).toBeNull();
    expect(node(t, "Features")).toHaveAttribute("aria-expanded", "false");
    // Da tastiera: → riapre.
    node(t, "Features").focus();
    await user.keyboard("{ArrowRight}");
    expect(node(t, "Bills")).toBeInTheDocument();
  });

  it("Invio sul nodo apre la pagina", async () => {
    const user = userEvent.setup();
    const t = await openSpace();
    node(t, "Bills").focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(node(t, "Bills")).toHaveAttribute("aria-selected", "true");
  });

  it("Laura trascina «Bills» sopra «Sign-in»: moveProductPage sotto Features con index 0", async () => {
    const move = vi.spyOn(api.productDocs, "moveProductPage");
    const t = await openSpace();
    // Le righe sono alte 28 px, una sotto l'altra. La riga che segue il
    // puntatore (`DragOverlay`) sta dove la mettono il suo `top` e il suo
    // spostamento, come in un browser.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const overlay = this.closest<HTMLElement>(".product-tree-overlay");
      const row = this.closest("[data-tree-row]");
      const rows = [...document.querySelectorAll("[data-tree-row]")];
      const shift = overlay
        ? Number(/translate3d\([-\d.]+px, ([-\d.]+)px/.exec(overlay.style.transform)?.[1] ?? 0)
        : 0;
      const top = overlay
        ? parseFloat(overlay.style.top) + shift
        : row
          ? rows.indexOf(row) * 28
          : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 240,
        bottom: top + 28,
        width: 240,
        height: 28,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const handle = within(node(t, "Bills")).getByRole("button", { name: "Move Bills" });
    // Bills è la quarta riga (top 84), Sign-in la terza (top 56).
    fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 98 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 92 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 66 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 10, clientY: 66 });
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(pageBy("Bills").id, {
        parentId: pageBy("Features").id,
        index: 0,
      }),
    );
    await waitFor(() => expect(pageBy("Bills").order).toBe(0));
    expect(await screen.findByText("Moved Bills before Sign-in")).toBeInTheDocument();
  });

  it("da tastiera «Indent» su «Screens» la mette sotto «Features», e il fuoco resta sul nodo", async () => {
    const user = userEvent.setup();
    const t = await openSpace();
    const menu = await nodeMenu(t, "Screens");
    await user.click(within(menu).getByRole("menuitem", { name: "Indent" }));
    await waitFor(() => expect(pageBy("Screens").parentId).toBe(pageBy("Features").id));
    await waitFor(() => expect(node(t, "Screens")).toHaveAttribute("aria-level", "2"));
    await waitFor(() => expect(node(t, "Screens")).toHaveFocus());
  });

  it("le voci impossibili sono spente con la loro frase: Move up sulla prima, Outdent su una radice", async () => {
    const t = await openSpace();
    const menu = await nodeMenu(t, "Sign-in");
    const up = within(menu).getByRole("menuitem", { name: /^Move up/ });
    expect(up).toHaveAttribute("aria-disabled", "true");
    expect(up).toHaveTextContent("Already first");
    expect(within(menu).getByRole("menuitem", { name: /^Indent/ })).toHaveTextContent(
      "Needs a page above it to go under",
    );
    await userEvent.keyboard("{Escape}");
    const root = await nodeMenu(t, "Phases");
    expect(within(root).getByRole("menuitem", { name: /^Outdent/ })).toHaveTextContent(
      "Already at the top level",
    );
    expect(within(root).getByRole("menuitem", { name: /^Move down/ })).toHaveTextContent(
      "Already last",
    );
  });

  it("«Delete» su «Features» è spento con «Move or delete its subpages first», senza «Who?»", async () => {
    const t = await openSpace();
    const menu = await nodeMenu(t, "Features");
    const del = await within(menu).findByRole("menuitem", { name: /^Delete…/ });
    await waitFor(() => expect(del).toHaveTextContent("Move or delete its subpages first"));
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).queryByRole("menuitem", { name: /^who/i })).toBeNull();
    expect(menu.querySelector("[data-who-can]")).toBeNull();
  });

  it("uno spostamento che non riesce rimette la pagina dov'era, con l'avviso e Retry", async () => {
    const user = userEvent.setup();
    const t = await openSpace();
    failNext("productDocs.moveProductPage");
    const menu = await nodeMenu(t, "Bills");
    await user.click(within(menu).getByRole("menuitem", { name: "Move up" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't move “Bills”");
    // Di nuovo al suo posto: dopo Sign-in.
    const titles = within(t)
      .getAllByRole("treeitem")
      .map((n) => n.getAttribute("aria-label"));
    expect(titles.indexOf("Bills")).toBe(titles.indexOf("Sign-in") + 1);
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pageBy("Bills").order).toBe(0));
  });

  it("«+» crea «Untitled» come ultima sottopagina e la apre", async () => {
    const user = userEvent.setup();
    const t = await openSpace();
    await user.click(within(node(t, "Features")).getByRole("button", { name: "New subpage under Features" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();
    const created = pageBy("Untitled");
    expect(created.parentId).toBe(pageBy("Features").id);
    expect(created.order).toBe(4);
  });
});

describe("rinominare sul posto", () => {
  it("F2 apre il campo; Invio salva e il fuoco resta sulla voce", async () => {
    const user = userEvent.setup();
    const t = await openSpace();
    node(t, "Bills").focus();
    await user.keyboard("{F2}");
    const field = within(t).getByRole("textbox", { name: "Title of Bills" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Bills and payments{Enter}");
    await waitFor(() => expect(pageBy("Bills and payments")).toBeTruthy());
    const renamed = await within(t).findByRole("treeitem", { name: "Bills and payments" });
    expect(renamed).toHaveFocus();
    expect(within(t).queryByRole("textbox")).toBeNull();
  });

  it("Esc torna al titolo di prima e il fuoco resta sulla voce; vuoto non salva", async () => {
    const user = userEvent.setup();
    const rename = vi.spyOn(api.productDocs, "renameProductPage");
    const t = await openSpace();
    node(t, "Bills").focus();
    await user.keyboard("{F2}");
    const field = within(t).getByRole("textbox", { name: "Title of Bills" });
    await user.clear(field);
    await user.type(field, "Something else{Escape}");
    expect(node(t, "Bills")).toHaveFocus();
    expect(within(t).queryByRole("textbox")).toBeNull();
    // Vuoto: torna al titolo di prima, senza scrivere.
    await user.keyboard("{F2}");
    const again = within(t).getByRole("textbox", { name: "Title of Bills" });
    await user.clear(again);
    expect(again).toHaveAttribute("title", "A page needs a title");
    await user.keyboard("{Enter}");
    expect(node(t, "Bills")).toHaveFocus();
    expect(rename).not.toHaveBeenCalled();
    expect(pageBy("Bills")).toBeTruthy();
  });
});

/** Righe da 28 px una sotto l'altra; la riga che segue il puntatore dove la mettono `top` e spostamento. */
function mockRows() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const overlay = this.closest<HTMLElement>(".product-tree-overlay");
    const row = this.closest("[data-tree-row]");
    const rows = [...document.querySelectorAll("[data-tree-row]")];
    const shift = overlay
      ? Number(/translate3d\([-\d.]+px, ([-\d.]+)px/.exec(overlay.style.transform)?.[1] ?? 0)
      : 0;
    const top = overlay ? parseFloat(overlay.style.top) + shift : row ? rows.indexOf(row) * 28 : 0;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 240,
      bottom: top + 28,
      width: 240,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

describe("fix round 1: trascinare e rinominare", () => {
  it("[PS 12] durante il trascinamento: l'origine è una riga vuota tratteggiata, la linea sta all'arrivo", async () => {
    const t = await openSpace();
    mockRows();
    const handle = within(node(t, "Bills")).getByRole("button", { name: "Move Bills" });
    fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 98 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 92 });
    // Ancora sopra sé stessa: nessuna destinazione che cambi qualcosa, nessuna linea.
    await waitFor(() => expect(node(t, "Bills").querySelector("[data-drag-origin]")).not.toBeNull());
    expect(document.querySelector("[data-drop-line]")).toBeNull();
    // Sopra Sign-in: la linea in cima a Sign-in, al rientro del livello 1; l'origine resta.
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 66 });
    await waitFor(() =>
      expect(node(t, "Sign-in").querySelector('[data-drop-line="top"]')).not.toBeNull(),
    );
    expect((node(t, "Sign-in").querySelector("[data-drop-line]") as HTMLElement).style.left).toBe(
      "32px",
    );
    expect(node(t, "Bills").querySelector("[data-drag-origin]")).not.toBeNull();
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 10, clientY: 66 });
    await waitFor(() => expect(document.querySelector("[data-drag-origin]")).toBeNull());
  });

  it("trascinata di lato a sinistra, «Bills» esce da Features: radice dopo Features", async () => {
    const move = vi.spyOn(api.productDocs, "moveProductPage");
    const t = await openSpace();
    mockRows();
    const handle = within(node(t, "Bills")).getByRole("button", { name: "Move Bills" });
    fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 1, clientX: 60, clientY: 98 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 50, clientY: 98 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 30, clientY: 98 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 30, clientY: 98 });
    // Sotto Bills c'è Meter reading, a livello 1: il livello non scende sotto
    // quello della riga che segue, e Bills resta dov'è (nessuna scrittura).
    await waitFor(() => expect(move).not.toHaveBeenCalled());
    // «Fault reports», l'ultima figlia, invece esce: radice, subito dopo Features.
    const fault = within(node(t, "Fault reports")).getByRole("button", { name: "Move Fault reports" });
    fireEvent.pointerDown(fault, { button: 0, isPrimary: true, pointerId: 2, clientX: 60, clientY: 154 });
    fireEvent.pointerMove(document, { pointerId: 2, clientX: 50, clientY: 154 });
    fireEvent.pointerMove(document, { pointerId: 2, clientX: 30, clientY: 154 });
    fireEvent.pointerUp(document, { pointerId: 2, clientX: 30, clientY: 154 });
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(pageBy("Fault reports").id, { parentId: null, index: 2 }),
    );
  });

  it("una ricarica durante la rinomina non fa tornare il titolo di prima", async () => {
    const user = userEvent.setup();
    // La rinomina resta in volo: la lettura nuova non ha ancora il nome nuovo.
    vi.spyOn(api.productDocs, "renameProductPage").mockImplementation(() => new Promise(() => {}));
    const t = await openSpace();
    node(t, "Bills").focus();
    await user.keyboard("{F2}");
    const field = within(t).getByRole("textbox", { name: "Title of Bills" });
    await user.clear(field);
    await user.type(field, "Bills and payments{Enter}");
    expect(await within(t).findByRole("treeitem", { name: "Bills and payments" })).toBeInTheDocument();
    // Un'altra scrittura ricarica lo spazio.
    const menu = await nodeMenu(t, "Phases");
    await user.click(within(menu).getByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(pageBy("Phases").order).toBe(3));
    await waitFor(() => {
      const titles = within(t).getAllByRole("treeitem").map((n) => n.getAttribute("aria-label"));
      expect(titles.indexOf("Phases")).toBeLessThan(titles.indexOf("Client decisions"));
    });
    expect(within(t).getByRole("treeitem", { name: "Bills and payments" })).toBeInTheDocument();
    expect(within(t).queryByRole("treeitem", { name: "Bills" })).toBeNull();
  });
});

describe("chi legge soltanto", () => {
  it("Sara: nessuna maniglia, nessun «+», nessun «⋯», nessun «New page»", async () => {
    const t = await openSpace(SARA);
    expect(node(t, "Features")).toBeInTheDocument();
    expect(within(t).queryAllByRole("button", { name: /^move /i })).toHaveLength(0);
    expect(within(t).queryAllByRole("button", { name: /^new subpage/i })).toHaveLength(0);
    expect(within(t).queryAllByRole("button", { name: /^more for/i })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /new page/i })).toBeNull();
    // ⇧F10 e F2 non aprono niente.
    const user = userEvent.setup();
    node(t, "Bills").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{F2}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(t).queryByRole("textbox")).toBeNull();
  });
});
