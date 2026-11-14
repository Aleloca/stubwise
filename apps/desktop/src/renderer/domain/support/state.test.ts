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
  triage: null,
  confirmedAt: null,
  followerIds: [],
  claudeDraft: null,
  ...over,
});

describe("supportState", () => {
  it("senza esito e senza giudizio: in triage", () => {
    expect(supportState(conv({ messages: [msg("customer", "1")] }))).toBe("triage");
    expect(supportState(conv())).toBe("triage");
  });

  it("senza esito, il giudizio dopo il silenzio: non conclusa, o risposta bastata (answered)", () => {
    const messages = [msg("customer", "1"), msg("triage", "2")];
    expect(
      supportState(
        conv({ messages, triage: { outcome: "not_concluded", at: "3", byUserId: null } }),
      ),
    ).toBe("not_concluded");
    expect(
      supportState(conv({ messages, triage: { outcome: "concluded", at: "3", byUserId: null } })),
    ).toBe("answered");
  });

  it("un messaggio del cliente dopo il giudizio lo rende vecchio: di nuovo in triage", () => {
    const messages = [msg("customer", "1"), msg("triage", "2"), msg("customer", "4")];
    expect(
      supportState(conv({ messages, triage: { outcome: "concluded", at: "3", byUserId: null } })),
    ).toBe("triage");
    expect(
      supportState(
        conv({ messages, triage: { outcome: "not_concluded", at: "3", byUserId: null } }),
      ),
    ).toBe("triage");
  });

  it("un giudizio dato insieme all'ultimo messaggio del cliente vale (at uguale)", () => {
    const messages = [msg("customer", "3")];
    expect(
      supportState(conv({ messages, triage: { outcome: "concluded", at: "3", byUserId: null } })),
    ).toBe("answered");
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

  it("un esito vince sul giudizio (non conclusa e answered sono solo senza esito)", () => {
    for (const outcome of ["concluded", "not_concluded"] as const) {
      expect(
        supportState(
          conv({
            requestId: "req-1",
            triage: { outcome, at: "3", byUserId: null },
            messages: [msg("triage", "1")],
          }),
        ),
      ).toBe("request_open");
    }
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
