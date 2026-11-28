import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { renderRoute } from "../../test/renderRoute";

// Il login con `next` (revisione della fase 2, I-2): la pagina a sé della
// cassaforte manda qui chi non ha una sessione, e dopo l'accesso si torna lì
// con una navigazione completa. `next` è un elenco chiuso: un URL o `//host`
// portano alla Home.

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetApi();
  setLatency(0);
  assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => vi.restoreAllMocks());

describe("/login?next=…", () => {
  it("già dentro, `next=vault-setup`: navigazione completa alla pagina a sé", async () => {
    renderRoute("/login?next=vault-setup", "p-laura");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/app/vault/#/setup"));
  });

  it("`next=vault-pair` porta con sé lo state, se valido", async () => {
    renderRoute("/login?next=vault-pair&state=c3Rh-dGU_", "p-laura");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/app/vault/#/pair?state=c3Rh-dGU_"));
  });

  it.each(["https://evil.example/", "//evil.example", "/app/vault/#/setup", "nope"])("`next=%s` porta alla Home", async (next) => {
    const router = renderRoute(`/login?next=${encodeURIComponent(next)}`, "p-laura");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    expect(assign).not.toHaveBeenCalled();
  });
});
