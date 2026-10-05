import { UNKNOWN } from "@stubwise/shared";
import type { AiJob, AiJobStatus, Reader, Unknown } from "@stubwise/shared";
import { resolveWorkState } from "./work-state";

/**
 * Lo stato «in parole» dell'ultimo job, per lo `StatusBadge` di testata.
 * Spostato qui da `lib/timeline.ts` (piano B2): la timeline a sei passi esce
 * dall'app, questa regola no.
 */
function job(status: AiJobStatus | Unknown): Reader<AiJob> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ticketId: "33333333-3333-4333-8333-333333333333",
    status,
    log: "",
    prUrl: null,
    error: null,
    createdAt: "2026-08-12T09:05:00.000Z",
    startedAt: null,
    finishedAt: null,
    providerLabel: null,
    providerKind: null,
    requestedByUserId: null,
  };
}

describe("resolveWorkState", () => {
  test("nessun job: null", () => {
    expect(resolveWorkState(undefined)).toBeNull();
  });

  test("job noto: lo stato in parole", () => {
    expect(resolveWorkState(job("fixing"))).toBe("working");
  });

  test("job con stato ignoto: il segnaposto UNKNOWN, mai il valore grezzo del server", () => {
    expect(resolveWorkState(job(UNKNOWN))).toBe(UNKNOWN);
  });
});
