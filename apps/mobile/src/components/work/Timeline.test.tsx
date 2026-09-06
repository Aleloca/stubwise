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
  }));
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
});
