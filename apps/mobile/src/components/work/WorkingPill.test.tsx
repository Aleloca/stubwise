import { render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import "../../i18n";
import { colors } from "../../theme/tokens";
import { WorkingPill } from "./WorkingPill";

const NOW = new Date("2026-08-12T13:18:00.000Z").getTime();

describe("WorkingPill", () => {
  test("18 minuti da startedAt: «sta lavorando da 18 min — ti avviso io»", async () => {
    await render(<WorkingPill startedAt="2026-08-12T13:00:00.000Z" now={() => NOW} />);
    expect(screen.getByText("sta lavorando da 18 min — ti avviso io")).toBeTruthy();
  });

  test("meno di un minuto: testo dedicato, non '0 min'", async () => {
    await render(<WorkingPill startedAt="2026-08-12T13:17:40.000Z" now={() => NOW} />);
    expect(screen.getByText("sta lavorando da pochi istanti — ti avviso io")).toBeTruthy();
    expect(screen.queryByText(/0 min/)).toBeNull();
  });

  test("oltre un'ora: i minuti continuano a contare per intero (78 min), niente arrotondamento a ore", async () => {
    await render(<WorkingPill startedAt="2026-08-12T12:00:00.000Z" now={() => NOW} />);
    expect(screen.getByText("sta lavorando da 78 min — ti avviso io")).toBeTruthy();
  });

  test("è composto su PulseIndicator: il testo prende il colore del tono (sky), come il pallino — non grigio", async () => {
    await render(<WorkingPill startedAt="2026-08-12T13:00:00.000Z" now={() => NOW} />);
    const text = screen.getByText("sta lavorando da 18 min — ti avviso io");
    const flatStyle = StyleSheet.flatten(text.props.style);
    expect(flatStyle.color).toBe(colors.sky);
  });
});
