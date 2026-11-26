import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { settleSaved } from "./calendarCache";
import type { CalendarEventView } from "./types";

const KEY = [
  "as",
  "p-me",
  "calendar",
  "events",
  { from: "2026-11-13T00:00:00Z", to: "2026-11-14T00:00:00Z" },
];
const view = (id: string, over: Partial<CalendarEventView> = {}) =>
  ({
    id,
    title: "Kick-off",
    startsAt: "2026-11-13T09:00:00Z",
    endsAt: "2026-11-13T10:00:00Z",
    allDay: false,
    isOrganizer: true,
    attendees: [],
    ...over,
  }) as unknown as CalendarEventView;

// Review F4, 4: la riunione nuova entra negli elenchi con l'id della bozza;
// salvata, il server le dà il SUO id. Il blocco della bozza non resta lì
// accanto (due «Kick-off» fino alla rilettura).
describe("settleSaved: l'esito prende il posto di ciò che si è visto salvare", () => {
  it("salvata con un id nuovo: il blocco della bozza se ne va, resta quello del server", () => {
    const client = new QueryClient();
    client.setQueryData(KEY, [view("draft", { save: { state: "saving" } })]);
    settleSaved(client, "p-me", ["draft"], view("ev-server", { save: { state: "saved" } }));
    expect(client.getQueryData<CalendarEventView[]>(KEY)!.map((e) => e.id)).toEqual(["ev-server"]);
  });

  it("non salvata (stesso id): resta, con la sua parola di stato", () => {
    const client = new QueryClient();
    client.setQueryData(KEY, [view("draft", { save: { state: "saving" } })]);
    settleSaved(
      client,
      "p-me",
      ["draft"],
      view("draft", { save: { state: "failed", error: "unreachable" } }),
    );
    expect(client.getQueryData<CalendarEventView[]>(KEY)).toEqual([
      expect.objectContaining({ id: "draft", save: { state: "failed", error: "unreachable" } }),
    ]);
  });
});
