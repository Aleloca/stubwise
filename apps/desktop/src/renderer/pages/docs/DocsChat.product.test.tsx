import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, resolveCitations, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { DocsAnswer } from "../../data/types";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { renderWithData } from "../../test/renderWithData";
import { CitationProvider, indexCitations } from "../claude/conversation/citations";
import { DocsAnswerSources } from "./DocsChat";

// La chat del progetto e le pagine di prodotto (area 11a, Task 6; shape
// product-space.md §3.9): la fonte di una pagina di prodotto dice «from
// Product» / «da Prodotto» al posto del nome del repository.

const METER = "pp-acq-meter-reading";
const meterCode = () => state.productPages.find((p) => p.id === METER)!.code;

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  act(() => setLanguage("en"));
});

/** Le fonti di una risposta, con le citazioni lette come Laura. */
async function renderSources(answer: DocsAnswer) {
  setSessionPersonId("p-laura");
  const views = await resolveCitations(answer.refs);
  renderWithData(
    <CitationProvider value={indexCitations(views)}>
      <DocsAnswerSources answer={answer} />
    </CitationProvider>,
    { personId: "p-laura" },
  );
}

describe("Docs — chat del progetto e pagine di prodotto", () => {
  it("«How do meter readings work?» nella chat di ACQ: cita Meter reading «from Product»", async () => {
    renderRoute("/p/ACQ/docs", "p-laura");
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    await userEvent.type(
      within(chat).getByRole("textbox", { name: "Ask the docs" }),
      "How do meter readings work?{Enter}",
    );
    const used = await within(chat).findByText("Used:", undefined, { timeout: 3000 });
    const line = used.parentElement!;
    const link = within(line).getByRole("link", {
      name: new RegExp(`${meterCode()} Meter reading`),
    });
    expect(link).toHaveAttribute("href", `#/p/ACQ/docs/product/${meterCode()}`);
    expect(line).toHaveTextContent(`${meterCode()} Meter reading from Product`);
    expect(line).not.toHaveTextContent(/portale-utenti/i);
  });

  it("in italiano la fonte è «da Prodotto»", async () => {
    act(() => setLanguage("it"));
    await renderSources({
      answeredAt: "2026-11-05T12:00:00Z",
      text: "",
      refs: [{ kind: "doc", id: METER }],
      sources: [{ pageId: METER, repositoryName: "", space: "product" }],
    });
    expect(screen.getByText(/da Prodotto/)).toBeInTheDocument();
  });

  it("una risposta senza `space` (fixture apposta, una risposta di prima) mostra il nome del repository", async () => {
    // Nessun campo `space`: è la forma delle risposte di sempre.
    await renderSources({
      answeredAt: "2026-11-05T12:00:00Z",
      text: "",
      refs: [{ kind: "doc", id: "doc-acq-test-accounts" }],
      sources: [{ pageId: "doc-acq-test-accounts", repositoryName: "portale-utenti" }],
    });
    expect(screen.getByText(/from portale-utenti/)).toBeInTheDocument();
    expect(screen.queryByText(/from Product/)).toBeNull();
  });
});
