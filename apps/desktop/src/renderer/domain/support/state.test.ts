import { describe, expect, it } from "vitest";
import type { SupportConversation, SupportMessage } from "../../data/model";
import { supportState, waitingSince } from "./state";

const msg = (from: SupportMessage["from"], at: string): SupportMessage => ({
  id: `m-${at}`,
  from,
  authorId: from === "team" ? "p-laura" : null,
  body: "x",
  at,
});

const conv = (over: Partial<SupportConversation> = {}): SupportConversation => ({
  id: "sup-x",
  code: "ACQ-S9",
  projectId: "prj-acq",
  channel: "widget",
  widgetId: null,
  customer: { name: "Mario", email: null },
  messages: [],
  rewrittenWish: null,
  requestId: null,
  leftAt: null,
  confirmedAt: null,
  followerIds: [],
  claudeDraft: null,
  ...over,
});

describe("supportState", () => {
  it("senza richiesta: in triage, o non conclusa se il cliente se n'è andato", () => {
    expect(supportState(conv({ messages: [msg("customer", "1")] }))).toBe("triage");
    expect(supportState(conv())).toBe("triage");
    expect(supportState(conv({ leftAt: "2", messages: [msg("customer", "1")] }))).toBe(
      "not_concluded",
    );
  });

  it("con richiesta: l'ultimo messaggio decide (cliente → aspetta noi, team → risposta inviata)", () => {
    const base = { requestId: "req-1" };
    expect(supportState(conv({ ...base, messages: [msg("customer", "1")] }))).toBe("waiting_us");
    expect(
      supportState(conv({ ...base, messages: [msg("customer", "1"), msg("team", "2")] })),
    ).toBe("reply_sent");
    expect(
      supportState(conv({ ...base, messages: [msg("customer", "1"), msg("triage", "2")] })),
    ).toBe("request_open");
    expect(supportState(conv(base))).toBe("request_open");
  });

  it("una richiesta aperta vince sull'abbandono (la «non conclusa» è solo senza richiesta)", () => {
    expect(
      supportState(conv({ requestId: "req-1", leftAt: "3", messages: [msg("triage", "1")] })),
    ).toBe("request_open");
  });
});

describe("waitingSince", () => {
  it("dal primo dei messaggi del cliente rimasti senza risposta", () => {
    const c = conv({
      requestId: "req-1",
      messages: [
        msg("customer", "1"),
        msg("team", "2"),
        msg("customer", "3"),
        msg("customer", "4"),
      ],
    });
    expect(waitingSince(c)).toBe("3");
  });

  it("null se non aspetta noi", () => {
    expect(waitingSince(conv({ messages: [msg("customer", "1")] }))).toBeNull();
    expect(
      waitingSince(
        conv({ requestId: "req-1", messages: [msg("customer", "1"), msg("team", "2")] }),
      ),
    ).toBeNull();
  });
});
