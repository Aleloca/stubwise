import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MilestoneWithCounts } from "../lib/api";
import { MilestoneProgress } from "./milestone-progress";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function milestone(overrides: Partial<MilestoneWithCounts> = {}): MilestoneWithCounts {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: PROJECT_ID,
    name: "v1.0",
    description: null,
    dueDate: null,
    status: "open",
    closedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 4, completed: 1, byStatus: {} },
    ...overrides,
  };
}

describe("MilestoneProgress", () => {
  it("mostra nome e avanzamento come completati su totale", () => {
    render(<MilestoneProgress milestone={milestone()} />);
    expect(screen.getByText("v1.0")).toBeInTheDocument();
    expect(screen.getByText("1/4 tickets done")).toBeInTheDocument();
  });

  it("la barra è accessibile e porta la percentuale come valore", () => {
    render(<MilestoneProgress milestone={milestone()} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("una milestone senza ticket non divide per zero", () => {
    render(<MilestoneProgress milestone={milestone({ counts: { total: 0, completed: 0, byStatus: {} } })} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("no tickets yet")).toBeInTheDocument();
  });

  it("senza scadenza lo dice, invece di lasciare il posto vuoto", () => {
    render(<MilestoneProgress milestone={milestone()} />);
    expect(screen.getByText("no due date")).toBeInTheDocument();
  });

  it("una scadenza già passata è marcata come scaduta", () => {
    render(
      <MilestoneProgress
        milestone={milestone({ dueDate: "2026-08-01T00:00:00.000Z" })}
        now={new Date("2026-09-06T12:00:00.000Z")}
      />,
    );
    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it("una scadenza futura NON è marcata come scaduta", () => {
    render(
      <MilestoneProgress
        milestone={milestone({ dueDate: "2026-10-01T00:00:00.000Z" })}
        now={new Date("2026-09-06T12:00:00.000Z")}
      />,
    );
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(screen.getByText(/due 01\/10\/2026/)).toBeInTheDocument();
  });
});
