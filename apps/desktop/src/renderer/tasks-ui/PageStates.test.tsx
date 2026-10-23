import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageEmpty, PageError, PageSkeleton } from "./PageStates";

describe("PageStates", () => {
  it("lo scheletro ha la forma delle righe vere e si annuncia come caricamento", () => {
    const { container } = render(<PageSkeleton rows={8} />);
    expect(container.querySelectorAll("[data-skeleton-row]")).toHaveLength(8);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
  });

  it("lo scheletro a colonne ne mostra quante richieste", () => {
    const { container } = render(<PageSkeleton shape="columns" columns={4} />);
    expect(container.querySelectorAll("[data-skeleton-column]")).toHaveLength(4);
  });

  it("l'errore dice cosa non è riuscito e «Retry» riprova", async () => {
    const retry = vi.fn();
    render(<PageError message="Couldn't load tasks" onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load tasks");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("il vuoto ha il titolo, la frase e l'azione se c'è", () => {
    render(
      <PageEmpty
        title="No tasks yet"
        body="Only people who can create tasks can add one."
        action={<button type="button">New task</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No tasks yet" })).toBeInTheDocument();
    expect(screen.getByText("Only people who can create tasks can add one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
  });
});
