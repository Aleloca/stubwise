import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ConversationEvent, FieldRef } from "../../data/types";
import { ViewerProvider } from "../../data/viewer";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { fillableFor, useFillableField } from "./fillable";
import { __forgetPageEventsForTest, undoDraft, usePageEventRunner } from "./pageActions";

// Il registro dei campi riempibili e il runner delle bozze (area 10b, Task
// 10; shape `claude-drafts.md`): una bozza va SOLO nel campo dichiarato della
// pagina aperta, una volta; con del testo chiede prima; vecchia o senza
// campo aspetta; «Undo» rimette il testo di prima solo se c'è ancora quello
// di Claude, e una modifica della persona chiude la riga `changed_after`.
// Solo il riquadro di chi ha aperto la conversazione mette le bozze.

const LAURA = "p-laura";
const FIELD: FieldRef = { kind: "taskDescription", taskId: "t-acq-7" };
const OTHER: FieldRef = { kind: "taskDescription", taskId: "t-acq-3" };
type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
const draftEvents = (): DraftEvent[] =>
  [...state.conversationEvents.values()].flat().filter((e): e is DraftEvent => e.type === "draft");

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});
afterEach(() => {
  vi.restoreAllMocks();
  setSessionPersonId("p-giulia");
});

/** Un campo di prova: il testo vivo in un ref, `put` contato. */
const puts: string[] = [];
let setFromOutside: (text: string) => void = () => {};
function ToyField({ field, initial = "" }: { field: FieldRef | null; initial?: string }) {
  const [text, setTextState] = useState(initial);
  const live = useRef(initial);
  const setText = (next: string) => {
    live.current = next;
    setTextState(next);
  };
  setFromOutside = setText;
  useFillableField(
    field && {
      ref: field,
      labelKey: "claude.drafts.placed.taskDescription",
      get: () => live.current,
      put: (draft, how) => {
        puts.push(draft);
        setText(how === "below" && live.current ? `${live.current}\n\n${draft}` : draft);
      },
      restore: setText,
    },
  );
  return <p data-toy>{text}</p>;
}

function Harness({
  conversationId,
  field,
  initial,
}: {
  conversationId: string | null;
  field: FieldRef | null;
  initial?: string;
}) {
  usePageEventRunner(conversationId);
  return <ToyField field={field} initial={initial} />;
}

function mount(personId: string, props: Parameters<typeof Harness>[0]) {
  const root = createRootRoute({ component: () => <Harness {...props} /> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
}

const toy = () => document.querySelector("[data-toy]")?.textContent ?? null;

async function conversationWithDraft(personId: string, field: FieldRef, after: "none" | "user") {
  setSessionPersonId(personId);
  const cid = (await api.createConversation()).id;
  await api.runScript(cid, [
    {
      step: "event",
      event: { type: "draft", field, text: "Claude's text.", status: "pending" },
    },
    ...(after === "user"
      ? [
          {
            step: "event" as const,
            event: {
              type: "user" as const,
              authorId: personId,
              text: "thanks",
              attachments: [],
              delivery: "delivered" as const,
            },
          },
        ]
      : []),
  ]);
  return cid;
}

describe("il registro", () => {
  it("un campo esiste finché la pagina è montata; `null` non si dichiara; vale l'ultimo", async () => {
    expect(fillableFor(FIELD)).toBeNull();
    const a = mount(LAURA, { conversationId: null, field: FIELD });
    await waitFor(() => expect(toy()).not.toBeNull());
    const first = fillableFor(FIELD);
    expect(first).not.toBeNull();
    expect(fillableFor(OTHER)).toBeNull();
    const b = mount(LAURA, { conversationId: null, field: FIELD, initial: "second" });
    await waitFor(() => expect(fillableFor(FIELD)?.get()).toBe("second"));
    b.unmount();
    expect(fillableFor(FIELD)?.get()).toBe("");
    a.unmount();
    expect(fillableFor(FIELD)).toBeNull();
    mount(LAURA, { conversationId: null, field: null });
    expect(fillableFor(FIELD)).toBeNull();
  });
});

describe("il runner delle bozze", () => {
  it("campo vuoto: la bozza entra una volta sola, anche dopo altri render, e l'evento è `placed`", async () => {
    puts.length = 0;
    const cid = await conversationWithDraft(LAURA, FIELD, "none");
    mount(LAURA, { conversationId: cid, field: FIELD });
    await waitFor(() => expect(draftEvents()[0]!.status).toBe("placed"));
    expect(toy()).toBe("Claude's text.");
    act(() => setFromOutside("Claude's text."));
    expect(puts).toEqual(["Claude's text."]);
  });

  it("mai nel campo di un'altra pagina: senza il suo campo la bozza aspetta (`waiting`)", async () => {
    puts.length = 0;
    const cid = await conversationWithDraft(LAURA, FIELD, "none");
    mount(LAURA, { conversationId: cid, field: OTHER, initial: "mine" });
    await waitFor(() => expect(draftEvents()[0]!.status).toBe("waiting"));
    expect(toy()).toBe("mine");
    expect(puts).toEqual([]);
  });

  it("una bozza vecchia (seguita da un altro messaggio) non entra da sola: `waiting`", async () => {
    puts.length = 0;
    const cid = await conversationWithDraft(LAURA, FIELD, "user");
    mount(LAURA, { conversationId: cid, field: FIELD });
    await waitFor(() => expect(draftEvents()[0]!.status).toBe("waiting"));
    expect(puts).toEqual([]);
    expect(toy()).toBe("");
  });

  it("il «vedi come»: il riquadro di un altro lettore non mette la bozza", async () => {
    puts.length = 0;
    const cid = await conversationWithDraft(LAURA, FIELD, "none");
    await api.setVisibility(cid, "public", { confirmedProjectIds: ["prj-acq"] });
    const roberta = mount("p-roberta", { conversationId: cid, field: FIELD });
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toEqual([]);
    expect(draftEvents()[0]!.status).toBe("pending");
    roberta.unmount();
  });

  it("una modifica della persona chiude la riga `changed_after`; «Undo» allora non tocca il campo", async () => {
    const cid = await conversationWithDraft(LAURA, FIELD, "none");
    mount(LAURA, { conversationId: cid, field: FIELD });
    await waitFor(() => expect(draftEvents()[0]!.status).toBe("placed"));
    act(() => setFromOutside("Claude's text. Mine."));
    await waitFor(() => expect(draftEvents()[0]!.status).toBe("changed_after"));
    expect(undoDraft(draftEvents()[0]!.id)).toBe("not_undoable");
    expect(toy()).toBe("Claude's text. Mine.");
  });

  it("«Undo» rimette il testo di prima una volta; dopo un ricaricamento non c'è più niente da annullare", async () => {
    const cid = await conversationWithDraft(LAURA, FIELD, "none");
    mount(LAURA, { conversationId: cid, field: FIELD });
    await waitFor(() => expect(draftEvents()[0]!.status).toBe("placed"));
    const id = draftEvents()[0]!.id;
    act(() => void expect(undoDraft(id)).toBe("undone"));
    expect(toy()).toBe("");
    expect(undoDraft(id)).toBe("not_undoable");
    act(() => __forgetPageEventsForTest());
    expect(undoDraft(id)).toBe("not_undoable");
  });
});
