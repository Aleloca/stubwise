import { describe, expect, it } from "vitest";
import { access, DENIED, hoursAgo, key, STATES, SUDO, verification } from "./fixtures";
import { accessState, accessUsable, journalReadable, verifyFailure } from "./sshAccess";

// L'accesso SSH di un server è UNO, di sola lettura (`stubwise-read`, area
// 8, F4b, Q3 = b): niente coppia di correzione, la correzione passa
// dall'agente.

describe("accessState e accessUsable", () => {
  it("i sei stati (una chiave sola: niente «in rigenerazione», decisione del maintainer)", () => {
    for (const [state, a] of Object.entries(STATES)) {
      expect(accessState(a), state).toBe(state);
    }
  });

  it("usabile solo verificato", () => {
    expect(accessUsable(STATES.not_linked)).toBe(false);
    expect(accessUsable(STATES.awaiting_command)).toBe(false);
    expect(accessUsable(STATES.verified)).toBe(true);
    expect(accessUsable(STATES.verify_failed)).toBe(false);
    expect(accessUsable(STATES.privileged)).toBe(false);
    expect(accessUsable(STATES.revoked)).toBe(false);
  });

  it("un utente nel gruppo docker non è di sola lettura: spento come con sudo", () => {
    const docker = access({
      verification: verification({
        groups: ["stubwise-read", "docker"],
        docker: true,
        journal: false,
        ok: false,
      }),
    });
    expect(accessState(docker)).toBe("privileged");
    expect(accessUsable(docker)).toBe(false);
  });

  it("verify_failed dice perché", () => {
    expect(verifyFailure(STATES.verify_failed)).toEqual({
      login: "denied",
      reason: "Permission denied (publickey)",
    });
    expect(verifyFailure(STATES.verified)).toBeNull();
    // Un utente con sudo non è un login fallito: è `privileged`, un'altra frase.
    expect(verifyFailure(STATES.privileged)).toBeNull();
  });

  it("la prima verifica fallita (chiave in attesa) → verify_failed, niente di usabile", () => {
    const a = access({
      key: null,
      pending: key(1),
      verification: { ...DENIED, login: "unreachable", ofPending: true },
    });
    expect(accessState(a)).toBe("verify_failed");
    expect(accessUsable(a)).toBe(false);
  });

  it("rigenerazione con verifica della nuova fallita: la vecchia resta usabile", () => {
    const a = access({
      pending: key(2),
      verification: { ...DENIED, ofPending: true },
      keyVerification: verification({ at: hoursAgo(5) }),
    });
    expect(accessState(a)).toBe("verify_failed");
    expect(accessUsable(a)).toBe(true);
  });

  it("rigenerazione partita con la vecchia fallita: resta spenta", () => {
    const a = access({
      pending: key(2),
      verification: { ...DENIED, ofPending: true },
      keyVerification: DENIED,
    });
    expect(accessUsable(a)).toBe(false);
  });

  it("rigenerazione partita da un utente con sudo: niente torna usabile finché una verifica non riesce", () => {
    const a = access({
      pending: key(2),
      verification: { ...DENIED, ofPending: true },
      keyVerification: SUDO,
    });
    expect(accessState(a)).toBe("privileged");
    expect(accessUsable(a)).toBe(false);
  });

  it("verifica della nuova senza l'esito della vecchia: niente di usabile (prudenza)", () => {
    const a = access({
      pending: key(2),
      verification: { ...DENIED, ofPending: true },
      keyVerification: null,
    });
    expect(accessUsable(a)).toBe(false);
  });

  it("rigenerazione con la nuova che ha sudo: spento", () => {
    const a = access({ pending: key(2), verification: { ...SUDO, ofPending: true } });
    expect(accessState(a)).toBe("privileged");
    expect(accessUsable(a)).toBe(false);
  });

  it("ricollegato dopo la revoca → in attesa del comando", () => {
    const a = access({ key: null, pending: key(2), verification: null, revokedAt: hoursAgo(5) });
    expect(accessState(a)).toBe("awaiting_command");
  });
});

describe("journalReadable (F4b-3 = a)", () => {
  it("il journal si legge solo se la verifica ha trovato il gruppo", () => {
    expect(journalReadable(STATES.verified)).toBe(true);
    const noGroup = access({
      verification: verification({ groups: ["stubwise-read"], journal: false }),
    });
    expect(accessUsable(noGroup)).toBe(true);
    expect(journalReadable(noGroup)).toBe(false);
  });

  it("mai con l'accesso non usabile", () => {
    expect(journalReadable(STATES.privileged)).toBe(false);
    expect(journalReadable(STATES.not_linked)).toBe(false);
  });

  it("in rigenerazione vale l'esito della chiave in uso", () => {
    const a = access({
      pending: key(2),
      verification: { ...DENIED, ofPending: true },
      keyVerification: verification({ groups: ["stubwise-read"], journal: false }),
    });
    expect(accessUsable(a)).toBe(true);
    expect(journalReadable(a)).toBe(false);
  });
});
