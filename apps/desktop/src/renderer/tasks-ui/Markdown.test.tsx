import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("un blocco di codice: testo intatto, scorre dentro sé stesso e si raggiunge da tastiera", () => {
    const { container } = render(
      <Markdown source={"Before\n\n```ts\nconst a = 1;\n  const b = <T>() => 2;\n```\n\nAfter"} />,
    );
    const pre = container.querySelector("pre")!;
    expect(pre.textContent).toBe("const a = 1;\n  const b = <T>() => 2;");
    expect(pre).toHaveAttribute("tabindex", "0");
    expect(pre.className).toMatch(/overflow-x-auto/);
    expect(pre.className).toMatch(/whitespace-pre/);
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("un blocco non chiuso (mentre arriva) resta un blocco", () => {
    const { container } = render(<Markdown source={"```\nline one\nline two"} />);
    expect(container.querySelector("pre")!.textContent).toBe("line one\nline two");
  });

  it("le tabelle: intestazione e righe, con lo scorrimento in un contenitore loro", () => {
    const { container } = render(
      <Markdown
        source={"| Code | Name |\n| --- | --- |\n| AUD-1 | **Export** |\n| AUD-2 | Sync |"}
      />,
    );
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Code", "Name"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Export").tagName).toBe("STRONG");
    expect(container.querySelector("[data-table-scroll]")!.className).toMatch(/overflow-x-auto/);
  });

  it("le righe «>» sono una citazione rientrata con il filo, senza il «>»", () => {
    const { container } = render(
      <Markdown source={"Before\n> The export must keep **dates**\n> in UTC.\nAfter"} />,
    );
    const quote = container.querySelector("blockquote")!;
    expect(quote.textContent).toBe("The export must keep dates\nin UTC.");
    expect(quote.querySelector("strong")).not.toBeNull();
    expect(quote.className).toMatch(/border-l border-rule-strong pl-3/);
    expect(container.textContent).not.toContain(">");
  });

  it("mentre arriva, una tabella aspetta la sua prima riga intera; prima è testo con il cursore", () => {
    const cursor = <span data-cursor />;
    const partial = "Here:\n| Code | Title |\n|---|---|\n| MKX-1 | Leaf";
    const { container, rerender } = render(<Markdown source={partial} trailing={cursor} />);
    expect(container.querySelector("table")).toBeNull();
    // Il cursore segue il testo arrivato, non sta da solo sotto una testata vuota.
    expect(container.querySelector("[data-cursor]")!.parentElement!.textContent).toContain(
      "MKX-1 | Leaf",
    );

    rerender(<Markdown source={`${partial}let |\n| MKX-2 | Po`} trailing={cursor} />);
    const table = container.querySelector("table")!;
    expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(table.textContent).toContain("Leaflet");
    expect(container.querySelector("[data-cursor]")!.parentElement!.textContent).toContain(
      "MKX-2 | Po",
    );

    // Arrivato tutto: le righe ci sono tutte.
    rerender(<Markdown source={`${partial}let |\n| MKX-2 | Poster |`} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("nessun HTML grezzo: il markup del testo resta testo", () => {
    const { container } = render(<Markdown source={"<img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("img")).toBeNull();
  });
});
