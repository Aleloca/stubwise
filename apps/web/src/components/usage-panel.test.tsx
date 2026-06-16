import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TicketUsage } from "../lib/api";
import { UsagePanel } from "./usage-panel";

function makeUsage(overrides: Partial<TicketUsage> = {}): TicketUsage {
  return {
    totalTokens: 1665,
    totalCostUsd: 0.0515,
    byModel: [
      {
        model: "claude-haiku-4-5",
        inputTokens: 110,
        outputTokens: 55,
        cacheReadTokens: 22,
        costUsd: 0.0015,
      },
      {
        model: "claude-opus-4-8",
        inputTokens: 12000,
        outputTokens: 500,
        cacheReadTokens: 200,
        costUsd: 0.05,
      },
    ],
    ...overrides,
  };
}

describe("UsagePanel", () => {
  it("mostra token totali con separatori e costo totale a 4 decimali", () => {
    render(<UsagePanel usage={makeUsage()} />);

    expect(screen.getByText("AI usage")).toBeInTheDocument();
    // it-IT raggruppa le migliaia da 10.000 in su: 1665 resta "1665".
    expect(screen.getByText("1665")).toBeInTheDocument();
    expect(screen.getByText("$0.0515")).toBeInTheDocument();
  });

  it("una riga per modello con token in/out, cache e costo", () => {
    render(<UsagePanel usage={makeUsage()} />);

    const haiku = screen.getByText("claude-haiku-4-5").closest("tr");
    expect(haiku).not.toBeNull();
    expect(within(haiku!).getByText("110")).toBeInTheDocument();
    expect(within(haiku!).getByText("55")).toBeInTheDocument();
    expect(within(haiku!).getByText("22")).toBeInTheDocument();
    expect(within(haiku!).getByText("$0.0015")).toBeInTheDocument();

    const opus = screen.getByText("claude-opus-4-8").closest("tr");
    expect(opus).not.toBeNull();
    // 12000 → "12.000".
    expect(within(opus!).getByText("12.000")).toBeInTheDocument();
    expect(within(opus!).getByText("$0.0500")).toBeInTheDocument();
  });

  it("costo null (modello senza costo riportato) mostra un trattino", () => {
    render(
      <UsagePanel
        usage={makeUsage({
          totalCostUsd: null,
          byModel: [
            {
              model: "modello-senza-costo",
              inputTokens: 7,
              outputTokens: 3,
              cacheReadTokens: 1,
              costUsd: null,
            },
          ],
        })}
      />,
    );

    const row = screen.getByText("modello-senza-costo").closest("tr");
    expect(within(row!).getByText("—")).toBeInTheDocument();
  });

  it("senza modelli non renderizza nulla (degrada a niente pannello)", () => {
    const { container } = render(<UsagePanel usage={makeUsage({ byModel: [] })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("AI usage")).not.toBeInTheDocument();
  });
});
