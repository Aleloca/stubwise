import { act, render, screen } from "@testing-library/react-native";
import { LIVE_TAIL_CHARS, LIVE_THROTTLE_MS, LONG_TEXT_CHARS } from "../../lib/transcript-text";
import { LiveText } from "./LiveText";

// ⚠️ `await render(...)`: vedi `docs/invariants/mobile-app.md`.
describe("LiveText — il testo dell'agente DAL VIVO", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("un testo corto è markdown già dal vivo, e intero dall'inizio", async () => {
    await render(<LiveText id="p1" text={"# Titolo\n\nUn **paragrafo** che continua"} />);
    expect(screen.getByText("Titolo")).toBeTruthy();
    // Reso, non grezzo: niente cancelletti né asterischi a schermo.
    expect(screen.queryByText(/# Titolo/)).toBeNull();
    expect(screen.queryByText(/\*\*paragrafo\*\*/)).toBeNull();
    expect(screen.getByTestId("transcript-live-p1")).toBeTruthy();
  });

  test("ridisegna al più ogni LIVE_THROTTLE_MS: i pezzi intermedi aspettano, l'ultimo arriva", async () => {
    jest.useFakeTimers();
    const view = await render(<LiveText id="p1" text="Primo pezzo" />);
    expect(screen.getByText("Primo pezzo")).toBeTruthy();

    await view.rerender(<LiveText id="p1" text="Primo pezzo, secondo" />);
    await view.rerender(<LiveText id="p1" text="Primo pezzo, secondo, terzo" />);
    // Ancora dentro la finestra: resta quello di prima.
    expect(screen.getByText("Primo pezzo")).toBeTruthy();
    expect(screen.queryByText("Primo pezzo, secondo, terzo")).toBeNull();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(LIVE_THROTTLE_MS);
    });
    // Il ridisegno di coda porta l'ULTIMO testo, non uno intermedio.
    expect(screen.getByText("Primo pezzo, secondo, terzo")).toBeTruthy();
  });

  test("oltre LONG_TEXT_CHARS è testo semplice, ma INTERO: l'inizio non sparisce", async () => {
    const text = `INIZIO **grassetto** ${"x".repeat(LONG_TEXT_CHARS)} FINE`;
    await render(<LiveText id="p1" text={text} />);
    const shown = screen.getByText(/INIZIO/);
    expect(shown.props.children).toBe(text);
  });

  test("solo oltre LIVE_TAIL_CHARS (un documento Docs intero) resta la coda", async () => {
    const text = `INIZIO ${"x".repeat(LIVE_TAIL_CHARS)} FINE`;
    await render(<LiveText id="p1" text={text} />);
    const shown = screen.getByText(/FINE/);
    expect(shown.props.children).toMatch(/^….*FINE$/s);
    expect(screen.queryByText(/INIZIO/)).toBeNull();
  });
});
