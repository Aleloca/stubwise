import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { readsAs } from "../../../data/api-mutations";
import { setSessionPersonId } from "../../../data/session";
import { PEOPLE } from "../../../data/seed/people";
import { can, viewerFor } from "../../../data/viewer";
import { respond } from "../../../domain/claude/intents";
import { renderWithData } from "../../../test/renderWithData";
import { AssistantMessage } from "./AssistantMessage";
import { CitationProvider, indexCitations } from "./citations";

// Il «Who?» di una risposta di Claude (area 10b, S3; maintainer, 2 nov 2026):
// `who:<azione>/<CODE>` per un'azione di progetto (com'era, solo se chi
// legge vede il progetto) e `who:<azione>` per un'azione d'istanza, senza
// controllo di visibilità (non c'è un progetto da nascondere). Un'azione di
// progetto senza codice, o un'azione che il catalogo non ha, resta testo.

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

/** Il messaggio dentro un router minimo: il riquadro di «Who?» ha il link «Open in Who can?». */
function show(text: string, personId: string) {
  setSessionPersonId(personId);
  const root = createRootRoute({
    component: () => (
      <CitationProvider value={indexCitations([])}>
        <AssistantMessage
          item={{
            kind: "assistant",
            key: "a1",
            event: { id: "a1", at: "2026-10-25T12:00:00Z", type: "assistant", text, done: true },
            refs: [],
          }}
          streaming={false}
        />
      </CitationProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory() });
  return renderWithData(<RouterProvider router={router} />, { personId });
}

const whoButtons = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-who-can]"),
];

describe("whoOf nella conversazione", () => {
  it("`who:seeUsage` è il «Who?» d'istanza: la lista dice chi ha `usage.view`", async () => {
    const user = userEvent.setup();
    const { container } = show(
      "The total is visible to people who can see usage · [Who?](who:seeUsage)",
      "p-laura",
    );
    await waitFor(() => expect(whoButtons(container)).toHaveLength(1));
    const [link] = whoButtons(container);
    expect(link!.dataset.whoCan).toBe("seeUsage");
    await user.click(link!);
    const popover = await screen.findByRole("dialog");
    expect(popover.dataset.whoCanPopover).toBe("seeUsage");
    await waitFor(() =>
      expect(popover.querySelectorAll("[data-who-row]").length).toBeGreaterThan(0),
    );
    const rows = [...popover.querySelectorAll<HTMLElement>("[data-who-row]")].map(
      (r) => r.dataset.whoRow!,
    );
    // Ogni riga ha `usage.view`; Laura, che non ce l'ha, non c'è.
    for (const id of rows) expect(can(viewerFor(id), "usage.view")).toBe(true);
    expect(rows).toContain("p-roberta");
    expect(rows).not.toContain("p-laura");
    expect(PEOPLE.some((p) => p.id === "p-laura")).toBe(true);
    // Il titolo è d'istanza: nessun codice di progetto.
    expect(within(popover).getByRole("heading")).toHaveTextContent(/^Who can see the usage$/);
  });

  it("`who:recordDecision/AUD` resta com'è: il link se chi legge vede AUD, niente se no", async () => {
    const text = "The decision log is written by people. [Who?](who:recordDecision/AUD)";
    const giulia = show(text, "p-giulia");
    await waitFor(() => expect(whoButtons(giulia.container)).toHaveLength(1));
    expect(whoButtons(giulia.container)[0]!.dataset.whoCan).toBe("recordDecision");
    giulia.unmount();
    // Sara non vede AUD: nessun «Who?», né come link né come testo.
    const sara = show(text, "p-sara");
    await waitFor(() => expect(sara.container).toHaveTextContent("The decision log"));
    // Il tempo di leggere gli indirizzi aperti.
    await new Promise((r) => setTimeout(r, 20));
    expect(whoButtons(sara.container)).toHaveLength(0);
    expect(sara.container).not.toHaveTextContent("Who?");
  });

  for (const href of ["who:recordDecision", "who:nonEsiste"]) {
    it(`\`${href}\` resta testo`, async () => {
      const { container } = show(`Ask someone · [Who?](${href})`, "p-roberta");
      await waitFor(() => expect(container).toHaveTextContent("Ask someone · Who?"));
      expect(whoButtons(container)).toHaveLength(0);
      expect(container.querySelector("a")).toBeNull();
    });
  }

  it("la riga di Laura in S3, resa nel flusso, ha il link «Who?» d'istanza", async () => {
    setSessionPersonId("p-laura");
    const steps = await respond("How much have we spent on AI this month?", {
      personId: "p-laura",
      contextProjectId: null,
      read: readsAs("p-laura"),
      t: i18n.getFixedT("en"),
      seed: "who-test",
    });
    const text = steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n\n");
    expect(text).toContain("(who:seeUsage)");
    const { container } = show(text, "p-laura");
    await waitFor(() => expect(whoButtons(container)).toHaveLength(1));
    expect(whoButtons(container)[0]!.dataset.whoCan).toBe("seeUsage");
    expect(container).toHaveTextContent("The total is visible to people who can see usage · Who?");
  });
});
