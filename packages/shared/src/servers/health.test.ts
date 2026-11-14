import { describe, expect, it } from "vitest";
import { RECOVERED_SHOWN_HOURS, serverHealth, type HealthEpisode } from "./health.js";

// Area 8, F4a: la salute di un server in una parola (era
// `domain/servers/health.ts` del prototipo), con UNA funzione per server e
// renderer.

const NOW = "2026-11-14T12:00:00.000Z";
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const ep = (over: Partial<HealthEpisode>): HealthEpisode => ({
  severity: "trouble",
  reasons: [{ kind: "cpu", valuePct: 97, thresholdPct: 95 }],
  startedAt: ago(2),
  recoveredAt: null,
  ...over,
});

describe("serverHealth", () => {
  it("mai collegato prima di tutto, anche con episodi", () => {
    expect(serverHealth({ status: "never_connected", lastSeenAt: null }, [ep({})], NOW)).toEqual({ health: "never_connected", since: null, reasons: [] });
  });

  it("un episodio aperto `down` → down, dal suo inizio, coi motivi di tutti gli aperti", () => {
    const h = serverHealth({ status: "online", lastSeenAt: ago(0) }, [ep({ startedAt: ago(3) }), ep({ severity: "down", startedAt: ago(1), reasons: [{ kind: "check", checkId: "c1" }] })], NOW);
    expect(h.health).toBe("down");
    expect(h.since).toBe(ago(1));
    expect(h.reasons.map((r) => r.kind)).toEqual(["cpu", "check"]);
  });

  it("offline senza episodi → down dall'ultimo segnale, «agente in silenzio»", () => {
    expect(serverHealth({ status: "offline", lastSeenAt: ago(5) }, [], NOW)).toEqual({
      health: "down",
      since: ago(5),
      reasons: [{ kind: "agent_silent", since: ago(5) }],
    });
  });

  it("offline con un episodio aperto → down dal suo inizio", () => {
    expect(serverHealth({ status: "offline", lastSeenAt: ago(1) }, [ep({ startedAt: ago(4) })], NOW)).toMatchObject({ health: "down", since: ago(4) });
  });

  it("un episodio aperto `trouble` → trouble", () => {
    expect(serverHealth({ status: "online", lastSeenAt: ago(0) }, [ep({ startedAt: ago(2) })], NOW)).toMatchObject({ health: "trouble", since: ago(2) });
  });

  it(`rientrato da meno di ${RECOVERED_SHOWN_HOURS} ore → recovered (l'ora del rientro); più vecchio → healthy`, () => {
    const s = { status: "online" as const, lastSeenAt: ago(0) };
    expect(serverHealth(s, [ep({ startedAt: ago(5), recoveredAt: ago(3) })], NOW)).toMatchObject({ health: "recovered", since: ago(3) });
    expect(serverHealth(s, [ep({ startedAt: ago(30), recoveredAt: ago(25) })], NOW)).toEqual({ health: "healthy", since: null, reasons: [] });
    expect(serverHealth(s, [], NOW)).toEqual({ health: "healthy", since: null, reasons: [] });
  });
});
