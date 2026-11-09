import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { CitationView } from "../../../data/types";
import { clearToasts, ToastRegion } from "../../../tasks-ui/Toast";
import { renderWithData } from "../../../test/renderWithData";
import { ChannelView } from "../../chat/ChannelView";
import { clearDrafts } from "../../chat/drafts";
import { CitationLink } from "./citations";

// Il gettone `drive` (area 5): anteprima (nome, tipo, progetto, riassunto,
// aperture), il clic apre il file e conta — dopo aver riletto che c'è ancora;
// un `AUD-F7` scritto a mano è un link solo per chi vede il file (R-G5).

const F7 = "drv-aud-7";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  clearToasts();
});

async function viewOf(personId: string, id = F7): Promise<CitationView> {
  setSessionPersonId(personId);
  return (await api.resolveCitations([{ kind: "drive", id }]))[0]!;
}

const opensOf = (id: string) => state.driveOpens.filter((o) => o.fileId === id).length;

describe("gettone drive", () => {
  it("codice + nome + ↗ di Google; l'anteprima dice tipo, progetto, riassunto e aperture", async () => {
    const view = await viewOf("p-giulia");
    renderWithData(<CitationLink view={view} />, { personId: "p-giulia" });
    const link = screen.getByRole("link", { name: /AUD-F7 Contratto quadro Audin 2025/ });
    expect(link.getAttribute("href")).toBe("#/p/AUD/drive?file=AUD-F7");
    vi.useFakeTimers();
    try {
      fireEvent.focus(link);
      act(() => vi.advanceTimersByTime(300));
    } finally {
      vi.useRealTimers();
    }
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Google document");
    expect(tip.textContent).toContain("AUD");
    expect(tip.textContent).toMatch(/30 working days/);
    expect(tip.textContent).toMatch(/opens? in the last 90 days/);
    expect(tip.textContent).toContain("Open in Google Drive");
  });

  it("il clic apre il file su Google e conta un'apertura (riaprire subito no)", async () => {
    const view = await viewOf("p-giulia");
    const before = opensOf(F7);
    renderWithData(
      <>
        <CitationLink view={view} />
        <ToastRegion />
      </>,
      { personId: "p-giulia" },
    );
    await userEvent.click(screen.getByRole("link", { name: /AUD-F7/ }));
    expect(await screen.findByText(/^Opened in Google Drive/)).toBeTruthy();
    await waitFor(() => expect(opensOf(F7)).toBe(before + 1));
    // Riaprire subito (entro 30′) non conta di nuovo.
    await userEvent.click(screen.getByRole("link", { name: /AUD-F7/ }));
    await waitFor(() => expect(screen.getAllByText(/^Opened in Google Drive/)).toHaveLength(2));
    expect(opensOf(F7)).toBe(before + 1);
  });

  it("sparito dopo la citazione (nascosto): «This file is no longer available», nessuna apertura", async () => {
    const view = await viewOf("p-giulia");
    state.driveFiles.find((f) => f.id === F7)!.hidden = true;
    const before = opensOf(F7);
    renderWithData(
      <>
        <CitationLink view={view} />
        <ToastRegion />
      </>,
      { personId: "p-giulia" },
    );
    await userEvent.click(screen.getByRole("link", { name: /AUD-F7/ }));
    expect(await screen.findByText("This file is no longer available")).toBeTruthy();
    expect(opensOf(F7)).toBe(before);
  });

  it("chi non vede il file legge «An item you can't open», identico a un id inesistente", async () => {
    const hidden = await viewOf("p-sara");
    const missing = await viewOf("p-sara", "drv-nope");
    const a = renderWithData(<CitationLink view={hidden} />, { personId: "p-sara" });
    const html = a.container.innerHTML;
    a.unmount();
    const b = renderWithData(<CitationLink view={missing} />, { personId: "p-sara" });
    expect(b.container.innerHTML).toBe(html);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("AUD-F7 scritto a mano in un messaggio", () => {
  function put(text: string) {
    state.chatMessages.push({
      id: "m-typed-f7",
      channelId: "ch-announcements",
      createdAt: "2026-10-23T11:00:00Z",
      threadOf: null,
      authorId: "p-marco",
      kind: "person",
      text,
      attachments: [],
      citations: [],
      reactions: [],
      asksReplyOf: [],
      linkedCodes: [],
      editedAt: null,
      deletedAt: null,
      deletedById: null,
    });
  }

  it("è un link per chi vede AUD; per Sara testo, come AUD-F999", async () => {
    put("Delivery dates are in AUD-F7, not in AUD-F999");
    const giulia = renderWithData(
      <div style={{ height: 800 }}>
        <ChannelView channelId="ch-announcements" />
      </div>,
      { personId: "p-giulia" },
    );
    const link = await screen.findByRole("link", { name: /AUD-F7 Contratto quadro Audin 2025/ });
    expect(link.getAttribute("data-citation")).toBe(`drive:${F7}`);
    giulia.unmount();

    renderWithData(
      <div style={{ height: 800 }}>
        <ChannelView channelId="ch-announcements" />
      </div>,
      { personId: "p-sara" },
    );
    const message = await screen.findByText(/Delivery dates are in/);
    const row = message.closest("[data-message]") as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain("AUD-F7, not in AUD-F999"));
    expect(row.querySelector("[data-citation]")).toBeNull();
  });
});
