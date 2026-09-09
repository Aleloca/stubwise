import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { WORK_STATES, type PrState, type TicketSource, type WorkState } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import {
  PrStateBadge,
  SourceBadge,
  WORK_STATE_DOT_CLASS,
  WORK_STATE_LABEL_KEYS,
  WORK_STATE_TEXT_CLASS,
} from "./badges";

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

/**
 * Vocabolario "in parole" del job AI (fase 7, Task 8): `workStateFor`
 * (`@stubwise/shared`) è totale sull'enum `WorkState`, quindi qui si verifica
 * che i tre `Record` che il web ne deriva — chiave i18n, colore-testo,
 * colore-pallino — coprano gli stessi 11 stati, non un sottoinsieme.
 * `WORK_STATES` è la fonte di verità: se un domani ne arriva un dodicesimo,
 * questo test lo scopre a runtime anche se il typecheck (che è la prima
 * difesa, essendo `Record` esaustivi) fosse per qualche motivo bypassato.
 */
describe("vocabolario WorkState (ai-job-timeline / activity-feed)", () => {
  it("copre tutti gli 11 WorkState in chiave i18n, colore-testo e colore-pallino", () => {
    for (const state of WORK_STATES) {
      expect(WORK_STATE_LABEL_KEYS[state]).toBeTruthy();
      expect(WORK_STATE_TEXT_CLASS[state]).toBeTruthy();
      expect(WORK_STATE_DOT_CLASS[state]).toBeTruthy();
    }
    expect(WORK_STATES.length).toBe(11);
  });

  // Testo PORTATO verbatim da `apps/mobile/src/i18n/en.json`
  // (`work.status.*`): stesso vocabolario "in parole", stesse chiavi.
  const cases: Array<[WorkState, string]> = [
    ["proposed", "Queued"],
    ["planning", "Analyzing"],
    ["working", "Running"],
    ["held", "Waiting to start"],
    ["waiting_answer", "Waiting for an answer"],
    ["waiting_approval", "Plan to approve"],
    ["pr_ready", "PR open"],
    ["done", "Released"],
    ["failed", "Failed"],
    ["skipped", "Skipped"],
    ["rejected", "PR closed"],
  ];

  it.each(cases)("rende l'etichetta 'in parole' i18n per lo stato %s", (state, label) => {
    function Probe() {
      const { t } = useTranslation();
      return <span>{t(WORK_STATE_LABEL_KEYS[state])}</span>;
    }
    render(<Probe />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
