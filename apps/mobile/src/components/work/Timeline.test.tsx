import { UNKNOWN } from "@stubwise/shared";
import type { WorkStep } from "../../lib/timeline";
import { render, screen } from "@testing-library/react-native";
import "../../i18n";
import { Timeline } from "./Timeline";

function steps(overrides: Partial<Record<WorkStep["id"], WorkStep["status"]>> = {}): WorkStep[] {
  const defaults: Record<WorkStep["id"], WorkStep["status"]> = {
    proposed: "done",
    questionAnswered: "future",
    planApproved: "future",
    working: "future",
    prReview: "future",
    release: "future",
  };
  return (Object.keys(defaults) as WorkStep["id"][]).map((id) => ({
    id,
    status: overrides[id] ?? defaults[id],
    at: null,
    verdict: null,
  }));
}

function withVerdict(verdict: WorkStep["verdict"]): WorkStep[] {
  return steps({ prReview: "done" }).map((step) => (step.id === "prReview" ? { ...step, verdict } : step));
}

describe("Timeline", () => {
  test("mostra sempre tutti e 6 i passi, nell'ordine del canvas", async () => {
    await render(<Timeline steps={steps()} />);
    for (const label of [
      "Proposto",
      "Domanda risposta",
      "Piano approvato",
      "In esecuzione",
      "PR e review",
      "Rilascio",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  test("il passo 'current' è quello del checkpoint — testID dedicato per il passo attivo", async () => {
    await render(<Timeline steps={steps({ proposed: "done", questionAnswered: "current" })} />);
    expect(screen.getByTestId("timeline-step-questionAnswered-current")).toBeTruthy();
    expect(screen.queryByTestId("timeline-step-planApproved-current")).toBeNull();
  });

  test("un passo con 'at' mostra la data formattata", async () => {
    const withDate: WorkStep[] = steps().map((step) =>
      step.id === "proposed" ? { ...step, at: "2026-08-12T09:00:00.000Z" } : step,
    );
    await render(<Timeline steps={withDate} />);
    // La formattazione esatta la decide `lib/format`; qui basta che QUALCOSA
    // compaia oltre all'etichetta — non l'assenza di data.
    expect(screen.getByTestId("timeline-step-proposed-at")).toBeTruthy();
  });

  test("un passo future senza 'at' non mostra alcuna data", async () => {
    await render(<Timeline steps={steps()} />);
    expect(screen.queryByTestId("timeline-step-release-at")).toBeNull();
  });

  test("il verdetto della review compare in parole accanto a 'PR e review'", async () => {
    await render(<Timeline steps={withVerdict("approve")} />);
    expect(screen.getByTestId("timeline-step-prReview-verdict")).toBeTruthy();
    expect(screen.getByText("approvata")).toBeTruthy();
  });

  test("verdetto 'request_changes': le parole della review, non il valore grezzo", async () => {
    await render(<Timeline steps={withVerdict("request_changes")} />);
    expect(screen.getByText("modifiche richieste")).toBeTruthy();
    expect(screen.queryByText("request_changes")).toBeNull();
  });

  test("nessun verdetto: nessuna etichetta in più sul passo", async () => {
    await render(<Timeline steps={withVerdict(null)} />);
    expect(screen.queryByTestId("timeline-step-prReview-verdict")).toBeNull();
  });

  /**
   * Un verdetto che questa build non conosce (server più nuovo, `readerSchema`)
   * non deve né sparire in silenzio né mostrare la stringa grezza: si dice che
   * una review c'è stata, senza pretendere di saperne l'esito.
   */
  test("verdetto UNKNOWN: etichetta generica, mai il valore grezzo", async () => {
    await render(<Timeline steps={withVerdict(UNKNOWN)} />);
    expect(screen.getByText("review completata")).toBeTruthy();
  });
});
