import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSettings, resetApi, setLatency } from "../../data/api";
import { getSessionPersonId, setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// «From the doc: ACQ-D11 Phases» (11b, Task 12; shape
// product-claude-backlog.md §3.4, [PB 5]): sulla task nata da una richiesta
// della doc di prodotto, sotto la richiesta d'origine, e sulla richiesta
// stessa in «Where it comes from». La riga porta alla pagina; chi la pagina
// non la vede (Docs spenti) non ha la riga, né il nome della pagina da
// nessuna parte (R-G5). Seme: `req-acq-6` nasce da Phases, e da lei la task.

const MARCO = "p-marco";
const LAURA = "p-laura";
const ACQ = "prj-acq";

const phases = () => state.productPages.find((p) => p.id === "pp-acq-phases")!;
const request = () => state.requests.find((r) => r.id === "req-acq-6")!;
const taskCode = () => state.tasks.find((t) => t.requestId === "req-acq-6")!.code;
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

async function docsOff() {
  const before = getSessionPersonId();
  setSessionPersonId(LAURA);
  try {
    await projectSettings.setDocsModule(ACQ, false);
  } finally {
    setSessionPersonId(before);
  }
}

describe("sulla task", () => {
  it("sotto «Origin request»: «From the doc: ACQ-D11 Phases», che apre la pagina", async () => {
    renderRoute(`/p/ACQ/tasks?task=${taskCode()}`, MARCO);
    const panel = await screen.findByRole("dialog", { name: `Task ${taskCode()}` });
    const origin = await waitFor(() => within(panel).getByRole("region", { name: "Origin request" }));
    const line = await waitFor(() => {
      const el = origin.querySelector<HTMLElement>("[data-product-origin]");
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(flat(line)).toBe(`From the doc: ${phases().code} Phases`));
    const link = await within(line).findByRole("link", { name: `${phases().code} Phases` });
    expect(link).toHaveAttribute("href", `#/p/ACQ/docs/product/${phases().code}`);
    // Dopo il titolo della richiesta d'origine.
    const requestLink = within(origin).getByRole("link", { name: request().title });
    expect(requestLink.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("in italiano: «Dalla doc:»", async () => {
    renderRoute(`/p/ACQ/tasks?task=${taskCode()}`, MARCO);
    const panel = await screen.findByRole("dialog", { name: `Task ${taskCode()}` });
    act(() => setLanguage("it"));
    await waitFor(() => expect(flat(panel)).toContain(`Dalla doc: ${phases().code} Phases`));
  });

  it("Docs spenti in ACQ: la riga non c'è, e la pagina non si nomina (R-G5)", async () => {
    await docsOff();
    renderRoute(`/p/ACQ/tasks?task=${taskCode()}`, MARCO);
    const panel = await screen.findByRole("dialog", { name: `Task ${taskCode()}` });
    const origin = await waitFor(() => within(panel).getByRole("region", { name: "Origin request" }));
    await within(origin).findByRole("link", { name: request().title });
    expect(origin.querySelector("[data-product-origin]")).toBeNull();
    expect(flat(panel).toLowerCase()).not.toContain("from the doc");
    expect(flat(panel).toLowerCase()).not.toContain(phases().code.toLowerCase());
  });
});

describe("sulla richiesta", () => {
  it("in «Where it comes from»: «From the doc: ACQ-D11 Phases»", async () => {
    renderRoute("/p/ACQ/requests?request=req-acq-6", MARCO);
    const dialog = await screen.findByRole("dialog", { name: "Request" });
    const section = await within(dialog).findByRole("region", { name: "Where it comes from" });
    await waitFor(() => expect(flat(section)).toContain(`From the doc: ${phases().code} Phases`));
    expect(within(section).getByRole("link", { name: `${phases().code} Phases` })).toHaveAttribute(
      "href",
      `#/p/ACQ/docs/product/${phases().code}`,
    );
  });

  it("Docs spenti: nessuna «Where it comes from», nessun nome della pagina", async () => {
    await docsOff();
    renderRoute("/p/ACQ/requests?request=req-acq-6", MARCO);
    const dialog = await screen.findByRole("dialog", { name: "Request" });
    await within(dialog).findByText(request().title);
    expect(within(dialog).queryByRole("region", { name: "Where it comes from" })).toBeNull();
    expect(flat(dialog).toLowerCase()).not.toContain("phases");
  });
});
