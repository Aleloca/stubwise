import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { AgentSessionDetail, BacklogItemDetail, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { BacklogItemScreen } from "./BacklogItemScreen";

const ITEM_ID = "88888888-8888-4888-8888-888888888888";
const TICKET_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const INPUT_ID = "22222222-2222-4222-8222-222222222222";

function item(overrides: Partial<Reader<BacklogItemDetail>> = {}): Reader<BacklogItemDetail> {
  return {
    id: ITEM_ID,
    projectId: "proj-1",
    title: "Accesso clienti con SSO",
    document: "I clienti enterprise chiedono il login SSO.",
    implementationPlan: null,
    originContent: null,
    status: "ready",
    effort: 4,
    risk: "medium",
    riskNote: null,
    urgency: "high",
    requestCount: 1,
    source: "manual",
    suggested: null,
    similarTo: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    tickets: [],
    refineSession: null,
    ...overrides,
  } as Reader<BacklogItemDetail>;
}

/** Il dettaglio della sessione attiva, COMPLETO (il doppio del client non parsa). */
function sessionDetail(overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    id: SESSION_ID,
    kind: "backlog_refine",
    title: "Refinement: Accesso clienti con SSO",
    projectId: "proj-1",
    projectName: "Apollo",
    ticketId: null,
    ticketNumber: null,
    startedAt: "2026-10-14T09:00:00.000Z",
    lastEventAt: "2026-10-14T10:00:00.000Z",
    state: "working",
    activeSegment: "refine",
    lastActivity: null,
    aiJobId: null,
    backlogItemId: ITEM_ID,
    outcome: null,
    canWrite: true,
    canIntervene: true,
    canInterrupt: true,
    canClose: true,
    paused: false,
    questions: [],
    inputs: [],
    ...overrides,
  };
}

/**
 * Il doppio del client: TUTTI i metodi che la schermata chiama, compresi
 * l'avvio della sessione di refinement e il dettaglio della sessione attiva —
 * un metodo mancante dietro il cast non fallisce, lascia la query in errore.
 */
function makeClient(
  overrides: { get?: jest.Mock; convert?: jest.Mock; start?: jest.Mock; sessionGet?: jest.Mock } = {},
): StubwiseClient {
  return {
    backlog: {
      get: overrides.get ?? jest.fn().mockResolvedValue(item()),
      convert: overrides.convert ?? jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 7 }),
      list: jest.fn(),
      create: jest.fn(),
      job: jest.fn(),
    },
    backlogRefine: {
      start: overrides.start ?? jest.fn().mockResolvedValue({ agentSessionId: SESSION_ID, inputId: null }),
      close: jest.fn(),
    },
    agentSessions: {
      get: overrides.sessionGet ?? jest.fn().mockResolvedValue(sessionDetail()),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const goBack = jest.fn();
  const navigate = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const navigation = { goBack, navigate } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <BacklogItemScreen navigation={navigation} route={{ key: "Item", name: "Item", params: { id: ITEM_ID } }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { goBack, navigate };
}

describe("BacklogItemScreen — caricamento ed errori", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient({ get: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("backlog-item-skeleton")).toBeTruthy();
  });

  test("404: stato 'non c'è più'", async () => {
    const client = makeClient({ get: jest.fn().mockRejectedValue(new ApiError(404, "Not found", "backlog_item_not_found")) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-not-found")).toBeTruthy());
  });

  test("errore di rete: Riprova ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(item());
    const client = makeClient({ get });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-retry")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-item-retry"));
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
  });

  test("il tasto indietro chiama goBack", async () => {
    const { goBack } = await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, incluse quelle di dettaglio come questa (prima
  // del fix ne era priva del tutto).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });
});

describe("BacklogItemScreen — corpo", () => {
  test("titolo, stato in parole, metadati e documento", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    expect(screen.getByText("Pronto")).toBeTruthy();
    expect(screen.getByText("alta · E4 · rischio medio")).toBeTruthy();
    expect(screen.getByText("I clienti enterprise chiedono il login SSO.")).toBeTruthy();
  });

  test("un link nel documento passa dall'allowlist: http si apre, javascript no", async () => {
    // Copre il wiring di `SafeMarkdown` (il componente che raccoglie tema e
    // guardia per tutte e quattro le schermate che rendono markdown): il
    // renderer, lasciato a sé, aprirebbe QUALUNQUE href.
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    openURL.mockClear();
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        // ⚠️ Lo schema ostile è `qualcosa://`, non `javascript:`: quest'ultimo
        // il renderer lo scarta da sé, quindi il link non comparirebbe
        // affatto e il test passerebbe senza esercitare la guardia. Uno
        // schema di un'altra app installata invece viene reso — ed è
        // esattamente il caso che `isSafeWebUrl` deve fermare.
        item({ document: "Vai su [buono](https://esempio.it) o [cattivo](altraapp://prendimi)." }),
      ),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("buono")).toBeTruthy());

    await fireEvent.press(screen.getByText("cattivo"));
    expect(openURL).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText("buono"));
    expect(openURL).toHaveBeenCalledWith("https://esempio.it");
  });

  test("il titolo sta nell'header ancorato, con indietro e avatar", async () => {
    // Stesso trattamento del dettaglio di una email (13 set 2026): scorrendo
    // un documento lungo si continua a vedere di quale voce si sta leggendo.
    // Prima il titolo stava nel corpo e scorreva via.
    await renderScreen(makeClient());
    // ⚠️ Si aspetta il TESTO, non l'header: l'header c'è dal primo render (col
    // titolo di ripiego), il titolo vero arriva con la query. Aspettare
    // l'header guarderebbe un istante in cui il titolo non c'è ancora — è la
    // stessa corsa che avevo scritto nel test del dettaglio email il 13 set
    // 2026 e che mi era stata corretta.
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    expect(screen.getByTestId("screen-header-back")).toBeTruthy();
    expect(screen.getByTestId("settings-avatar-button")).toBeTruthy();
  });

  test("il documento è RESO come markdown, non mostrato grezzo", async () => {
    // Fino al 16 set 2026 arrivava a schermo con cancelletti e asterischi:
    // dentro una voce di backlog vive spesso un design doc intero, e cosi'
    // era illeggibile. Il renderer e il tema esistevano gia' — li usano le
    // pagine Docs e il piano di un ticket — e qui mancavano e basta.
    const client = makeClient({
      get: jest.fn().mockResolvedValue(item({ document: "# Titolo\n\nUn **paragrafo**." })),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Titolo")).toBeTruthy());
    // Il cancelletto e gli asterischi non compaiono da nessuna parte: se il
    // documento fosse ancora un `<Text>` grezzo, questa riga fallirebbe.
    expect(screen.queryByText(/# Titolo/)).toBeNull();
    expect(screen.queryByText(/\*\*paragrafo\*\*/)).toBeNull();
  });

  test("voce 'ready': Procedi converte e naviga al Lavoro del ticket creato", async () => {
    const convert = jest.fn().mockResolvedValue({ ticketId: TICKET_ID, ticketNumber: 7 });
    const client = makeClient({ convert });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("backlog-item-proceed")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("backlog-item-proceed"));
    await waitFor(() => expect(convert).toHaveBeenCalledWith(ITEM_ID));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("Main", {
        screen: "Projects",
        params: { screen: "Ticket", params: { id: TICKET_ID } },
      }),
    );
  });

  test("voce convertita: niente Procedi", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ status: "converted" })) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    expect(screen.queryByTestId("backlog-item-proceed")).toBeNull();
    expect(screen.queryByTestId("backlog-item-refine")).toBeNull();
  });

  test("voce 'refining': niente Procedi, e nessuna chat — si lavora dalla sessione", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(item({ status: "refining" })) });
    await renderScreen(client);
    expect(await screen.findByTestId("backlog-item-refine-session")).toBeTruthy();
    expect(screen.queryByTestId("backlog-item-proceed")).toBeNull();
    expect(screen.queryByTestId("backlog-item-refine")).toBeNull();
  });

  test("ticket collegati: elencati, un tap naviga al Lavoro di quel ticket", async () => {
    const linkedTicketId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const client = makeClient({
      get: jest
        .fn()
        .mockResolvedValue(item({ status: "converted", tickets: [{ id: linkedTicketId, number: 12, title: "Login SSO enterprise", role: "converted_to" }] })),
    });
    const { navigate } = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Login SSO enterprise")).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`backlog-item-ticket-${linkedTicketId}`));
    expect(navigate).toHaveBeenCalledWith("Main", {
      screen: "Projects",
      params: { screen: "Ticket", params: { id: linkedTicketId } },
    });
  });
});

describe("BacklogItemScreen — sessione di refinement", () => {
  const ACTIVE = { agentSessionId: SESSION_ID, status: "active", closedReason: null, lastActivityAt: "2026-10-14T10:00:00.000Z" } as const;
  const CLOSED = { ...ACTIVE, status: "closed", closedReason: "idle" } as const;

  test("avvio: start col primo messaggio, voce riletta, sessione aperta sul root stack", async () => {
    const start = jest.fn().mockResolvedValue({ agentSessionId: SESSION_ID, inputId: INPUT_ID });
    const get = jest.fn().mockResolvedValue(item());
    const { navigate } = await renderScreen(makeClient({ start, get }));
    // Chi naviga trova il foglio GIÀ smontato (chiudere, smontare, poi navigare).
    let sheetAtNavigate: unknown = "non chiamato";
    navigate.mockImplementation(() => {
      sheetAtNavigate = screen.queryByTestId("refine-session-sheet");
    });
    await fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
    expect(screen.getByText("Inizia sessione")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("refine-session-first-message"), "  partiamo  ");
    await fireEvent.press(screen.getByTestId("refine-session-launch"));
    await waitFor(() => expect(start).toHaveBeenCalledWith(ITEM_ID, { message: "partiamo" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("AgentSession", { id: SESSION_ID }, { pop: true }));
    expect(sheetAtNavigate).toBeNull();
    // Dopo l'avvio la voce si rilegge: tornando indietro dice «Apri la sessione».
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  test("primo messaggio vuoto o di soli spazi: si parte senza messaggio", async () => {
    const start = jest.fn().mockResolvedValue({ agentSessionId: SESSION_ID, inputId: null });
    await renderScreen(makeClient({ start }));
    await fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
    await fireEvent.changeText(screen.getByTestId("refine-session-first-message"), "   ");
    await fireEvent.press(screen.getByTestId("refine-session-launch"));
    await waitFor(() => expect(start).toHaveBeenCalledWith(ITEM_ID, {}));
  });

  test("server senza la funzione: dopo il 404 senza code il bottone sparisce, niente navigazione", async () => {
    const start = jest.fn().mockRejectedValue(new ApiError(404, "Route not found"));
    const { navigate } = await renderScreen(makeClient({ start }));
    await fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
    await fireEvent.press(screen.getByTestId("refine-session-launch"));
    await waitFor(() => expect(screen.queryByTestId("backlog-item-refine-session")).toBeNull());
    expect(screen.getByText("Le sessioni di refinement non sono disponibili su questa istanza.")).toBeTruthy();
    expect(screen.queryByTestId("refine-session-sheet")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  test("un 404 CON code non è «server vecchio»: il bottone resta, l'errore in parole", async () => {
    const start = jest.fn().mockRejectedValue(new ApiError(404, "Not found", "not_found"));
    await renderScreen(makeClient({ start }));
    await fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
    await fireEvent.press(screen.getByTestId("refine-session-launch"));
    expect(await screen.findByTestId("refine-session-error")).toBeTruthy();
    expect(screen.getByTestId("backlog-item-refine-session")).toBeTruthy();
  });

  test("409 item_closed: errore in parole e voce riletta (chiusa: i bottoni spariscono)", async () => {
    const start = jest.fn().mockRejectedValue(new ApiError(409, "closed", "item_closed"));
    const get = jest.fn().mockResolvedValueOnce(item()).mockResolvedValue(item({ status: "converted" }));
    const { navigate } = await renderScreen(makeClient({ start, get }));
    await fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
    await fireEvent.press(screen.getByTestId("refine-session-launch"));
    expect(
      await screen.findByText("La voce è stata convertita o archiviata: la sessione non può più partire."),
    ).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("backlog-item-refine-session")).toBeNull());
    expect(navigate).not.toHaveBeenCalled();
  });

  test("sessione chiusa: «Riprendi sessione»", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(item({ refineSession: CLOSED })) }));
    expect(await screen.findByText("Riprendi sessione")).toBeTruthy();
    expect(screen.queryByTestId("backlog-item-open-session")).toBeNull();
  });

  test("sessione attiva: lo stato letto dalla SESSIONE e «Apri la sessione»", async () => {
    const sessionGet = jest.fn().mockResolvedValue(sessionDetail({ state: "idle", activeSegment: null, canInterrupt: false }));
    const { navigate } = await renderScreen(
      makeClient({ get: jest.fn().mockResolvedValue(item({ refineSession: ACTIVE })), sessionGet }),
    );
    expect(await screen.findByText("Sessione di refinement aperta · pronta")).toBeTruthy();
    expect(sessionGet).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.queryByTestId("backlog-item-refine-session")).toBeNull();
    await fireEvent.press(screen.getByTestId("backlog-item-open-session"));
    expect(navigate).toHaveBeenCalledWith("AgentSession", { id: SESSION_ID }, { pop: true });
  });

  test("sessione attiva al lavoro: «l'agente sta lavorando»", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(item({ refineSession: ACTIVE })) }));
    expect(await screen.findByText("Sessione di refinement aperta · l'agente sta lavorando")).toBeTruthy();
  });

  test("sessione attiva col turno in coda: «turno in coda», non «al lavoro»", async () => {
    await renderScreen(
      makeClient({
        get: jest.fn().mockResolvedValue(item({ refineSession: ACTIVE })),
        sessionGet: jest.fn().mockResolvedValue(sessionDetail({ state: "queued", activeSegment: null })),
      }),
    );
    expect(await screen.findByText("Sessione di refinement aperta · turno in coda")).toBeTruthy();
    expect(screen.queryByText("Sessione di refinement aperta · l'agente sta lavorando")).toBeNull();
  });

  test("la sessione risulta conclusa ma la voce la dice attiva: la voce si rilegge e compare «Riprendi sessione»", async () => {
    // Chiusa per inattività: la voce, riletta, lo sa.
    const get = jest
      .fn()
      .mockResolvedValueOnce(item({ refineSession: ACTIVE }))
      .mockResolvedValue(item({ refineSession: CLOSED }));
    const sessionGet = jest.fn().mockResolvedValue(sessionDetail({ state: "ended", outcome: "completed", activeSegment: null }));
    await renderScreen(makeClient({ get, sessionGet }));
    expect(await screen.findByText("Riprendi sessione")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("backlog-item-open-session")).toBeNull();
  });

  test("il primo messaggio ha il tetto dello schema del body", async () => {
    await renderScreen(makeClient());
    await fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
    expect(screen.getByTestId("refine-session-first-message").props.maxLength).toBe(4000);
  });

  test("sessione attiva, dettaglio della sessione in errore: la riga resta, senza stato fine", async () => {
    await renderScreen(
      makeClient({
        get: jest.fn().mockResolvedValue(item({ refineSession: ACTIVE })),
        sessionGet: jest.fn().mockRejectedValue(new ApiError(500, "boom")),
      }),
    );
    expect(await screen.findByText("Sessione di refinement aperta")).toBeTruthy();
    expect(screen.getByTestId("backlog-item-open-session")).toBeTruthy();
  });

  test("voce convertita: né avvio né «Apri la sessione»", async () => {
    await renderScreen(
      makeClient({ get: jest.fn().mockResolvedValue(item({ status: "converted", refineSession: CLOSED })) }),
    );
    await waitFor(() => expect(screen.getByText("Accesso clienti con SSO")).toBeTruthy());
    expect(screen.queryByTestId("backlog-item-refine-session")).toBeNull();
    expect(screen.queryByTestId("backlog-item-open-session")).toBeNull();
  });
});
