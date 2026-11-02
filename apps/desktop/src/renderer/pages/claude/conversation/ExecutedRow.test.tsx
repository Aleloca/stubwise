import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { expectNoDeploy } from "../../../test/noDeploy";
import { renderWithData } from "../../../test/renderWithData";
import { Conversation } from "./Conversation";

// Le righe delle azioni di Claude nel flusso (area 10a). Qui, dal Task 6, la
// riga D del deploy resa nel DOM: solo così `expectNoDeploy()` prova
// qualcosa (ruling del controller (pre-flight), P13). Il Task 9 aggiunge le
// righe eseguite e «Annulla».

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
});

describe("la riga D del deploy", () => {
  it("la frase, senza link e senza un controllo che faccia il deploy", async () => {
    setSessionPersonId("p-giulia");
    const c = await api.createConversation({ contextProjectId: "prj-mkx" });
    const { container } = renderWithData(
      <div style={{ height: 800 }}>
        <Conversation id={c.id} />
      </div>,
      { personId: "p-giulia" },
    );
    await screen.findByRole("combobox", { name: /message to claude/i });
    setSessionPersonId("p-giulia");
    await act(() => api.sendMessage(c.id, { text: "Deploy MKX to production" }));
    const line = "Stubwise doesn't deploy: merging a pull request is as far as it goes.";
    await waitFor(() => {
      const messages = container.querySelectorAll("[data-assistant]");
      expect(messages[messages.length - 1]?.textContent ?? "").toContain(line);
    });
    const message = [...container.querySelectorAll("[data-assistant]")].at(-1)!;
    expect(message.querySelector("a")).toBeNull();
    expect(container.querySelector("[data-proposal]")).toBeNull();
    expectNoDeploy();
  });
});
