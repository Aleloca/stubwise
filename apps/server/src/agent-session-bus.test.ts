import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { AGENT_SESSION_EVENTS_CHANNEL, AGENT_SESSION_PARTIAL_CHANNEL } from "@stubwise/shared";
import { createAgentSessionBus, type BusMessage } from "./agent-session-bus.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

const notify = (channel: string, payload: string) =>
  t.db.execute(sql`select pg_notify(${channel}, ${payload})`);
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("createAgentSessionBus", () => {
  it("smista eventi e parziali solo ai sottoscrittori di quella sessione", async () => {
    const bus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    const a: BusMessage[] = [];
    const b: BusMessage[] = [];
    const offA = bus.subscribe("A", (m) => a.push(m));
    const offB = bus.subscribe("B", (m) => b.push(m));
    await notify(AGENT_SESSION_EVENTS_CHANNEL, JSON.stringify({ sessionId: "A" }));
    await notify(
      AGENT_SESSION_PARTIAL_CHANNEL,
      JSON.stringify({ sessionId: "A", segmentId: "s", text: "ci" }),
    );
    await notify(
      AGENT_SESSION_PARTIAL_CHANNEL,
      JSON.stringify({ sessionId: "B", segmentId: "s", text: "bi" }),
    );
    await settle();
    expect(a).toEqual([
      { kind: "events", sessionId: "A" },
      { kind: "partial", sessionId: "A", segmentId: "s", text: "ci" },
    ]);
    expect(b).toEqual([{ kind: "partial", sessionId: "B", segmentId: "s", text: "bi" }]);
    offA();
    offB();
  });

  it("gli eventi portano solo l'id della sessione: il contenuto della NOTIFY non passa", async () => {
    const bus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    const got: BusMessage[] = [];
    const off = bus.subscribe("A", (m) => got.push(m));
    await notify(
      AGENT_SESSION_EVENTS_CHANNEL,
      JSON.stringify({ sessionId: "A", events: [{ text: "contenuto" }] }),
    );
    await settle();
    expect(got).toEqual([{ kind: "events", sessionId: "A" }]);
    off();
  });

  it("dopo l'unsubscribe non arriva più nulla", async () => {
    const bus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    const got: BusMessage[] = [];
    const off = bus.subscribe("A", (m) => got.push(m));
    off();
    await notify(AGENT_SESSION_EVENTS_CHANNEL, JSON.stringify({ sessionId: "A" }));
    await settle();
    expect(got).toEqual([]);
  });

  it("un payload malformato non lancia, non arriva a nessuno, e quello valido dopo arriva", async () => {
    const bus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    const got: BusMessage[] = [];
    const off = bus.subscribe("A", (m) => got.push(m));
    await notify(AGENT_SESSION_EVENTS_CHANNEL, "not json");
    await notify(AGENT_SESSION_EVENTS_CHANNEL, "null");
    await notify(AGENT_SESSION_EVENTS_CHANNEL, JSON.stringify({ sessionId: 42 }));
    await notify(AGENT_SESSION_PARTIAL_CHANNEL, JSON.stringify({ sessionId: "A" })); // senza text
    await settle();
    expect(got).toEqual([]);
    await notify(AGENT_SESSION_EVENTS_CHANNEL, JSON.stringify({ sessionId: "A" }));
    await settle();
    expect(got).toEqual([{ kind: "events", sessionId: "A" }]);
    off();
  });
});
