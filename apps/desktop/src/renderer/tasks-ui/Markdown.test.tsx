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

  it("nessun HTML grezzo: il markup del testo resta testo", () => {
    const { container } = render(<Markdown source={"<img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("img")).toBeNull();
  });
});
