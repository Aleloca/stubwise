import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../i18n";
import { InviteWarnings } from "./InviteDialog";

// Rimandi, lotto 4 (46, scelta (a)): accanto al link, una riga per progetto
// dove i permessi del reparto di ripiego non varranno per chi accetta. Il
// prototipo non ne dà mai (non ha il reparto di ripiego): la riga la provano
// gli avvisi del server.

const projects = [
  { projectId: "p1", code: "ACQ", name: "Acquisti", roles: [] },
  { projectId: "p2", code: "STW", name: "Stubwise", roles: [] },
];
const warnings = [{ projectId: "p1", missing: ["release.merge"] }];

afterEach(() => act(() => setLanguage("en")));

describe("gli avvisi dell'invito", () => {
  it("una riga per progetto, coi permessi che mancano, in inglese e in italiano", () => {
    const { rerender } = render(<InviteWarnings warnings={warnings} projects={projects} />);
    const line = screen.getByText(/^In ACQ/);
    expect(line.textContent).toMatch(
      /^In ACQ the department's permissions won't apply to them: you can't grant .+ there\.$/,
    );
    expect(line.textContent).not.toContain("STW");
    act(() => setLanguage("it"));
    rerender(<InviteWarnings warnings={warnings} projects={projects} />);
    expect(screen.getByText(/^In ACQ/).textContent).toMatch(
      /^In ACQ i permessi del reparto non varranno per questa persona: lì non puoi dare .+\.$/,
    );
  });

  it("nessun avviso, nessuna riga", () => {
    const { container } = render(<InviteWarnings warnings={[]} projects={projects} />);
    expect(container).toBeEmptyDOMElement();
  });
});
