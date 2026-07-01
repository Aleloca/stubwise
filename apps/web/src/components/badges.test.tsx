import { render, screen } from "@testing-library/react";
import type { PrState, TicketSource } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { PrStateBadge, SourceBadge } from "./badges";

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

/**
 * PrStateBadge: stato della PR aperta dal fix su un repo del ticket (Fase 3).
 * Le etichette passano da i18n (namespace `badges:prState.*`).
 */
describe("PrStateBadge", () => {
  const cases: Array<[PrState, string]> = [
    ["open", "PR open"],
    ["merged", "PR merged"],
    ["closed_unmerged", "PR closed"],
  ];

  it.each(cases)("rende l'etichetta i18n per lo stato PR %s", (state, label) => {
    render(<PrStateBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
