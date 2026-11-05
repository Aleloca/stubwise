import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productDocs, resetApi, setLatency } from "../../../data/api";
import { whenProductIdle } from "../../../data/productDocs/presence";
import { setSessionPersonId } from "../../../data/session";
import { nextSeq, now, state } from "../../../data/store";
import type { ProductBlock, RichText } from "../../../data/types";
import { toggleMark } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// La cronologia di una pagina di prodotto (area 11a, Task 10; shape
// product-comments-history.md §3.7): dalla più recente, chi · cosa · ora;
// aperta, «Before» / «After» per ancora coi segni, «Formatting changed»
// per un cambio di soli segni. Si legge: niente «Restore» né «Undo».

const LAURA = "p-laura";
const MARCO = "p-marco";

const pageByTitle = (title: string) => state.productPages.find((p) => p.title === title)!;

async function openHistory(title: string, person = LAURA) {
  const page = pageByTitle(title);
  renderRoute(`/p/ACQ/docs/product/${page.code}`, person);
  await screen.findByRole("heading", { level: 1, name: page.title });
  const bar = screen.getByRole("navigation", { name: /^(Product pages of|Pagine di prodotto di) ACQ$/ });
  const user = userEvent.setup();
  await user.click(within(bar).getByRole("button", { name: /^(History|Cronologia)$/ }));
  const region = await screen.findByRole("region", { name: /^(History|Cronologia)$/ });
  const list = await within(region).findByRole("list", { name: /^(Changes to this page|Modifiche a questa pagina)$/ });
  return { region, list, user, bar };
}

/** Il copione della pagina (Task 5) è già arrivato in fondo: le revisioni di prova sono le ultime. */
async function scriptDone(pageId: string) {
  setSessionPersonId(LAURA);
  await productDocs.joinProductPage(pageId);
  await whenProductIdle();
}

/** Le righe: bottoni che aprono il loro dettaglio (fix round 1: niente `listbox`). */
const rows = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>("[data-history-row]")];
const rowText = (row: HTMLElement) => (row.textContent ?? "").replace(/\s+/g, " ");

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

describe("la cronologia di Meter reading", () => {
  it("la riga di Marco del copione «Edited 1 sentence» con «Added», «After» e il testo; la riga create; un rename «Renamed from …»", async () => {
    const meter = pageByTitle("Meter reading");
    setSessionPersonId(LAURA);
    await productDocs.joinProductPage(meter.id);
    await whenProductIdle();
    productDocs.renameProductPageAs(LAURA, meter.id, "Meter readings");
    const { list, user } = await openHistory("Meter readings");
    const all = rows(list);
    // Dalla più recente: il rename di Laura, poi la scrittura di Marco.
    expect(rowText(all[0]!)).toContain("Laura Costa");
    expect(rowText(all[0]!)).toContain("Renamed from “Meter reading”");
    expect(rowText(all[1]!)).toContain("Marco Bellini");
    expect(rowText(all[1]!)).toContain("Edited 1 sentence");
    expect(rowText(all.at(-1)!)).toContain("Created the page");
    // Niente «Restore» né «Undo» nel 11a.
    expect(within(list).queryByRole("button", { name: /restore|undo/i })).toBeNull();

    await user.click(all[1]!);
    expect(all[1]!).toHaveAttribute("aria-expanded", "true");
    const details = document.getElementById(all[1]!.getAttribute("aria-controls")!)!;
    expect(within(details).getByText("Added")).toBeInTheDocument();
    expect(within(details).getByText("After")).toBeInTheDocument();
    expect(within(details).queryByText("Before")).toBeNull();
    const script = meter.blocks.find((b) => b.id === "blk-acq-meter-script-1") as Extract<ProductBlock, { content: RichText }>;
    expect(details.textContent).toContain(script.content.text);
  });

  it("in italiano: «Ha modificato 1 frase», «Ha creato la pagina»", async () => {
    act(() => setLanguage("it"));
    const { list } = await openHistory("Meter reading");
    const text = rows(list).map(rowText).join(" | ");
    expect(text).toContain("Ha modificato 1 frase");
    expect(text).toContain("Ha creato la pagina");
    expect(text).not.toContain("Edited");
  });

  it("una revisione senza `via` né `sessionId`, con blocchi senza `marks`, si disegna come le altre", async () => {
    const meter = pageByTitle("Meter reading");
    // Aprire la pagina ci fa entrare e avvia il copione (Task 11): prima che finisca, la riga di prova non sarebbe la prima.
    await scriptDone(meter.id);
    const seq = nextSeq();
    state.productRevisions.push({
      id: "prev-fixture",
      pageId: meter.id,
      seq,
      lastSeq: seq,
      at: now(),
      actorId: MARCO,
      kind: "edit",
      changes: [
        {
          blockId: "blk-acq-meter-3",
          // Apposta: `content` senza `marks` (un dato di prima).
          before: { id: "blk-acq-meter-3", type: "paragraph", content: { text: "Readings close on the 20th." } } as unknown as ProductBlock,
          after: { id: "blk-acq-meter-3", type: "paragraph", content: { text: "Readings close on the 25th." } } as unknown as ProductBlock,
          anchors: ["blk-acq-meter-3"],
        },
      ],
    });
    const { list, user } = await openHistory("Meter reading");
    const first = rows(list)[0]!;
    expect(rowText(first)).toContain("Marco Bellini");
    expect(rowText(first)).toContain("Edited 1 sentence");
    await user.click(first);
    const details = document.getElementById(first.getAttribute("aria-controls")!)!;
    expect(within(details).getByText("Before")).toBeInTheDocument();
    expect(details.textContent).toContain("Readings close on the 20th.");
    expect(details.textContent).toContain("Readings close on the 25th.");
  });
});

describe("i segni", () => {
  it("un grassetto messo da Laura è una riga «Formatting changed», aperta con «After» in grassetto", async () => {
    const signIn = pageByTitle("Sign-in");
    const block = signIn.blocks.find((b) => b.id === "blk-acq-signin-4") as Extract<ProductBlock, { content: RichText }>;
    productDocs.writeProductBlocksAs(LAURA, signIn.id, [
      { op: "set", block: { ...block, content: toggleMark(block.content, 0, 4, "bold") } },
    ], {});
    const { list, user } = await openHistory("Sign-in");
    const first = rows(list)[0]!;
    expect(rowText(first)).toContain("Laura Costa");
    expect(rowText(first)).toContain("Formatting changed");
    await user.click(first);
    const details = document.getElementById(first.getAttribute("aria-controls")!)!;
    expect(within(details).getByText("Formatting changed")).toBeInTheDocument();
    expect(within(details).queryByText("Before")).toBeNull();
    expect(details.querySelector("strong")).toHaveTextContent("Only");
  });

  it("una frase tolta: solo «Before», con «Removed»; un'immagine: «Image: <didascalia>»", async () => {
    const screens = pageByTitle("Screens");
    const image = screens.blocks.find((b) => b.type === "image") as Extract<ProductBlock, { type: "image" }>;
    productDocs.writeProductBlocksAs(LAURA, screens.id, [{ op: "delete", blockId: image.id }], {});
    const { list, user } = await openHistory("Screens");
    const first = rows(list)[0]!;
    await user.click(first);
    const details = document.getElementById(first.getAttribute("aria-controls")!)!;
    expect(within(details).getByText("Removed")).toBeInTheDocument();
    expect(within(details).getByText("Before")).toBeInTheDocument();
    expect(within(details).queryByText("After")).toBeNull();
    expect(details.textContent).toContain(`Image: ${image.caption}`);
  });
});

describe("la tastiera e il fuoco", () => {
  it("Tab fra le righe (fix round 2: ogni riga è un punto di Tab), Invio apre, ← chiude; × riporta il fuoco a «History»", async () => {
    const { region, list, user, bar } = await openHistory("Meter reading");
    const all = rows(list);
    expect(all.map((r) => r.tabIndex)).toEqual(all.map(() => 0));
    act(() => all[0]!.focus());
    await user.tab();
    expect(document.activeElement).toBe(all[1]);
    await user.keyboard("{Enter}");
    expect(all[1]!).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(all[1]!).toHaveAttribute("aria-expanded", "false");
    await user.click(within(region).getByRole("button", { name: "Close history" }));
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "History" }));
  });
});

describe("rimandi del Task 2", () => {
  it("uno spostamento di soli blocchi non è una riga, e la riga «Updated …» non lo afferma", async () => {
    const signIn = pageByTitle("Sign-in");
    const before = state.productRevisions.filter((r) => r.pageId === signIn.id).length;
    productDocs.writeProductBlocksAs(LAURA, signIn.id, [
      { op: "move", blockId: "blk-acq-signin-4", afterId: "blk-acq-signin-1" },
    ], {});
    expect(signIn.updatedById).toBe(LAURA);
    expect(state.productRevisions.filter((r) => r.pageId === signIn.id)).toHaveLength(before);
    const { list } = await openHistory("Sign-in");
    expect(rows(list)).toHaveLength(before);
    // L'ultima revisione è di Marco: la riga lo dice, non «by Laura Costa».
    const meta = screen.getByText(/^Updated .* by /);
    expect(meta).toHaveTextContent("by Marco Bellini");
  });
});

describe("una pagina nuova", () => {
  it("una sola riga «Created the page»", async () => {
    setSessionPersonId(LAURA);
    const created = await productDocs.createProductPage(pageByTitle("Sign-in").projectId, {
      title: "Fresh",
      parentId: null,
      index: 0,
    });
    const { list } = await openHistory(created.title);
    expect(rows(list)).toHaveLength(1);
    expect(rowText(rows(list)[0]!)).toContain("Created the page");
  });
});

describe("fix round 1", () => {
  it("dentro l'elenco solo righe: niente `listbox`, e il dettaglio aperto non sta nella riga", async () => {
    const { region, list, user } = await openHistory("Meter reading");
    expect(within(region).queryByRole("listbox")).toBeNull();
    expect(within(region).queryByRole("option")).toBeNull();
    const first = rows(list)[0]!;
    expect(first.tagName).toBe("BUTTON");
    await user.click(first);
    const details = document.getElementById(first.getAttribute("aria-controls")!)!;
    expect(first.contains(details)).toBe(false);
  });

  it("una tabella senza `anchors` (un dato di prima) conta solo la cella cambiata", async () => {
    const meter = pageByTitle("Meter reading");
    // Aprire la pagina ci fa entrare e avvia il copione (Task 11): prima che finisca, la riga di prova non sarebbe la prima.
    await scriptDone(meter.id);
    const table = meter.blocks.find((b) => b.type === "table") as Extract<ProductBlock, { type: "table" }>;
    const after = structuredClone(table);
    after.rows[1]!.cells[2]!.content = { text: "The 24th", marks: [] };
    const seq = nextSeq();
    state.productRevisions.push({
      id: "prev-table-fixture",
      pageId: meter.id,
      seq,
      lastSeq: seq,
      at: now(),
      actorId: MARCO,
      kind: "edit",
      changes: [{ blockId: table.id, before: table, after, anchors: [] }],
    });
    const { list, user } = await openHistory("Meter reading");
    const first = rows(list)[0]!;
    expect(rowText(first)).toContain("Edited 1 sentence");
    await user.click(first);
    const details = document.getElementById(first.getAttribute("aria-controls")!)!;
    expect(within(details).getAllByText("Table cell")).toHaveLength(1);
    expect(details.textContent).toContain("The 24th");
  });
});

