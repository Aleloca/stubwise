import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import type { FieldRef } from "../../../data/types";
import { ViewerProvider } from "../../../data/viewer";
import { setLanguage } from "../../../i18n";
import { DraftRow } from "./DraftRow";
import type { Ev } from "./flow";

// La riga di una bozza (area 10b, Task 10; shape `claude-drafts.md` §3.3):
// «dove» composto a lettura nella lingua di chi guarda, gli stati, e la riga
// chiusa per chi non vede l'oggetto del campo (R-G5: né codice, né testo,
// né stato). Lo stato del campo (memoria del riquadro) qui non c'è: dopo un
// ricaricamento una bozza messa «non si annulla più».

const DAVIDE = "p-davide";
const SUPPORT: FieldRef = { kind: "supportReply", conversationId: "sup-acq-2" };

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});
afterEach(() => act(() => setLanguage("en")));

function draft(
  field: FieldRef | null,
  status: Ev<"draft">["status"],
  text = "Hi Lucia, thanks for writing.",
): Ev<"draft"> {
  return { id: "ev-draft", at: "2026-10-23T09:00:00.000Z", type: "draft", field, text, status };
}

async function show(event: Ev<"draft">, viewerId = DAVIDE, ownerId = DAVIDE) {
  const rootRoute = createRootRoute({
    component: () => (
      <DraftRow conversationId="conv-x" event={event} viewerId={viewerId} ownerId={ownerId} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider initialPersonId={viewerId}>
        <RouterProvider router={router} />
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return screen.findByText(
    (_, el) => !!el?.matches("[data-draft-row]") && !el.hasAttribute("aria-busy"),
  );
}

describe("La riga `draft`", () => {
  it("chi non vede l'oggetto del campo: «Claude put a draft in a field», senza codice né stato", async () => {
    const row = await show(draft(null, "placed", ""), "p-giulia", DAVIDE);
    expect(row).toHaveTextContent("Claude put a draft in a field");
    expect(row.textContent!.toLowerCase()).not.toMatch(/acq|lucia/);
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("`waiting`: «… is ready · Put it in the field» e il testo, chiuso a 4 righe con «Show all»", async () => {
    const long = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}.`).join("\n");
    const row = await show(draft(SUPPORT, "waiting", long));
    expect(row).toHaveTextContent("The draft for the reply to ACQ-S2 is ready");
    expect(within(row).getByRole("button", { name: "Put it in the field" })).toBeInTheDocument();
    expect(within(row).getByLabelText("The draft's text")).toHaveClass("line-clamp-4");
    expect(within(row).getByRole("button", { name: "Show all" })).toBeInTheDocument();
  });

  it("`placed` dopo un ricaricamento: «Can't be undone anymore», nessun «Undo»", async () => {
    const row = await show(draft(SUPPORT, "placed"));
    expect(row).toHaveTextContent("Put a draft in the reply to ACQ-S2");
    expect(row).toHaveTextContent("Can't be undone anymore");
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("`undone` e `changed_after` dicono com'è andata", async () => {
    const undone = await show(draft(SUPPORT, "undone"));
    expect(undone).toHaveTextContent("Undone · the reply is as it was");
    document.body.replaceChildren();
    const changed = await show(draft(SUPPORT, "changed_after"));
    expect(changed).toHaveTextContent("The field changed afterwards · can't undo from here");
  });

  it("un altro lettore che vede il campo: la frase, senza stato né bottoni", async () => {
    const row = await show(draft(SUPPORT, "placed"), "p-matteo", DAVIDE);
    expect(row).toHaveTextContent("Put a draft in the reply to ACQ-S2");
    expect(row).not.toHaveTextContent("Can't be undone anymore");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("in italiano: «ad» davanti a una vocale, la nuova email, le note con la PR", async () => {
    act(() => setLanguage("it"));
    const reply = await show(draft(SUPPORT, "placed"));
    expect(reply).toHaveTextContent("Messa una bozza nella risposta ad ACQ-S2");
    document.body.replaceChildren();
    const mail = await show(
      draft({ kind: "mailBody", threadId: null }, "placed"),
      "p-giulia",
      "p-giulia",
    );
    expect(mail).toHaveTextContent("Messa una bozza nella nuova email");
    document.body.replaceChildren();
    const notes = await show(
      draft({ kind: "releaseNotes", prId: "opr-acq-77" }, "waiting"),
      "p-laura",
      "p-laura",
    );
    expect(notes).toHaveTextContent(
      "La bozza per le note di rilascio di ACQ · pull request #77 è pronta",
    );
  });
});
