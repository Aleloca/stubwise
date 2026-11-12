import { render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CalendarEventView } from "../../data/types";
import { blockShape, EventListRow, GridBlockBody, useEventName } from "./EventBlock";

// F3b: il calendario con TUTTI gli eventi porta il tipo di Google e il
// libero/occupato. La griglia li dice a PAROLA (e «libero» anche con la forma),
// mai col colore: fuori ufficio, tempo di concentrazione, libero.

const event = (over: Partial<CalendarEventView> = {}): CalendarEventView => ({
  id: "e1",
  calendarPersonIds: ["p1"],
  title: "Palestra",
  description: null,
  startsAt: "2026-11-12T14:00:00.000Z",
  endsAt: "2026-11-12T15:00:00.000Z",
  allDay: false,
  location: null,
  meetUrl: null,
  attendees: [],
  reminders: [],
  seriesId: null,
  projectId: null,
  projectBy: null,
  myResponse: null,
  isOrganizer: true,
  calendarEmail: "ada@acme.test",
  hasPrep: false,
  ...over,
});

const body = (e: CalendarEventView) =>
  render(
    <GridBlockBody e={e} heightPx={40} project={undefined} past={false} roomy={false} continues={false} fromPrevious={false} hideCode={false} />,
  );

describe("il tipo dell'evento e il libero/occupato (F3b)", () => {
  it("fuori ufficio e tempo di concentrazione: la parola sul blocco", () => {
    body(event({ eventType: "outOfOffice" }));
    expect(screen.getByText("Out of office")).toBeInTheDocument();
    body(event({ id: "e2", eventType: "focusTime" }));
    expect(screen.getByText("Focus time")).toBeInTheDocument();
  });

  it("libero (`transparent`): la parola e il contorno tratteggiato", () => {
    body(event({ transparency: "transparent" }));
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(blockShape(event({ transparency: "transparent" }))).toContain("border-dashed");
    expect(blockShape(event())).not.toContain("border-dashed");
  });

  it("un evento normale (o di un server di prima, senza i campi): nessuna parola in più", () => {
    body(event({ eventType: "default", transparency: "opaque" }));
    body(event({ id: "e3" }));
    for (const w of ["Out of office", "Focus time", "Free"]) expect(screen.queryByText(w)).toBeNull();
  });

  it("anche nella riga d'elenco e nel nome accessibile", () => {
    render(<EventListRow e={event({ eventType: "outOfOffice" })} project={undefined} name="x" onOpen={() => undefined} />);
    expect(screen.getByText("Out of office")).toBeInTheDocument();
    const { result } = renderHook(() => useEventName());
    expect(result.current(event({ transparency: "transparent" }), undefined, false)).toContain("Free");
  });
});

describe("gli invitati nella vista Giorno, dalla lista leggera (F3b)", () => {
  it("senza gli invitati sulla riga, il loro numero (`attendeeCount`): «3 guests»", () => {
    render(
      <GridBlockBody e={event({ attendees: [], attendeeCount: 3 })} heightPx={120} project={undefined} past={false} roomy continues={false} fromPrevious={false} hideCode={false} />,
    );
    expect(screen.getByText("3 guests")).toBeInTheDocument();
  });

  it("nessuno (o un server che non lo dice): niente riga", () => {
    render(
      <GridBlockBody e={event({ attendees: [], attendeeCount: null })} heightPx={120} project={undefined} past={false} roomy continues={false} fromPrevious={false} hideCode={false} />,
    );
    expect(screen.queryByText(/guests?$/)).toBeNull();
  });
});

