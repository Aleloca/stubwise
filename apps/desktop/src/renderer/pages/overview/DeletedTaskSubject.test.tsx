import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { DeletedTaskSubject } from "./DeletedTaskSubject";

// Lotto 4 (regola di 46): chi non vede quale task fosse legge solo che una
// task è stata eliminata, senza codice, titolo né chi.
describe("la riga di una task eliminata", () => {
  const base = {
    kind: "task_deleted" as const,
    at: "2026-11-24T08:00:00.000Z",
    taskId: "t1",
    byId: "p-marco",
    byName: "Marco Bellini",
  };

  it("con codice e titolo: chi, quale", () => {
    render(<DeletedTaskSubject event={{ ...base, code: "ACQ-9", title: "Prova" }} />);
    expect(screen.getByText(/Marco Bellini deleted/)).toBeInTheDocument();
    expect(screen.getByText("ACQ-9")).toBeInTheDocument();
  });

  it("nascosta: «A task was deleted», niente nome", () => {
    const { container } = render(
      <DeletedTaskSubject event={{ ...base, code: "", title: "", concealed: true }} />,
    );
    expect(container).toHaveTextContent("A task was deleted");
    expect(container).not.toHaveTextContent("Marco");
  });
});
