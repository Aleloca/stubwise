import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { whenAnalysesIdle } from "../../data/servers/analysis";
import { setStreamLatency, state } from "../../data/store";
import type { ServerDetail } from "../../data/servers";
import { renderRoute } from "../../test/renderRoute";
import { renderWithData } from "../../test/renderWithData";
import { ManualAnalysis } from "./ManualAnalysis";

// Area 8, F4b (R0-A2): «Ask Claude to look into it» sul dettaglio del
// server, per chi ha `servers.operate` in un progetto che lo usa; la riga
// dell'ultima analisi a mano dice chi l'ha chiesta e dove sta la diagnosi.

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  await whenAnalysesIdle();
  resetApi();
});

async function open(person: string) {
  renderRoute("/p/ACQ/servers/SRV-1", person);
  await screen.findByRole("heading", { level: 1 });
}

const region = () => screen.getByRole("region", { name: "Claude on this server" });

describe("analisi a mano dal dettaglio (R0-A2)", () => {
  it("Laura (senza servers.operate) non vede il bottone", async () => {
    await open("p-laura");
    expect(screen.queryByRole("button", { name: "Ask Claude to look into it" })).toBeNull();
  });

  it("Marco la avvia: la riga dice che Claude guarda, chiesto da lui; alla fine la diagnosi con la task", async () => {
    // Lo stream rallentato: l'analisi si coglie a metà.
    setStreamLatency(20);
    await open("p-marco");
    await userEvent.click(screen.getByRole("button", { name: "Ask Claude to look into it" }));
    expect(
      await within(region()).findByText(
        "Marco Bellini asked Claude to look into it: Claude is looking with read-only access",
      ),
    ).toBeInTheDocument();
    // Mentre gira il bottone non c'è.
    expect(screen.queryByRole("button", { name: "Ask Claude to look into it" })).toBeNull();
    await whenAnalysesIdle();
    const a = state.serverAnalyses.find((x) => x.startedBy === "p-marco")!;
    const task = state.tasksById.get(a.taskId!)!;
    await waitFor(() =>
      expect(
        within(region()).getByText("Diagnosis ready, asked by Marco Bellini"),
      ).toBeInTheDocument(),
    );
    expect(within(region()).getByRole("link", { name: new RegExp(task.code) })).toBeInTheDocument();
  });

  it("un errore si dice nelle parole del motivo, e il bottone resta", async () => {
    await open("p-marco");
    failNext("servers.startServerAnalysis");
    await userEvent.click(screen.getByRole("button", { name: "Ask Claude to look into it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't ask Claude to look into it. Try again.",
    );
    expect(screen.getByRole("button", { name: "Ask Claude to look into it" })).toBeInTheDocument();
  });
});

describe("build app: un'analisi a mano bloccata prima di partire (il cancello del worker)", () => {
  it("la riga dice perché, senza sessione né task", () => {
    const server = {
      code: "SRV-1",
      canStartAnalysis: false,
      manualAnalysis: {
        id: "an-1",
        serverCode: "SRV-1",
        episodeId: null,
        outcome: "stopped",
        startedBy: { id: "p-marco", name: "Marco Bellini" },
        startedAt: "2026-11-15T10:00:00.000Z",
        endedAt: null,
        canViewDiagnosis: false,
        sessionId: null,
        attribution: null,
        diagnosis: null,
        taskCode: null,
        blockedBy: "monthly_budget",
      },
    } as unknown as ServerDetail;
    renderWithData(<ManualAnalysis server={server} />, { personId: "p-marco" });
    expect(
      screen.getByText(
        "Claude didn't look into it (asked by Marco Bellini): the monthly AI budget is used up.",
      ),
    ).toBeInTheDocument();
  });
});
