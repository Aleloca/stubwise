import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { renderWithData } from "../../test/renderWithData";
import { AgentKeyDialog } from "./AgentKeyPanel";

// Area 8, F4b (R3): nel dialogo della chiave dell'agente, le operazioni
// (riavviare, fermare, avviare un container, liberare spazio: solo dopo un
// piano approvato da una persona) si accendono nel comando d'installazione,
// spente di base. Accese, il comando porta la chiave pubblica d'istanza.

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

const command = () => document.querySelector("[data-command]")?.textContent ?? "";

describe("le operazioni dell'agente nel comando (R3)", () => {
  it("spente di base; accese, il comando le porta con la chiave dei comandi", async () => {
    renderWithData(
      <AgentKeyDialog title="Agent key" code="SRV-1" agentKey="sk_test" onDone={() => {}} />,
      { personId: "p-roberta" },
    );
    const box = screen.getByRole("checkbox", { name: "Let the agent run fix actions" });
    expect(box).not.toBeChecked();
    expect(command()).toContain("STUBWISE_SERVER_KEY=sk_test");
    expect(command()).not.toContain("STUBWISE_OPERATIONS");
    await userEvent.click(box);
    await waitFor(() => expect(command()).toContain("STUBWISE_OPERATIONS=1"));
    expect(command()).toMatch(/STUBWISE_COMMAND_PUBLIC_KEY=ssh-ed25519 \S+/);
    expect(command()).toContain("-v stubwise-agent-state:/var/lib/stubwise-agent");
  });

  it("senza la chiave dei comandi (errore) niente comando da copiare, e lo dice", async () => {
    failNext("servers.getCommandKey");
    renderWithData(
      <AgentKeyDialog title="Agent key" code="SRV-1" agentKey="sk_test" onDone={() => {}} />,
      { personId: "p-roberta" },
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Let the agent run fix actions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load the key that signs the agent's actions.",
    );
    expect(document.querySelector("[data-command]")).toBeNull();
  });
});
