import { fireEvent, render, screen } from "@testing-library/react-native";
import "../../i18n";
import { TechLevel } from "./TechLevel";

describe("TechLevel", () => {
  test("mostra il ramo di ogni repository", async () => {
    await render(
      <TechLevel
        repositories={[
          { repositoryId: "repo-1", branch: "stubwise/fix-245-image-cache" },
          { repositoryId: "repo-2", branch: "stubwise/fix-245-image-cache-widget" },
        ]}
        log=""
      />,
    );
    expect(screen.getByText("stubwise/fix-245-image-cache")).toBeTruthy();
    expect(screen.getByText("stubwise/fix-245-image-cache-widget")).toBeTruthy();
  });

  test("due repository con lo STESSO nome di ramo: entrambe le righe compaiono (chiave stabile su repositoryId, non sul branch)", async () => {
    await render(
      <TechLevel
        repositories={[
          { repositoryId: "repo-1", branch: "stubwise/fix-245" },
          { repositoryId: "repo-2", branch: "stubwise/fix-245" },
        ]}
        log=""
      />,
    );
    expect(screen.getAllByText("stubwise/fix-245")).toHaveLength(2);
  });

  test("nessuna repository ancora: nessuna riga di ramo", async () => {
    await render(<TechLevel repositories={[]} log="" />);
    expect(screen.queryByText("ramo")).toBeNull();
  });

  test("log vuoto: messaggio dedicato, nessun toggle", async () => {
    await render(<TechLevel repositories={[]} log="" />);
    expect(screen.getByText("Nessun log ancora.")).toBeTruthy();
    expect(screen.queryByTestId("tech-level-log-toggle")).toBeNull();
  });

  test("log presente: nascosto finché non si preme il toggle, poi mostra le ULTIME 50 righe", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `riga ${i + 1}`);
    await render(<TechLevel repositories={[]} log={lines.join("\n")} />);

    expect(screen.queryByText("riga 80")).toBeNull();
    await fireEvent.press(screen.getByTestId("tech-level-log-toggle"));

    expect(screen.getByText(/\briga 80\b/)).toBeTruthy();
    expect(screen.getByText(/\briga 31\b/)).toBeTruthy();
    // Le prime 30 righe (81 - 50) NON compaiono: solo le ultime 50. Confine di
    // parola (\b), non ancore di riga (^$/m): `getByText` normalizza gli spazi
    // bianchi (i "\n" del log diventano " "), quindi ^/$ non ancorano più le
    // singole righe — un confine di parola sopravvive alla normalizzazione.
    expect(screen.queryByText(/\briga 30\b/)).toBeNull();
  });

  test("log con meno di 50 righe: le mostra tutte", async () => {
    const lines = ["prima", "seconda", "terza"];
    await render(<TechLevel repositories={[]} log={lines.join("\n")} />);
    await fireEvent.press(screen.getByTestId("tech-level-log-toggle"));
    expect(screen.getByText(/prima/)).toBeTruthy();
    expect(screen.getByText(/terza/)).toBeTruthy();
  });
});
