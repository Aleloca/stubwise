import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { PR_PANEL_DOCKED_QUERY } from "./PrPanel";

// Area 8, R-2 (= a, 46): i «Simula» dei rilasci sono del prototipo. Nella
// build app non ci sono, nemmeno con la sezione accesa (qui col mock di
// `integration`, sui dati del prototipo).
vi.mock("../../data/integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/integration")>();
  const on = (name: string) => name === "releases";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      ((t.kind === "projectSection" || t.kind === "feature") && on(t.name)) ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => on(name) || actual.featureIntegrated(name),
  };
});

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  setMatchMedia(PR_PANEL_DOCKED_QUERY, true);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetViewerGrants();
  act(() => setLanguage("en"));
});

describe("i «Simula» dei rilasci fuori dalla build app (area 8, R-2)", () => {
  it("il dettaglio di un rilascio non ha il riquadro «Prototype only»", async () => {
    renderRoute("/p/STW/releases/STW-V2", "p-laura");
    await screen.findByRole("region", { name: "Now" });
    expect(screen.queryByRole("region", { name: "Prototype only" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Simulate/ })).toBeNull();
  });

  it("il pannello di una PR non ha il riquadro «Prototype only»", async () => {
    renderRoute("/p/AUD/releases?pr=opr-aud-246", "p-laura");
    await screen.findByRole("region", { name: "Pull request audin-app#246" });
    expect(screen.queryByRole("region", { name: "Prototype only" })).toBeNull();
  });
});

describe("il log di una run nella build app (area 8, P-1 = a)", () => {
  it("niente log nell'app: la riga dice che è sul provider, accanto al link", async () => {
    renderRoute("/p/AUD/releases/AUD-V3", "p-laura");
    await screen.findByRole("region", { name: "Now" });
    expect(screen.queryByRole("region", { name: /^Log of / })).toBeNull();
    expect(screen.getByText(/The full log is on GitHub: open the run there\./)).toBeInTheDocument();
    expect(screen.queryByText("This run has no log.")).toBeNull();
  });
});
