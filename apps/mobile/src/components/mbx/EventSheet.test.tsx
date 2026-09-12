import type { StubwiseClient } from "@stubwise/api-client";
import type { CalendarEventItem, CalendarSeriesItem, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { EventSheet } from "./EventSheet";

/**
 * Il dettaglio di un appuntamento e la configurazione della sua serie (App
 * M3, Fase D, Task 12).
 *
 * La proprietà che questi test difendono più di ogni altra: **la UI non
 * deve poter comporre `enabled: true` senza `projectId`** — il 400
 * `project_required` del server è la rete, non il controllo.
 */
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SERIES = "abc123_20260911T090000Z";

function event(overrides: Partial<Reader<CalendarEventItem>> = {}): Reader<CalendarEventItem> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: ACCOUNT,
    accountEmail: "ops@example.com",
    recurringEventId: SERIES,
    projectId: null,
    projectName: null,
    title: "Riunione settimanale",
    organizer: "capo@example.com",
    attendees: [
      { email: "ops@example.com", responseStatus: "accepted" },
      { email: "altro@example.com", responseStatus: null },
    ],
    startsAt: new Date(2026, 8, 17, 9, 30).toISOString(),
    endsAt: new Date(2026, 8, 17, 10, 30).toISOString(),
    allDay: false,
    status: "new",
    outcome: null,
    error: null,
    url: "https://calendar.google.com/day",
    eventUrl: "https://calendar.google.com/event?eid=x",
    reproposable: false,
    ...overrides,
  } as Reader<CalendarEventItem>;
}

function seriesItem(overrides: Partial<Reader<CalendarSeriesItem>> = {}): Reader<CalendarSeriesItem> {
  return {
    accountId: ACCOUNT,
    accountEmail: "ops@example.com",
    recurringEventId: SERIES,
    title: "Riunione settimanale",
    occurrenceCount: 12,
    nextOccurrenceAt: null,
    enabled: false,
    projectId: null,
    projectName: null,
    action: "milestone",
    leadDays: 2,
    auto: false,
    ...overrides,
  } as Reader<CalendarSeriesItem>;
}

function makeClient(overrides: { series?: jest.Mock; putSeries?: jest.Mock; deleteSeries?: jest.Mock } = {}) {
  const putSeries = overrides.putSeries ?? jest.fn().mockResolvedValue({ ok: true });
  const deleteSeries = overrides.deleteSeries ?? jest.fn().mockResolvedValue({ ok: true });
  const client = {
    calendar: {
      list: jest.fn(),
      range: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      series: overrides.series ?? jest.fn().mockResolvedValue({ items: [seriesItem()] }),
      putSeries,
      deleteSeries,
    },
    projects: {
      list: jest.fn().mockResolvedValue([{ id: PROJECT, name: "negozio-web" }]),
    },
  } as unknown as StubwiseClient;
  return { client, putSeries, deleteSeries };
}

async function renderSheet(client: StubwiseClient, ev: Reader<CalendarEventItem> = event()) {
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
  const onRequestClose = jest.fn();
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <EventSheet event={ev} visible onRequestClose={onRequestClose} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { onRequestClose };
}

describe("EventSheet — il dettaglio dell'appuntamento", () => {
  test("titolo, quando (ora locale), organizzatore e partecipanti con lo stato", async () => {
    const { client } = makeClient();
    await renderSheet(client);

    expect(screen.getByText("Riunione settimanale")).toBeTruthy();
    expect(screen.getByText("17 settembre, 09:30 – 10:30")).toBeTruthy();
    expect(screen.getByText("capo@example.com")).toBeTruthy();
    expect(screen.getByText("Accettato")).toBeTruthy();
    // `responseStatus: null` NON è "non ha risposto": è "non lo sappiamo".
    expect(screen.getByText("Sconosciuto")).toBeTruthy();
    expect(screen.queryByText("Nessuna risposta")).toBeNull();
  });

  test("un evento TUTTO IL GIORNO dice il giorno UTC, senza ora", async () => {
    const { client } = makeClient();
    await renderSheet(
      client,
      event({ startsAt: "2026-09-17T00:00:00.000Z", endsAt: null, allDay: true, recurringEventId: null }),
    );
    expect(screen.getByText("Tutto il giorno, 17 settembre")).toBeTruthy();
  });

  test("un evento SENZA serie non mostra nessuna configurazione", async () => {
    const { client } = makeClient();
    await renderSheet(client, event({ recurringEventId: null }));
    await waitFor(() => expect(screen.getByText("Riunione settimanale")).toBeTruthy());
    expect(screen.queryByTestId("series-config")).toBeNull();
  });
});

describe("EventSheet — accendere una serie", () => {
  test("una serie mai configurata parte SPENTA, e il testo dice cosa comporta accenderla", async () => {
    const { client } = makeClient({ series: jest.fn().mockResolvedValue({ items: [] }) });
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    expect(screen.getByTestId("series-enabled").props.accessibilityState.checked).toBe(false);
    expect(screen.getByText(/OGNI occorrenza futura/)).toBeTruthy();
    // Spenta: niente bottone «Spegni» da premere.
    expect(screen.queryByTestId("series-disable")).toBeNull();
  });

  test("accesa SENZA progetto: «Salva» è disabilitato e il motivo è scritto", async () => {
    const { client, putSeries } = makeClient();
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("series-enabled"));

    expect(screen.getByTestId("series-project-required")).toBeTruthy();
    expect(screen.getByTestId("series-save").props.accessibilityState.disabled).toBe(true);
    // La prova che conta: nessun corpo `enabled: true, projectId: null` parte.
    await fireEvent.press(screen.getByTestId("series-save"));
    expect(putSeries).not.toHaveBeenCalled();
  });

  test("scelto il progetto, «Salva» manda il corpo INTERO", async () => {
    const { client, putSeries } = makeClient();
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("series-enabled"));
    await fireEvent.press(screen.getByTestId(`series-project-${PROJECT}`));
    await fireEvent.press(screen.getByTestId("series-action-backlog_item"));
    await fireEvent.press(screen.getByTestId("series-lead-plus"));
    await fireEvent.press(screen.getByTestId("series-auto"));

    expect(screen.queryByTestId("series-project-required")).toBeNull();
    await fireEvent.press(screen.getByTestId("series-save"));

    await waitFor(() => expect(putSeries).toHaveBeenCalled());
    expect(putSeries).toHaveBeenCalledWith(SERIES, {
      accountId: ACCOUNT,
      enabled: true,
      projectId: PROJECT,
      action: "backlog_item",
      leadDays: 3,
      auto: true,
    });
  });

  test("l'anticipo non esce da 0..30: sotto zero il meno è chiuso", async () => {
    const { client } = makeClient({ series: jest.fn().mockResolvedValue({ items: [seriesItem({ leadDays: 1 })] }) });
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("series-lead-minus")); // 0
    expect(screen.getByTestId("series-lead-value").props.children).toBe("0 giorni");
    expect(screen.getByTestId("series-lead-minus").props.accessibilityState.disabled).toBe(true);
  });
});

describe("EventSheet — spegnere una serie", () => {
  test("una serie ACCESA arriva coi suoi valori e si può spegnere", async () => {
    const { client, deleteSeries } = makeClient({
      series: jest.fn().mockResolvedValue({
        items: [seriesItem({ enabled: true, projectId: PROJECT, action: "reminder", leadDays: 5, auto: true })],
      }),
    });
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    expect(screen.getByTestId("series-enabled").props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId("series-auto").props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId("series-lead-value").props.children).toBe("5 giorni");
    expect(screen.getByTestId(`series-project-${PROJECT}`).props.accessibilityState.selected).toBe(true);

    await fireEvent.press(screen.getByTestId("series-disable"));
    await waitFor(() => expect(deleteSeries).toHaveBeenCalledWith(SERIES, ACCOUNT));
  });

  test("spegnere dal solo interruttore e salvare non manda un progetto", async () => {
    // Spenta, il progetto non serve più: è ciò che fa anche il web, e tenerlo
    // nel corpo direbbe al server qualcosa che non è più vero.
    const { client, putSeries } = makeClient({
      series: jest.fn().mockResolvedValue({ items: [seriesItem({ enabled: true, projectId: PROJECT })] }),
    });
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("series-enabled")); // spenta
    await fireEvent.press(screen.getByTestId("series-save"));

    await waitFor(() => expect(putSeries).toHaveBeenCalled());
    expect(putSeries.mock.calls[0]![1]).toMatchObject({ enabled: false, projectId: null });
  });

  test("un errore del server si vede, con le parole giuste", async () => {
    const { ApiError } = jest.requireActual<typeof import("@stubwise/api-client")>("@stubwise/api-client");
    const { client } = makeClient({
      putSeries: jest.fn().mockRejectedValue(new ApiError(400, "…", "project_required")),
      series: jest.fn().mockResolvedValue({ items: [seriesItem({ enabled: true, projectId: PROJECT })] }),
    });
    await renderSheet(client);
    await waitFor(() => expect(screen.getByTestId("series-config")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("series-save"));
    await waitFor(() => expect(screen.getByTestId("series-error")).toBeTruthy());
    expect(screen.getByText("Scegli un progetto prima di accendere questa serie.")).toBeTruthy();
  });
});
