import { render, screen } from "@testing-library/react-native";
import { fireEvent } from "@testing-library/react-native";
import { Linking, StyleSheet } from "react-native";
import { fontFamily, fontSize } from "../theme/typography";
import { SafeMarkdown } from "./SafeMarkdown";

// ⚠️ `await render(...)`: in questo progetto `render` va atteso, altrimenti
// l'albero non viene montato e `screen` resta vuoto («render function has not
// been called»). È il motivo per cui questo file, alla prima stesura, sembrava
// rotto dall'ambiente — non lo era.
describe("SafeMarkdown", () => {
  test("un link http si apre", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    openURL.mockClear();
    await render(<SafeMarkdown>{"Vai su [qui](https://esempio.it/pagina)."}</SafeMarkdown>);
    await fireEvent.press(screen.getByText("qui"));
    expect(openURL).toHaveBeenCalledWith("https://esempio.it/pagina");
  });

  test("uno schema che non è http NON si apre", async () => {
    // `altraapp://` e non `javascript:`: quest'ultimo il renderer lo scarta da
    // sé, quindi il link non comparirebbe e il test passerebbe senza
    // esercitare la guardia.
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    openURL.mockClear();
    await render(<SafeMarkdown>{"Clicca [qui](altraapp://prendimi)."}</SafeMarkdown>);
    await fireEvent.press(screen.getByText("qui"));
    expect(openURL).not.toHaveBeenCalled();
  });

  test("il markdown è RESO, non mostrato grezzo", async () => {
    await render(<SafeMarkdown>{"# Titolo\n\nUn **paragrafo**."}</SafeMarkdown>);
    expect(screen.getByText("Titolo")).toBeTruthy();
    expect(screen.queryByText(/# Titolo/)).toBeNull();
  });

  test("fuori dalle domande un'immagine resta un'immagine (testo dell'agente, piano, Docs)", async () => {
    await render(<SafeMarkdown>{"![grafico](https://x.test/p.png)"}</SafeMarkdown>);
    expect(JSON.stringify(screen.toJSON())).toContain("https://x.test/p.png");
  });

  test("in modalità domanda un'immagine NON si carica: resta l'alt (niente se vuoto), e niente tipografia", async () => {
    await render(
      <SafeMarkdown question>{"Vedi ![il grafico](https://x.test/q.png) e ![](https://x.test/r.png) con --force"}</SafeMarkdown>,
    );
    const json = JSON.stringify(screen.toJSON());
    expect(json).not.toContain("x.test");
    expect(json).not.toContain("FitImage");
    expect(screen.getByText("il grafico")).toBeTruthy();
    expect(json).toContain("--force");
  });

  test("in modalità domanda l'HTML grezzo resta testo (parser con html: false): un <img> non diventa un'immagine", async () => {
    await render(<SafeMarkdown question>{'Prima <img src="https://x.test/p.png"> dopo'}</SafeMarkdown>);
    expect(screen.getByText('Prima <img src="https://x.test/p.png"> dopo')).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toContain('"source"');
  });
  test("in modalità domanda il testo è 15/21 SemiBold anche senza stile, e il codice inline è più piccolo con la stessa interlinea", async () => {
    await render(<SafeMarkdown question>{"Modifico `calc.js`?"}</SafeMarkdown>);
    expect(StyleSheet.flatten(screen.getByText("Modifico").props.style)).toMatchObject({
      fontFamily: fontFamily.sansSemiBold,
      fontSize: 15,
      lineHeight: 21,
    });
    const code = StyleSheet.flatten(screen.getByText("calc.js").props.style);
    expect(code).toMatchObject({ fontFamily: fontFamily.mono, fontSize: 13.5, lineHeight: 21 });
  });

  test("fuori dalle domande corpo e codice restano come prima (14, il codice eredita la taglia)", async () => {
    await render(<SafeMarkdown>{"Testo `x()`"}</SafeMarkdown>);
    expect(StyleSheet.flatten(screen.getByText("Testo").props.style)).toMatchObject({
      fontFamily: fontFamily.sans,
      fontSize: fontSize.body,
    });
    expect(StyleSheet.flatten(screen.getByText("x()").props.style).fontSize).toBe(fontSize.body);
  });
});
