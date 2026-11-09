import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "../../data/types";
import { dayLabel, flowDays, mergeFlow, mergeThread, threadRows } from "./flow";

function msg(id: string, at: string, extra: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id,
    channelId: "ch",
    threadOf: null,
    authorId: "p-marco",
    kind: "person",
    text: id,
    attachments: [],
    citations: [],
    reactions: [],
    asksReplyOf: [],
    linkedCodes: [],
    createdAt: at,
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    thread: null,
    answeredIds: [],
    mentionsViewer: false,
    linkedRefs: [],
    ...extra,
  };
}

const sys = (id: string, at: string, kind: "task_closed" | "pr_merged" = "task_closed") =>
  msg(id, at, { kind: "system", authorId: null, event: { kind, ref: { kind: "task", id } } });

describe("chat: il flusso del canale", () => {
  it("raggruppa per autore entro 5 minuti; un altro autore, un giorno o la riga «New» separano", () => {
    const days = flowDays(
      [
        msg("a", "2026-10-22T10:00:00Z"),
        msg("b", "2026-10-22T10:04:00Z"),
        msg("c", "2026-10-22T10:10:00Z"),
        msg("d", "2026-10-22T10:11:00Z", { authorId: "p-elena" }),
        msg("e", "2026-10-23T09:00:00Z", { authorId: "p-elena" }),
        msg("f", "2026-10-23T09:01:00Z", { authorId: "p-elena" }),
      ],
      { viewerId: "p-giulia", lastReadAt: "2026-10-23T09:00:30Z" },
    );
    expect(days.map((d) => d.day)).toEqual(["2026-10-22", "2026-10-23"]);
    const heads = days.flatMap((d) =>
      d.rows.map((r) => (r.kind === "message" ? `${r.message.id}${r.head ? "*" : ""}` : r.kind)),
    );
    expect(heads).toEqual(["a*", "b", "c*", "d*", "e*", "new", "f*"]);
  });

  it("la riga «New» salta i propri messaggi e non c'è senza lettura", () => {
    const list = [
      msg("mine", "2026-10-23T09:00:00Z", { authorId: "p-giulia" }),
      msg("theirs", "2026-10-23T09:02:00Z"),
    ];
    const rows = flowDays(list, { viewerId: "p-giulia", lastReadAt: "2026-10-23T08:00:00Z" })[0]!
      .rows;
    expect(rows.map((r) => r.kind)).toEqual(["message", "new", "message"]);
    expect(
      flowDays(list, { viewerId: "p-giulia", lastReadAt: null })[0]!.rows.some(
        (r) => r.kind === "new",
      ),
    ).toBe(false);
  });

  it("eventi dello stesso tipo entro 10 minuti diventano una scheda; «People only» li toglie", () => {
    const list = [
      sys("s1", "2026-10-23T09:00:00Z"),
      sys("s2", "2026-10-23T09:08:00Z"),
      sys("s3", "2026-10-23T09:30:00Z"),
      sys("s4", "2026-10-23T09:31:00Z", "pr_merged"),
      msg("m", "2026-10-23T09:40:00Z"),
    ];
    const rows = flowDays(list, { viewerId: "p-giulia", lastReadAt: null })[0]!.rows;
    expect(
      rows.map((r) => (r.kind === "system" ? r.messages.map((m) => m.id).join("+") : r.kind)),
    ).toEqual(["s1+s2", "s3", "s4", "message"]);
    const people = flowDays(list, { viewerId: "p-giulia", lastReadAt: null, peopleOnly: true });
    expect(people[0]!.rows.map((r) => r.kind)).toEqual(["message"]);
  });

  it("unisce lo stream alla pagina: sostituisce, aggiunge in ordine, ignora le risposte nel thread", () => {
    const page = [msg("a", "2026-10-23T09:00:00Z"), msg("b", "2026-10-23T09:05:00Z")];
    const merged = mergeFlow(
      page,
      [
        msg("b", "2026-10-23T09:05:00Z", { text: "edited" }),
        msg("c", "2026-10-23T09:10:00Z"),
        msg("r", "2026-10-23T09:11:00Z", { threadOf: "a" }),
        msg("old", "2026-10-20T09:00:00Z"),
      ],
      true,
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[1]!.text).toBe("edited");
  });

  it("le etichette dei giorni", () => {
    const words = { today: "Today", yesterday: "Yesterday" };
    expect(dayLabel("2026-10-23", "2026-10-23", "en", words)).toBe("Today");
    expect(dayLabel("2026-10-22", "2026-10-23", "en", words)).toBe("Yesterday");
    expect(dayLabel("2026-10-15", "2026-10-23", "en", words)).toBe("Thursday, Oct 15");
    expect(dayLabel("2025-10-02", "2026-10-23", "en", words)).toBe("Oct 2, 2025");
  });
});

describe("threadRows / mergeThread", () => {
  const r = (id: string, at: string, extra: Partial<ChatMessageView> = {}) =>
    msg(id, at, { threadOf: "root", ...extra });

  it("gruppi per autore entro 5 minuti; una risposta di Claude apre sempre un gruppo", () => {
    const rows = threadRows(
      [
        r("a", "2026-10-23T10:00:00Z"),
        r("b", "2026-10-23T10:02:00Z"),
        r("c", "2026-10-23T10:03:00Z", { kind: "claude", authorId: "p-claude" }),
        r("d", "2026-10-23T10:03:30Z", { kind: "claude", authorId: "p-claude" }),
      ],
      { viewerId: "p-giulia", lastReadAt: null },
    );
    expect(rows.map((x) => (x.kind === "message" ? x.head : null))).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it("«New replies» prima della prima risposta non mia dopo la lettura", () => {
    const rows = threadRows(
      [
        r("a", "2026-10-23T10:00:00Z"),
        r("mine", "2026-10-23T10:10:00Z", { authorId: "p-giulia" }),
        r("b", "2026-10-23T10:11:00Z"),
      ],
      { viewerId: "p-giulia", lastReadAt: "2026-10-23T10:05:00Z" },
    );
    expect(rows.map((x) => (x.kind === "message" ? x.message.id : x.kind))).toEqual([
      "a",
      "mine",
      "new",
      "b",
    ]);
  });

  it("lo stream sostituisce radice e risposte per id e aggiunge le nuove in ordine; gli altri thread no", () => {
    const merged = mergeThread(
      msg("root", "2026-10-23T09:00:00Z"),
      [r("a", "2026-10-23T10:00:00Z")],
      [
        msg("root", "2026-10-23T09:00:00Z", { text: "edited" }),
        r("b", "2026-10-23T10:05:00Z"),
        r("a", "2026-10-23T10:00:00Z", { text: "a2" }),
        msg("x", "2026-10-23T10:01:00Z", { threadOf: "other" }),
      ],
    );
    expect(merged.root.text).toBe("edited");
    expect(merged.replies.map((m) => `${m.id}:${m.text}`)).toEqual(["a:a2", "b:b"]);
  });
});
