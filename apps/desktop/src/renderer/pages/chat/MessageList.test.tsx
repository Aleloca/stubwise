import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TODAY } from "../../data/dates";
import type { ChatMessageView } from "../../data/types";
import type { FlowDay } from "./flow";
import { MessageList } from "./MessageList";

// La riga «New» che apre un giorno non si impila sotto il filetto del giorno
// (revisione Impeccable dell'area 4, #6): un filetto solo, «Today · New».

const message = (id: string) => ({ id }) as ChatMessageView;

function list(days: FlowDay[]) {
  render(
    <MessageList
      days={days}
      hasMore={false}
      loadingEarlier={false}
      onLoadEarlier={() => undefined}
      renderRow={(row, key) =>
        row.kind === "message" ? (
          <p key={key} data-message={row.message.id}>
            {row.message.id}
          </p>
        ) : null
      }
      onAtBottom={() => undefined}
      label="Messages"
      announce=""
    />,
  );
}

describe("MessageList: giorno e «New»", () => {
  it("«New» come prima riga del giorno: un filetto solo, «Today · New», d'inchiostro", () => {
    list([
      {
        day: TODAY,
        rows: [{ kind: "new" }, { kind: "message", message: message("m1"), head: true }],
      },
    ]);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Today · New");
    expect(headings[0]!.hasAttribute("data-new-line")).toBe(true);
    expect(document.querySelectorAll("[data-new-line]")).toHaveLength(1);
    expect(headings[0]!.className).toMatch(/text-ink(\s|$)/);
  });

  it("«New» a metà giorno resta la sua riga sotto i messaggi già letti", () => {
    list([
      {
        day: TODAY,
        rows: [
          { kind: "message", message: message("m0"), head: true },
          { kind: "new" },
          { kind: "message", message: message("m1"), head: true },
        ],
      },
    ]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Today");
    const line = document.querySelector("[data-new-line]")!;
    expect(line.textContent).toBe("New");
    expect(line.nextElementSibling?.getAttribute("data-message")).toBe("m1");
  });
});
