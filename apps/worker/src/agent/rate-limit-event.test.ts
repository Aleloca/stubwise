import { describe, expect, it } from "vitest";
import { parseRateLimitEvent } from "./rate-limit-event.js";

function ev(
  name: string,
  utilization: number,
  resetsAt: number,
  overageStatus: string,
  overageDisabledReason?: string,
) {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt,
      rateLimitType: "seven_day",
      overageStatus,
      ...(overageDisabledReason ? { overageDisabledReason } : {}),
      isUsingOverage: false,
      unifiedWindows: { seven_day: { utilization, resetsAt } },
    },
    uuid: name,
    session_id: "s",
  };
}

const leo = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1795428000,
    rateLimitType: "seven_day",
    overageStatus: "allowed",
    overageResetsAt: 1796083200,
    isUsingOverage: false,
    unifiedWindows: { seven_day: { utilization: 0.28, resetsAt: 1795428000 } },
  },
  uuid: "u",
  session_id: "s",
};
const max = ev("max", 0.18, 1795611600, "rejected", "org_level_disabled");
const anthropic = ev("anth", 0.38, 1795420800, "rejected", "out_of_credits");

describe("parseRateLimitEvent", () => {
  it("legge la riga vera di Account Leo", () => {
    expect(parseRateLimitEvent(leo)).toEqual({
      status: "allowed",
      rateLimitType: "seven_day",
      windows: {
        seven_day: { usedPercent: 28, resetsAt: new Date(1795428000 * 1000) },
      },
    });
  });

  it("legge le altre due righe vere", () => {
    expect(parseRateLimitEvent(max)?.windows.seven_day).toEqual({
      usedPercent: 18,
      resetsAt: new Date(1795611600 * 1000),
    });
    expect(parseRateLimitEvent(anthropic)?.windows.seven_day).toEqual({
      usedPercent: 38,
      resetsAt: new Date(1795420800 * 1000),
    });
  });

  it("forma vecchia senza unifiedWindows", () => {
    const r = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.5,
        resetsAt: 1795400000,
      },
    });
    expect(r?.windows).toEqual({
      five_hour: { usedPercent: 50, resetsAt: new Date(1795400000 * 1000) },
    });
  });

  it("utilization sopra 1 satura a 100", () => {
    const r = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        unifiedWindows: { seven_day: { utilization: 1.04, resetsAt: 1 } },
      },
    });
    expect(r?.windows.seven_day?.usedPercent).toBe(100);
    expect(r?.status).toBe("rejected");
  });

  it("scarta le finestre con utilization negativa o non numerica", () => {
    const r = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          a: { utilization: -1, resetsAt: 1 },
          b: { utilization: "x", resetsAt: 1 },
          c: { utilization: 0.1, resetsAt: 1 },
        },
      },
    });
    expect(Object.keys(r!.windows)).toEqual(["c"]);
    expect(
      parseRateLimitEvent({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: { a: { utilization: -1 }, b: { utilization: "x" } },
        },
      }),
    ).toBeNull();
  });

  it("resetsAt assente o non numerico diventa null", () => {
    const r = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          a: { utilization: 0.1 },
          b: { utilization: 0.2, resetsAt: "domani" },
        },
      },
    });
    expect(r?.windows.a?.resetsAt).toBeNull();
    expect(r?.windows.b?.resetsAt).toBeNull();
  });

  it("tipo diverso o rate_limit_info mancante: null", () => {
    expect(parseRateLimitEvent({ ...leo, type: "assistant" })).toBeNull();
    expect(parseRateLimitEvent({ type: "rate_limit_event" })).toBeNull();
  });

  it("più finestre: le riporta tutte", () => {
    const r = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        unifiedWindows: {
          seven_day: { utilization: 0.9, resetsAt: 10 },
          seven_day_opus: { utilization: 0.3, resetsAt: 20 },
        },
      },
    });
    expect(Object.keys(r!.windows).sort()).toEqual(["seven_day", "seven_day_opus"]);
    expect(r?.status).toBe("allowed_warning");
  });
});
