import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { WISEY_STAGE_MS, WISEY_WORD_MS } from "../../lib/wisey-phase";
import { WiseyProvider } from "../../components/wisey/WiseyProvider";
import { WiseyScreen } from "./WiseyScreen";

/**
 * WISEY, l'anteprima («Wisey, anteprima nell'app», 25 set 2026, design §4-§6).
 *
 * ⚠️ Nessuna chiamata al server, per costruzione: il client è un oggetto
 * VUOTO. Se la schermata ne chiamasse un metodo, il test lancerebbe — è la
 * prova che le risposte sono tutte finte, non un doppio da completare.
 */
const HIDDEN = { includeHiddenElements: true };

async function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client: {} as StubwiseClient,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <WiseyProvider>
          <WiseyScreen />
        </WiseyProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

const BACKLOG_REPLY =
  "Presto creerò io la voce di backlog e la stimerò per te. Per ora sono un'anteprima: puoi farlo da Backlog › Nuova idea.";

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("WiseyScreen — prima di parlare", () => {
  test("intestazione con «Anteprima», il gufo grande a riposo, benvenuto e tre suggerimenti", async () => {
    await renderScreen();
    expect(screen.getByText("Wisey")).toBeTruthy();
    expect(screen.getByTestId("screen-header-badge")).toBeTruthy();
    expect(screen.getByText("Anteprima")).toBeTruthy();
    expect(screen.getByTestId("wisey-status").props.children).toBe("A riposo");
    expect(screen.getByTestId("wisey-welcome")).toBeTruthy();
    expect(screen.getByText("Cosa mi aspetta?")).toBeTruthy();
    expect(screen.getByText("Avvia una voce di backlog")).toBeTruthy();
    expect(screen.getByText("Come va il mio progetto?")).toBeTruthy();
    // Il gufo grande: 112×96.
    const box = StyleSheet.flatten(screen.getByTestId("wisey-sprite", HIDDEN).props.style) as { width: number };
    expect(box.width).toBe(112);
  });

  test("a campo vuoto non si invia; scrivendo sì", async () => {
    await renderScreen();
    expect(screen.getByTestId("wisey-send").props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByTestId("wisey-input"), "   ");
    expect(screen.getByTestId("wisey-send").props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByTestId("wisey-input"), "ciao");
    expect(screen.getByTestId("wisey-send").props.accessibilityState).toMatchObject({ disabled: false });
  });

  test("col campo a fuoco, o testo scritto, il gufo ti ascolta", async () => {
    await renderScreen();
    await fireEvent(screen.getByTestId("wisey-input"), "focus");
    expect(screen.getByTestId("wisey-status").props.children).toBe("Ti ascolta…");
    await fireEvent(screen.getByTestId("wisey-input"), "blur");
    expect(screen.getByTestId("wisey-status").props.children).toBe("A riposo");
    await fireEvent.changeText(screen.getByTestId("wisey-input"), "ciao");
    expect(screen.getByTestId("wisey-status").props.children).toBe("Ti ascolta…");
  });
});

describe("WiseyScreen — una domanda", () => {
  test("una richiesta di FARE: pensa → lavora → risponde a scatti → fatto → riposo", async () => {
    await renderScreen();
    await fireEvent.press(screen.getByText("Avvia una voce di backlog"));

    // La domanda è partita: bolla dell'utente, gufo che pensa, suggerimenti via.
    expect(screen.getByTestId("wisey-message-user-0")).toBeTruthy();
    expect(screen.queryByTestId("wisey-welcome")).toBeNull();
    expect(screen.getByTestId("wisey-status").props.children).toBe("Sta pensando…");

    await advance(WISEY_STAGE_MS.thinking);
    expect(screen.getByTestId("wisey-status").props.children).toBe("Sta lavorando…");

    await advance(WISEY_STAGE_MS.working);
    expect(screen.getByTestId("wisey-status").props.children).toBe("Ti risponde");
    // A scatti: all'inizio la risposta NON è intera.
    await advance(WISEY_WORD_MS * 3);
    const partial = screen.getByTestId("wisey-message-text-1").props.children as string;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial).not.toBe(BACKLOG_REPLY);
    expect(BACKLOG_REPLY.startsWith(partial)).toBe(true);

    await advance(WISEY_WORD_MS * BACKLOG_REPLY.split(" ").length);
    expect(screen.getByTestId("wisey-message-text-1").props.children).toBe(BACKLOG_REPLY);
    expect(screen.getByTestId("wisey-status").props.children).toBe("Fatto");

    await advance(WISEY_STAGE_MS.done);
    expect(screen.getByTestId("wisey-status").props.children).toBe("A riposo");
  });

  test("una domanda e basta non passa da «sta lavorando»", async () => {
    await renderScreen();
    await fireEvent.press(screen.getByText("Come va il mio progetto?"));
    expect(screen.getByTestId("wisey-status").props.children).toBe("Sta pensando…");
    await advance(WISEY_STAGE_MS.thinking);
    expect(screen.getByTestId("wisey-status").props.children).toBe("Ti risponde");
  });

  test("scritta a mano e inviata: il campo si svuota", async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId("wisey-input"), "Ciao Wisey");
    await fireEvent.press(screen.getByTestId("wisey-send"));
    expect(screen.getByTestId("wisey-message-text-0").props.children).toBe("Ciao Wisey");
    expect(screen.getByTestId("wisey-input").props.value).toBe("");
  });

  test("durante una risposta un secondo invio è disabilitato", async () => {
    await renderScreen();
    await fireEvent.press(screen.getByText("Come va il mio progetto?"));
    await fireEvent.changeText(screen.getByTestId("wisey-input"), "e il backlog?");
    expect(screen.getByTestId("wisey-send").props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByTestId("wisey-send"));
    expect(screen.queryByTestId("wisey-message-user-2")).toBeNull();
  });

  /**
   * Design §10: il gufo grande resta FISSO in testa, sempre a 2×, per tutta
   * la conversazione — non si rimpicciolisce più alla prima domanda — e sta
   * FUORI da ciò che scorre: scorrono solo i messaggi, sotto di lui.
   */
  test("il gufo resta grande e fisso anche a conversazione avviata", async () => {
    await renderScreen();
    await fireEvent.press(screen.getByText("Come va il mio progetto?"));
    await advance(WISEY_STAGE_MS.thinking);
    const box = StyleSheet.flatten(screen.getByTestId("wisey-sprite", HIDDEN).props.style) as { width: number };
    expect(box.width).toBe(112);
    // Fuori dallo ScrollView dei messaggi.
    const list = screen.getByTestId("wisey-messages");
    expect(within(list).queryAllByTestId("wisey-sprite", HIDDEN)).toHaveLength(0);
  });

  test("UN solo gufo nella pagina: le risposte hanno l'etichetta «Wisey», non un gufo", async () => {
    await renderScreen();
    await fireEvent.press(screen.getByText("Come va il mio progetto?"));
    await advance(WISEY_STAGE_MS.thinking);
    expect(screen.getByTestId("wisey-message-wisey-1")).toBeTruthy();
    expect(screen.getAllByTestId("wisey-sprite", HIDDEN)).toHaveLength(1);
    expect(screen.getByTestId("wisey-message-label-1").props.children).toBe("Wisey");
  });
});
