import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectTimelineEntry } from "../lib/api";
import { ProjectTimeline, weekStart } from "./project-timeline";

/**
 * La timeline di progetto è SOLA LETTURA e puramente presentazionale: qui si
 * sorveglia il raggruppamento per settimana, la resa dei brief come separatori
 * e il fatto che una voce di PR mostri verdetto e riassunto della review —
 * cioè le tre cose che rendono la pagina leggibile a chi non legge codice.
 */

const TICKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function entries(...items: ProjectTimelineEntry[]): ProjectTimelineEntry[] {
  return items;
}

/**
 * Render dentro un router di memoria, per le voci che contengono un `Link`
 * (il brief e i ticket chiusi): fuori da un `RouterProvider` `useLinkProps`
 * esplode, e non è un difetto del componente — è il contratto di TanStack
 * Router. Le altre voci non ne hanno bisogno e restano su `render` nudo.
 */
function renderWithRouter(items: ProjectTimelineEntry[]) {
  const rootRoute = createRootRoute({ component: () => <ProjectTimeline entries={items} /> });
  const briefRoute = createRoute({ getParentRoute: () => rootRoute, path: "/briefs/$id" });
  const ticketRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tickets/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([briefRoute, ticketRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("weekStart", () => {
  it("riporta al lunedì della stessa settimana", () => {
    // Martedì 1 settembre 2026 → lunedì 31 agosto.
    expect(weekStart("2026-09-01T10:00:00.000Z")).toBe("2026-08-31");
  });

  it("una domenica appartiene alla settimana che comincia il lunedì PRECEDENTE", () => {
    // È la trappola classica di `getDay()`, dove domenica vale 0: senza
    // correzione una domenica finirebbe nella settimana successiva.
    expect(weekStart("2026-09-06T23:00:00.000Z")).toBe("2026-08-31");
  });

  it("un lunedì è già l'inizio della sua settimana", () => {
    expect(weekStart("2026-09-07T00:30:00.000Z")).toBe("2026-09-07");
  });
});

describe("ProjectTimeline", () => {
  it("raggruppa le voci per settimana, una intestazione per gruppo", () => {
    render(
      <ProjectTimeline
        entries={entries(
          {
            kind: "ticket_opened",
            id: TICKET,
            at: "2026-09-01T10:00:00.000Z",
            ticketNumber: 7,
            title: "Login rotto",
          },
          {
            kind: "report_day",
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            at: "2026-09-07T00:00:00.000Z",
            date: "2026-09-07",
            summary: "Giornata di rifiniture.",
          },
        )}
      />,
    );
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getByText(/Login rotto/)).toBeInTheDocument();
    expect(within(groups[1]!).getByText(/Giornata di rifiniture/)).toBeInTheDocument();
  });

  it("la voce PR mostra verdetto e riassunto della review", () => {
    render(
      <ProjectTimeline
        entries={entries({
          kind: "pr_merged",
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          at: "2026-09-01T10:00:00.000Z",
          ticketId: TICKET,
          ticketNumber: 7,
          ticketTitle: "Login rotto",
          prUrl: "https://git.example.com/pr/42",
          reviewVerdict: "approve",
          prSummary: "Sistema il login senza toccare il resto.",
        })}
      />,
    );
    expect(screen.getByText("Sistema il login senza toccare il resto.")).toBeInTheDocument();
    expect(screen.getByText(/review: approved/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pull request/i })).toHaveAttribute(
      "href",
      "https://git.example.com/pr/42",
    );
  });

  it("una PR senza review non inventa un verdetto", () => {
    render(
      <ProjectTimeline
        entries={entries({
          kind: "pr_opened",
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          at: "2026-09-01T10:00:00.000Z",
          ticketId: TICKET,
          ticketNumber: 7,
          ticketTitle: "Login rotto",
          prUrl: "https://git.example.com/pr/43",
        })}
      />,
    );
    expect(screen.queryByText(/review:/i)).not.toBeInTheDocument();
  });

  it("il brief è un SEPARATORE, non una riga come le altre, e LINKA al brief intero", async () => {
    renderWithRouter(
      entries({
        kind: "brief",
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        at: "2026-09-01T10:00:00.000Z",
        periodStart: "2026-08-24",
        periodEnd: "2026-08-30",
        headline: "Siamo a metà del rilascio.",
      }),
    );
    const separator = await screen.findByRole("separator");
    expect(within(separator).getByText(/Siamo a metà del rilascio/)).toBeInTheDocument();
    expect(within(separator).getByText(/Weekly brief/i)).toBeInTheDocument();
    // Il link che la Fase C aveva lasciato in sospeso: la headline è l'incipit,
    // il testo intero sta sulla pagina del brief.
    expect(within(separator).getByRole("link")).toHaveAttribute(
      "href",
      "/briefs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
  });

  it("la decisione mostra il testo deciso e chi ha deciso", () => {
    render(
      <ProjectTimeline
        entries={entries({
          kind: "decision",
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          at: "2026-09-01T10:00:00.000Z",
          title: "Approvato il piano del ticket #7",
          decision: "Procedere con il fix proposto",
          decidedBy: { id: TICKET, email: "ada@example.com" },
        })}
      />,
    );
    expect(screen.getByText(/Procedere con il fix proposto/)).toBeInTheDocument();
    expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
  });

  it("senza voci mostra lo stato vuoto, non un elenco vuoto", () => {
    render(<ProjectTimeline entries={[]} />);
    expect(screen.getByText("No events in this period.")).toBeInTheDocument();
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });
});
