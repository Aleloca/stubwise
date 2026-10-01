import { describe, expect, it } from "vitest";
import type { PrCycle } from "./api";
import { prCycleLineFor } from "./pr-cycle-line";

/**
 * Fixture di base SENZA `heldReason`, `canResume`, `heldJobId` e senza
 * `lastRequest.platform`: è la forma che manda un server più vecchio del
 * bundle, e il web fa un cast, non un parse (nessun `.default()` gira qui).
 * Il tipo `PrCycle` del web li dichiara opzionali apposta, quindi questa
 * fixture compila senza cast. I test che li vogliono li passano negli
 * `overrides`.
 */
function cycle(overrides: Partial<PrCycle> = {}): PrCycle {
  return {
    state: "idle",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    ...overrides,
  };
}

const keys = (c: PrCycle) => prCycleLineFor(c).segments.map((s) => s.key);

describe("prCycleLineFor", () => {
  it("correzione automatica: giro N di M", () => {
    const line = prCycleLineFor(cycle({ state: "correcting", round: 2 }));
    expect(line.tone).toBe("sky");
    expect(line.segments).toEqual([
      { key: "tickets:cycle.correctingRound", params: { round: 2, max: 3 } },
    ]);
  });

  it("correzione chiesta da una persona (giro 0): dice chi, poi che corregge", () => {
    const line = prCycleLineFor(
      cycle({
        state: "correcting",
        lastRequest: {
          via: "provider",
          platform: "bitbucket",
          name: "mario.rossi",
          at: "2026-09-30T10:00:00.000Z",
        },
      }),
    );
    expect(line.segments).toEqual([
      { key: "tickets:cycle.requestedOnPlatform", params: { name: "mario.rossi", platform: "Bitbucket" } },
      { key: "tickets:cycle.correcting", params: {} },
    ]);
  });

  it("richiesta dal provider senza piattaforma (server più vecchio): «sulla PR»", () => {
    const line = prCycleLineFor(
      cycle({
        state: "correcting",
        lastRequest: { via: "provider", name: "mario-rossi", at: "2026-09-30T10:00:00.000Z" },
      }),
    );
    expect(line.segments[0]).toEqual({ key: "tickets:cycle.requestedOnPr", params: { name: "mario-rossi" } });
  });

  it("richiesta umana in attesa: la review/correzione corrente, poi chi aspetta in coda", () => {
    expect(
      keys(
        cycle({
          state: "reviewing",
          pendingRequest: true,
          lastRequest: { via: "stubwise", platform: null, name: "ada@acme.test", at: "2026-09-30T10:00:00.000Z" },
        }),
      ),
    ).toEqual(["tickets:cycle.reviewing", "tickets:cycle.requestedInStubwise", "tickets:cycle.queued"]);
  });

  it("approvata: tono ok, pronta per il merge (non «tocca a te»: il merge non spetta a un operatore)", () => {
    const line = prCycleLineFor(cycle({ state: "approved" }));
    expect(line.tone).toBe("ok");
    expect(line.segments[0]!.key).toBe("tickets:cycle.approved");
  });

  it("fermo al tetto: il conteggio è il giro raggiunto", () => {
    const line = prCycleLineFor(cycle({ state: "stopped_at_cap", round: 3 }));
    expect(line.tone).toBe("signal");
    expect(line.segments).toEqual([{ key: "tickets:cycle.stoppedAtCap", params: { count: 3 } }]);
  });

  it("correzione fallita: tono danger", () => {
    expect(prCycleLineFor(cycle({ state: "correction_failed" })).tone).toBe("danger");
  });

  it("uno stato che il web non conosce non lancia: chiave neutra", () => {
    const line = prCycleLineFor(cycle({ state: "stato_futuro" as PrCycle["state"] }));
    expect(line.segments[0]!.key).toBe("tickets:cycle.unknown");
  });

  describe("correzione ferma (heldReason, canResume)", () => {
    it("server più vecchio: `correcting` SENZA heldReason/canResume è «in corso», non «ferma»", () => {
      // La fixture non ha i due campi: arriva al ramo `correcting`, che li
      // legge con `?? null` / `?? false`. Senza la difesa `undefined !== null`
      // farebbe dire «ferma» a una correzione che sta lavorando.
      const c = cycle({ state: "correcting" });
      expect("heldReason" in c).toBe(false);
      expect("canResume" in c).toBe(false);
      const line = prCycleLineFor(c);
      expect(line.tone).toBe("sky");
      expect(line.segments).toEqual([{ key: "tickets:cycle.correcting", params: {} }]);
    });

    it("server più vecchio, con un giro: la frase di sempre", () => {
      const c = cycle({ state: "correcting", round: 2 });
      expect("heldReason" in c).toBe(false);
      expect(keys(c)).toEqual(["tickets:cycle.correctingRound"]);
    });

    it("ferma per budget e chi guarda la può riprendere: heldBudget", () => {
      const line = prCycleLineFor(cycle({ state: "correcting", heldReason: "budget", canResume: true }));
      expect(line.tone).toBe("signal");
      expect(line.segments).toEqual([{ key: "tickets:cycle.heldBudget", params: {} }]);
    });

    it("ferma per budget e chi guarda NON la può riprendere: la riprende un maintainer", () => {
      const line = prCycleLineFor(cycle({ state: "correcting", heldReason: "budget", canResume: false }));
      expect(line.segments).toEqual([{ key: "tickets:cycle.heldBudgetNeedsMaintainer", params: {} }]);
    });

    it("ferma per budget e `canResume` ASSENTE (server più vecchio): nessuna promessa, la riprende un maintainer", () => {
      const c = cycle({ state: "correcting", heldReason: "budget" });
      expect("canResume" in c).toBe(false);
      expect(keys(c)).toEqual(["tickets:cycle.heldBudgetNeedsMaintainer"]);
    });

    it("due viste sugli stessi dati del ciclo: decide `canResume` del server, il ruolo non è un input", () => {
      const data = {
        state: "correcting" as const,
        round: 1,
        heldReason: "budget" as const,
        heldJobId: "11111111-1111-4111-8111-111111111111",
      };
      const seenByWhoCanResume = prCycleLineFor(cycle({ ...data, canResume: true }));
      const seenByWhoCannot = prCycleLineFor(cycle({ ...data, canResume: false }));
      expect(seenByWhoCanResume.segments.map((s) => s.key)).toEqual([
        "tickets:cycle.round",
        "tickets:cycle.heldBudget",
      ]);
      expect(seenByWhoCannot.segments.map((s) => s.key)).toEqual([
        "tickets:cycle.round",
        "tickets:cycle.heldBudgetNeedsMaintainer",
      ]);
      // La funzione prende SOLO il ciclo: nessun parametro per il ruolo.
      expect(prCycleLineFor.length).toBe(1);
    });

    it("con un giro: «Giro N di M», poi il motivo al posto di «in corso»", () => {
      const line = prCycleLineFor(cycle({ state: "correcting", round: 2, heldReason: "budget", canResume: true }));
      expect(line.segments).toEqual([
        { key: "tickets:cycle.round", params: { round: 2, max: 3 } },
        { key: "tickets:cycle.heldBudget", params: {} },
      ]);
    });

    it("limite del provider: riparte da sola, `canResume` non cambia la frase", () => {
      for (const canResume of [true, false]) {
        const line = prCycleLineFor(cycle({ state: "correcting", heldReason: "limit", canResume }));
        expect(line.tone).toBe("sky");
        expect(line.segments).toEqual([{ key: "tickets:cycle.heldLimit", params: {} }]);
      }
    });

    it("altro motivo: heldOther", () => {
      expect(keys(cycle({ state: "correcting", heldReason: "other", canResume: true }))).toEqual([
        "tickets:cycle.heldOther",
      ]);
    });

    it("un motivo che il web non conosce: heldOther, non lancia", () => {
      expect(
        keys(cycle({ state: "correcting", heldReason: "futuro" as NonNullable<PrCycle["heldReason"]> })),
      ).toEqual(["tickets:cycle.heldOther"]);
    });

    it("richiesta umana (giro 0) poi ferma: chi l'ha chiesta resta, il motivo prende il posto di «in corso»", () => {
      expect(
        keys(
          cycle({
            state: "correcting",
            heldReason: "budget",
            canResume: false,
            lastRequest: { via: "stubwise", platform: null, name: "ada@acme.test", at: "2026-09-30T10:00:00.000Z" },
          }),
        ),
      ).toEqual(["tickets:cycle.requestedInStubwise", "tickets:cycle.heldBudgetNeedsMaintainer"]);
    });

    it("richiesta in coda dietro una correzione ferma per budget: il motivo, poi chi aspetta", () => {
      expect(
        keys(
          cycle({
            state: "correcting",
            round: 1,
            heldReason: "budget",
            canResume: true,
            pendingRequest: true,
            lastRequest: { via: "provider", platform: "github", name: "octo", at: "2026-09-30T10:00:00.000Z" },
          }),
        ),
      ).toEqual([
        "tickets:cycle.round",
        "tickets:cycle.heldBudget",
        "tickets:cycle.requestedOnPlatform",
        "tickets:cycle.queued",
      ]);
    });

    it("heldReason su uno stato che non è `correcting` non cambia la riga", () => {
      expect(keys(cycle({ state: "reviewing", heldReason: "budget", canResume: false }))).toEqual([
        "tickets:cycle.reviewing",
      ]);
    });
  });
});
