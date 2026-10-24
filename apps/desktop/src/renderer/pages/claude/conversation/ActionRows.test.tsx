import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { actionLabel, actionResult, ActionRows } from "./ActionRows";
import type { Ev } from "./flow";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const action = (label: string, state: Ev<"action">["state"], id = label): Ev<"action"> => ({
  id,
  at: "2026-10-23T09:00:00Z",
  type: "action",
  tool: "repo.read",
  label,
  state,
});

describe("etichette delle azioni", () => {
  it("al passato quando sono finite (anche non riuscite), al presente solo in corso", () => {
    const t = i18n.t.bind(i18n);
    expect(actionLabel(t, action("Reads MKX-3", "done"))).toBe("Read MKX-3");
    expect(actionLabel(t, action("Runs the desktop tests", "failed"))).toBe(
      "Ran the desktop tests",
    );
    expect(actionLabel(t, action("Writes the plan of STW-R4", "done"))).toBe(
      "Wrote the plan of STW-R4",
    );
    expect(actionLabel(t, action("Edits apps/desktop/x.ts", "done"))).toBe(
      "Edited apps/desktop/x.ts",
    );
    expect(actionLabel(t, action("Reads MKX-3", "running"))).toBe("Reads MKX-3");
    // Un'etichetta già al passato torna al presente mentre è in corso.
    expect(actionLabel(t, action("Wrote the result in MKX-2", "running"))).toBe(
      "Writes the result in MKX-2",
    );
    // Un verbo che non si conosce resta com'è.
    expect(actionLabel(t, action("Looked up MKX-3", "done"))).toBe("Looked up MKX-3");
  });

  it("il verbo nella lingua di chi guarda", async () => {
    await i18n.changeLanguage("it");
    const t = i18n.t.bind(i18n);
    expect(actionLabel(t, action("Reads MKX-3", "done"))).toBe("Letto MKX-3");
    expect(actionLabel(t, action("Runs the tests", "running"))).toBe("Esegue the tests");
  });

  it("una riga registrata come frase si legge tutta nella lingua di chi guarda, risultato compreso", async () => {
    const searched: Ev<"action"> = {
      ...action("Searched AUD docs for “invoice PDF”", "done"),
      labelText: {
        key: "claude.answers.actions.searchDocs",
        params: { code: "AUD", topic: "invoice PDF" },
      },
      result: "2 pages",
      resultText: { key: "claude.answers.actions.pages", params: { count: 2 } },
    };
    await i18n.changeLanguage("it");
    const t = i18n.t.bind(i18n);
    expect(actionLabel(t, searched)).toBe("Cercato «invoice PDF» nei Docs di AUD");
    expect(actionResult(t, searched)).toBe("2 pagine");
  });

  it("il riassunto del gruppo ha un solo separatore: il conteggio, poi l'ultima azione", () => {
    render(
      <ActionRows
        actions={[
          action("Reads MKX-3", "done", "a"),
          action("Edits src/a.ts", "done", "b"),
          action("Runs the desktop tests", "done", "c"),
        ]}
      />,
    );
    const group = screen.getByRole("button", { name: /3 actions/ });
    expect(group.textContent).toBe("3 actions·Ran the desktop tests");
  });
});
