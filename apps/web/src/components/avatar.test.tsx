import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./avatar";

/**
 * Avatar: immagine tonda con fallback a iniziali su sfondo deterministico.
 * Componente puro (nessuna query interna): si testa in isolamento.
 */
describe("Avatar", () => {
  it("con src rende un'immagine con alt=label", () => {
    render(<Avatar src="https://cdn.example.com/a.png" label="mario@x.com" />);
    const img = screen.getByRole("img", { name: "mario@x.com" });
    expect(img).toHaveAttribute("src", "https://cdn.example.com/a.png");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("la dimensione passata si riflette su width/height dell'immagine", () => {
    render(<Avatar src="https://cdn.example.com/a.png" label="mario@x.com" size={40} />);
    const img = screen.getByRole("img", { name: "mario@x.com" });
    expect(img).toHaveAttribute("width", "40");
    expect(img).toHaveAttribute("height", "40");
  });

  it("senza src rende le iniziali derivate dalla parte locale dell'email", () => {
    render(<Avatar label="mario@x.com" />);
    // "mario" → "MA"
    expect(screen.getByText("MA")).toBeInTheDocument();
    // Il fallback è etichettato per l'accessibilità.
    expect(screen.getByLabelText("mario@x.com")).toBeInTheDocument();
  });

  it("iniziali da un nome con più parole: prima lettera delle prime due", () => {
    render(<Avatar label="Ada Lovelace" />);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("colore di sfondo deterministico: stessa label → stesso bg", () => {
    const { container: a } = render(<Avatar label="mario@x.com" />);
    const { container: b } = render(<Avatar label="mario@x.com" />);
    const bgA = a.querySelector("[data-avatar-fallback]")?.getAttribute("style");
    const bgB = b.querySelector("[data-avatar-fallback]")?.getAttribute("style");
    expect(bgA).toBeTruthy();
    expect(bgA).toBe(bgB);
  });

  it("label diverse possono dare bg diversi (palette non degenerata)", () => {
    // Due label scelte per cadere su slot diversi della palette: il punto è
    // che il colore dipenda dalla label, non che sia un valore fisso.
    const { container: a } = render(<Avatar label="alice" />);
    const { container: b } = render(<Avatar label="bob" />);
    const bgA = a.querySelector("[data-avatar-fallback]")?.getAttribute("style");
    const bgB = b.querySelector("[data-avatar-fallback]")?.getAttribute("style");
    expect(bgA).not.toBe(bgB);
  });

  it("onError sull'immagine passa al fallback con le iniziali", () => {
    const { container } = render(
      <Avatar src="https://cdn.example.com/broken.png" label="mario@x.com" />,
    );
    expect(container.querySelector("img")).not.toBeNull();
    fireEvent.error(container.querySelector("img")!);
    // Dopo l'errore il tag <img> sparisce e compaiono le iniziali (il fallback
    // conserva role="img"/aria-label per l'accessibilità).
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("MA")).toBeInTheDocument();
    expect(screen.getByLabelText("mario@x.com")).toBeInTheDocument();
  });
});
