import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../lib/api";
import { NewTicketDialog } from "./new-ticket-dialog";

/**
 * Dialog "Nuovo ticket" puro: progetti (gruppi) iniettati. In Fase 3 non c'è
 * più un repository bersaglio (l'AI sceglie i repo in fase di fix): si verifica
 * che il payload porti il solo progetto, senza `repositoryId`, e la chiusura.
 */

const PROJECT_ALFA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const projects: Project[] = [
  {
    id: PROJECT_ALFA,
    name: "Progetto Alfa",
    slug: "progetto-alfa",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    ingestionKey: "key-alfa",
    nextTicketNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: PROJECT_BETA,
    name: "Progetto Beta",
    slug: "progetto-beta",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    ingestionKey: "key-beta",
    nextTicketNumber: 1,
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

function renderDialog(props: {
  onSubmit: (draft: unknown) => Promise<void>;
  onClose?: () => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <NewTicketDialog
        projects={projects}
        onSubmit={props.onSubmit as never}
        onClose={props.onClose ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("NewTicketDialog", () => {
  it("invia il payload col solo progetto (niente repositoryId), tipo, priorità e body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onSubmit });

    expect(screen.getByRole("dialog", { name: "New ticket" })).toBeInTheDocument();
    // Nessun selettore "repository bersaglio" nel nuovo dialog.
    expect(screen.queryByLabelText("Target repository")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Title"), "Crash al checkout");
    await user.selectOptions(screen.getByLabelText("Project"), "Progetto Beta");
    await user.selectOptions(screen.getByLabelText("Type"), "Bug");
    await user.selectOptions(screen.getByLabelText("Priority"), "High");
    await user.type(screen.getByLabelText("Description (optional)"), "Stacktrace in allegato");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: PROJECT_BETA,
      title: "Crash al checkout",
      body: "Stacktrace in allegato",
      type: "bug",
      priority: "high",
    });
  });

  it("preseleziona il primo progetto e omette body senza descrizione", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onSubmit });

    await user.type(screen.getByLabelText("Title"), "Solo titolo");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: PROJECT_ALFA,
      title: "Solo titolo",
      type: "task",
      priority: "medium",
    });
  });

  it("il submit è disabilitato finché il titolo è vuoto", async () => {
    const onSubmit = vi.fn();
    renderDialog({ onSubmit });

    expect(screen.getByRole("button", { name: "Create ticket" })).toBeDisabled();
  });

  it("Annulla ed Escape chiudono senza inviare", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onSubmit, onClose });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("un rigetto di onSubmit mostra l'errore e non chiude", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Creazione fallita"));
    const onClose = vi.fn();
    renderDialog({ onSubmit, onClose });

    await user.type(screen.getByLabelText("Title"), "Boom");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(await screen.findByText("Creazione fallita")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
