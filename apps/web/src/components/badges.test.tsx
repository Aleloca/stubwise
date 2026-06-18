import { render, screen } from "@testing-library/react";
import type { TicketSource } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { SourceBadge } from "./badges";

/**
 * SourceBadge: chip generico per la sorgente del ticket. Le etichette passano
 * da i18n (namespace `badges:source.*`). Qui verifichiamo che le sorgenti di
 * ingestion esterna (slack / webhook) rendano l'etichetta giusta, oltre alle
 * sorgenti storiche.
 */
describe("SourceBadge", () => {
  const cases: Array<[TicketSource, string]> = [
    ["manual", "Manual"],
    ["api", "API"],
    ["slack", "Slack"],
    ["webhook", "Webhook"],
  ];

  it.each(cases)("rende l'etichetta i18n per la source %s", (source, label) => {
    render(<SourceBadge source={source} />);
    expect(screen.getByText(label, { exact: false })).toBeInTheDocument();
  });
});
