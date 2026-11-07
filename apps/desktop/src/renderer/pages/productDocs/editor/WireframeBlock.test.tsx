import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import { emitProductPage } from "../../../data/productDocs/events";
import { drawWireframeAs } from "../../../data/productDocs/wireframes";
import { failNext, state } from "../../../data/store";
import type { ProductBlock } from "../../../data/types";
import { getSessionPersonId, setSessionPersonId } from "../../../data/session";
import { revokeProjectPermission } from "../../../data/viewer";
import { plain } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { placeCaret } from "./domRange";

// La bozza di schermata di Claude nella pagina (11b, Task 12; shape
// product-claude-backlog.md §3.5–3.6): il blocco con l'etichetta «Claude's
// draft», «Keep» (toglie l'etichetta, maintainer 6 nov 2026), «Redraw»,
// «Replace with an image»; «/» → «Screen sketch» e «⋯» → «Draw this
// screen». Pagine di ACQ: Bills e Sign-in (seme 11a). Laura scrive, Sara
// legge soltanto.

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const BILLS = "pp-acq-bills";
const SIGNIN_LAST = "blk-acq-signin-4";

type Wireframe = Extract<ProductBlock, { type: "wireframe" }>;

const page = (id: string) => state.productPages.find((p) => p.id === id)!;
const blockOf = (pageId: string, id: string) => page(pageId).blocks.find((b) => b.id === id);
const revisionsOf = (pageId: string) => state.productRevisions.filter((r) => r.pageId === pageId);
const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
const shellOf = (id: string) => body().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const announced = () => document.querySelector("[data-marks-announce]")?.textContent ?? "";
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

/** Il budget del mese finito (Roberta gestisce l'istanza), senza cambiare chi guarda. */
async function budgetUsedUp() {
  const before = getSessionPersonId();
  setSessionPersonId("p-roberta");
  try {
    await api.instance.simulateBudgetReached(true);
  } finally {
    setSessionPersonId(before);
  }
}

/** Una bozza disegnata da Claude per Laura dopo il primo blocco di Bills. */
function drawnOnBills(): string {
  return drawWireframeAs(LAURA, BILLS, { afterId: page(BILLS).blocks[0]!.id }).blockId;
}

async function open(pageId: string, person = LAURA) {
  const p = page(pageId);
  renderRoute(`/p/ACQ/docs/product/${p.code}`, person);
  await screen.findByRole("heading", { level: 1, name: p.title });
}

/** Il fuoco perso sul body (o su un nodo tolto) anche per un solo giro. */
function watchBody() {
  const hits: number[] = [];
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) hits.push(hits.length);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  return { hits, stop: () => observer.disconnect() };
}

describe("il blocco della bozza", () => {
  it("Laura: la figura con «Claude's draft · Screen sketch», lo schizzo con il suo nome, e i tre gesti", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const shell = shellOf(id);
    const figure = within(shell).getByRole("figure");
    expect(figure.querySelector("figcaption")).not.toBeNull();
    expect(flat(within(figure).getByText("Claude's draft").parentElement!)).toBe("Claude's draft · Screen sketch");
    expect(figure).toHaveAccessibleName("Claude's draft · Screen sketch");
    expect(within(figure).getByRole("img", { name: "Claude's draft: sketch of the bills screen" })).toBeInTheDocument();
    expect(within(figure).getByRole("img").querySelector("svg")).not.toBeNull();
    const actions = within(shell).getByRole("group", { name: "Sketch actions" });
    expect(within(actions).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Keep",
      "Redraw",
      "Replace with an image",
    ]);
  });

  it("in italiano il nome si compone in lettura: «Bozza di Claude: schizzo della schermata delle bollette»", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    act(() => setLanguage("it"));
    const shell = shellOf(id);
    expect(
      await within(shell).findByRole("img", { name: "Bozza di Claude: schizzo della schermata delle bollette" }),
    ).toBeInTheDocument();
    expect(within(shell).getByRole("button", { name: "Tieni" })).toBeInTheDocument();
    expect(within(shell).getByRole("button", { name: "Rifai" })).toBeInTheDocument();
  });

  it("Sara legge soltanto: l'etichetta e lo schizzo, nessun bottone", async () => {
    const id = drawnOnBills();
    await open(BILLS, SARA);
    const block = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
    expect(flat(block)).toContain("Claude's draft · Screen sketch");
    expect(within(block).getByRole("img", { name: "Claude's draft: sketch of the bills screen" })).toBeInTheDocument();
    expect(within(block).queryAllByRole("button")).toHaveLength(0);
  });

  it("un disegno che il seme non ha più: «This sketch is no longer available», e «Redraw» resta", async () => {
    const id = drawnOnBills();
    (blockOf(BILLS, id) as Wireframe).wireframeId = "gone-forever";
    await open(BILLS);
    const shell = shellOf(id);
    expect(flat(shell)).toContain("This sketch is no longer available");
    expect(within(shell).getByRole("button", { name: "Redraw" })).toBeInTheDocument();
    expect(within(shell).queryByRole("button", { name: "Keep" })).toBeNull();
  });
});

describe("«Redraw»", () => {
  it("la variante seguente sul posto, «New sketch»; il fuoco resta su «Redraw»; un doppio clic fa una sola scrittura", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const before = revisionsOf(BILLS).length;
    const redraw = within(shellOf(id)).getByRole("button", { name: "Redraw" });
    act(() => redraw.focus());
    act(() => {
      fireEvent.click(redraw);
      fireEvent.click(redraw);
    });
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).variant).toBe(1));
    await waitFor(() => expect(announced()).toBe("New sketch"));
    expect(revisionsOf(BILLS).length).toBe(before + 1);
    const again = within(shellOf(id)).getByRole("button", { name: "Redraw" });
    expect(again).toHaveFocus();
    expect(again.isConnected).toBe(true);
  });

  it("dopo «Keep» rimette l'etichetta", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const user = userEvent.setup();
    await user.click(within(shellOf(id)).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(within(shellOf(id)).queryByText("Claude's draft")).toBeNull());
    await user.click(within(shellOf(id)).getByRole("button", { name: "Redraw" }));
    await waitFor(() => expect(within(shellOf(id)).getByText("Claude's draft")).toBeInTheDocument());
    expect((blockOf(BILLS, id) as Wireframe).kept).toBeUndefined();
  });
});

describe("«Keep»", () => {
  it("toglie l'etichetta: una figura come le altre, «Screen sketch: …»; il fuoco va al blocco, mai sul body; un doppio clic, una scrittura", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const before = revisionsOf(BILLS).length;
    const keep = within(shellOf(id)).getByRole("button", { name: "Keep" });
    act(() => keep.focus());
    const watch = watchBody();
    act(() => {
      fireEvent.click(keep);
      fireEvent.click(keep);
    });
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).kept).toBe(true));
    await waitFor(() => expect(shellOf(id)).toHaveFocus());
    watch.stop();
    expect(watch.hits).toEqual([]);
    expect(keep.isConnected).toBe(false);
    expect(revisionsOf(BILLS).length).toBe(before + 1);
    const shell = shellOf(id);
    expect(within(shell).queryByText("Claude's draft")).toBeNull();
    expect(within(shell).getByRole("img", { name: "Screen sketch: sketch of the bills screen" })).toBeInTheDocument();
    expect(within(shell).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(within(shell).getByRole("button", { name: "Redraw" })).toBeInTheDocument();
    expect(within(shell).getByRole("button", { name: "Replace with an image" })).toBeInTheDocument();
    await waitFor(() => expect(announced()).toBe("Kept · the sketch is now a figure of the page"));
  });

  it("il livello dati rifiuta (`forbidden`) e la vista dice ancora «scrive»: «Keep» spento con «Keeping it is for people with Edit docs in ACQ · Who?»", async () => {
    const id = drawnOnBills();
    vi.spyOn(api.productDocs, "keepWireframe").mockRejectedValue(new Error("forbidden"));
    await open(BILLS);
    const user = userEvent.setup();
    const keep = within(shellOf(id)).getByRole("button", { name: "Keep" });
    await user.click(keep);
    await waitFor(() => expect(flat(shellOf(id))).toContain("Keeping it is for people with Edit docs in ACQ · Who?"));
    expect(keep).toHaveAttribute("aria-disabled", "true");
    expect(keep).toHaveFocus();
    expect(keep).toHaveAccessibleDescription(/Keeping it is for people with Edit docs in ACQ/);
    expect(within(shellOf(id)).getByRole("button", { name: /who can/i })).toHaveTextContent("Who?");
    expect((blockOf(BILLS, id) as Wireframe).kept).toBeUndefined();
  });

  it("permesso perso proprio al clic: la pagina torna in sola lettura (la riga col «Who?»), il fuoco sul titolo, mai sul body", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const user = userEvent.setup();
    const keep = within(shellOf(id)).getByRole("button", { name: "Keep" });
    keep.addEventListener("click", () => revokeProjectPermission(LAURA, ACQ, "docs.edit" as never), {
      capture: true,
      once: true,
    });
    const watch = watchBody();
    await user.click(keep);
    await waitFor(() => expect(flat(document.body)).toContain("You can read this page. Editing is for people with Edit docs in ACQ"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Bills" })).toHaveFocus());
    watch.stop();
    expect(watch.hits).toEqual([]);
    const block = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
    expect(within(block).queryAllByRole("button")).toHaveLength(0);
    expect((blockOf(BILLS, id) as Wireframe).kept).toBeUndefined();
  });
});

describe("«Replace with an image»", () => {
  it("la scelta del file; l'immagine prende il posto del blocco (stesso id) e il fuoco va alla sua didascalia", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const id = drawnOnBills();
    await open(BILLS);
    const user = userEvent.setup();
    const replace = within(shellOf(id)).getByRole("button", { name: "Replace with an image" });
    await user.click(replace);
    await waitFor(() => expect(click).toHaveBeenCalled());
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const watch = watchBody();
    act(() => {
      fireEvent.change(chooser, {
        target: { files: [new File([new Uint8Array(1024)], "bills.png", { type: "image/png" })] },
      });
    });
    await waitFor(() => expect(blockOf(BILLS, id)).toMatchObject({ id, type: "image", caption: "", alt: "bills" }));
    const caption = await within(shellOf(id)).findByRole("textbox", { name: "Caption" });
    await waitFor(() => expect(caption).toHaveFocus());
    watch.stop();
    expect(watch.hits).toEqual([]);
    // La cronologia lo dice, con la persona (non Claude) e il suo «Undo».
    await user.click(screen.getByRole("button", { name: "History" }));
    const history = await screen.findByRole("region", { name: "History" });
    await waitFor(() => expect(flat(history)).toContain("Laura CostaReplaced the screen sketch with an image"));
  });

  it("un file rifiutato: la frase sotto il blocco, e la bozza resta", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const id = drawnOnBills();
    await open(BILLS);
    const user = userEvent.setup();
    await user.click(within(shellOf(id)).getByRole("button", { name: "Replace with an image" }));
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    act(() => {
      fireEvent.change(chooser, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Only PNG, JPEG, GIF and WebP images");
    expect(blockOf(BILLS, id)).toMatchObject({ type: "wireframe" });
  });
});

describe("la cronologia dice cosa è successo alla bozza", () => {
  it("«Drew a screen sketch», «Redrew the screen sketch», «Kept the screen sketch»", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const user = userEvent.setup();
    await user.click(within(shellOf(id)).getByRole("button", { name: "Redraw" }));
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).variant).toBe(1));
    await user.click(within(shellOf(id)).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).kept).toBe(true));
    await user.click(screen.getByRole("button", { name: "History" }));
    const history = await screen.findByRole("region", { name: "History" });
    await waitFor(() => expect(flat(history)).toContain("Kept the screen sketch"));
    expect(flat(history)).toContain("Redrew the screen sketch");
    expect(flat(history)).toContain("Drew a screen sketch");
  });
});

// --- disegnare -----------------------------------------------------------------

function input(el: HTMLElement, inputType: string, data: string | null = null) {
  act(() => {
    el.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }));
  });
}
const editing = () => document.querySelector<HTMLElement>("[data-editing]")!;
const textbox = (text: string) =>
  within(body())
    .getAllByRole("textbox")
    .find((el) => el.textContent === text)!;

function emptySignInBlock() {
  const p = page("pp-acq-sign-in");
  p.blocks = p.blocks.map((b) =>
    b.id === SIGNIN_LAST ? ({ id: SIGNIN_LAST, type: "paragraph", content: plain("") } as ProductBlock) : b,
  );
}

describe("«/» → «Screen sketch»", () => {
  it("la voce c'è per chi scrive; scelta, la bozza prende il posto del paragrafo vuoto, il fuoco sul blocco nuovo e «Sketch added»", async () => {
    emptySignInBlock();
    await open("pp-acq-sign-in");
    const user = userEvent.setup();
    await user.click(textbox(""));
    input(editing(), "insertText", "/");
    const menu = await screen.findByRole("listbox", { name: "Blocks" });
    input(editing(), "insertText", "sketch");
    await waitFor(() => expect(within(menu).getAllByRole("option").map((o) => o.textContent)).toEqual(["Screen sketch"]));
    const watch = watchBody();
    act(() => {
      fireEvent.keyDown(editing(), { key: "Enter" });
    });
    await waitFor(() =>
      expect(blockOf("pp-acq-sign-in", SIGNIN_LAST)).toMatchObject({ id: SIGNIN_LAST, type: "wireframe", wireframeId: "sign-in" }),
    );
    await waitFor(() => expect(shellOf(SIGNIN_LAST)).toHaveFocus());
    await waitFor(() => expect(announced()).toBe("Sketch added"));
    watch.stop();
    expect(watch.hits).toEqual([]);
    expect(within(shellOf(SIGNIN_LAST)).getByRole("img", { name: "Claude's draft: sketch of the sign-in screen" })).toBeInTheDocument();
  });

  it("col budget del mese finito la voce è spenta con la sua frase, e sceglierla non disegna", async () => {
    await budgetUsedUp();
    emptySignInBlock();
    await open("pp-acq-sign-in");
    const user = userEvent.setup();
    await user.click(textbox(""));
    input(editing(), "insertText", "/");
    const menu = await screen.findByRole("listbox", { name: "Blocks" });
    input(editing(), "insertText", "sketch");
    const option = await within(menu).findByRole("option", { name: /Screen sketch/ });
    await waitFor(() => expect(option).toHaveAttribute("aria-disabled", "true"));
    expect(option).toHaveTextContent("The monthly AI budget is used up");
    // Fix round 1 (M2): la frase è la descrizione, non parte del nome.
    expect(option).toHaveAccessibleName("Screen sketch");
    expect(option).toHaveAccessibleDescription("The monthly AI budget is used up");
    act(() => {
      fireEvent.keyDown(editing(), { key: "Enter" });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(blockOf("pp-acq-sign-in", SIGNIN_LAST)).toMatchObject({ type: "paragraph" });
  });
});

describe("«⋯» → «Draw this screen»", () => {
  async function chooseDraw() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More for this page" }));
    const menu = await screen.findByRole("menu", { name: "More for this page" });
    return { user, menu, item: within(menu).getByRole("menuitem", { name: "Draw this screen" }) };
  }

  it("dopo il blocco che aveva il cursore; il fuoco va alla bozza nuova; un doppio clic fa una sola bozza", async () => {
    const draw = vi.spyOn(api.productDocs, "drawWireframe");
    await open(BILLS);
    const target = page(BILLS).blocks[1]!;
    const user = userEvent.setup();
    const text = within(body()).getAllByRole("textbox").find((el) => el.textContent === (target as { content: { text: string } }).content.text)!;
    await user.click(text);
    await waitFor(() => expect(editing()).toBeTruthy());
    act(() => placeCaret(editing(), 0));
    const before = page(BILLS).blocks.length;
    const { item } = await chooseDraw();
    act(() => {
      fireEvent.click(item);
      fireEvent.click(item);
    });
    await waitFor(() => expect(page(BILLS).blocks.length).toBe(before + 1));
    const blocks = page(BILLS).blocks;
    const at = blocks.findIndex((b) => b.id === target.id);
    const drawn = blocks[at + 1]!;
    expect(drawn).toMatchObject({ type: "wireframe" });
    await waitFor(() => expect(shellOf(drawn.id)).toHaveFocus());
    expect(draw).toHaveBeenCalledTimes(1);
    expect(blocks.filter((b) => b.type === "wireframe")).toHaveLength(1);
  });

  it("revisione Impeccable 7: mentre Claude disegna il fuoco sta sul posto della bozza, mai sul titolo né sul body; poi sulla bozza", async () => {
    await open(BILLS);
    const { user, item } = await chooseDraw();
    setLatency(400);
    const body = watchBody();
    const visited: Element[] = [];
    const onFocusIn = (e: FocusEvent) => visited.push(e.target as Element);
    document.addEventListener("focusin", onFocusIn);
    await user.click(item);
    const sketching = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-sketching]");
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(document.activeElement).toBe(sketching));
    expect(sketching).toHaveAccessibleName("Claude is sketching…");
    await waitFor(() => expect(page(BILLS).blocks.at(-1)).toMatchObject({ type: "wireframe" }), { timeout: 3000 });
    const drawn = page(BILLS).blocks.at(-1)!.id;
    await waitFor(() => expect(shellOf(drawn)).toHaveFocus(), { timeout: 3000 });
    document.removeEventListener("focusin", onFocusIn);
    body.stop();
    expect(body.hits).toEqual([]);
    expect(visited.filter((el) => el.tagName === "H1" || el.closest("h1"))).toEqual([]);
  });

  it("revisione Impeccable 7: un disegno che non riesce rimette il fuoco su «⋯», non sul body", async () => {
    await open(BILLS);
    const { user, item } = await chooseDraw();
    failNext("productDocs.drawWireframe");
    const body = watchBody();
    await user.click(item);
    await screen.findByText("Couldn't draw the sketch. Nothing was changed.");
    await waitFor(() => expect(document.querySelector("[data-sketching]")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for this page" }));
    body.stop();
    expect(body.hits).toEqual([]);
  });

  it("senza un cursore, in fondo alla pagina", async () => {
    await open(BILLS);
    const last = page(BILLS).blocks.at(-1)!.id;
    const { user, item } = await chooseDraw();
    await user.click(item);
    await waitFor(() => expect(page(BILLS).blocks.at(-1)).toMatchObject({ type: "wireframe" }));
    expect(page(BILLS).blocks.at(-2)!.id).toBe(last);
  });

  it("col budget finito è spenta con «The monthly AI budget is used up · Who?»", async () => {
    await budgetUsedUp();
    await open(BILLS);
    const { menu } = await chooseDraw();
    const item = within(menu).getByRole("menuitem", { name: /Draw this screen/ });
    await waitFor(() => expect(item).toHaveAttribute("aria-disabled", "true"));
    expect(flat(menu)).toContain("The monthly AI budget is used up");
    expect(within(menu).getAllByRole("menuitem", { name: /who can/i }).length).toBeGreaterThan(0);
  });

  it("Sara: nel «⋯» niente gruppo di Claude", async () => {
    await open(BILLS, SARA);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More for this page" }));
    const menu = await screen.findByRole("menu", { name: "More for this page" });
    expect(within(menu).queryByRole("menuitem", { name: /Draw this screen/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Propose backlog items/ })).toBeNull();
  });
});

// --- fix round 1 ---------------------------------------------------------------

describe("fix round 1: il fuoco non cade mai sul body", () => {
  it("I1: «Redraw» dopo «Keep» rimette la testata; il fuoco segue «Redraw» nel posto nuovo, mai sul body", async () => {
    const id = drawnOnBills();
    await open(BILLS);
    const user = userEvent.setup();
    await user.click(within(shellOf(id)).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).kept).toBe(true));
    const corner = within(shellOf(id)).getByRole("button", { name: "Redraw" });
    act(() => corner.focus());
    const watch = watchBody();
    await user.click(corner);
    await waitFor(() => expect(within(shellOf(id)).getByText("Claude's draft")).toBeInTheDocument());
    const redraw = within(shellOf(id)).getByRole("button", { name: "Redraw" });
    await waitFor(() => expect(redraw).toHaveFocus());
    watch.stop();
    expect(watch.hits).toEqual([]);
    expect(redraw.isConnected).toBe(true);
    // Il bottone dell'angolo è stato rimontato nella testata: non è più lo stesso nodo.
    expect(corner.isConnected).toBe(false);
  });

  it("I2: «Couldn't redraw · Retry»: il fuoco passa a «Redraw» prima che la riga se ne vada", async () => {
    const id = drawnOnBills();
    const real = api.productDocs.redrawWireframe;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(api.productDocs, "redrawWireframe")
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(((...args: Parameters<typeof real>) => gate.then(() => real(...args))) as typeof real);
    await open(BILLS);
    const user = userEvent.setup();
    await user.click(within(shellOf(id)).getByRole("button", { name: "Redraw" }));
    const alert = await within(shellOf(id)).findByRole("alert");
    expect(flat(alert)).toMatch(/Couldn't redraw\s*·\s*Retry/);
    const retry = within(alert).getByRole("button", { name: "Retry" });
    const watch = watchBody();
    await user.click(retry);
    // In corso: la riga se n'è andata, il fuoco è già sul gesto (che resta, «Redrawing…»).
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(within(shellOf(id)).getByRole("button", { name: "Redrawing…" })).toHaveFocus();
    release();
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).variant).toBe(1));
    await waitFor(() => expect(within(shellOf(id)).getByRole("button", { name: "Redraw" })).toHaveFocus());
    watch.stop();
    expect(watch.hits).toEqual([]);
  });

  it("I2: «Couldn't keep it · Retry»: il fuoco passa a «Keep», poi al blocco tenuto; mai sul body", async () => {
    const id = drawnOnBills();
    const real = api.productDocs.keepWireframe;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(api.productDocs, "keepWireframe")
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(((...args: Parameters<typeof real>) => gate.then(() => real(...args))) as typeof real);
    await open(BILLS);
    const user = userEvent.setup();
    await user.click(within(shellOf(id)).getByRole("button", { name: "Keep" }));
    const alert = await within(shellOf(id)).findByRole("alert");
    expect(flat(alert)).toMatch(/Couldn't keep it\s*·\s*Retry/);
    const retry = within(alert).getByRole("button", { name: "Retry" });
    const watch = watchBody();
    await user.click(retry);
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(within(shellOf(id)).getByRole("button", { name: "Keeping…" })).toHaveFocus();
    release();
    await waitFor(() => expect((blockOf(BILLS, id) as Wireframe).kept).toBe(true));
    await waitFor(() => expect(shellOf(id)).toHaveFocus());
    watch.stop();
    expect(watch.hits).toEqual([]);
  });
});

describe("fix round 1, I3: «Redraw» col budget del mese finito", () => {
  for (const [lang, redrawName, sentence, keepName] of [
    ["en", "Redraw", "The monthly AI budget is used up", "Keep"],
    ["it", "Rifai", "Il budget mensile per l'AI è esaurito", "Tieni"],
  ] as const) {
    it(`${lang}: spenta con la sua frase e il «Who?»; «Keep» resta`, async () => {
      const id = drawnOnBills();
      await budgetUsedUp();
      await open(BILLS);
      if (lang === "it") act(() => setLanguage("it"));
      const shell = shellOf(id);
      const redraw = await within(shell).findByRole("button", { name: redrawName });
      await waitFor(() => expect(redraw).toHaveAttribute("aria-disabled", "true"));
      expect(redraw).toHaveAccessibleDescription(new RegExp(sentence));
      expect(within(shell).getAllByRole("button").some((b) => /Who\?|Chi\?/.test(b.textContent ?? ""))).toBe(true);
      expect(within(shell).getByRole("button", { name: keepName })).not.toHaveAttribute("aria-disabled");
      const before = revisionsOf(BILLS).length;
      const user = userEvent.setup();
      await user.click(redraw);
      await new Promise((r) => setTimeout(r, 20));
      expect(revisionsOf(BILLS).length).toBe(before);
      expect(within(shellOf(id)).queryByRole("alert")).toBeNull();
    });
  }
});

describe("fix round 1, M6: la sola lettura non ruba un fuoco che non era nella pagina", () => {
  it("il fuoco già sul body quando la pagina torna in sola lettura: il titolo non lo prende", async () => {
    await open(BILLS);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    act(() => {
      revokeProjectPermission(LAURA, ACQ, "docs.edit" as never);
      // La pagina si rilegge (un evento della pagina, come una scrittura altrui).
      emitProductPage(BILLS, "blocks");
    });
    await waitFor(() => expect(flat(document.body)).toContain("You can read this page"));
    expect(screen.getByRole("heading", { level: 1, name: "Bills" })).not.toHaveFocus();
  });
});

describe("fix round 1, M1: una scrittura fallita non blocca il disegno", () => {
  it("salvataggio fallito, poi «Draw this screen»: la bozza arriva e «Claude is sketching…» se ne va", async () => {
    await open(BILLS);
    const target = page(BILLS).blocks.at(-1)!;
    const user = userEvent.setup();
    const text = within(body())
      .getAllByRole("textbox")
      .find((el) => el.textContent === (target as { content: { text: string } }).content.text)!;
    await user.click(text);
    await waitFor(() => expect(editing()).toBeTruthy());
    act(() => placeCaret(editing(), 0));
    failNext("productDocs.saveProductBlocks");
    input(editing(), "insertText", "X");
    await user.click(screen.getByRole("button", { name: "More for this page" }));
    const menu = await screen.findByRole("menu", { name: "More for this page" });
    await user.click(within(menu).getByRole("menuitem", { name: "Draw this screen" }));
    await waitFor(() => expect(page(BILLS).blocks.some((b) => b.type === "wireframe")).toBe(true));
    await waitFor(() => expect(document.querySelector("[data-sketching]")).toBeNull());
  });
});
