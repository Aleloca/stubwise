import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { colors } from "../../theme/tokens";
import { HubTabBar, type HubTab } from "./HubTabBar";

/**
 * La barra delle tab del dettaglio progetto, riusata dalla pagina del ticket
 * a tab (2 ott 2026, piano Task 3). Le aggiunte sono ADDITIVE: `dot` (il
 * pallino ambra «serve una tua azione», diverso dal rosso `alert`, «qualcosa è
 * rotto»), `count` (il contatore neutro, es. i commenti) e `testIDPrefix`.
 * Senza di esse la barra è quella di prima: il dettaglio progetto non cambia
 * (i suoi test, e `navigation.test.tsx` coi testID `hub-tab-*`, restano).
 */
type Key = "status" | "content" | "activity" | "details";

const TABS: readonly HubTab<Key>[] = [
  { key: "status", label: "Stato", dot: true, dotLabel: "Serve una tua azione" },
  { key: "content", label: "Contenuto", dot: false, dotLabel: "Serve una tua azione" },
  { key: "activity", label: "Attività", count: 4, countLabel: "4 commenti" },
  { key: "details", label: "Dettagli" },
];

describe("HubTabBar", () => {
  test("rende le quattro tab; premere una chiama onSelect con la sua chiave", async () => {
    const onSelect = jest.fn();
    await render(<HubTabBar tabs={TABS} active="status" onSelect={onSelect} />);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    fireEvent.press(screen.getByTestId("hub-tab-activity"));
    expect(onSelect).toHaveBeenCalledWith("activity");
  });

  test("solo la attiva è `selected`", async () => {
    await render(<HubTabBar tabs={TABS} active="content" onSelect={() => {}} />);
    expect(screen.getByTestId("hub-tab-content").props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId("hub-tab-status").props.accessibilityState).toEqual({ selected: false });
  });

  test("il pallino compare solo con `dot: true`, ambra e con la sua etichetta", async () => {
    await render(<HubTabBar tabs={TABS} active="status" onSelect={() => {}} />);
    const dot = screen.getByTestId("hub-tab-status-dot");
    expect(dot.props.accessibilityLabel).toBe("Serve una tua azione");
    expect(StyleSheet.flatten(dot.props.style).backgroundColor).toBe(colors.signal);
    // `dot: false` e `dot` assente: nessun pallino.
    expect(screen.queryByTestId("hub-tab-content-dot")).toBeNull();
    expect(screen.queryByTestId("hub-tab-details-dot")).toBeNull();
  });

  test("il contatore compare col numero, neutro, e solo dove c'è", async () => {
    await render(<HubTabBar tabs={TABS} active="status" onSelect={() => {}} />);
    const count = screen.getByTestId("hub-tab-activity-count");
    expect(count.props.accessibilityLabel).toBe("4 commenti");
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.queryByTestId("hub-tab-details-count")).toBeNull();
    // Neutro: non è il badge ambra del dettaglio progetto.
    expect(screen.queryByTestId("hub-tab-activity-badge")).toBeNull();
  });

  test("`count: 0` passato dal chiamante compare «0»: decide il chiamante, non la barra", async () => {
    await render(
      <HubTabBar tabs={[{ key: "activity", label: "Attività", count: 0 }]} active="activity" onSelect={() => {}} />,
    );
    expect(screen.getByTestId("hub-tab-activity-count")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  test("con `testIDPrefix` i testID cambiano; senza restano `hub-tab-*`", async () => {
    await render(<HubTabBar tabs={TABS} active="status" onSelect={() => {}} testIDPrefix="work-tab" />);
    expect(screen.getByTestId("work-tab-status")).toBeTruthy();
    expect(screen.getByTestId("work-tab-status-dot")).toBeTruthy();
    expect(screen.getByTestId("work-tab-activity-count")).toBeTruthy();
    expect(screen.queryByTestId("hub-tab-status")).toBeNull();
  });

  test("le aggiunte non toccano badge e alert di prima", async () => {
    await render(
      <HubTabBar
        tabs={[{ key: "now", label: "Adesso", badge: 2, badgeLabel: "2 da fare", alert: true, alertLabel: "rotto" }]}
        active="now"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("hub-tab-now-badge").props.accessibilityLabel).toBe("2 da fare");
    expect(StyleSheet.flatten(screen.getByTestId("hub-tab-now-alert").props.style).backgroundColor).toBe(colors.danger);
    expect(screen.queryByTestId("hub-tab-now-dot")).toBeNull();
    expect(screen.queryByTestId("hub-tab-now-count")).toBeNull();
  });

  test("l'etichetta sta su una riga sola, e può restringersi (senza `flexShrink` in una riga non tronca)", async () => {
    await render(<HubTabBar tabs={TABS} active="status" onSelect={() => {}} />);
    const label = screen.getByText("Contenuto");
    expect(label.props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(label.props.style).flexShrink).toBe(1);
  });

  test("senza `compact` la barra è quella del dettaglio progetto: misure invariate", async () => {
    await render(<HubTabBar tabs={TABS} active="status" onSelect={() => {}} />);
    expect(StyleSheet.flatten(screen.getByTestId("hub-tabs").props.style)).toMatchObject({ paddingHorizontal: 20, gap: 4 });
    expect(StyleSheet.flatten(screen.getByText("Contenuto").props.style).letterSpacing).toBe(1);
    expect(StyleSheet.flatten(screen.getByTestId("hub-tab-status").props.style).gap).toBe(6);
  });

  /**
   * Il conto a 375 pt (IBM Plex Mono: 0,6 em per carattere, quindi 7,2 pt a
   * 12 pt e 6,6 pt a 11 pt):
   * - SENZA `compact`: (375 − 2×20 − 3×4) / 4 = 80,75 pt a tab; «ATTIVITÀ»
   *   = 8 × (7,2 + 1) = 65,6, + gap 6 + contatore a una cifra (2 bordo + 2×5
   *   + 6,6 = 18,6) = 90,2 pt: NON ci sta.
   * - CON `compact`: (375 − 2×12 − 3×2) / 4 = 86,25 pt a tab; «ATTIVITÀ»
   *   = 8 × 7,2 = 57,6, + gap 4 + contatore (2 + 2×4 + 6,6 = 16,6) = 78,2 pt
   *   con una cifra, 84,8 con due: ci sta. «CONTENUTO» 64,8, «DETTAGLI» 57,6,
   *   «STATO» + pallino 36 + 4 + 6 = 46. In inglese le etichette sono più
   *   corte o uguali. Con tre cifre (91,4) l'etichetta si restringe e tronca,
   *   ed è a questo che serve `flexShrink`.
   */
  test("`compact` (quattro tab su 375 pt): margini, spaziature e lettere più strette", async () => {
    await render(<HubTabBar tabs={TABS} active="status" onSelect={() => {}} compact />);
    expect(StyleSheet.flatten(screen.getByTestId("hub-tabs").props.style)).toMatchObject({ paddingHorizontal: 12, gap: 2 });
    expect(StyleSheet.flatten(screen.getByText("Contenuto").props.style).letterSpacing).toBe(0);
    expect(StyleSheet.flatten(screen.getByTestId("hub-tab-status").props.style).gap).toBe(4);
    expect(StyleSheet.flatten(screen.getByTestId("hub-tab-activity-count").props.style).paddingHorizontal).toBe(4);
  });
});
