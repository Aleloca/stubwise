import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CollapsibleSection } from "./collapsible-section";

describe("CollapsibleSection", () => {
  it("apre e chiude il contenuto col toggle", async () => {
    render(
      <CollapsibleSection title="Sezione" defaultOpen={false}>
        <p>Contenuto interno</p>
      </CollapsibleSection>,
    );

    // Chiusa di default: contenuto non montato.
    expect(screen.queryByText("Contenuto interno")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Sezione/ }));
    expect(screen.getByText("Contenuto interno")).toBeInTheDocument();
  });

  it("rende l'action nell'header senza rompere il toggle, e come sibling del button", async () => {
    render(
      <CollapsibleSection
        title="Sezione"
        defaultOpen
        action={
          <a href="/download" onClick={(e) => e.stopPropagation()}>
            scarica
          </a>
        }
      >
        <p>Contenuto interno</p>
      </CollapsibleSection>,
    );

    const action = screen.getByRole("link", { name: "scarica" });
    expect(action).toHaveAttribute("href", "/download");
    // L'action NON è dentro il button di toggle (HTML valido).
    expect(action.closest("button")).toBeNull();

    // Cliccare l'action (stopPropagation) non chiude la sezione.
    await userEvent.click(action);
    expect(screen.getByText("Contenuto interno")).toBeInTheDocument();

    // Il toggle continua a funzionare.
    await userEvent.click(screen.getByRole("button", { name: /Sezione/ }));
    expect(screen.queryByText("Contenuto interno")).not.toBeInTheDocument();
  });

  it("senza action il comportamento resta invariato (nessun elemento extra)", async () => {
    render(
      <CollapsibleSection title="Sezione" defaultOpen meta="3">
        <p>Contenuto interno</p>
      </CollapsibleSection>,
    );

    expect(screen.getByText("Contenuto interno")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // Nessun link nell'header.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
