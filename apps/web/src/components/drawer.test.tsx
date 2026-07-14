import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Drawer } from "./drawer";

/**
 * Drawer off-canvas: pannello `role="dialog"`/`aria-modal`, chiusura su backdrop
 * e Escape, scroll-lock del body mentre è aperto, e stato non interattivo
 * (`aria-hidden`) quando chiuso. Componente puro: si testa in isolamento.
 */
describe("Drawer", () => {
  it("aperto: rende il pannello con role=dialog, aria-modal e label", () => {
    render(
      <Drawer open onClose={() => {}} aria-label="Navigazione">
        <a href="/tickets">Tickets</a>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Navigazione" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Tickets")).toBeInTheDocument();
  });

  it("aperto: il pannello riceve il focus", () => {
    render(
      <Drawer open onClose={() => {}} aria-label="Navigazione">
        <span>contenuto</span>
      </Drawer>,
    );
    expect(screen.getByRole("dialog", { name: "Navigazione" })).toHaveFocus();
  });

  it("aperto: blocca lo scroll del body e lo ripristina alla chiusura", () => {
    const { rerender } = render(
      <Drawer open onClose={() => {}} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    rerender(
      <Drawer open={false} onClose={() => {}} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("click sul backdrop chiama onClose", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Drawer open onClose={onClose} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    const backdrop = container.querySelector("[data-drawer-backdrop]");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismissOnBackdrop=false: il click sul backdrop NON chiama onClose", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Drawer open onClose={onClose} dismissOnBackdrop={false} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    const backdrop = container.querySelector("[data-drawer-backdrop]");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismissOnBackdrop=false: Escape continua a chiamare onClose", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} dismissOnBackdrop={false} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape chiama onClose", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("chiuso: aria-hidden e contenitore non interattivo", () => {
    const { container } = render(
      <Drawer open={false} onClose={() => {}} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root.className).toContain("pointer-events-none");
  });

  it("chiuso: Escape non chiama onClose (listener non attivo)", () => {
    const onClose = vi.fn();
    render(
      <Drawer open={false} onClose={onClose} aria-label="Nav">
        <span>x</span>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("side=right usa il bordo sinistro e l'ancoraggio a destra", () => {
    render(
      <Drawer open side="right" onClose={() => {}} aria-label="Chat">
        <span>x</span>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Chat" });
    expect(dialog.className).toContain("right-0");
    expect(dialog.className).toContain("border-l");
  });
});
