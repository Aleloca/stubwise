import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import type { CitationRef, CitationView } from "../../../data/types";
import i18n from "../../../i18n";
import { renderWithData } from "../../../test/renderWithData";
import { CitationProvider, indexCitations, UsedLine } from "./citations";

// La riga «Used: A · B · C» (ri-revisione finale del 5 nov 2026, scatto
// `a10b-scen-s4-light-en`): andando a capo nessun «·» resta appeso in fondo
// a una riga, né in testa alla successiva. Il «·» sta in coda al suo pezzo
// e si spegne quando il pezzo dopo va sulla riga sotto. Le anteprime dei
// codici escono dalla riga, quindi niente contenitore che taglia: si misura.

const views: CitationView[] = ["MKX-1", "MKX-2", "MKX-3", "MKX-4"].map((code, i) => ({
  kind: "task",
  id: `t-${i}`,
  visible: true,
  code,
  name: `Task ${i + 1}`,
  projectCode: "MKX",
  status: "In progress",
  personId: null,
  route: `#/p/MKX/tasks/${code}`,
}));
const refs: CitationRef[] = views.map((v) => ({ kind: "task", id: v.id }) as CitationRef);

beforeEach(async () => {
  api.setLatency(0);
  api.resetApi();
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

/** Le righe finte: ogni pezzo sta sulla riga che dice `lineOf` (alto 20px). */
function layout(lineOf: (index: number) => number) {
  const index = (el: HTMLElement) => {
    const item = el.closest<HTMLElement>("[data-used-item]");
    return item === el ? Number(item.dataset.usedItem) : null;
  };
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    const i = index(this);
    return i === null ? 0 : lineOf(i) * 20;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
}

function mount() {
  return renderWithData(
    <CitationProvider value={indexCitations(views)}>
      <UsedLine refs={refs} />
    </CitationProvider>,
  );
}

const separators = () =>
  [...document.querySelectorAll<HTMLElement>("[data-used-item]")].map((item) => {
    const sep = item.querySelector<HTMLElement>("[data-used-sep]");
    return sep ? sep.style.visibility !== "hidden" : null;
  });

describe("UsedLine andando a capo", () => {
  it("tutto su una riga: un «·» fra ogni coppia, nessuno dopo l'ultimo", async () => {
    layout(() => 0);
    mount();
    await screen.findByText("Used:");
    expect(separators()).toEqual([true, true, true, null]);
  });

  it("MKX-3 va a capo: il «·» in fondo alla prima riga si spegne, nessuno in testa alla seconda", async () => {
    layout((i) => (i >= 2 ? 1 : 0));
    mount();
    await screen.findByText("Used:");
    expect(separators()).toEqual([true, false, true, null]);
    // Il primo pezzo della seconda riga non porta un «·» davanti.
    const third = document.querySelector<HTMLElement>('[data-used-item="2"]')!;
    expect(third.textContent!.trimStart().startsWith("·")).toBe(false);
  });
});
