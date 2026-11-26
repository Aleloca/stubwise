import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { ServerCommandRow } from "../../domain/servers/commands";
import { renderWithData } from "../../test/renderWithData";
import { stepLabel } from "../claude/conversation/serverFixPlan";
import { commandLabel, ServerCommandLog } from "./ServerCommandLog";

// Review F4b (minori): un comando annullato o scaduto non è «Failed»; la
// frase di un comando prende solo i parametri noti; un'azione o una pulizia
// che l'app non conosce ha una frase di ripiego.

const row = (over: Partial<ServerCommandRow> = {}): ServerCommandRow => ({
  id: "c1",
  action: "container.restart",
  params: { container: "api", timeoutSeconds: 30 },
  kind: "change",
  via: "agent",
  status: "done",
  requestedById: null,
  approvalId: "a1",
  issuedAt: "2026-11-15T10:00:00.000Z",
  exitCode: 0,
  output: null,
  ...over,
});

describe("il registro dei comandi della correzione", () => {
  it("annullato e scaduto hanno il loro stato, non «Failed»", async () => {
    renderWithData(
      <ServerCommandLog
        commands={[row({ id: "c1", status: "cancelled" }), row({ id: "c2", status: "expired" })]}
        serverCode="SRV-1"
        live
      />,
      { personId: "p-roberta" },
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Commands on SRV-1 · 2/ }));
  });

  it("la frase prende solo i parametri noti; un'azione sconosciuta dice il suo nome", () => {
    const t = i18n.t.bind(i18n);
    expect(commandLabel(t, row({ params: { container: "api", evil: "<b>x</b>" } }))).toBe(
      "Restarted api",
    );
    expect(commandLabel(t, row({ action: "container.teleport", params: {} }))).toBe(
      "container.teleport",
    );
    expect(
      stepLabel(t, { action: "docker.prune", params: { what: "everything" }, why: "" } as never),
    ).toBe("Free up space");
  });
});
