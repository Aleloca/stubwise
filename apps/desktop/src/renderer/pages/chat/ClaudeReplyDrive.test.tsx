import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearDrafts } from "./drafts";

// R-H5: il codice di un file del Drive CITATO da una risposta di @Claude si
// legge identico, tenue, per ogni causa per cui chi legge non può aprirlo —
// progetto invisibile, file nascosto, file tolto dal Drive dopo la risposta.
// Chi lo vede legge il link.

const F7 = "drv-aud-7";
const Q = "@Claude What does the client contract say about delivery times?";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

/** Giulia chiama @Claude in #announcements: la risposta cita AUD-F7. */
async function callClaude(): Promise<string> {
  setSessionPersonId("p-giulia");
  const call = await api.chat.sendMessage("ch-announcements", { text: Q });
  const reply = state.chatMessages.find((m) => m.threadOf === call.id && m.kind === "claude")!;
  await api.chat.whenClaudeIdle(reply.id);
  return call.id;
}

/** Il paragrafo della risposta che nomina il contratto, come lo disegna il thread per `personId`. */
async function paragraph(callId: string, personId: string): Promise<HTMLElement> {
  renderRoute(`/chat/ch-announcements?thread=${callId}`, personId);
  const panel = await screen.findByRole("region", { name: "Thread" });
  const reply = await within(panel).findByRole("article", { name: "called by Giulia Ferri" });
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = [...reply.querySelectorAll<HTMLElement>("p")].find((p) =>
      p.textContent?.includes("Contratto quadro Audin 2025"),
    );
    expect(found).toBeDefined();
  });
  return found!;
}

describe("@Claude che cita un file del Drive (R-H5)", () => {
  it("invisibile, nascosto e tolto si leggono identici; chi lo vede legge il link", async () => {
    const callId = await callClaude();

    const giulia = await paragraph(callId, "p-giulia");
    await waitFor(() =>
      expect(giulia.querySelector(`[data-citation="drive:${F7}"]`)).not.toBeNull(),
    );
    cleanup();

    const markup = async (personId: string) => {
      const p = await paragraph(callId, personId);
      await waitFor(() => expect(p.querySelector('[data-citation="hidden"]')).not.toBeNull());
      const html = p.innerHTML;
      cleanup();
      return html;
    };

    // Sara non vede AUD.
    const invisible = await markup("p-sara");
    expect(invisible).toContain("AUD-F7");
    // Nascosto dopo la risposta (anche Giulia non lo apre più da qui).
    const file = state.driveFiles.find((f) => f.id === F7)!;
    file.hidden = true;
    const hidden = await markup("p-giulia");
    // Tolto dal Drive dopo la risposta (come `dropFiles`): non c'è più nello stato.
    file.hidden = false;
    state.driveFiles.splice(state.driveFiles.indexOf(file), 1);
    const removed = await markup("p-giulia");

    expect(hidden).toBe(invisible);
    expect(removed).toBe(invisible);
  });
});
