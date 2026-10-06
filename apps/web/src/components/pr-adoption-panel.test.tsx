import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrAdoption } from "../lib/api";
import { PrAdoptionPanel } from "./pr-adoption-panel";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATH = `/api/tickets/${TICKET_ID}/repositories/${REPO_ID}/adoption`;

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
 * Fixture SENZA i campi col `.default()` (`branch`, `unavailableReason`,
 * `adoptedAt`, `adoptedBy`, `canManage`): è la forma di un server più vecchio
 * del bundle, e il web fa un cast, non un parse. I test che li vogliono li
 * aggiungono con `overrides` — la loro assenza qui è la prova che la difesa
 * `??` nel punto di lettura c'è.
 */
function adoption(overrides: Partial<PrAdoption> = {}): PrAdoption {
  return {
    repositoryId: REPO_ID,
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    state: "available",
    ...overrides,
  };
}

function renderPanel(a: PrAdoption) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <PrAdoptionPanel ticketId={TICKET_ID} adoption={a} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("PrAdoptionPanel", () => {
  it("senza canManage (server vecchio, o un operatore) il bottone NON c'è", () => {
    renderPanel(adoption());
    expect(screen.queryByRole("button", { name: "Let Stubwise fix it" })).toBeNull();
    expect(screen.queryByTestId("pr-adoption")).toBeNull();
  });

  it("un operatore vede che Stubwise la corregge, ma non il bottone per fermarlo", () => {
    renderPanel(adoption({ state: "adopted", adoptedBy: "mario@acme.test", canManage: false }));
    expect(screen.getByText("Stubwise is correcting this PR · handed over by mario@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop correcting" })).toBeNull();
  });

  it("un maintainer: nota, conferma, POST con la nota, ticket ricaricato", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { correctionId: "33333333-3333-4333-8333-333333333333" }));
    const { invalidate } = renderPanel(adoption({ canManage: true, branch: "feature/login" }));

    await userEvent.click(screen.getByRole("button", { name: "Let Stubwise fix it" }));
    expect(screen.getByText(/push its commits to feature\/login/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Note for the first correction (optional)"), "  segui la review ");
    await userEvent.click(screen.getByRole("button", { name: "Hand over and start the first correction" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(PATH);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ note: "segui la review" });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it("non disponibile: il bottone c'è ma è spento, col motivo", () => {
    renderPanel(adoption({ canManage: true, state: "unavailable", unavailableReason: "fork" }));
    expect(screen.getByRole("button", { name: "Let Stubwise fix it" })).toBeDisabled();
    expect(
      screen.getByText("Not available: the PR comes from a fork, and Stubwise cannot push to its branch."),
    ).toBeInTheDocument();
  });

  it("un motivo che il bundle non conosce: spento, con un testo generico (mai la chiave)", () => {
    renderPanel(
      adoption({
        canManage: true,
        state: "unavailable",
        unavailableReason: "archived" as PrAdoption["unavailableReason"],
      }),
    );
    expect(screen.getByRole("button", { name: "Let Stubwise fix it" })).toBeDisabled();
    expect(screen.getByText("Not available.")).toBeInTheDocument();
  });

  it("un rifiuto del server si MOSTRA tradotto", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { code: "pr_from_fork", message: "raw" }));
    renderPanel(adoption({ canManage: true }));
    await userEvent.click(screen.getByRole("button", { name: "Let Stubwise fix it" }));
    await userEvent.click(screen.getByRole("button", { name: "Hand over and start the first correction" }));
    expect(
      await screen.findByText("This PR comes from a fork: Stubwise cannot push to its branch"),
    ).toBeInTheDocument();
  });

  it("adottata, maintainer: «Smetti di correggere» in due passi → DELETE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    renderPanel(adoption({ state: "adopted", canManage: true }));

    // Senza `adoptedBy` (server vecchio): la riga senza nome.
    expect(screen.getByText("Stubwise is correcting this PR")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop correcting" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Stop: commits already pushed stay" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(PATH);
    expect(init!.method).toBe("DELETE");
  });
});
