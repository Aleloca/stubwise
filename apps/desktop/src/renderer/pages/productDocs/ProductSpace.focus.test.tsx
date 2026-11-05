import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { emitProductPage } from "../../data/productDocs/events";
import { createProductPageAs } from "../../data/productDocs/writes";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";

// Lo spazio Prodotto, fix round 1 del Task 7: dove va il fuoco (mai sul body)
// anche sotto i 1200 px, il cassetto che si chiude, un codice di un altro
// progetto (R-G5), il ritorno dalla pagina che non c'è e la pagina iniziale
// di un progetto senza repository.

const LAURA = "p-laura";
const GIULIA = "p-giulia";
const NOT_FOUND = "This page doesn't exist or you can't see it";

const page = (code: string) => state.productPages.find((p) => p.code === code)!;
const narrow = () => setMatchMedia(DOCKED_PANEL_QUERY, false);
const drawer = () => screen.queryByRole("complementary", { name: /product pages of/i });
const groupHeadings = () =>
  screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.toLowerCase());

async function deleteFromBar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More for this page" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => resetViewerGrants());

describe("il fuoco dopo un'eliminazione e un'accensione", () => {
  it("1024: eliminata dalla barra, si apre il genitore e il fuoco va al suo titolo", async () => {
    narrow();
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/docs/product/ACQ-D6", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Bills" });
    await deleteFromBar(user);
    const parent = await screen.findByRole("heading", { level: 1, name: "Features" });
    expect(router.state.location.pathname).toBe("/p/ACQ/docs/product/ACQ-D4");
    await waitFor(() => expect(parent).toHaveFocus());
  });

  it("1024: l'ultima pagina dello spazio eliminata dalla barra: il fuoco al titolo dell'indice", async () => {
    narrow();
    const user = userEvent.setup();
    const only = createProductPageAs(LAURA, "prj-vrd", { title: "Booking rules" });
    renderRoute(`/p/VRD/docs/product/${only.code}`, LAURA);
    await screen.findByRole("heading", { level: 1, name: "Booking rules" });
    await deleteFromBar(user);
    const index = await screen.findByRole("heading", { level: 1, name: "Product" });
    await waitFor(() => expect(index).toHaveFocus());
    expect(screen.getByRole("heading", { name: /no product pages yet/i })).toBeInTheDocument();
  });

  it("1440: l'ultima pagina eliminata dall'albero: il fuoco su «New page» in testa all'albero", async () => {
    const user = userEvent.setup();
    const only = createProductPageAs(LAURA, "prj-vrd", { title: "Booking rules" });
    renderRoute(`/p/VRD/docs/product/${only.code}`, LAURA);
    const tree = await screen.findByRole("tree", { name: "Product pages of VRD" });
    within(tree).getByRole("treeitem", { name: "Booking rules" }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "More for Booking rules" });
    await user.click(await within(menu).findByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByRole("heading", { name: /no product pages yet/i });
    const aside = screen.getByRole("complementary", { name: "Product pages of VRD" });
    await waitFor(() =>
      expect(within(aside).getByRole("button", { name: "New page" })).toHaveFocus(),
    );
  });

  it("1024: Docs accesi da un indirizzo di uno spazio di repository: la pagina iniziale, col fuoco su «Start from a blank page»", async () => {
    narrow();
    const user = userEvent.setup();
    const router = renderRoute("/p/MKX/docs/whatever", GIULIA);
    await user.click(await screen.findByRole("button", { name: "Turn on Docs" }));
    const start = await screen.findByRole("button", { name: "Start from a blank page" });
    expect(router.state.location.pathname).toBe("/p/MKX/docs");
    await waitFor(() => expect(start).toHaveFocus());
  });
});

describe("il cassetto sotto i 1200 px", () => {
  it("la pagina che diventa «non trovata» chiude il cassetto aperto; il fuoco su «Pages»", async () => {
    narrow();
    const user = userEvent.setup();
    renderRoute("/p/ACQ/docs/product/ACQ-D7", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Meter reading" });
    await user.click(screen.getByRole("button", { name: "Pages" }));
    expect(drawer()).not.toBeNull();
    await waitFor(() => expect(drawer()!.contains(document.activeElement)).toBe(true));
    const id = page("ACQ-D7").id;
    act(() => {
      state.productPages = state.productPages.filter((p) => p.id !== id);
      emitProductPage(id, "gone");
    });
    expect(await screen.findByRole("heading", { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    await waitFor(() => expect(drawer()).toBeNull());
    expect(screen.getByRole("button", { name: "Pages" })).toHaveFocus();
  });

  it("«+» dal cassetto lo chiude e il fuoco va al titolo della pagina nuova", async () => {
    narrow();
    const user = userEvent.setup();
    renderRoute("/p/ACQ/docs/product/ACQ-D5", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Sign-in" });
    await user.click(screen.getByRole("button", { name: "Pages" }));
    await user.click(
      within(drawer()!).getByRole("button", { name: "New subpage under Features" }),
    );
    const title = await screen.findByRole("heading", { level: 1, name: "Untitled" });
    await waitFor(() => expect(drawer()).toBeNull());
    await waitFor(() => expect(title).toHaveFocus());
  });
});

// Revisione finale F1: la pagina aperta che diventa «non trovata» smonta
// ciò che aveva il fuoco (editor, titolo, colonna): il fuoco va all'h1 della
// pagina che non c'è, mai sul body; se era altrove, resta dov'era.
describe("il fuoco quando la pagina aperta diventa «non trovata»", () => {
  const remove = (code: string) => {
    const id = page(code).id;
    act(() => {
      state.productPages = state.productPages.filter((p) => p.id !== id);
      emitProductPage(id, "gone");
    });
  };
  const firstBlockText = () =>
    document.querySelector<HTMLElement>("[data-editor-body] [data-block-text]")!;

  for (const [label, wide] of [
    ["1440", true],
    ["1024", false],
  ] as const) {
    it(`${label}: col fuoco nell'editor, il fuoco va all'h1 della pagina che non c'è`, async () => {
      if (!wide) narrow();
      const user = userEvent.setup();
      renderRoute("/p/ACQ/docs/product/ACQ-D7", LAURA);
      await screen.findByRole("heading", { level: 1, name: "Meter reading" });
      await user.click(firstBlockText());
      await waitFor(() =>
        expect(document.querySelector("[data-editor-body]")!.contains(document.activeElement)).toBe(true),
      );
      remove("ACQ-D7");
      const heading = await screen.findByRole("heading", { level: 1, name: NOT_FOUND });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(document.activeElement).not.toBe(document.body);
    });

    it(`${label}: col fuoco nella colonna dei commenti, il fuoco va all'h1 della pagina che non c'è`, async () => {
      if (!wide) narrow();
      renderRoute("/p/ACQ/docs/product/ACQ-D5?comment=pc-acq-signin-1", LAURA);
      await screen.findByRole("heading", { level: 1, name: "Sign-in" });
      const col = await screen.findByRole("region", { name: "Comments" });
      const resolve = await within(col).findByRole("button", { name: "Resolve" });
      act(() => resolve.focus());
      expect(col.contains(document.activeElement)).toBe(true);
      remove("ACQ-D5");
      const heading = await screen.findByRole("heading", { level: 1, name: NOT_FOUND });
      await waitFor(() => expect(heading).toHaveFocus());
    });
  }

  it("col fuoco su un elemento della barra che resta, il fuoco resta lì", async () => {
    renderRoute("/p/ACQ/docs/product/ACQ-D7", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Meter reading" });
    const product = within(
      screen.getByRole("navigation", { name: "Product pages of ACQ" }),
    ).getByRole("link", { name: "Product" });
    act(() => product.focus());
    remove("ACQ-D7");
    await screen.findByRole("heading", { level: 1, name: NOT_FOUND });
    expect(product).toHaveFocus();
  });
});

describe("i confini dello spazio", () => {
  it("R-G5: un codice di un altro progetto nell'indirizzo di ACQ è una pagina che non c'è", async () => {
    const aud = createProductPageAs("p-roberta", "prj-aud", { title: "Audin overview" });
    renderRoute(`/p/ACQ/docs/product/${aud.code}`, "p-roberta");
    expect(await screen.findByRole("heading", { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    expect(screen.queryByText(/audin overview/i)).toBeNull();
    expect(screen.queryByRole("navigation", { name: /where this page is/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /more for this page/i })).toBeNull();
    cleanup();
    renderRoute(`/p/AUD/docs/product/${aud.code}`, "p-roberta");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Audin overview" }),
    ).toBeInTheDocument();
  });

  it("fuori dallo spazio (modulo spento): «Back to the index» porta alla pagina iniziale dei Docs", async () => {
    state.projectsById.get("prj-acq")!.modules = state.projectsById
      .get("prj-acq")!
      .modules.filter((m) => m !== "docs");
    renderRoute("/p/ACQ/docs/product/ACQ-D5", LAURA);
    await screen.findByRole("heading", { level: 1, name: NOT_FOUND });
    expect(screen.getByRole("link", { name: /back to the index/i })).toHaveAttribute(
      "href",
      "/p/ACQ/docs",
    );
  });

  it("VRD senza repository: niente WHAT'S NEW né la riga dell'aggiornamento notturno", async () => {
    state.projectSettings.get("prj-vrd")!.switches.docsNightly = false;
    renderRoute("/p/VRD/docs", LAURA);
    await screen.findByRole("list", { name: "Product" });
    expect(groupHeadings()).not.toContain("what's new");
    expect(document.querySelector('[data-switch-off="docsNightly"]')).toBeNull();
    expect(screen.queryByText(/nightly update/i)).toBeNull();
  });
});
