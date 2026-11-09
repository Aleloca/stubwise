import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { CitationRef, CitationView } from "../../../data/types";
import { renderWithData } from "../../../test/renderWithData";
import { DocsChatPanel, type DocsChatState } from "../../docs/DocsChat";
import { AssistantMessage } from "./AssistantMessage";
import { CitationProvider, indexCitations } from "./citations";

// R-H5 in ogni superficie, non solo nella Chat: un file del Drive citato e
// poi non più visibile (progetto invisibile, nascosto, tolto) si legge come
// il codice registrato con la citazione, tenue e identico per ogni causa —
// mai «An item you can't open», mai sparito. La conversazione con Claude
// (testo e «Used:»), la chat dei Docs («Used:» e testo) e i gettoni della
// ricerca nella Chat.

const F7 = "drv-aud-7";
const CITED: CitationRef = { kind: "drive", id: F7, code: "AUD-F7" };
const TEXT = "**AUD-F7 Contratto quadro Audin 2025**, in the AUD Drive, says:";

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

/** La vista come la legge `personId` (invisibile per Sara: niente codice). */
async function viewAs(personId: string): Promise<CitationView[]> {
  setSessionPersonId(personId);
  return api.resolveCitations([CITED]);
}

/** Le tre cause: progetto invisibile (Sara), file nascosto, file tolto. */
async function causes(): Promise<CitationView[][]> {
  const invisible = await viewAs("p-sara");
  const file = state.driveFiles.find((f) => f.id === F7)!;
  file.hidden = true;
  const hidden = await viewAs("p-giulia");
  file.hidden = false;
  state.driveFiles.splice(state.driveFiles.indexOf(file), 1);
  const removed = await viewAs("p-giulia");
  return [invisible, hidden, removed];
}

describe("R-H5 nella conversazione con Claude", () => {
  it("nel testo e in «Used:» il codice registrato, tenue; identico per ogni causa", async () => {
    const markup: string[] = [];
    for (const views of await causes()) {
      const { container, unmount } = renderWithData(
        <CitationProvider value={indexCitations(views)}>
          <AssistantMessage
            item={{
              kind: "assistant",
              key: "a1",
              event: { id: "a1", at: "2026-10-25T12:00:00Z", type: "assistant", text: TEXT, done: true },
              refs: [CITED],
            }}
            streaming={false}
          />
        </CitationProvider>,
      );
      const hidden = [...container.querySelectorAll('[data-citation="hidden"]')];
      // Una nel testo, una in «Used:».
      expect(hidden.map((h) => h.textContent)).toEqual(["AUD-F7", "AUD-F7"]);
      expect(container).not.toHaveTextContent("An item you can't open");
      markup.push(container.innerHTML);
      unmount();
    }
    expect(new Set(markup).size).toBe(1);
  });
});

describe("R-H5 nella chat dei Docs", () => {
  it("«Used:» e testo: il codice registrato del file, non «An item you can't open»", async () => {
    const chat: DocsChatState = {
      turns: [
        {
          id: "q1",
          question: "What does the client contract say about delivery times?",
          status: "done",
          answer: {
            answeredAt: "2026-10-25T12:00:00Z",
            text: TEXT,
            refs: [CITED],
            sources: [],
          },
        },
      ],
      send: () => {},
      retry: () => {},
      reset: () => {},
      busy: false,
      unavailable: false,
    };
    renderWithData(
      <DocsChatPanel chat={chat} available suggestions={[]} scope="AUD" placeholder="Ask" />,
      { personId: "p-sara" },
    );
    const used = await screen.findByText("Used:");
    const line = used.parentElement!;
    await waitFor(() =>
      expect(within(line).getByText("AUD-F7")).toHaveAttribute("data-citation", "hidden"),
    );
    expect(line).not.toHaveTextContent("An item you can't open");
    const inText = [...document.querySelectorAll('[data-citation="hidden"]')].filter(
      (el) => !line.contains(el),
    );
    expect(inText.map((el) => el.textContent)).toEqual(["AUD-F7"]);
  });
});
