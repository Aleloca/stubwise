import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

// Review F4a, M3: se la chiave dell'agente non c'è più quando il pannello la
// prende, il dialogo lo dice e non resta pronto per un secondo clic che
// creerebbe un doppione.
vi.mock("../../data/revealedAgentKey", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/revealedAgentKey")>();
  return { ...actual, takeAgentKey: () => undefined };
});

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("la chiave che non c'è più (review F4a, M3)", () => {
  it("l'errore, e «Create» fermo: un server solo", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/servers", "p-roberta");
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "edge-01");
    const before = state.servers.length;
    const create = within(dialog).getByRole("button", { name: /^Create/ });
    await user.click(create);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The server was created, but its key can't be shown",
    );
    expect(create).toBeDisabled();
    await user.click(create);
    await waitFor(() => expect(state.servers).toHaveLength(before + 1));
  });
});
