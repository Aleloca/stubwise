import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrCycle } from "../lib/api";
import { ticketKeys } from "../lib/queries";
import { PrCycleRow } from "./pr-cycle-row";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HELD_JOB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const URL_PATH = `/api/tickets/${TICKET_ID}/repositories/${REPO_ID}/corrections`;
const RUN_AI_PATH = `/api/tickets/${TICKET_ID}/run-ai`;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Fixture SENZA `heldReason`, `canResume` e `heldJobId` di proposito: è la
 * forma di un server più vecchio del bundle, e il web fa un cast, non un
 * parse. I test che vogliono quei campi li aggiungono con `overrides`.
 */
function cycle(overrides: Partial<PrCycle> = {}): PrCycle {
  return {
    state: "changes_requested",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    ...overrides,
  };
}

/** Una correzione ferma che chi guarda PUÒ riprendere, con l'id del job. */
function heldCycle(overrides: Partial<PrCycle> = {}): PrCycle {
  return cycle({
    state: "correcting",
    round: 1,
    canRequestCorrection: false,
    heldReason: "limit",
    canResume: true,
    heldJobId: HELD_JOB_ID,
    ...overrides,
  });
}

function renderRow(c: PrCycle) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <PrCycleRow ticketId={TICKET_ID} repositoryId={REPO_ID} cycle={c} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("PrCycleRow", () => {
  it("mostra la riga di stato derivata dal server", () => {
    renderRow(cycle({ state: "correcting", round: 2 }));
    expect(screen.getByText("Round 2 of 3 · correction in progress")).toBeInTheDocument();
  });

  it("il bottone segue canRequestCorrection (letto, mai dedotto)", () => {
    // Stato "approved" ma il server dice che non si può: il bottone è spento.
    renderRow(cycle({ state: "approved", canRequestCorrection: false }));
    expect(screen.getByRole("button", { name: "Apply corrections" })).toBeDisabled();
  });

  it("e lo stesso stato con canRequestCorrection vero lo accende", () => {
    // Stesso stato del test sopra: se il bottone dipendesse dallo stato (o dal
    // ruolo) e non dal campo, uno dei due test diventerebbe rosso.
    renderRow(cycle({ state: "approved", canRequestCorrection: true }));
    expect(screen.getByRole("button", { name: "Apply corrections" })).toBeEnabled();
  });

  it("la nota ha un tetto di 4000 caratteri", async () => {
    const user = userEvent.setup();
    renderRow(cycle());
    await user.click(screen.getByRole("button", { name: "Apply corrections" }));
    expect(screen.getByLabelText("Note for the agent (optional)")).toHaveAttribute("maxLength", "4000");
  });

  it("conferma con la nota: POST con la nota ripulita, poi dettaglio, job e feed invalidati", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(202, { correctionId: "c1" }));
    const { invalidate } = renderRow(cycle());

    await user.click(screen.getByRole("button", { name: "Apply corrections" }));
    await user.type(screen.getByLabelText("Note for the agent (optional)"), "  rinomina anche il test  ");
    await user.click(screen.getByRole("button", { name: "Start correction" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(input), "http://test.local").pathname).toBe(URL_PATH);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ note: "rinomina anche il test" });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.detail(TICKET_ID) }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.jobs(TICKET_ID) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.activity(TICKET_ID) });
    // Il modulo si chiude.
    expect(screen.queryByLabelText("Note for the agent (optional)")).not.toBeInTheDocument();
  });

  it("senza nota il corpo è vuoto", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(202, { correctionId: "c1" }));
    renderRow(cycle());

    await user.click(screen.getByRole("button", { name: "Apply corrections" }));
    await user.click(screen.getByRole("button", { name: "Start correction" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({});
  });

  it("un 409 si mostra tradotto, e il modulo resta aperto", async () => {
    const user = userEvent.setup();
    // Il message del server è diverso dal testo tradotto: così l'asserzione
    // prova la traduzione del `code`, non l'eco del message.
    fetchMock.mockResolvedValue(jsonResponse(409, { code: "correction_in_flight", message: "server says busy" }));
    renderRow(cycle());

    await user.click(screen.getByRole("button", { name: "Apply corrections" }));
    await user.click(screen.getByRole("button", { name: "Start correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A correction is already running on this PR");
    expect(screen.getByLabelText("Note for the agent (optional)")).toBeInTheDocument();
  });

  it("un 404 (nessuna PR) si mostra col suo testo", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(404, { code: "pr_not_found", message: "not found" }));
    renderRow(cycle());

    await user.click(screen.getByRole("button", { name: "Apply corrections" }));
    await user.click(screen.getByRole("button", { name: "Start correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There is no PR for this ticket on this repository",
    );
  });

  it("Annulla chiude senza chiamare il server", async () => {
    const user = userEvent.setup();
    renderRow(cycle());

    await user.click(screen.getByRole("button", { name: "Apply corrections" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply corrections" })).toBeEnabled();
  });

  describe("Riprendi una correzione ferma (G5)", () => {
    it("con canResume e heldJobId: run-ai con resumeCorrectionJobId, poi ticket ricaricato", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(jsonResponse(202, { jobId: HELD_JOB_ID, status: "queued" }));
      const { invalidate } = renderRow(heldCycle());

      await user.click(screen.getByRole("button", { name: "Resume correction" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [input, init] = fetchMock.mock.calls[0]!;
      expect(new URL(String(input), "http://test.local").pathname).toBe(RUN_AI_PATH);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ resumeCorrectionJobId: HELD_JOB_ID });
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.detail(TICKET_ID) }),
      );
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.jobs(TICKET_ID) });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.activity(TICKET_ID) });
    });

    it("server senza heldJobId: il bottone NON c'è (run-ai senza intento avvierebbe un fix)", () => {
      // `heldJobId` ASSENTE dalla fixture (non null): è ciò che arriva da un
      // server più vecchio, e il web non fa parse. `canResume` è vero, quindi
      // la condizione arriva davvero a leggere `heldJobId`.
      const withoutJobId = heldCycle();
      delete withoutJobId.heldJobId;
      expect("heldJobId" in withoutJobId).toBe(false);
      renderRow(withoutJobId);

      // La riga di stato c'è: il componente è montato e sta dicendo «ferma».
      expect(screen.getByText(/correction on hold/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume correction" })).not.toBeInTheDocument();
    });

    it("server senza canResume: il bottone NON c'è, anche con heldJobId", () => {
      // `canResume` ASSENTE: chi può riprendere lo dice solo il server.
      const withoutCanResume = heldCycle();
      delete withoutCanResume.canResume;
      expect("canResume" in withoutCanResume).toBe(false);
      renderRow(withoutCanResume);

      expect(screen.getByText(/correction on hold/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume correction" })).not.toBeInTheDocument();
    });

    it("canResume false (member, budget): niente bottone, la riga dice di chiedere a un maintainer", () => {
      renderRow(heldCycle({ heldReason: "budget", canResume: false }));
      expect(screen.getByText(/ask a maintainer to resume it/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume correction" })).not.toBeInTheDocument();
    });

    it("409 correction_not_held: testo dedicato e ticket ricaricato", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(jsonResponse(409, { code: "correction_not_held", message: "not held" }));
      const { invalidate } = renderRow(heldCycle());

      await user.click(screen.getByRole("button", { name: "Resume correction" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This correction is no longer on hold: the ticket has been reloaded",
      );
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.detail(TICKET_ID) });
    });

    it("409 job_in_flight: il testo dell'errore, e NESSUNA ricarica (decide il code, non lo status)", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(jsonResponse(409, { code: "job_in_flight", message: "busy" }));
      const { invalidate } = renderRow(heldCycle());

      await user.click(screen.getByRole("button", { name: "Resume correction" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("A job is already running on this ticket");
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("403 needs_maintainer: il testo dedicato", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(jsonResponse(403, { code: "needs_maintainer", message: "forbidden" }));
      renderRow(heldCycle({ heldReason: "budget" }));

      await user.click(screen.getByRole("button", { name: "Resume correction" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This correction is on hold because the budget is exhausted; only a maintainer can resume it: ask one",
      );
    });
  });
});
