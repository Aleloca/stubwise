import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../lib/api";
import { TicketFilters } from "./ticket-filters";

const projects: Project[] = [
  {
    id: "p1",
    name: "Progetto Alfa",
    slug: "progetto-alfa",
    provider: "github",
    repoUrl: "https://github.com/acme/alfa",
    defaultBranch: "main",
    ingestionKey: "key-alfa",
    gitAccountId: "acc-1",
    gitAccountName: "GitHub Demo",
    webhookConfiguredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "p2",
    name: "Progetto Beta",
    slug: "progetto-beta",
    provider: "bitbucket",
    repoUrl: "https://bitbucket.org/acme/beta",
    defaultBranch: "main",
    ingestionKey: "key-beta",
    gitAccountId: "acc-2",
    gitAccountName: "Bitbucket Prod",
    webhookConfiguredAt: null,
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

function renderFilters(value: Parameters<typeof TicketFilters>[0]["value"] = {}) {
  const onChange = vi.fn();
  render(<TicketFilters value={value} projects={projects} onChange={onChange} />);
  return onChange;
}

describe("TicketFilters", () => {
  it("selezionare uno stato chiama onChange con il valore", async () => {
    const onChange = renderFilters();

    await userEvent.selectOptions(screen.getByLabelText(/stato/i), "open");

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ status: "open" });
  });

  it("tornare a «Tutti» azzera il filtro (undefined, sparisce dall'URL)", async () => {
    const onChange = renderFilters({ status: "done" });

    expect(screen.getByLabelText(/stato/i)).toHaveValue("done");
    await userEvent.selectOptions(screen.getByLabelText(/stato/i), "");

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ status: undefined });
  });

  it("tipo, priorità e progetto chiamano onChange con la chiave giusta", async () => {
    const onChange = renderFilters();

    await userEvent.selectOptions(screen.getByLabelText(/tipo/i), "bug");
    await userEvent.selectOptions(screen.getByLabelText(/priorità/i), "urgent");
    await userEvent.selectOptions(screen.getByLabelText(/progetto/i), "p2");

    expect(onChange).toHaveBeenNthCalledWith(1, { type: "bug" });
    expect(onChange).toHaveBeenNthCalledWith(2, { priority: "urgent" });
    expect(onChange).toHaveBeenNthCalledWith(3, { projectId: "p2" });
  });

  it("il select progetto elenca i progetti per nome", () => {
    renderFilters();

    const select = screen.getByLabelText(/progetto/i);
    expect(select).toContainHTML("Progetto Alfa");
    expect(select).toContainHTML("Progetto Beta");
  });

  it("la ricerca è debounced: una sola onChange dopo la pausa, non una per tasto", async () => {
    const onChange = renderFilters();

    await userEvent.type(screen.getByRole("searchbox", { name: /cerca/i }), "login");

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ q: "login" }), {
      timeout: 1000,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("svuotare la ricerca manda q undefined", async () => {
    const onChange = renderFilters({ q: "login" });

    await userEvent.clear(screen.getByRole("searchbox", { name: /cerca/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ q: undefined }), {
      timeout: 1000,
    });
  });
});
