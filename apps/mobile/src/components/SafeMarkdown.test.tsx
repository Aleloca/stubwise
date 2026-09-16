import { render, screen } from "@testing-library/react-native";
import { fireEvent } from "@testing-library/react-native";
import { Linking } from "react-native";
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
});
