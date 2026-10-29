import { describe, expect, it } from "vitest";
import type { ServerSshAccess } from "../../data/model";
import { access, hoursAgo, pair, STATES } from "./fixtures";
import { accessState, accessUsable, verifyFailure } from "./sshAccess";

describe("accessState e accessUsable", () => {
  it("i sette stati", () => {
    for (const [state, a] of Object.entries(STATES)) {
      expect(accessState(a), state).toBe(state);
    }
  });

  it("chi è usabile in ogni stato", () => {
    const usable = (a: ServerSshAccess | undefined) => [
      accessUsable(a, "read"),
      accessUsable(a, "fix"),
    ];
    expect(usable(STATES.not_linked)).toEqual([false, false]);
    expect(usable(STATES.awaiting_command)).toEqual([false, false]);
    expect(usable(STATES.verified)).toEqual([true, true]);
    expect(usable(STATES.verify_failed)).toEqual([true, false]);
    // Scelta del piano: una lettura che scrive spegne ENTRAMBI.
    expect(usable(STATES.read_writes)).toEqual([false, false]);
    // Rigenerazione: le vecchie restano usabili finché le nuove non sono verificate.
    expect(usable(STATES.regenerating)).toEqual([true, true]);
    expect(usable(STATES.revoked)).toEqual([false, false]);
  });

  it("verify_failed dice quale accesso e perché", () => {
    expect(verifyFailure(STATES.verify_failed)).toEqual({
      read: false,
      fix: true,
      reason: "Permission denied (publickey)",
    });
    expect(verifyFailure(STATES.verified)).toBeNull();
  });

  it("la prima verifica fallita (chiavi in attesa) → verify_failed, niente di usabile", () => {
    const a = access({
      keys: null,
      pending: pair(1),
      verification: {
        at: hoursAgo(1),
        read: "failed",
        fix: "failed",
        reason: "Connection timed out",
        ofPending: true,
      },
    });
    expect(accessState(a)).toBe("verify_failed");
    expect(accessUsable(a, "read")).toBe(false);
    expect(verifyFailure(a)).toEqual({ read: true, fix: true, reason: "Connection timed out" });
  });

  it("rigenerazione con verifica delle nuove fallita: le vecchie restano usabili", () => {
    const a = access({
      pending: pair(2),
      verification: { at: hoursAgo(1), read: "failed", fix: "ok", reason: "x", ofPending: true },
    });
    expect(accessState(a)).toBe("verify_failed");
    expect(accessUsable(a, "read")).toBe(true);
    expect(accessUsable(a, "fix")).toBe(true);
  });

  it("rigenerazione partita da una verifica fallita: finché le nuove non si verificano vale l'esito di prima", () => {
    const a = access({
      pending: pair(2),
      verification: { at: hoursAgo(1), read: "ok", fix: "failed", reason: "x", ofPending: false },
    });
    expect([accessUsable(a, "read"), accessUsable(a, "fix")]).toEqual([true, false]);
  });

  it("rigenerazione con le nuove che scrivono: nessuno dei due", () => {
    const a = access({
      pending: pair(2),
      verification: { at: hoursAgo(1), read: "writes", fix: "ok", reason: "x", ofPending: true },
    });
    expect(accessState(a)).toBe("read_writes");
    expect([accessUsable(a, "read"), accessUsable(a, "fix")]).toEqual([false, false]);
  });

  it("ricollegato dopo la revoca → in attesa del comando", () => {
    const a = access({ keys: null, pending: pair(2), verification: null, revokedAt: hoursAgo(5) });
    expect(accessState(a)).toBe("awaiting_command");
  });
});
