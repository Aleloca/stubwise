import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearDrafts } from "./drafts";

// Review F7 renderer, I1: le proposte della Chat usano lo stesso catalogo, e
// una C (addMember) si conferma solo con la riconferma, come nel riquadro.

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetReauthForTest();
  clearDrafts();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

describe("@Claude nella Chat: una C chiede il codice alla conferma", () => {
  it("Laura aggiunge Luca ad ACQ: Confirm → dialogo → 123456 → Luca è membro", async () => {
    setSessionPersonId("p-laura");
    const call = await api.chat.sendMessage("ch-announcements", {
      text: "@Claude invita Luca come Developer in ACQ",
    });
    const reply = state.chatMessages.find((m) => m.threadOf === call.id && m.kind === "claude")!;
    await api.chat.whenClaudeIdle(reply.id);

    renderRoute(`/chat/ch-announcements?thread=${call.id}`, "p-laura");
    const panel = await screen.findByRole("region", { name: "Thread" });
    const article = await within(panel).findByRole("article", { name: /called by Laura/ });
    const confirm = await within(article).findByRole("button", { name: "Confirm" });
    await userEvent.click(confirm);
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.type(within(dialog).getByLabelText("Code"), "123456");
    await waitFor(() => expect(state.projectsById.get("prj-acq")!.memberIds).toContain("p-luca"));
  });
});
