import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearDrafts } from "./drafts";

// Un «Who?» di Claude nella Chat (`[Who?](who:…)`) è il link del riquadro,
// non la parola nuda: una «Who?» che non fa niente afferma ciò che la UI non
// fa (review finale 10b, 5).

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

describe("@Claude con un «Who?» nella risposta", () => {
  it("Laura senza i consumi dell'istanza: «Who?» apre chi può vedere i consumi", async () => {
    setSessionPersonId("p-laura");
    const call = await api.chat.sendMessage("ch-announcements", {
      text: "@Claude how much have we spent on AI this month?",
    });
    const reply = state.chatMessages.find((m) => m.threadOf === call.id && m.kind === "claude")!;
    await api.chat.whenClaudeIdle(reply.id);
    expect(reply.text ?? "").toContain("(who:seeUsage)");

    renderRoute(`/chat/ch-announcements?thread=${call.id}`, "p-laura");
    const panel = await screen.findByRole("region", { name: "Thread" });
    const article = await within(panel).findByRole("article", { name: /called by Laura/ });
    const who = await waitFor(() => {
      const el = article.querySelector<HTMLElement>('[data-who-can="seeUsage"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.click(who);
    await waitFor(() =>
      expect(document.querySelector('[data-who-can-popover="seeUsage"]')).not.toBeNull(),
    );
  });
});
