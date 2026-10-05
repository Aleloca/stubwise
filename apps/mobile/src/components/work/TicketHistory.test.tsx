import type { Reader, TicketHistory as TicketHistoryData, TicketHistoryEvent } from "@stubwise/shared";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import "../../i18n";
import { TicketHistory } from "./TicketHistory";

/**
 * La «Storia del lavoro» vera (piano B3). Le fixture sono COMPLETE (ogni
 * campo dell'evento, la trappola delle fixture dell'app): il parse non gira
 * nei test, quindi un campo mancante arriverebbe `undefined` al componente.
 */

function event(i: number, overrides: Partial<Reader<TicketHistoryEvent>> = {}): Reader<TicketHistoryEvent> {
  return {
    id: `run_started:${i}`,
    kind: "run_started",
    // Dal più recente, come lo manda il server.
    at: new Date(Date.UTC(2026, 9, 2, 12, 0) - i * 60_000).toISOString(),
    actor: null,
    prNumber: null,
    prUrl: null,
    round: null,
    detail: null,
    fromStatus: null,
    ...overrides,
  };
}

function history(events: Reader<TicketHistoryEvent>[], total = events.length): Reader<TicketHistoryData> {
  return { events, total };
}

// `Linking.openURL` è già un `jest.fn` nel preset di React Native: lo spy
// restituisce lo stesso mock, e le chiamate di un test passerebbero al
// successivo senza un azzeramento esplicito.
beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("TicketHistory", () => {
  test("12 eventi: 8 righe e «Mostra tutto (12)»; premuto, tutte e 12", async () => {
    const events = Array.from({ length: 12 }, (_, i) => event(i));
    await render(<TicketHistory history={history(events)} unavailable={false} />);
    expect(screen.getAllByTestId(/^work-history-row-/)).toHaveLength(8);
    expect(screen.getByText("Mostra tutto (12)")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("work-history-show-all"));
    expect(screen.getAllByTestId(/^work-history-row-/)).toHaveLength(12);
    expect(screen.queryByTestId("work-history-show-all")).toBeNull();
  });

  test("«Mostra tutto (N)» usa total del server, e oltre il tetto lo dice", async () => {
    const events = Array.from({ length: 10 }, (_, i) => event(i));
    await render(<TicketHistory history={history(events, 250)} unavailable={false} />);
    expect(screen.getByText("Mostra tutto (250)")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("work-history-show-all"));
    expect(screen.getByText("Ultimi 10 di 250")).toBeTruthy();
  });

  test("un kind sconosciuto è una riga generica, non sparisce", async () => {
    await render(
      <TicketHistory history={history([event(0, { id: "boh:1", kind: "brand_new" })])} unavailable={false} />,
    );
    expect(screen.getByTestId("work-history-row-boh:1")).toBeTruthy();
    expect(screen.getByText("Aggiornamento")).toBeTruthy();
  });

  test("una riga con prUrl è un bottone e apre la PR; senza, non è premibile", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await render(
      <TicketHistory
        history={history([
          event(0, {
            id: "pr_opened:1",
            kind: "pr_opened",
            prNumber: 4,
            prUrl: "https://bitbucket.org/acme/r/pull-requests/4",
          }),
          event(1, { id: "status_changed:1", kind: "status_changed", detail: "in_review", fromStatus: "in_progress" }),
        ])}
        unavailable={false}
      />,
    );
    const withPr = screen.getByTestId("work-history-row-pr_opened:1");
    expect(withPr.props.accessibilityRole).toBe("button");
    await fireEvent.press(withPr);
    expect(open).toHaveBeenCalledWith("https://bitbucket.org/acme/r/pull-requests/4");

    const without = screen.getByTestId("work-history-row-status_changed:1");
    expect(without.props.accessibilityRole).toBeUndefined();
  });

  test("un prUrl non http/https non è un bottone e non apre niente", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await render(
      <TicketHistory
        history={history([event(0, { id: "pr_opened:x", kind: "pr_opened", prNumber: 4, prUrl: "javascript:alert(1)" })])}
        unavailable={false}
      />,
    );
    const row = screen.getByTestId("work-history-row-pr_opened:x");
    expect(row.props.accessibilityRole).toBeUndefined();
    await fireEvent.press(row);
    expect(open).not.toHaveBeenCalled();
  });

  test("evento con i soli campi obbligatori (default del parse): la riga c'è", async () => {
    await render(<TicketHistory history={history([event(0)])} unavailable={false} />);
    expect(screen.getByTestId("work-history-row-run_started:0")).toBeTruthy();
    expect(screen.getByText("Lavoro avviato")).toBeTruthy();
  });

  test("storia non disponibile (query fallita, server vecchio): lo dice", async () => {
    await render(<TicketHistory history={undefined} unavailable />);
    expect(screen.getByText("Storia non disponibile.")).toBeTruthy();
  });

  test("storia vuota: lo dice", async () => {
    await render(<TicketHistory history={history([])} unavailable={false} />);
    expect(screen.getByTestId("work-history-empty")).toBeTruthy();
  });

  test("chiusura, persona eliminata e PR con correzione, in parole", async () => {
    await render(
      <TicketHistory
        history={history([
          event(0, { id: "ticket_closed:1", kind: "ticket_closed", detail: "done" }),
          event(1, {
            id: "changes_requested:1",
            kind: "changes_requested",
            actor: { type: "user", name: null },
            prNumber: 4,
            round: 3,
          }),
        ])}
        unavailable={false}
      />,
    );
    expect(screen.getByText("Ticket chiuso (done)")).toBeTruthy();
    expect(screen.getByText("qualcuno · PR #4 · correzione 3")).toBeTruthy();
  });
});
