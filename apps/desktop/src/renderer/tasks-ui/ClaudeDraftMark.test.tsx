import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../data/api";
import { renderWithData } from "../test/renderWithData";
import { ClaudeDraftMark } from "./ClaudeDraftMark";

// Il segno «Claude's draft» (area 10b, Task 10; shape `claude-drafts.md`
// §3.1): le fonti sono link se chi guarda vede l'oggetto, altrimenti il
// codice tenue che non si apre (R-E9), mai il titolo. Il separatore delle
// fonti non è un punto scritto: andando a capo, una riga non comincia con «·».

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

describe("ClaudeDraftMark", () => {
  it("una fonte visibile è un link col nome; una invisibile è il codice tenue, senza nome", async () => {
    // Giulia vede MKX, non ACQ.
    renderWithData(
      <ClaudeDraftMark
        id="m"
        action="send"
        sources={[
          { code: "MKX-1", title: "fallback" },
          { code: "ACQ-7", title: "Reminder text message before the bill is due" },
        ]}
      />,
      { personId: "p-giulia" },
    );
    const mark = screen.getByText("Claude's draft").closest("[data-claude-draft-mark]")!;
    const link = await waitFor(() =>
      within(mark as HTMLElement).getByRole("link", { name: /^MKX-1\b/ }),
    );
    expect(link).toHaveAttribute("href", "#/p/MKX/tasks?task=MKX-1");
    expect(within(mark as HTMLElement).queryByRole("link", { name: /ACQ-7/ })).toBeNull();
    const hidden = within(mark as HTMLElement).getByText("ACQ-7");
    expect(hidden).toHaveClass("text-ink-faint");
    expect(mark.textContent!.toLowerCase()).not.toContain("reminder");
    // Nessun «·» scritto davanti a «Used:».
    expect(mark.textContent).not.toMatch(/·\s*Used:/);
  });
});
