import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import type { ChatMessageView, CitationView } from "../../data/types";
import { CitationProvider, indexCitations, refKey } from "../claude/conversation/citations";
import { SystemCard } from "./SystemCard";

// La scheda di un evento (revisione Impeccable dell'area 4, #1 e #5): finché
// l'oggetto non è letto una riga scheletro, mai il tipo ripetuto; invisibile
// il solo codice tenue, che non si apre (R-E9).

let event: ChatMessageView;

beforeEach(async () => {
  api.setLatency(0);
  api.resetApi();
  setSessionPersonId("p-laura");
  const page = await api.chat.listMessages("ch-aud-releases");
  event = page!.messages.find((m) => m.kind === "system" && m.event?.kind === "pr_opened")!;
});

const card = () => document.querySelector<HTMLElement>("[data-system-card]")!;

describe("SystemCard", () => {
  it("non ancora letto: una riga scheletro, il tipo una volta sola e nessun «Open»", () => {
    render(<SystemCard eventKind="pr_opened" messages={[event]} />);
    expect(card().textContent!.match(/Pull request opened/g)).toHaveLength(1);
    expect(card().querySelector("[data-event-pending]")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(card()).queryByRole("link")).toBeNull();
  });

  it("invisibile: il solo codice tenue, che non si apre", () => {
    const hidden: CitationView = {
      kind: event.event!.ref.kind,
      id: event.event!.ref.id,
      visible: false,
      code: "AUD-12",
      name: null,
      projectCode: null,
      status: null,
      personId: null,
      route: null,
    };
    const index = indexCitations([hidden]);
    expect(index.byRef.has(refKey(event.event!.ref))).toBe(true);
    render(
      <CitationProvider value={index}>
        <SystemCard eventKind="pr_opened" messages={[event]} />
      </CitationProvider>,
    );
    expect(within(card()).getByText("AUD-12").getAttribute("data-citation")).toBe("hidden");
    expect(within(card()).queryByRole("link")).toBeNull();
    expect(screen.queryByText("Drop the legacy SMS module")).toBeNull();
  });

  it("l'intestazione pesa meno di un messaggio: tipo e ora tenui, senza grassetto", () => {
    render(<SystemCard eventKind="pr_opened" messages={[event]} />);
    const kind = within(card()).getByText("Pull request opened");
    expect(kind.className).not.toMatch(/font-semibold/);
    expect(kind.closest("p")!.className).toMatch(/text-ink-muted/);
  });
});
