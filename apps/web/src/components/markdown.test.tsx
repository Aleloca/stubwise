import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineMarkdown, Markdown } from "./markdown";

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

  it("fuori dalle domande un'immagine resta un'immagine (testo dell'agente, corpo del ticket, Docs)", () => {
    const { container } = render(<Markdown source="![grafico](https://x.test/p.png)" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://x.test/p.png");
  });

  it("in modalità domanda un'immagine NON si carica: resta il suo alt, come testo", () => {
    const { container } = render(
      <Markdown
        question
        source={
          'Vedi ![grafico <b>x</b>](https://x.test/p.png) e <img src="https://x.test/q.png" alt="pixel">, poi ![](https://x.test/r.png).'
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("grafico <b>x</b>");
    expect(container.textContent).toContain("pixel");
    expect(container.innerHTML).not.toContain("x.test");
  });

  it("in modalità domanda nessuna variante d'immagine carica qualcosa: riferimento, <picture>, srcset", () => {
    const { container } = render(
      <Markdown
        question
        source={[
          "Vedi ![grafico][r] qui.",
          "",
          '<picture><source srcset="https://x.test/s.webp"><img src="https://x.test/p.png" alt="pic"></picture>',
          "",
          '<img srcset="https://x.test/a.png 1x, https://x.test/b.png 2x" alt="set">',
          "",
          "[r]: https://x.test/ref.png",
        ].join("\n")}
      />,
    );
    expect(container.querySelectorAll("img, picture, source")).toHaveLength(0);
    expect(container.querySelectorAll("[src], [srcset]")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("x.test");
    expect(container.textContent).toContain("grafico");
  });

  it("InlineMarkdown (solo testi di una domanda): un'immagine diventa il suo alt, mai un <img>", () => {
    const { container } = render(
      <InlineMarkdown source="See ![chart](https://x.test/p.png) now" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("See chart now");
  });
});
