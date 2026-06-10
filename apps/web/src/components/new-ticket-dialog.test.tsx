import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../lib/api";
import { NewTicketDialog } from "./new-ticket-dialog";

/**
 * Dialog "Nuovo ticket" puro: progetti e onSubmit iniettati, si verifica il
 * payload prodotto e la chiusura.
 */

const projects: Project[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Progetto Alfa",
    slug: "progetto-alfa",
    provider: "github",
    repoUrl: "https://github.com/acme/alfa",
    defaultBranch: "main",
    ingestionKey: "key-alfa",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Progetto Beta",
    slug: "progetto-beta",
    provider: "bitbucket",
    repoUrl: "https://bitbucket.org/acme/beta",
    defaultBranch: "main",
    ingestionKey: "key-beta",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

describe("NewTicketDialog", () => {
  it("invia il payload con progetto, tipo, priorità e body opzionale", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewTicketDialog projects={projects} onSubmit={onSubmit} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Nuovo ticket" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Titolo"), "Crash al checkout");
    await user.selectOptions(screen.getByLabelText("Progetto"), "Progetto Beta");
    await user.selectOptions(screen.getByLabelText("Tipo"), "Bug");
    await user.selectOptions(screen.getByLabelText("Priorità"), "Alta");
    await user.type(screen.getByLabelText("Descrizione (opzionale)"), "Stacktrace in allegato");
    await user.click(screen.getByRole("button", { name: "Crea ticket" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Crash al checkout",
      body: "Stacktrace in allegato",
      type: "bug",
      priority: "high",
    });
  });

  it("senza descrizione il payload omette body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewTicketDialog projects={projects} onSubmit={onSubmit} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Titolo"), "Solo titolo");
    await user.click(screen.getByRole("button", { name: "Crea ticket" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: projects[0]!.id,
      title: "Solo titolo",
      type: "task",
      priority: "medium",
    });
  });

  it("Annulla ed Escape chiudono senza inviare", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<NewTicketDialog projects={projects} onSubmit={onSubmit} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Annulla" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("un rigetto di onSubmit mostra l'errore e non chiude", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Progetto non trovato"));
    const onClose = vi.fn();
    render(<NewTicketDialog projects={projects} onSubmit={onSubmit} onClose={onClose} />);

    await user.type(screen.getByLabelText("Titolo"), "Boom");
    await user.click(screen.getByRole("button", { name: "Crea ticket" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Progetto non trovato");
    expect(onClose).not.toHaveBeenCalled();
  });
});
