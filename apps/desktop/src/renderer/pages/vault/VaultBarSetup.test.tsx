import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { renderWithData } from "../../test/renderWithData";

const bar = vi.hoisted(() => ({ state: "no_key" as string, admin: false }));
vi.mock("../../data/viewing", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../data/viewing")>();
  return {
    ...real,
    useViewer: () => {
      const v = real.useViewer();
      return { ...v, viewer: { ...v.viewer, instancePermissions: bar.admin ? ["instance.full_admin"] : [] } };
    },
  };
});
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useVaultStatus: () => ({
    isError: false,
    data: { state: bar.state, touchId: false, macFingerprint: null, ownFingerprint: null, pairing: null },
    refetch: () => undefined,
  }),
}));

const { VaultBar } = await import("./VaultBar");

// La fase 2 della cassaforte (design §10): «senza chiave» e «non attiva»
// portano alla pagina della cassaforte della nuova app, non al web vecchio.
// Nella build web è una pagina di qui; dal Mac si apre nel browser.

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetApi();
  setLatency(0);
  assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  window.location.hash = "";
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function barWith(state: "no_key" | "inactive" | "locked" | "disabled", personId: string) {
  bar.state = state;
  bar.admin = personId === "p-roberta";
  renderWithData(<VaultBar />, { personId });
}

describe("la barra porta alla pagina della cassaforte", () => {
  it("web, senza chiave: «Create your key» fa una navigazione COMPLETA alla pagina a sé (I-2)", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.stubEnv("VITE_STUBWISE_TARGET", "web");
    await barWith("no_key", "p-laura");
    fireEvent.click(await screen.findByRole("button", { name: "Create your key" }));
    expect(assign).toHaveBeenCalledWith("/vault/#/setup");
    expect(window.location.hash).toBe("");
  });

  it("web, non attiva: al full admin «Activate the vault», agli altri niente", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.stubEnv("VITE_STUBWISE_TARGET", "web");
    await barWith("inactive", "p-roberta");
    fireEvent.click(await screen.findByRole("button", { name: "Activate the vault" }));
    expect(assign).toHaveBeenCalledWith("/vault/#/setup");
  });

  it("web, non attiva, chi non è full admin: nessun bottone", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.stubEnv("VITE_STUBWISE_TARGET", "web");
    await barWith("inactive", "p-laura");
    expect(await screen.findByText("The vault hasn't been activated on this instance yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate the vault" })).toBeNull();
  });

  it("Mac, senza chiave: «Open in the browser» apre la pagina della nuova app, non il web vecchio", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.stubEnv("VITE_STUBWISE_TARGET", "electron");
    await barWith("no_key", "p-laura");
    fireEvent.click(await screen.findByRole("button", { name: "Open in the browser" }));
    expect(assign).toHaveBeenCalledWith("/vault/#/setup");
  });

  it("Mac senza Touch ID o con la cassaforte solo dal browser: «Open in the browser» apre la cassaforte della nuova app", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    vi.stubEnv("VITE_STUBWISE_TARGET", "electron");
    await barWith("locked", "p-laura");
    fireEvent.click(await screen.findByRole("button", { name: "Open in the browser" }));
    expect(assign).toHaveBeenCalledWith("/#/vault");
  });
});
