import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failNext, productDocs, resetApi, setLatency, setStreamLatency } from "../../../data/api";
import { addProductCommentAs } from "../../../data/productDocs/comments";
import { answerProductQuestionAs } from "../../../data/productDocs/questions";
import { createProductPageAs } from "../../../data/productDocs/writes";
import { revokeProjectPermission } from "../../../data/viewer";
import { firstVersionWayFreshKey, isFresh } from "../parts";
import {
  openProductQuestions,
  productFirstVersionOf,
  startFirstVersionAs,
  whenFirstVersionIdle,
} from "../../../data/productDocs/firstVersion";
import { deleteProductPageAs, writeProductBlocksAs } from "../../../data/productDocs/writes";
import { pauseQueueAs } from "../../../data/instance/queue";
import { VRD_FIRST_VERSION, VRD_IDS } from "../../../data/seed/productDocs/vrdFirstVersion";
import { state } from "../../../data/store";
import type { ProductBlock } from "../../../data/types";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// La prima versione di Claude nello spazio Prodotto (11b, Task 11; shape
// product-claude-questions.md §3.6, [PQ 6]–[PQ 9]). VRD è vuoto nel seme:
// Laura (`docs.edit`) la lancia dalla prima strada, sceglie le fonti nella
// finestra, guarda le pagine arrivare una per una e, in cima a ogni pagina,
// accetta o annulla tutto. Sara legge soltanto; Marco tocca una pagina e
// «Undo the first version» si spegne col suo nome.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const VRD: string = VRD_IDS.projectId;
const INDEX = "/p/VRD/docs/product";
const TEXT = { kind: "text", text: "Notes from the kickoff: classes are booked a week ahead." } as const;
const EMAIL = { kind: "email", id: VRD_IDS.lauraEmailId } as const;

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  await act(() => whenFirstVersionIdle());
  setStreamLatency(null);
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
/** Le righe col «·» fra elementi flessibili non hanno spazi nel testo: si normalizza. */
const dotted = (el: Element) => flat(el).replace(/\s*·\s*/g, " · ");
const vrdPages = () => state.productPages.filter((p) => p.projectId === VRD);

/** Il fuoco perso sul body anche per un solo giro: a ogni mutazione del DOM si guarda dov'è. */
function watchBody() {
  const hits: string[] = [];
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) hits.push(String(hits.length));
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  return { hits, stop: () => observer.disconnect() };
}

function expectFocusAlive() {
  const active = document.activeElement;
  expect(active && active !== document.body && active.isConnected).toBe(true);
}

async function openIndex(person = LAURA) {
  renderRoute(INDEX, person);
  await screen.findByRole("heading", { level: 1, name: /^(Product|Prodotto)$/ });
}

const ways = () => screen.getByRole("list", { name: /^(Ways to start|Da dove cominciare)$/ });
const firstWay = () =>
  screen.getByRole("button", { name: /^(Write the first version with Claude|Scrivi la prima versione con Claude)/ });

/** Lancia la prima versione dal livello dati e aspetta che finisca. */
async function written(sources: Parameters<typeof startFirstVersionAs>[2] = [EMAIL, TEXT, { kind: "drive", fileId: VRD_IDS.driveFileId }]) {
  startFirstVersionAs(LAURA, VRD, sources);
  await whenFirstVersionIdle();
}

const firstPage = () => vrdPages().find((p) => p.parentId === null)!;

async function openPage(code: string, person = LAURA) {
  renderRoute(`${INDEX}/${code}`, person);
  const title = state.productPages.find((p) => p.code === code)!.title;
  return screen.findByRole("heading", { level: 1, name: title });
}

const banner = () => screen.findByRole("region", { name: /^(First version by Claude|Prima versione di Claude)$/ });

describe("lo spazio vuoto: le due strade", () => {
  it("Laura: «Write the first version with Claude» per prima, con la sua frase; poi «Start from a blank page»", async () => {
    await openIndex();
    const rows = within(ways()).getAllByRole("button");
    expect(rows.map(flat)).toEqual([
      "Write the first version with Claude Claude drafts the pages from the emails, meetings, notes and files you choose. Anything unclear becomes a question.",
      "Start from a blank page",
    ]);
    expect(rows[0]).not.toHaveAttribute("aria-disabled");
  });

  it("Sara (legge soltanto): la sola riga, spenta, con «Writing the first version is for people with Edit docs in VRD · Who?»", async () => {
    await openIndex(SARA);
    expect(screen.getByText("When someone writes the first page, it shows up here.")).toBeInTheDocument();
    const row = firstWay();
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: /start from a blank page/i })).toBeNull();
    const why = document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(flat(why)).toBe("Writing the first version is for people with Edit docs in VRD · Who?");
    expect(within(why).getByRole("button", { name: /^Who/ })).toBeInTheDocument();
    // Spenta, il clic non apre niente.
    await userEvent.setup().click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("col budget del mese finito: spenta, con la frase del budget e «Who?»", async () => {
    state.instance.simulate.budgetReached = true;
    await openIndex();
    const row = firstWay();
    await waitFor(() => expect(row).toHaveAttribute("aria-disabled", "true"));
    const why = document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(flat(why)).toBe(
      "The monthly AI budget is used up: Claude can't answer until it's raised or the month ends. Who?",
    );
    expect(within(why).getByRole("button", { name: /^Who/ })).toBeInTheDocument();
    await userEvent.setup().click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
    // «Start from a blank page» non dipende dal budget.
    expect(screen.getByRole("button", { name: "Start from a blank page" })).toBeEnabled();
  });

  it("la coda in pausa non la spegne (P48)", async () => {
    expect(pauseQueueAs(ROBERTA, VRD)).toEqual({ ok: true });
    await openIndex();
    expect(firstWay()).not.toHaveAttribute("aria-disabled");
  });

  it("in italiano, composta in lettura", async () => {
    act(() => setLanguage("it"));
    await openIndex();
    expect(flat(within(ways()).getAllByRole("button")[0]!)).toBe(
      "Scrivi la prima versione con Claude Claude scrive le pagine dalle email, riunioni, note e file che scegli. Ciò che non è chiaro diventa una domanda.",
    );
  });
});

describe("la finestra delle fonti", () => {
  it("le fonti che Laura apre, la nota sulla riservatezza, «Write the first version» spento senza fonti con la frase", async () => {
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog", { name: "Write the first version with Claude" });
    expect(dialog).toHaveTextContent(
      "Choose what Claude reads. It writes only what the sources say clearly; anything unclear becomes a question on the sentence.",
    );
    const emails = await within(dialog).findByRole("group", { name: "Emails" });
    expect(within(emails).getByRole("checkbox", { name: /Booking rules for the classes/ })).toBeInTheDocument();
    expect(within(emails).getByRole("checkbox", { name: /Membership plans and prices/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Meetings" })).toHaveTextContent("No meetings in VRD");
    expect(within(dialog).getByRole("textbox", { name: "Pasted text" })).toHaveAttribute(
      "placeholder",
      "Paste notes, a brief or minutes…",
    );
    const files = within(dialog).getByRole("group", { name: "Drive files" });
    expect(within(files).getByRole("checkbox", { name: /VRD-F1/ })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Everyone who reads VRD's docs will read what Claude writes from these sources. The emails themselves stay visible only to the people who received them.",
    );
    // Il fuoco sulla prima casella.
    await waitFor(() => expect(within(emails).getAllByRole("checkbox")[0]).toHaveFocus());
    const start = within(dialog).getByRole("button", { name: "Write the first version" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(flat(document.getElementById(start.getAttribute("aria-describedby")!)!)).toBe(
      "Choose at least one source, or paste some text.",
    );
    const write = vi.spyOn(productDocs, "startFirstVersion");
    await user.click(start);
    expect(write).not.toHaveBeenCalled();
    // Una fonte: «1 source», e il bottone si accende.
    await user.click(within(emails).getAllByRole("checkbox")[0]!);
    expect(dialog).toHaveTextContent("1 source");
    expect(start).not.toHaveAttribute("aria-disabled");
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "Kickoff notes");
    expect(dialog).toHaveTextContent("2 sources");
  });

  it("Esc chiude e il fuoco torna alla riga; Cancel lo stesso", async () => {
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    await screen.findByRole("dialog", { name: "Write the first version with Claude" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(firstWay()).toHaveFocus();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(firstWay()).toHaveFocus();
  });

  it("budget finito fra la lettura e il clic: la frase del budget col «Who?», la finestra resta", async () => {
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "notes");
    state.instance.simulate.budgetReached = true;
    await user.click(within(dialog).getByRole("button", { name: "Write the first version" }));
    const alert = await within(dialog).findByRole("alert");
    expect(flat(alert)).toBe(
      "The monthly AI budget is used up: Claude can't answer until it's raised or the month ends. Who?",
    );
    expect(vrdPages()).toEqual([]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("qualcuno ha aggiunto una pagina nel frattempo: la frase e «Close», che chiude senza lasciare il fuoco sul body", async () => {
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "notes");
    // Marco crea una pagina mentre Laura sceglie.
    const { createProductPageAs } = await import("../../../data/productDocs/writes");
    createProductPageAs(MARCO, VRD, { title: "Marco's page", parentId: null });
    await user.click(within(dialog).getByRole("button", { name: "Write the first version" }));
    const alert = await within(dialog).findByRole("alert");
    expect(flat(alert)).toContain(
      "Someone added a page in the meantime: the first version starts only in an empty space.",
    );
    await user.click(within(alert).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expectFocusAlive();
  });
});

describe("l'avanzamento", () => {
  it("un doppio clic su «Write the first version» avvia una volta; il fuoco va al titolo dell'avanzamento, mai sul body; le pagine arrivano una per una, poi l'albero", async () => {
    setStreamLatency(25);
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    const emails = await within(dialog).findByRole("group", { name: "Emails" });
    await user.click(within(emails).getByRole("checkbox", { name: /Booking rules for the classes/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "Kickoff notes");
    const write = vi.spyOn(productDocs, "startFirstVersion");
    const body = watchBody();
    await user.dblClick(within(dialog).getByRole("button", { name: "Write the first version" }));
    const title = await screen.findByRole("heading", { name: "Claude is writing the first version" });
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    expect(state.productFirstVersions).toHaveLength(1);
    const total = VRD_FIRST_VERSION.length;
    // Durante: «N of M pages · for Laura Costa», una riga che sta scrivendo.
    const list = screen.getByRole("list", { name: "Pages of the first version" });
    await waitFor(() => expect(within(list).getByText("writing…")).toBeInTheDocument());
    expect(screen.getByText(new RegExp(`^\\d+ of ${total} pages · for Laura Costa$`))).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByRole("link").length).toBeGreaterThan(0));
    // Fine.
    await act(() => whenFirstVersionIdle());
    await screen.findByRole("heading", { name: "Claude wrote the first version" });
    const questions = openProductQuestions(LAURA, VRD).count;
    expect(
      screen.getByText(
        questions > 0 ? `${total} pages · ${questions} question${questions === 1 ? "" : "s"} to close` : `${total} pages`,
      ),
    ).toBeInTheDocument();
    expect(within(list).getAllByRole("link")).toHaveLength(total);
    expect(within(list).queryByText("writing…")).toBeNull();
    const open = screen.getByRole("link", { name: "Open the first page" });
    expect(open).toHaveAttribute("href", `${INDEX}/${firstPage().code}`);
    // L'albero ha le pagine.
    const tree = screen.getByRole("tree");
    expect(within(tree).getByRole("treeitem", { name: /Overview/ })).toBeInTheDocument();
    body.stop();
    expect(body.hits).toEqual([]);
  });

  it("l'annuncio dice ogni pagina scritta, e la fine", async () => {
    setStreamLatency(20);
    await openIndex();
    act(() => void startFirstVersionAs(LAURA, VRD, [TEXT]));
    const live = () => document.querySelector("[data-first-version-announce]")!;
    await waitFor(() => expect(live().textContent).toBe(`${VRD_FIRST_VERSION[0]!.title} written`));
    await act(() => whenFirstVersionIdle());
    await waitFor(() => expect(live().textContent).toBe("Claude wrote the first version"));
  });

  it("Sara vede l'avanzamento lanciato da Laura, senza la riga per lanciarla", async () => {
    setStreamLatency(25);
    await openIndex(SARA);
    act(() => void startFirstVersionAs(LAURA, VRD, [TEXT]));
    expect(await screen.findByRole("heading", { name: "Claude is writing the first version" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Write the first version with Claude/ })).toBeNull();
  });

  it("interrotta a metà (una pagina tolta): l'elenco si ferma, «Claude stopped the first version», niente «wrote»", async () => {
    setStreamLatency(20);
    await openIndex();
    let deleted = false;
    const stop = productDocs.onProductFirstVersion(() => {
      const view = productFirstVersionOf(LAURA, VRD)!;
      if (view.pagesDone === 2 && !deleted) {
        deleted = true;
        deleteProductPageAs(LAURA, view.pages[0]!.pageId!);
      }
    });
    act(() => void startFirstVersionAs(LAURA, VRD, [TEXT]));
    await screen.findByRole("heading", { name: "Claude is writing the first version" });
    await act(() => whenFirstVersionIdle());
    stop();
    await screen.findByRole("heading", { name: "Claude stopped the first version" });
    expect(screen.queryByRole("heading", { name: "Claude wrote the first version" })).toBeNull();
    expect(screen.getByText(`2 of ${VRD_FIRST_VERSION.length} pages written`)).toBeInTheDocument();
  });

  it("in italiano", async () => {
    act(() => setLanguage("it"));
    setStreamLatency(25);
    await openIndex();
    act(() => void startFirstVersionAs(LAURA, VRD, [TEXT]));
    expect(await screen.findByRole("heading", { name: "Claude sta scrivendo la prima versione" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(new RegExp(`^\\d+ di ${VRD_FIRST_VERSION.length} pagine · per Laura Costa$`))).toBeInTheDocument(),
    );
    await act(() => whenFirstVersionIdle());
    expect(await screen.findByRole("heading", { name: "Claude ha scritto la prima versione" })).toBeInTheDocument();
  });

  it("dalla visita successiva l'indice torna normale", async () => {
    await written([TEXT]);
    await openIndex();
    expect(screen.queryByRole("heading", { name: /first version/ })).toBeNull();
    expect(screen.getByRole("list", { name: "All pages" })).toBeInTheDocument();
  });
});

describe("la riga in cima alla pagina", () => {
  it("«First version written by Claude on behalf of Laura Costa», le fonti, «Accept» e «Undo the first version»", async () => {
    await written();
    await openPage(firstPage().code);
    const row = await banner();
    expect(flat(row)).toContain("First version written by Claude on behalf of Laura Costa");
    expect(row.querySelector("[data-source-line]")).not.toBeNull();
    expect(within(row).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Undo the first version" })).not.toHaveAttribute("aria-disabled");
  });

  it("«Accept» toglie la riga da questa pagina, il fuoco va all'h1 senza passare dal body, un doppio clic scrive una volta", async () => {
    await written([TEXT]);
    await openPage(firstPage().code);
    const row = await banner();
    const accept = vi.spyOn(productDocs, "acceptFirstVersionPage");
    const body = watchBody();
    await userEvent.setup().dblClick(within(row).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "First version by Claude" })).toBeNull());
    expect(accept).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
    body.stop();
    expect(body.hits).toEqual([]);
    await waitFor(() => expect(document.querySelector("[data-marks-announce]")!.textContent).toBe("Accepted"));
    // Le altre pagine la tengono.
    expect(productFirstVersionOf(LAURA, VRD)!.bannerPageIds).toHaveLength(vrdPages().length - 1);
  });

  it("«Undo the first version»: la conferma; Esc rende il fuoco al bottone; confermata, l'indice vuoto col fuoco sulla prima strada, mai sul body", async () => {
    const user = userEvent.setup();
    await written([TEXT]);
    await openPage(firstPage().code);
    const row = await banner();
    const undo = within(row).getByRole("button", { name: "Undo the first version" });
    await user.click(undo);
    const ask = await screen.findByRole("dialog", { name: "Undo the first version?" });
    expect(ask).toHaveTextContent(
      `All ${vrdPages().length} pages Claude wrote are removed, with their comments and questions. Their codes aren't reused. This can't be undone.`,
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(undo).toHaveFocus();
    await user.click(undo);
    const again = await screen.findByRole("dialog", { name: "Undo the first version?" });
    const write = vi.spyOn(productDocs, "undoFirstVersion");
    const body = watchBody();
    await user.dblClick(within(again).getByRole("button", { name: "Undo the first version" }));
    await waitFor(() => expect(firstWay()).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    expect(vrdPages()).toEqual([]);
    expect(within(ways()).getAllByRole("button")).toHaveLength(2);
    body.stop();
    expect(body.hits).toEqual([]);
  });

  it("dopo un tocco di Marco «Undo the first version» è spento: «Marco Bellini edited “…” afterwards»; Accept resta", async () => {
    await written([TEXT]);
    const page = firstPage();
    const block = page.blocks[0]!;
    writeProductBlocksAs(
      MARCO,
      page.id,
      [{ op: "set", block: { ...block, content: { text: "Marco's words", marks: [] } } as ProductBlock }],
      { sessionId: "s-marco" },
    );
    await openPage(page.code);
    const row = await banner();
    const undo = within(row).getByRole("button", { name: "Undo the first version" });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    const why = document.getElementById(undo.getAttribute("aria-describedby")!)!;
    expect(flat(why)).toBe(`Marco Bellini edited “${page.title}” afterwards · Who?`);
    expect(within(why).getByRole("button", { name: /^Who/ })).toBeInTheDocument();
    expect(within(why).getByRole("link", { name: `“${page.title}”` })).toHaveAttribute("href", `${INDEX}/${page.code}`);
    await userEvent.setup().click(undo);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(row).getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it("Sara: la frase, nessun bottone, «Accepting or undoing it is for people with Edit docs in VRD · Who?», poi la riga di sola lettura", async () => {
    await written([TEXT]);
    await openPage(firstPage().code, SARA);
    const row = await banner();
    expect(within(row).queryByRole("button", { name: "Accept" })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(flat(row)).toContain("Accepting or undoing it is for people with Edit docs in VRD · Who?");
    expect(within(row).getByRole("button", { name: /^Who/ })).toBeInTheDocument();
    // Prima questa, poi la sola lettura.
    const readOnly = screen.getByText(/You can read this page/);
    expect(row.compareDocumentPosition(readOnly) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("interrotta: la riga lo dice («Claude stopped after 2 of N pages.»)", async () => {
    let deleted = false;
    const stop = productDocs.onProductFirstVersion(() => {
      const view = productFirstVersionOf(LAURA, VRD)!;
      if (view.pagesDone === 2 && !deleted) {
        deleted = true;
        deleteProductPageAs(LAURA, view.pages[0]!.pageId!);
      }
    });
    await written([TEXT]);
    stop();
    await openPage(vrdPages()[0]!.code);
    const row = await banner();
    expect(flat(row)).toContain(`Claude stopped after 2 of ${VRD_FIRST_VERSION.length} pages.`);
  });

  it("in italiano", async () => {
    act(() => setLanguage("it"));
    await written([TEXT]);
    await openPage(firstPage().code);
    const row = await screen.findByRole("region", { name: "Prima versione di Claude" });
    expect(flat(row)).toContain("Prima versione scritta da Claude per conto di Laura Costa");
    expect(within(row).getByRole("button", { name: "Accetta" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Annulla la prima versione" })).toBeInTheDocument();
  });
});

describe("a 1024", () => {
  it("la finestra: 560 di larghezza, al più 80vh, i gruppi scorrono e i bottoni restano in fondo", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog", { name: "Write the first version with Claude" });
    expect(dialog.style.width).toBe("560px");
    expect(dialog.className).toContain("max-h-[80vh]");
    const scroller = dialog.querySelector("[data-dialog-body]")!;
    expect(scroller.className).toContain("overflow-y-auto");
    const footer = dialog.querySelector("footer")!;
    expect(scroller.contains(footer)).toBe(false);
    expect(within(footer).getByRole("button", { name: "Write the first version" })).toBeInTheDocument();
  });
});

// --- Fix round 1 del Task 11 ------------------------------------------------------

const vrdQuestions = () => {
  const ids = new Set(vrdPages().map((p) => p.id));
  return state.productComments.filter((c) => ids.has(c.pageId) && c.question !== undefined);
};

/** La frase dello «Undo» spento sulla prima pagina, come la legge Laura. */
async function undoReason() {
  await openPage(firstPage().code);
  const row = await banner();
  const undo = within(row).getByRole("button", { name: /^(Undo the first version|Annulla la prima versione)$/ });
  expect(undo).toHaveAttribute("aria-disabled", "true");
  const why = document.getElementById(undo.getAttribute("aria-describedby")!)!;
  expect(within(why).getByRole("button", { name: /^(Who|Chi)/ })).toBeInTheDocument();
  return flat(why);
}

describe("fix round 1 — «Undo» spento: chi ha toccato, e «Who?» (M3)", () => {
  it("un commento di Marco", async () => {
    await written();
    const page = vrdPages().find((p) => p.title === "Memberships")!;
    const anchor = page.blocks.find((b) => b.type === "paragraph")!;
    addProductCommentAs(MARCO, page.id, { anchorId: anchor.id, quote: "plans", body: "Yearly plan?" });
    expect(await undoReason()).toBe("Marco Bellini commented on “Memberships” afterwards · Who?");
  });

  it("una risposta di Marco a una domanda di Claude", async () => {
    await written();
    const q = vrdQuestions()[0]!;
    answerProductQuestionAs(MARCO, q.id, "keep");
    const title = vrdPages().find((p) => p.id === q.pageId)!.title;
    expect(await undoReason()).toBe(`Marco Bellini answered a question on “${title}” afterwards · Who?`);
  });

  it("una pagina nuova di Marco", async () => {
    await written([TEXT]);
    createProductPageAs(MARCO, VRD, { title: "Marco's page", parentId: null });
    expect(await undoReason()).toBe("Marco Bellini added “Marco's page” afterwards · Who?");
  });

  it("una pagina tolta (chi l'ha tolta non si sa più)", async () => {
    await written([TEXT]);
    const last = vrdPages().find((p) => p.title === VRD_FIRST_VERSION.at(-1)!.title)!;
    deleteProductPageAs(MARCO, last.id);
    expect(await undoReason()).toBe("A page was edited afterwards · Who?");
  });

  it("in italiano: una modifica", async () => {
    act(() => setLanguage("it"));
    await written();
    const page = firstPage();
    const block = page.blocks[0]!;
    writeProductBlocksAs(
      MARCO,
      page.id,
      [{ op: "set", block: { ...block, content: { text: "Parole di Marco", marks: [] } } as ProductBlock }],
      { sessionId: "s-marco-it" },
    );
    expect(await undoReason()).toBe(`Marco Bellini ha modificato «${page.title}» dopo · Chi?`);
  });

  it("in italiano: una pagina nuova", async () => {
    act(() => setLanguage("it"));
    await written([TEXT]);
    createProductPageAs(MARCO, VRD, { title: "Pagina di Marco", parentId: null });
    expect(await undoReason()).toBe("Marco Bellini ha aggiunto «Pagina di Marco» dopo · Chi?");
  });

  it("in italiano: un commento", async () => {
    act(() => setLanguage("it"));
    await written();
    const page = vrdPages().find((p) => p.title === "Memberships")!;
    const anchor = page.blocks.find((b) => b.type === "paragraph")!;
    addProductCommentAs(MARCO, page.id, { anchorId: anchor.id, quote: "plans", body: "Annuale?" });
    expect(await undoReason()).toBe("Marco Bellini ha commentato «Memberships» dopo · Chi?");
  });
});

describe("fix round 1 — a 1024 la nota e i rifiuti restano a vista (I1)", () => {
  it("la nota sulla riservatezza e il rifiuto stanno fuori dal corpo che scorre, sopra i bottoni; il rifiuto è un alert", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    const body = dialog.querySelector("[data-dialog-body]")!;
    const privacy = dialog.querySelector("[data-first-version-privacy]")!;
    expect(body.contains(privacy)).toBe(false);
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "notes");
    state.instance.simulate.budgetReached = true;
    await user.click(within(dialog).getByRole("button", { name: "Write the first version" }));
    const alert = await within(dialog).findByRole("alert");
    expect(body.contains(alert)).toBe(false);
    const band = dialog.querySelector("[data-dialog-before-footer]")!;
    expect(band.contains(alert) && band.contains(privacy)).toBe(true);
    const footer = dialog.querySelector("footer")!;
    expect(band.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert).toBeVisible();
  });
});

describe("fix round 1 — i rifiuti e gli errori (M5)", () => {
  async function dialogWithText() {
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "notes");
    return { user, dialog };
  }

  it("avvio rifiutato perché Laura non può più modificare: «You can no longer edit the docs in VRD. · Who?»", async () => {
    const { user, dialog } = await dialogWithText();
    revokeProjectPermission(LAURA, VRD, "docs.edit" as never);
    await user.click(within(dialog).getByRole("button", { name: "Write the first version" }));
    const alert = await within(dialog).findByRole("alert");
    expect(flat(alert)).toBe("You can no longer edit the docs in VRD. · Who?");
    expect(within(alert).getByRole("button", { name: /^Who/ })).toBeInTheDocument();
    expect(vrdPages()).toEqual([]);
  });

  it("avvio non riuscito: «Couldn't start · Retry», e «Retry» avvia", async () => {
    const { user, dialog } = await dialogWithText();
    failNext("productDocs.startFirstVersion");
    const start = within(dialog).getByRole("button", { name: "Write the first version" });
    await user.click(start);
    const alert = await within(dialog).findByRole("alert");
    expect(dotted(alert)).toBe("Couldn't start · Retry");
    expect(start).toHaveFocus();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { name: /^Claude (is writing|wrote) the first version$/ }),
    ).toBeInTheDocument();
    expect(state.productFirstVersions).toHaveLength(1);
  });

  it("le fonti non caricate: «Couldn't load the sources · Retry», e «Retry» le carica", async () => {
    failNext("productDocs.listFirstVersionSources");
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    const alert = await within(dialog).findByRole("alert");
    expect(dotted(alert)).toBe("Couldn't load the sources · Retry");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByRole("group", { name: "Emails" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  async function confirmUndo() {
    const user = userEvent.setup();
    await written([TEXT]);
    await openPage(firstPage().code);
    const row = await banner();
    await user.click(within(row).getByRole("button", { name: "Undo the first version" }));
    const ask = await screen.findByRole("dialog", { name: "Undo the first version?" });
    return { user, ask };
  }

  it("annullamento rifiutato (toccata nel frattempo): la frase e «Close», niente tolto, il fuoco resta vivo", async () => {
    const { user, ask } = await confirmUndo();
    createProductPageAs(MARCO, VRD, { title: "Marco's page", parentId: null });
    await user.click(within(ask).getByRole("button", { name: "Undo the first version" }));
    const alert = await within(ask).findByRole("alert");
    expect(flat(alert)).toBe("A page was changed in the meantime: the first version can no longer be undone.");
    expect(within(ask).queryByRole("button", { name: "Undo the first version" })).toBeNull();
    await user.click(within(ask).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expectFocusAlive();
    expect(vrdPages().length).toBe(VRD_FIRST_VERSION.length + 1);
  });

  it("annullamento non riuscito: «Couldn't undo the first version · Retry», e «Retry» annulla", async () => {
    const { user, ask } = await confirmUndo();
    failNext("productDocs.undoFirstVersion");
    await user.click(within(ask).getByRole("button", { name: "Undo the first version" }));
    const alert = await within(ask).findByRole("alert");
    expect(dotted(alert)).toBe("Couldn't undo the first version · Retry");
    expect(vrdPages().length).toBe(VRD_FIRST_VERSION.length);
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(firstWay()).toHaveFocus());
    expect(vrdPages()).toEqual([]);
  });
});

describe("fix round 1 — la conferma non resta su «Undoing…» (M1)", () => {
  /** L'annullamento riesce, ma una pagina nasce subito dopo: l'indice non torna vuoto. */
  function undoThenMarcoAddsAPage() {
    const real = productDocs.undoFirstVersion;
    vi.spyOn(productDocs, "undoFirstVersion").mockImplementation(async (projectId) => {
      await real(projectId);
      createProductPageAs(MARCO, VRD, { title: "Marco's page", parentId: null });
    });
  }

  async function confirmAndWatch() {
    undoThenMarcoAddsAPage();
    const user = userEvent.setup();
    await written([TEXT]);
    await openPage(firstPage().code);
    await user.click(within(await banner()).getByRole("button", { name: "Undo the first version" }));
    const ask = await screen.findByRole("dialog");
    const body = watchBody();
    await user.click(within(ask).getByRole("button", { name: "Undo the first version" }));
    return { user, body };
  }

  it("chiusa a mano (Esc): il fuoco sull'h1 dell'indice, mai sul body, e il segno è tolto", async () => {
    const { user, body } = await confirmAndWatch();
    await screen.findByRole("list", { name: "All pages" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Undoing…");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Product" })).toHaveFocus();
    expect(isFresh(firstVersionWayFreshKey("VRD"))).toBe(false);
    body.stop();
    expect(body.hits).toEqual([]);
  });

  it("lasciata lì: si chiude da sola, col fuoco sull'h1, mai sul body", async () => {
    const { body } = await confirmAndWatch();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4000 });
    expect(screen.getByRole("heading", { level: 1, name: "Product" })).toHaveFocus();
    expect(isFresh(firstVersionWayFreshKey("VRD"))).toBe(false);
    body.stop();
    expect(body.hits).toEqual([]);
  });
});

describe("fix round 1 — l'avanzamento che cambia sotto il fuoco (M2, M4)", () => {
  it("interrotta: la pagina scritta e poi tolta è «removed», non in attesa; il fuoco che era sul suo link va al titolo", async () => {
    setStreamLatency(20);
    await openIndex();
    let deleted = false;
    let focusedLink = false;
    let body: ReturnType<typeof watchBody> | null = null;
    const stop = productDocs.onProductFirstVersion(() => {
      const view = productFirstVersionOf(LAURA, VRD)!;
      if (view.pagesDone === 2 && !deleted) {
        deleted = true;
        // Il fuoco sul link della prima pagina, poi la pagina sparisce.
        const first = VRD_FIRST_VERSION[0]!.title;
        const link = screen
          .queryAllByRole("link")
          .find((a) => a.closest("ul")?.getAttribute("aria-label") === "Pages of the first version" && a.textContent?.includes(first));
        link?.focus();
        focusedLink = !!link && document.activeElement === link;
        body = watchBody();
        deleteProductPageAs(LAURA, view.pages[0]!.pageId!);
      }
    });
    act(() => void startFirstVersionAs(LAURA, VRD, [TEXT]));
    await screen.findByRole("heading", { name: "Claude is writing the first version" });
    await act(() => whenFirstVersionIdle());
    stop();
    const title = await screen.findByRole("heading", { name: "Claude stopped the first version" });
    const list = screen.getByRole("list", { name: "Pages of the first version" });
    const removed = list.querySelector("[data-first-version-removed]")!;
    expect(flat(removed)).toBe(`${VRD_FIRST_VERSION[0]!.title}removed`);
    expect(screen.getByText(`2 of ${VRD_FIRST_VERSION.length} pages written`)).toBeInTheDocument();
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(focusedLink).toBe(true);
    await waitFor(() => expect(title).toHaveFocus());
    body!.stop();
    expect(body!.hits).toEqual([]);
  });

  it("annullata da un altro mentre il fuoco è nell'avanzamento: il fuoco va alla prima strada, mai sul body", async () => {
    setStreamLatency(20);
    const user = userEvent.setup();
    await openIndex();
    await user.click(firstWay());
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Pasted text" }), "notes");
    await user.click(within(dialog).getByRole("button", { name: "Write the first version" }));
    await act(() => whenFirstVersionIdle());
    const open = await screen.findByRole("link", { name: "Open the first page" });
    act(() => open.focus());
    const body = watchBody();
    const { undoFirstVersionAs } = await import("../../../data/productDocs/firstVersion");
    act(() => undoFirstVersionAs(MARCO, VRD));
    await waitFor(() => expect(firstWay()).toHaveFocus());
    body.stop();
    expect(body.hits).toEqual([]);
  });
});
