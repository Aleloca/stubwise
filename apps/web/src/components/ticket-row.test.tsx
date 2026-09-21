import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TicketListItem } from "../lib/api";
import { TicketRow } from "./ticket-row";

/**
 * La riga della lista ticket.
 *
 * ⚠️ Questo file nasce da un difetto trovato il 21 set 2026 mentre si
 * verificava il design della vista «ciò che è fermo»: la riga mostrava
 * `createdAt` — l'ETÀ del ticket — mentre `updatedAt` era già nello schema e
 * non veniva usato.
 *
 * **Perché era peggio del non mostrare niente**: se la riga non dicesse nulla,
 * chi guarda saprebbe di non sapere. Così invece SEMBRA dire l'ultima
 * attività, e un ticket aperto due mesi fa ma lavorato ieri leggeva «2 mesi
 * fa» — pareva fermo mentre si stava muovendo. Non un'informazione mancante:
 * un'informazione che si scambia per quella che serve.
 *
 * Il componente non aveva nessun test, ed è la ragione per cui il difetto è
 * passato: nessuno asseriva QUALE campo finisse a schermo.
 */

const MESI_FA = "2026-07-01T10:00:00.000Z";
const IERI = "2026-09-20T10:00:00.000Z";

function makeTicket(overrides: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: "t1",
    projectId: "p1",
    number: 42,
    title: "Login rotto",
    body: "",
    type: "bug",
    priority: "medium",
    status: "open",
    source: "manual",
    assigneeId: null,
    milestoneId: null,
    effort: null,
    labels: [],
    technicalPayload: null,
    occurrences: 1,
    lastSeenAt: null,
    createdAt: MESI_FA,
    updatedAt: MESI_FA,
    repositoryCount: 0,
    ...overrides,
  } as TicketListItem;
}

/** La riga è un `<Link>`: senza un router nel contesto non monta. */
function renderRow(ticket: TicketListItem) {
  const rootRoute = createRootRoute({ component: () => <TicketRow ticket={ticket} projectName="Portale B2B" /> });
  const ticketRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tickets/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([ticketRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // `<time>` non ha un ruolo ARIA, quindi non si raggiunge con `getByRole`:
  // si legge dal container, che è anche il modo più diretto di asserire QUALE
  // data finisce nell'attributo.
  return render(<RouterProvider router={router} />).container;
}

describe("TicketRow", () => {
  it("⚠️ mostra da quanto NON SI MUOVE, non da quanto esiste", async () => {
    // Il caso che il difetto sbagliava: aperto mesi fa, lavorato ieri.
    const container = renderRow(makeTicket({ createdAt: MESI_FA, updatedAt: IERI }));
    // Il router monta in modo asincrono: senza attesa il container è vuoto.
    await waitFor(() => expect(container.querySelector("time")).not.toBeNull());
    const quando = container.querySelector("time");
    expect(quando?.getAttribute("datetime")).toBe(IERI);
    // Il NEGATIVO: senza questa riga, un componente che mostrasse ancora
    // `createdAt` passerebbe la prima asserzione appena qualcuno riallineasse
    // le due date nella fixture.
    expect(quando?.getAttribute("datetime")).not.toBe(MESI_FA);
  });

  it("su un ticket mai toccato le due date coincidono, e va bene così", async () => {
    const container = renderRow(makeTicket());
    await waitFor(() => expect(container.querySelector("time")).not.toBeNull());
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(MESI_FA);
  });
});
