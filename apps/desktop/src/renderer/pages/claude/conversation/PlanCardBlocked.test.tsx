import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithData } from "../../../test/renderWithData";
import { PlanCard } from "./PlanCard";

// Review F4b I1: con l'approvazione spenta (`blockedReason`, es. operazioni
// dell'agente spente) Approve è spento anche se chi guarda potrebbe
// approvare (`canDecidePlan`): difesa in profondità sul permesso del server.

describe("la scheda del piano di una correzione bloccata", () => {
  it("Approve spento col motivo, Reject attivo", () => {
    const event = {
      id: "p1",
      at: "2026-11-15T10:00:00.000Z",
      type: "plan" as const,
      planText: "",
      summary: "",
      status: "pending" as const,
      serverPlan: {
        steps: [
          {
            action: "container.restart",
            params: { container: "api", timeoutSeconds: 30 },
            why: "x",
          },
        ],
      },
    };
    renderWithData(
      <PlanCard
        conversationId="c1"
        event={event as never}
        canDecidePlan
        projectCode="ACQ"
        statusShown
        serverFix={{
          code: "SRV-1",
          canReject: true,
          blockedReason: "operations_off",
          startedByViewer: false,
          pruneWarning: null,
        }}
        onDecide={async () => {}}
      />,
      { personId: "p-roberta" },
    );
    expect(screen.getByRole("button", { name: "Approve the plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject the plan" })).toBeEnabled();
  });

  it("409 plan_stale: chiede un piano nuovo; senza piano da leggere niente «Read the full plan»", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const event = {
      id: "p2",
      at: "2026-11-15T10:00:00.000Z",
      type: "plan" as const,
      planText: "",
      summary: "",
      status: "pending" as const,
      serverPlan: {
        steps: [{ action: "container.start", params: { container: "api" }, why: "x" }],
      },
    };
    renderWithData(
      <PlanCard
        conversationId=""
        event={event as never}
        canDecidePlan
        projectCode="ACQ"
        statusShown
        serverFix={{
          code: "SRV-1",
          canReject: true,
          blockedReason: null,
          startedByViewer: false,
          pruneWarning: null,
        }}
        onDecide={async () => {
          throw new Error("invalid: plan_stale");
        }}
      />,
      { personId: "p-roberta" },
    );
    expect(screen.queryByRole("button", { name: /Read the full plan/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Approve the plan" }));
    expect(
      await screen.findByText("The plan no longer fits the server: ask Claude for a new plan."),
    ).toBeInTheDocument();
  });
});
