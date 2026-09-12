import type { StubwiseClient } from "@stubwise/api-client";
import type { CalendarEventItem, CalendarEventPage, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
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

/**
 * Cambia mese e ASPETTA che la griglia torni: la chiave di query cambia con
 * il mese, quindi `useCalendarRange` riparte da `isPending` e il pannello
 * mostra di nuovo lo skeleton. Non è un dettaglio del test: è il
 * comportamento reale, ed è voluto (mostrare i puntini del mese precedente
 * su una griglia nuova sarebbe peggio di un attimo di attesa).
 */
async function goToMonth(direction: "prev" | "next") {
  await fireEvent.press(screen.getByTestId(`calendar-${direction}-month`));
  await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
}

async function renderPanel(
  client: StubwiseClient,
  now: Date = NOW,
  extra: { initialDay?: string; focusEventId?: string } = {},
) {
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
        <CalendarPanel now={now} {...extra} />
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

describe("CalendarPanel — le celle fuori dalla finestra di ingestione", () => {
  test("nel mese corrente nessuna cella è attenuata: la finestra lo copre tutto", async () => {
    // Settembre sta interamente dentro [16 ago, 14 nov].
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    expect(screen.queryByTestId("calendar-day-dim-2026-09-20")).toBeNull();
  });

  test("nel mese di bordo la PARTE fuori finestra è attenuata, il resto no", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    await goToMonth("prev"); // agosto

    // La finestra parte il 16 agosto: prima è attenuato, dopo no.
    expect(screen.getByTestId("calendar-day-dim-2026-08-03")).toBeTruthy();
    expect(screen.getByTestId("calendar-day-dim-2026-08-15")).toBeTruthy();
    expect(screen.queryByTestId("calendar-day-dim-2026-08-20")).toBeNull();
    // Il giorno del bordo è mezzo dentro: si mostra come DENTRO, o gli
    // appuntamenti di quel pomeriggio sembrerebbero non esistere.
    expect(screen.queryByTestId("calendar-day-dim-2026-08-16")).toBeNull();
  });

  test("un giorno fuori finestra dice una frase DIVERSA: non manda a rivedere le regole", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    await goToMonth("prev");
    await fireEvent.press(screen.getByTestId("calendar-day-2026-08-03"));

    expect(screen.getByTestId("calendar-day-out-of-window")).toBeTruthy();
    expect(screen.queryByTestId("calendar-day-empty")).toBeNull();
    expect(screen.getByText("Qui Stubwise non ha guardato")).toBeTruthy();
    // Mandare a rivedere le regole di smistamento per un giorno mai letto
    // sarebbe una caccia a vuoto: quella frase NON deve comparire qui.
    expect(screen.queryByText(/sezione Posta del progetto/)).toBeNull();
  });

  test("un giorno DENTRO la finestra e vuoto dice ancora la frase delle regole", async () => {
    await renderPanel(makeClient());
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    await goToMonth("prev");
    await fireEvent.press(screen.getByTestId("calendar-day-2026-08-25"));

    expect(screen.getByTestId("calendar-day-empty")).toBeTruthy();
    expect(screen.queryByTestId("calendar-day-out-of-window")).toBeNull();
    expect(screen.getByText(/sezione Posta del progetto/)).toBeTruthy();
  });
});

describe("CalendarPanel — arrivandoci da un deep link (App M3, Fase D)", () => {
  const range = () => jest.fn().mockResolvedValue({ items: [event()], nextCursor: null });

  test("con un giorno: la griglia nasce su QUEL mese e quel giorno, non su oggi", async () => {
    await renderPanel(makeClient(range()), NOW, { initialDay: "2026-10-08" });
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());

    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("ottobre");
    expect(screen.getByTestId("calendar-day-2026-10-08").props.accessibilityState.selected).toBe(true);
  });

  test("il giorno si legge in LOCALE: `2026-09-17` è il 17, non il 16", async () => {
    // `new Date("2026-09-17")` sarebbe mezzanotte UTC — il giorno prima per
    // chi sta a ovest di Greenwich. La griglia ragiona in giorni locali.
    await renderPanel(makeClient(range()), NOW, { initialDay: "2026-09-17" });
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    expect(screen.getByTestId("calendar-day-2026-09-17").props.accessibilityState.selected).toBe(true);
  });

  test("con un giorno illeggibile si ricade su oggi, invece di non mostrare niente", async () => {
    await renderPanel(makeClient(range()), NOW, { initialDay: "domani" });
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("settembre");
  });

  test("con l'id dell'appuntamento: il foglio si apre da solo appena i dati arrivano", async () => {
    await renderPanel(makeClient(range()), NOW, { initialDay: "2026-09-17", focusEventId: ID });
    await waitFor(() => expect(screen.getByTestId("event-sheet")).toBeTruthy());
    // `within` e non `screen`: il titolo compare DUE volte — nella riga
    // dell'agenda sotto e nel foglio sopra — ed è giusto così. Quello che
    // questo test verifica è che sia nel FOGLIO.
    expect(within(screen.getByTestId("event-sheet")).getByText("Riunione settimanale")).toBeTruthy();
  });

  test("chiuso il foglio NON si riapre: il focus si consuma una volta sola", async () => {
    // Senza questo, il primo refetch (o un cambio giorno) lo rimetterebbe
    // davanti a chi l'aveva appena chiuso.
    await renderPanel(makeClient(range()), NOW, { initialDay: "2026-09-17", focusEventId: ID });
    await waitFor(() => expect(screen.getByTestId("event-sheet")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("event-sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("event-sheet")).toBeNull());

    await fireEvent.press(screen.getByTestId("calendar-day-2026-09-18"));
    expect(screen.queryByTestId("event-sheet")).toBeNull();
  });

  test("un id che non è fra gli eventi del mese: resta il giorno, nessun foglio vuoto", async () => {
    // Una card vecchia, o un appuntamento cancellato da Google: il link
    // porta comunque dove voleva portare, senza aprire un foglio su nulla.
    await renderPanel(makeClient(range()), NOW, {
      initialDay: "2026-09-17",
      focusEventId: "00000000-0000-4000-8000-000000000000",
    });
    await waitFor(() => expect(screen.getByTestId("calendar-grid")).toBeTruthy());
    expect(screen.queryByTestId("event-sheet")).toBeNull();
    expect(screen.getByTestId("calendar-day-2026-09-17").props.accessibilityState.selected).toBe(true);
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
