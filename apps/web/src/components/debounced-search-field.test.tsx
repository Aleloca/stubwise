import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebouncedSearchField } from "./debounced-search-field";

/**
 * Test del campo di ricerca debounced condiviso: la digitazione NON emette a
 * ogni tasto, ma un solo `onChange` col valore trimmato a debounce scaduto; un
 * campo svuotato emette `undefined` (il chiamante rimuove il parametro).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function renderField(onChange: (v: string | undefined) => void, value?: string) {
  render(
    <DebouncedSearchField
      id="q"
      label="Search"
      placeholder="Search…"
      value={value}
      onChange={onChange}
      debounceMs={50}
    />,
  );
}

describe("DebouncedSearchField", () => {
  it("digitando emette un solo onChange col valore trimmato a debounce scaduto", async () => {
    const onChange = vi.fn();
    renderField(onChange);

    const input = screen.getByRole("searchbox", { name: "Search" });
    await userEvent.type(input, "  export  ");

    // Il draft si vede subito (controllato), ma l'onChange è ritardato.
    expect(input).toHaveValue("  export  ");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("export"));
  });

  it("svuotare il campo emette undefined", async () => {
    const onChange = vi.fn();
    renderField(onChange, "export");

    const input = screen.getByRole("searchbox", { name: "Search" });
    await userEvent.clear(input);

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(undefined));
  });

  it("un value nuovo dall'esterno riallinea il campo", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DebouncedSearchField
        id="q"
        label="Search"
        placeholder="Search…"
        value="one"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("one");

    rerender(
      <DebouncedSearchField
        id="q"
        label="Search"
        placeholder="Search…"
        value="two"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("two");
  });
});
