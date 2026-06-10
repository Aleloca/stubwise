import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renderizza la sintassi markdown di base", () => {
    const { container } = render(
      <Markdown source={"# Titolo\n\nTesto **grassetto** e `codice`."} />,
    );

    expect(screen.getByRole("heading", { name: "Titolo" })).toBeInTheDocument();
    expect(screen.getByText("grassetto").tagName).toBe("STRONG");
    expect(container.querySelector("code")).toHaveTextContent("codice");
  });

  it("i link restano cliccabili", () => {
    render(<Markdown source="Vedi [la doc](https://example.com/doc)." />);

    expect(screen.getByRole("link", { name: "la doc" })).toHaveAttribute(
      "href",
      "https://example.com/doc",
    );
  });

  it("sanitizza: lo script viene rimosso", () => {
    const { container } = render(
      <Markdown source={'ciao <script>window.hacked = true</script> mondo'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("window.hacked");
    expect(container.textContent).toContain("ciao");
  });

  it("sanitizza: gli attributi-evento vengono rimossi", () => {
    const { container } = render(
      <Markdown source={'<img src="x" onerror="window.hacked = true" alt="img">'} />,
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).not.toHaveAttribute("onerror");
  });

  it("sanitizza: i link javascript: perdono l'href", () => {
    render(<Markdown source={'<a href="javascript:alert(1)">malizioso</a>'} />);

    expect(screen.getByText("malizioso")).not.toHaveAttribute("href");
  });
});
