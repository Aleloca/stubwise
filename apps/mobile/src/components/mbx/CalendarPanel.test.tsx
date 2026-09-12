import type { StubwiseClient } from "@stubwise/api-client";
import type { CalendarEventItem, CalendarEventPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { CalendarPanel } from "./CalendarPanel";

/**
 * La griglia mensile (App M3, Fase D, Task 11).
 *
 * `NOW` è il 15 settembre 2026 a mezzogiorno LOCALE (non UTC): la griglia
 * ragiona in giorni locali, e fissare l'ora a mezzogiorno tiene il test
 * lontano dai confini di giornata in qualunque fuso il runner giri — senza
 * dover fissare `TZ`, cosa che il test della logica pura
 * (`packages/shared/src/calendar-grid.test.ts`) fa già per conto suo.
 *
 * Con −30/+60 giorni la finestra va dal 16 agosto al 14 novembre: i mesi
 * raggiungibili sono agosto → novembre.
 */
const NOW = new Date(2026, 8, 15, 12, 0, 0);
const ID = "11111111-1111-4111-8111-111111111111";

function event(overrides: Partial<Reader<CalendarEventItem>> = {}): Reader<CalendarEventItem> {
  return {
    id: ID,
    accountId: "acc-1",
    accountEmail: "ops@example.com",
    recurringEventId: null,
    projectId: "proj-1",
    projectName: "negozio-web",
    title: "Riunione settimanale",
    organizer: "capo@example.com",
    attendees: [],
    // 17 settembre 2026, 09:30 LOCALI.
    startsAt: new Date(2026, 8, 17, 9, 30).toISOString(),
    endsAt: new Date(2026, 8, 17, 10, 30).toISOString(),
    allDay: false,
    status: "new",
    outcome: null,
    error: null,
    url: "https://calendar.google.com/x",
    eventUrl: null,
    reproposable: false,
    ...overrides,
  } as Reader<CalendarEventItem>;
}

function makeClient(range?: jest.Mock): StubwiseClient {
  return {
    calendar: {
      list: jest.fn(),
      range: range ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null } as Reader<CalendarEventPage>),
      series: jest.fn().mockResolvedValue({ items: [] }),
      putSeries: jest.fn(),
      deleteSeries: jest.fn(),
    },
    projects: { list: jest.fn().mockResolvedValue([]) },
  } as unknown as StubwiseClient;
}

async function renderPanel(client: StubwiseClient, now: Date = NOW) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <CalendarPanel now={now} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe("CalendarPanel — il mese e i puntini", () => {
  test("chiede al server le settimane INTERE del mese, non solo il mese", async () => {
    const range = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    await renderPanel(makeClient(range));
    await waitFor(() => expect(range).toHaveBeenCalled());

    const { from, to } = range.mock.calls[0]![0] as { from: string; to: string };
    // Settembre 2026 comincia di martedì: la griglia parte dal lunedì prima,
    // il 31 agosto — se chiedesse dal 1° settembre la prima riga avrebbe un
    // buco proprio dove i giorni ci sono.
    expect(new Date(from).getDate()).toBe(31);
    expect(new Date(from).getMonth()).toBe(7); // agosto
    expect(new Date(to).getTime()).toBeGreaterThan(new Date(from).getTime());
  });

  test("un giorno PIENO ha il puntino, uno vuoto no", async () => {
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [event()], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    expect(screen.getByTestId("calendar-dot-2026-09-17")).toBeTruthy();
    expect(screen.queryByTestId("calendar-dot-2026-09-18")).toBeNull();
  });

  test("un evento a cavallo di mezzanotte mette il puntino su ENTRAMBI i giorni", async () => {
    const spanning = event({
      id: "e-span",
      startsAt: new Date(2026, 8, 17, 23, 0).toISOString(),
      endsAt: new Date(2026, 8, 18, 1, 0).toISOString(),
    });
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [spanning], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    expect(screen.getByTestId("calendar-dot-2026-09-17")).toBeTruthy();
    expect(screen.getByTestId("calendar-dot-2026-09-18")).toBeTruthy();
  });
});

describe("CalendarPanel — il giorno scelto", () => {
  test("toccando un giorno pieno se ne vede l'agenda, con l'ora LOCALE", async () => {
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [event()], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("calendar-day-2026-09-17"));
    expect(screen.getByTestId(`calendar-event-${ID}`)).toBeTruthy();
    expect(screen.getByText("Riunione settimanale")).toBeTruthy();
    expect(screen.getByText("09:30")).toBeTruthy();
    expect(screen.getByText("negozio-web")).toBeTruthy();
  });

  test("un evento TUTTO IL GIORNO non mostra un'ora, che sarebbe inventata", async () => {
    // Il worker lo fissa a mezzanotte UTC perché è una DATA, non un istante:
    // renderne l'ora locale direbbe "02:00" a chi sta a Roma.
    const allDay = event({
      id: "e-allday",
      title: "Scadenza fattura",
      startsAt: "2026-09-17T00:00:00.000Z",
      endsAt: null,
      allDay: true,
    });
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [allDay], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("calendar-day-2026-09-17"));
    expect(screen.getByText("Scadenza fattura")).toBeTruthy();
    expect(screen.getByText("tutto il g.")).toBeTruthy();
    expect(screen.queryByText("00:00")).toBeNull();
    expect(screen.queryByText("02:00")).toBeNull();
  });

  test("un giorno VUOTO si spiega: cosa si vede qui e dove si cambiano le regole", async () => {
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [event()], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("calendar-day-2026-09-18"));
    expect(screen.getByTestId("calendar-day-empty")).toBeTruthy();
    expect(screen.getByText("Niente in questo giorno")).toBeTruthy();
    // Non «nessun evento»: dice PERCHÉ, e dove si cambia.
    expect(screen.getByText(/regole di smistamento/)).toBeTruthy();
    expect(screen.getByText(/sezione Posta del progetto/)).toBeTruthy();
  });
});

describe("CalendarPanel — il dettaglio di un evento (Task 12)", () => {
  test("un tap su un evento apre il foglio col suo dettaglio", async () => {
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [event()], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("calendar-day-2026-09-17"));

    expect(screen.queryByTestId("event-sheet")).toBeNull();
    await fireEvent.press(screen.getByTestId(`calendar-event-${ID}`));
    await waitFor(() => expect(screen.getByTestId("event-sheet")).toBeTruthy());
  });

  test("chiudendo il foglio si torna alla griglia", async () => {
    await renderPanel(makeClient(jest.fn().mockResolvedValue({ items: [event()], nextCursor: null })));
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("calendar-day-2026-09-17"));
    await fireEvent.press(screen.getByTestId(`calendar-event-${ID}`));
    await waitFor(() => expect(screen.getByTestId("event-sheet")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("event-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("event-sheet")).toBeNull());
    expect(screen.getByTestId("calendar-grid")).toBeTruthy();
  });
});

describe("CalendarPanel — i bordi della finestra di ingestione", () => {
  test("dentro la finestra non c'è nessuna spiegazione da dare", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    expect(screen.queryByTestId("calendar-edge-start")).toBeNull();
    expect(screen.queryByTestId("calendar-edge-end")).toBeNull();
  });

  test("indietro fino ad agosto, poi la freccia si ferma E la pagina dice perché", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("calendar-prev-month")); // agosto
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("agosto");

    // Il bordo si annuncia PRIMA che qualcuno prema una freccia che non risponde.
    expect(screen.getByTestId("calendar-edge-start")).toBeTruthy();
    expect(screen.getByText(/Più indietro di qui Stubwise non ha guardato/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId("calendar-prev-month")); // niente: luglio è fuori
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("agosto");
  });

  test("avanti fino a novembre, poi la freccia si ferma E la pagina dice perché", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("calendar-next-month")); // ottobre
    await fireEvent.press(screen.getByTestId("calendar-next-month")); // novembre
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("novembre");
    expect(screen.getByTestId("calendar-edge-end")).toBeTruthy();
    expect(screen.getByText(/Più avanti di qui Stubwise non guarda ancora/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId("calendar-next-month")); // niente: dicembre è fuori
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("novembre");
  });

  test("la spiegazione del bordo dice l'intervallo VERO, non una formula", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("calendar-prev-month"));

    // 15 settembre − 30 giorni = 16 agosto; + 60 = 14 novembre.
    expect(screen.getByText(/16 agosto/)).toBeTruthy();
    expect(screen.getByText(/14 novembre/)).toBeTruthy();
  });
});

describe("CalendarPanel — caricamento ed errore", () => {
  test("caricamento: skeleton, nessuna griglia vuota che sembri un mese senza niente", async () => {
    await renderPanel(makeClient(jest.fn(() => new Promise(() => {}))));
    expect(screen.getByTestId("calendar-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("calendar-grid")).toBeNull();
  });

  test("errore: si distingue da un mese vuoto, e Riprova ricarica", async () => {
    const range = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ items: [event()], nextCursor: null });
    await renderPanel(makeClient(range));

    await waitFor(() => expect(screen.getByTestId("calendar-error")).toBeTruthy());
    // Un errore NON deve travestirsi da giorno vuoto: sono due cose diverse.
    expect(screen.queryByTestId("calendar-day-empty")).toBeNull();

    await fireEvent.press(screen.getByTestId("calendar-retry"));
    await waitFor(() => expect(screen.getByTestId("calendar-dot-2026-09-17")).toBeTruthy());
  });
});
