import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../data/api";
import { state } from "../data/store";
import { ViewerProvider } from "../data/viewer";
import { setLanguage } from "../i18n";
import { createAppRouter } from "../router";
import { ThemeProvider } from "../theme/ThemeProvider";

// ⌘K e lo spazio Prodotto (area 11a, Task 6; shape product-space.md §3.9):
// dentro `#/p/<P>/docs/product…` l'ambito «In Product» (solo pagine di
// prodotto, da un carattere), Tab allarga a «Everywhere», dove le pagine di
// prodotto hanno il loro gruppo subito dopo quello dei Docs. Chi non legge i
// Docs del progetto non ha né l'ambito né le pagine (R-G5).

function renderAt(path: string, personId = "p-laura") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("button", { name: "Search and commands" });
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Search and commands" });
}

const productCodes = () => new Set(state.productPages.map((p) => p.code));
const codeOf = (id: string) => state.productPages.find((p) => p.id === id)!.code;

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(() => {
  act(() => setLanguage("en"));
});

describe("⌘K nello spazio Prodotto", () => {
  it("«bill»: solo pagine di prodotto, ambito «In Product»; Tab allarga con i due gruppi; un clic apre la pagina", async () => {
    const user = userEvent.setup();
    const router = renderAt("/p/ACQ/docs/product");
    const dialog = await openPalette(user);
    expect(within(dialog).getByText("In Product")).toBeInTheDocument();
    expect(within(dialog).getByText("Tab: search everything")).toBeInTheDocument();
    const field = within(dialog).getByRole("combobox");
    expect(field).toHaveAttribute("placeholder", "Search the product pages…");
    await user.type(field, "bill");
    const scoped = await within(dialog).findByRole("group", { name: "Product pages" });
    expect(within(dialog).getAllByRole("group")).toHaveLength(1);
    const options = within(scoped).getAllByRole("option");
    // Solo pagine di prodotto: nessuna pagina dei Docs del repository («Test accounts»).
    const codes = productCodes();
    for (const o of options) expect(codes.has(o.querySelector(".num")!.textContent!)).toBe(true);
    expect(within(dialog).queryByText(/Test accounts/i)).toBeNull();
    const bills = within(scoped).getByRole("option", { name: `${codeOf("pp-acq-bills")} Bills` });
    // Con l'ambito niente progetto accanto al titolo; il passaggio ha le parole evidenziate.
    expect(bills).not.toHaveTextContent("ACQ · Product");
    expect(bills.querySelector("mark")).toBeTruthy();

    await user.keyboard("{Tab}");
    expect(within(dialog).getByText("Everywhere")).toBeInTheDocument();
    const pages = await within(dialog).findByRole("group", { name: "Pages" });
    const product = within(dialog).getByRole("group", { name: "Product pages" });
    // Il gruppo delle pagine di prodotto viene subito dopo quello dei Docs.
    const order = within(dialog)
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-labelledby"));
    expect(order.indexOf(product.getAttribute("aria-labelledby"))).toBe(
      order.indexOf(pages.getAttribute("aria-labelledby")) + 1,
    );
    expect(within(pages).getByRole("option", { name: /Test accounts/ })).toBeInTheDocument();
    const wide = within(product).getByRole("option", { name: `${codeOf("pp-acq-bills")} Bills` });
    expect(wide).toHaveTextContent("ACQ · Product");

    await user.keyboard("{Tab}");
    expect(within(dialog).getByText("In Product")).toBeInTheDocument();
    // Le righe di una ricerca vecchia non si scelgono: si aspetta quella nuova.
    await waitFor(() =>
      expect(within(dialog).getByRole("listbox")).toHaveAttribute("aria-busy", "false"),
    );
    expect(within(dialog).getAllByRole("group")).toHaveLength(1);
    await user.click(
      within(dialog).getByRole("option", { name: `${codeOf("pp-acq-bills")} Bills` }),
    );
    expect(router.state.location.pathname).toBe(`/p/ACQ/docs/product/${codeOf("pp-acq-bills")}`);
  });

  it("dentro lo spazio l'ambito cerca da un carattere; in italiano «Nel Prodotto»", async () => {
    act(() => setLanguage("it"));
    const user = userEvent.setup();
    renderAt("/p/ACQ/docs/product");
    await screen.findByRole("button", { name: "Cerca e comandi" });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Cerca e comandi" });
    expect(within(dialog).getByText("Nel Prodotto")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("combobox"), "m");
    expect(
      await within(dialog).findByRole("group", { name: "Pagine di prodotto" }),
    ).toBeInTheDocument();
    await user.keyboard("{Tab}");
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "meter");
    const product = await within(dialog).findByRole("group", { name: "Pagine di prodotto" });
    expect(
      within(product).getByRole("option", { name: `${codeOf("pp-acq-meter-reading")} Meter reading` }),
    ).toHaveTextContent("ACQ · Prodotto");
  });

  it("chi non legge i Docs di ACQ: né l'ambito né le pagine di prodotto, come se non ci fossero", async () => {
    const user = userEvent.setup();
    renderAt("/p/ACQ/docs/product", "p-giulia");
    const dialog = await openPalette(user);
    expect(within(dialog).queryByText("In Product")).toBeNull();
    expect(within(dialog).queryByText(/Tab: search/)).toBeNull();
    await user.type(within(dialog).getByRole("combobox"), "meter reading");
    expect(await within(dialog).findByText("No results for “meter reading”")).toBeInTheDocument();
    const text = (within(dialog).getByRole("listbox").textContent ?? "")
      .replaceAll("“meter reading”", "")
      .toLowerCase();
    expect(text).not.toContain("meter reading");
    for (const code of productCodes()) expect(text).not.toContain(code.toLowerCase());
  });

  it("col modulo Docs spento il progetto si vede ma lo spazio no: niente ambito né pagine", async () => {
    const acq = state.projectsById.get("prj-acq")!;
    acq.modules = acq.modules.filter((m) => m !== "docs");
    const user = userEvent.setup();
    renderAt("/p/ACQ/docs/product");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "meter reading");
    expect(await within(dialog).findByText("No results for “meter reading”")).toBeInTheDocument();
    expect(within(dialog).queryByText("In Product")).toBeNull();
    expect(within(dialog).queryByText(/Tab: search/)).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Product pages" })).toBeNull();
  });
});
