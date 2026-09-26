import { render, screen } from "@testing-library/react-native";
import { colors } from "../theme/tokens";
import { AppSwitch } from "./AppSwitch";

/**
 * L'interruttore dell'app coi colori del design, non il verde di iOS (26 set
 * 2026): lo «Only significant» della documentazione era uscito verde, il terzo
 * Switch scritto a mano dopo le impostazioni e le impostazioni di progetto.
 */
describe("AppSwitch", () => {
  test("pomello ink950, traccia ambra da acceso e line da spento", async () => {
    await render(<AppSwitch value testID="s" onValueChange={() => {}} />);
    const host = screen.getByTestId("s");
    expect(host.props.thumbTintColor).toBe(colors.ink950);
    expect(host.props.onTintColor).toBe(colors.signal);
    expect(host.props.tintColor).toBe(colors.line);
  });
});
