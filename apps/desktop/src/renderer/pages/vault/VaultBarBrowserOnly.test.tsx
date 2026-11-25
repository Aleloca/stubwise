import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { queryKeys } from "../../data/queries";
import { setLanguage } from "../../i18n";
import { lastQueryClient, renderRoute } from "../../test/renderRoute";

// Due stati della barra che solo l'app vera produce (lotto 10, il main):
// `disabled` (l'istanza ha la cassaforte dal desktop spenta, VAULT_DESKTOP)
// e `unsupported` (un build o un Mac senza Secure Enclave). In entrambi la
// cassaforte si apre dal browser, e la barra lo dice con «Open in the
// browser». Il prototipo non li produce: qui si mette lo stato nella cache.

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(() => act(() => setLanguage("en")));

async function withState(state: "disabled" | "unsupported") {
  renderRoute("/p/ACQ/credentials", "p-laura");
  await screen.findByRole("heading", { level: 1, name: "Credentials" });
  await screen.findByRole("button", { name: "Open with Touch ID" });
  act(() =>
    lastQueryClient().setQueryData(queryKeys.vaultStatus("p-laura"), {
      state,
      touchId: false,
      macFingerprint: null,
      ownFingerprint: null,
      pairing: null,
    }),
  );
}

describe("la barra quando la cassaforte si apre solo dal browser", () => {
  it("disabled: l'istanza la apre solo dal browser", async () => {
    await withState("disabled");
    expect(
      await screen.findByText("This instance opens the vault only in the browser."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in the browser" })).toBeInTheDocument();
  });

  it("unsupported: questo Mac non può aprirla", async () => {
    await withState("unsupported");
    expect(
      await screen.findByText(
        "This Mac can't open the vault (no Secure Enclave, or a build without it). Open it in the browser.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in the browser" })).toBeInTheDocument();
  });
});
