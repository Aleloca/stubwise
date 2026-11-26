import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { citationEventsOf } from "./claude";
import { resolveCitations } from "./claudeChat";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverProject, TICKET_ID } from "./fakeServer";

// Lotto 9, voce 1 (72, 2fe8b9989): le citazioni di un turno di Claude stanno
// in `turn_end.data.citations` (`{ kind, id }`), già filtrate per chi guarda;
// si leggono con `POST /api/claude/citations/resolve`, che dà solo le visibili.

beforeEach(() => setAppClientForTests(null));
afterEach(() => setAppClientForTests(null));

describe("le citazioni dei messaggi di Claude nella build app", () => {
  it("dal `turn_end` l'evento `citation` del prototipo, al suo istante", () => {
    const events = [
      {
        id: "1",
        type: "assistant_text",
        segmentId: "s1",
        at: "2026-11-24T10:00:00.000Z",
        data: { text: "AUD-12" },
      },
      {
        id: "2",
        type: "turn_end",
        segmentId: "s1",
        at: "2026-11-24T10:00:05.000Z",
        data: { citations: [{ kind: "task", id: TICKET_ID }] },
      },
      { id: "3", type: "turn_end", segmentId: "s2", at: "2026-11-24T10:01:00.000Z", data: {} },
    ];
    expect(citationEventsOf(events as never)).toEqual([
      {
        id: "citation:2",
        at: "2026-11-24T10:00:05.000Z",
        type: "citation",
        refs: [{ kind: "task", id: TICKET_ID }],
      },
    ]);
  });

  it("la risoluzione chiede al server e dà le viste delle visibili; un'invisibile non torna", async () => {
    const HIDDEN = "ffffffff-0000-4000-8000-000000000009";
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "POST /api/claude/citations/resolve": {
        body: {
          items: [
            {
              kind: "task",
              id: TICKET_ID,
              label: "AUD-12",
              projectId: PROJECT_ID,
              code: "AUD-12",
              doc: null,
              drive: null,
              product: null,
            },
          ],
        },
      },
    });
    const views = await resolveCitations([
      { kind: "task", id: TICKET_ID },
      { kind: "task", id: HIDDEN },
    ]);
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({
      refs: [
        { kind: "task", id: TICKET_ID },
        { kind: "task", id: HIDDEN },
      ],
    });
    expect(views[0]).toMatchObject({ kind: "task", id: TICKET_ID, visible: true, code: "AUD-12" });
    expect(views[1]).toMatchObject({ visible: false, code: null });
  });
});
