import type { PrCycle, Reader } from "@stubwise/shared";
import { prCycleSchema, readerSchema, UNKNOWN } from "@stubwise/shared";
import i18next, { type TFunction } from "i18next";
import webEn from "../../../web/src/i18n/locales/en.json";
import webIt from "../../../web/src/i18n/locales/it.json";
import i18n from "../i18n";
import appEn from "../i18n/en.json";
import appIt from "../i18n/it.json";
import { isHeldCorrectionJob, prCycleCardFor, prCycleLineFor, prCycleText } from "./pr-cycle";

/**
 * GEMELLO di `apps/web/src/lib/pr-cycle-line.test.ts`: ogni caso del web è
 * qui, con le stesse fixture, sulle chiavi `mobile.work.pr.cycle.*` al posto
 * di `tickets:cycle.*`. Una differenza di FORMA, non di regola: il web
 * fabbrica la «risposta di un server più vecchio» togliendo i campi dalla
 * fixture (fa un cast), l'app la ottiene come l'otterrebbe in produzione —
 * la risposta grezza senza quei campi passata da `readerSchema`, che porta
 * `heldReason`/`heldJobId` a `null`, `canResume` a `false` e
 * `lastRequest.platform` a `null`. Le fixture tipate invece sono COMPLETE
 * (CLAUDE.md, la trappola delle fixture dell'app).
 */

const t = i18n.t.bind(i18n) as TFunction;

function cycle(overrides: Partial<Reader<PrCycle>> = {}): Reader<PrCycle> {
  return {
    state: "idle",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    heldReason: null,
    canResume: false,
    heldJobId: null,
    blockedReason: null,
    ...overrides,
  };
}

/** La risposta GREZZA di un server di prima del ciclo «ferma» (senza i tre campi), parsata come la parsa l'app. */
function oldServerCycle(raw: Record<string, unknown>): Reader<PrCycle> {
  return readerSchema(prCycleSchema).parse({
    state: "idle",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    ...raw,
  });
}

/**
 * Uno stato GREZZO che l'app non conosce, NON passato da `readerSchema`: è ciò
 * che arriva da una fixture o da un doppio del client (che il parse non lo
 * fanno). Stessa forma dei test del web, che fanno lo stesso cast.
 */
function rawUnknownStateCycle(): Reader<PrCycle> {
  return { ...cycle(), state: "stato_futuro" } as unknown as Reader<PrCycle>;
}

const keys = (c: Reader<PrCycle>) => prCycleLineFor(c).segments.map((s) => s.key);
const HELD_JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("prCycleLineFor (gemella di prCycleLineFor del web)", () => {
  it("correzione automatica: giro N di M", () => {
    const line = prCycleLineFor(cycle({ state: "correcting", round: 2 }));
    expect(line.tone).toBe("sky");
    expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.correctingRound", params: { round: 2, max: 3 } }]);
  });

  it("correzione chiesta da una persona (giro 0): dice chi, poi che corregge", () => {
    const line = prCycleLineFor(
      cycle({
        state: "correcting",
        lastRequest: { via: "provider", platform: "bitbucket", name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" },
      }),
    );
    expect(line.segments).toEqual([
      { key: "mobile.work.pr.cycle.requestedOnPlatform", params: { name: "mario.rossi", platform: "Bitbucket" } },
      { key: "mobile.work.pr.cycle.correcting", params: {} },
    ]);
  });

  it("richiesta dal provider senza piattaforma (server più vecchio): «sulla PR»", () => {
    const line = prCycleLineFor(
      oldServerCycle({
        state: "correcting",
        lastRequest: { via: "provider", name: "mario-rossi", at: "2026-09-30T10:00:00.000Z" },
      }),
    );
    expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedOnPr", params: { name: "mario-rossi" } });
  });

  it("piattaforma sconosciuta (UNKNOWN da readerSchema): «sulla PR», come null", () => {
    const line = prCycleLineFor(
      cycle({
        state: "correcting",
        lastRequest: { via: "provider", platform: UNKNOWN, name: "mario-rossi", at: "2026-09-30T10:00:00.000Z" },
      }),
    );
    expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedOnPr", params: { name: "mario-rossi" } });
  });

  it("`via` sconosciuto: si legge come una richiesta dalla piattaforma, il nome non si perde", () => {
    const line = prCycleLineFor(
      cycle({
        state: "correcting",
        lastRequest: { via: UNKNOWN, platform: null, name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" },
      }),
    );
    expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedOnPr", params: { name: "mario.rossi" } });
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
    ).toEqual(["mobile.work.pr.cycle.reviewing", "mobile.work.pr.cycle.requestedInStubwise", "mobile.work.pr.cycle.queued"]);
  });

  it("approvata: tono ok, pronta per il merge (non «tocca a te»: il merge non spetta a un operatore)", () => {
    const line = prCycleLineFor(cycle({ state: "approved" }));
    expect(line.tone).toBe("ok");
    expect(line.segments[0]!.key).toBe("mobile.work.pr.cycle.approved");
  });

  it("fermo al tetto: il conteggio è il giro raggiunto", () => {
    const line = prCycleLineFor(cycle({ state: "stopped_at_cap", round: 3 }));
    expect(line.tone).toBe("signal");
    expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.stoppedAtCap", params: { count: 3 } }]);
  });

  it("correzione fallita: tono danger", () => {
    expect(prCycleLineFor(cycle({ state: "correction_failed" })).tone).toBe("danger");
  });

  it("uno stato che l'app non conosce non lancia: chiave neutra", () => {
    const line = prCycleLineFor(rawUnknownStateCycle());
    expect(line.segments[0]!.key).toBe("mobile.work.pr.cycle.unknown");
  });

  it("lo stesso stato passato da readerSchema (UNKNOWN): chiave neutra", () => {
    const c = oldServerCycle({ state: "stato_futuro" });
    expect(c.state).toBe(UNKNOWN);
    expect(prCycleLineFor(c).segments[0]!.key).toBe("mobile.work.pr.cycle.unknown");
  });

  it("stato GREZZO non parsato (fixture, doppio del client): chiave unknown, tono faint, e la riga si traduce senza lanciare", () => {
    const line = prCycleLineFor(rawUnknownStateCycle());
    expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.unknown", params: {} }]);
    expect(line.tone).toBe("faint");
    expect(() => prCycleText(line, t)).not.toThrow();
    expect(prCycleText(line, t)).toBe("Stato del ciclo di correzione non riconosciuto: aggiorna l'app");
  });

  describe("correzione ferma (heldReason, canResume)", () => {
    it("server più vecchio: `correcting` SENZA heldReason/canResume è «in corso», non «ferma»", () => {
      const c = oldServerCycle({ state: "correcting" });
      expect(c.heldReason).toBeNull();
      expect(c.canResume).toBe(false);
      const line = prCycleLineFor(c);
      expect(line.tone).toBe("sky");
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.correcting", params: {} }]);
    });

    it("server più vecchio, con un giro: la frase di sempre", () => {
      const c = oldServerCycle({ state: "correcting", round: 2 });
      expect(c.heldReason).toBeNull();
      expect(keys(c)).toEqual(["mobile.work.pr.cycle.correctingRound"]);
    });

    it("ferma per budget e chi guarda la può riprendere: heldBudget", () => {
      const line = prCycleLineFor(
        cycle({ state: "correcting", heldReason: "budget", canResume: true, heldJobId: HELD_JOB_ID }),
      );
      expect(line.tone).toBe("signal");
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.heldBudget", params: {} }]);
    });

    it("ferma per budget e chi guarda NON la può riprendere: la riprende un maintainer", () => {
      const line = prCycleLineFor(
        cycle({ state: "correcting", heldReason: "budget", canResume: false, heldJobId: HELD_JOB_ID }),
      );
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.heldBudgetNeedsMaintainer", params: {} }]);
    });

    it("ferma per budget e `canResume` ASSENTE (server più vecchio): nessuna promessa, la riprende un maintainer", () => {
      const c = oldServerCycle({ state: "correcting", heldReason: "budget" });
      expect(c.canResume).toBe(false);
      expect(keys(c)).toEqual(["mobile.work.pr.cycle.heldBudgetNeedsMaintainer"]);
    });

    it("due viste sugli stessi dati del ciclo: decide `canResume` del server, il ruolo non è un input", () => {
      const data = { state: "correcting" as const, round: 1, heldReason: "budget" as const, heldJobId: HELD_JOB_ID };
      const seenByWhoCanResume = prCycleLineFor(cycle({ ...data, canResume: true }));
      const seenByWhoCannot = prCycleLineFor(cycle({ ...data, canResume: false }));
      expect(seenByWhoCanResume.segments).toEqual([
        { key: "mobile.work.pr.cycle.heldBudgetRound", params: { round: 1, max: 3 } },
      ]);
      expect(seenByWhoCannot.segments).toEqual([
        { key: "mobile.work.pr.cycle.heldBudgetNeedsMaintainerRound", params: { round: 1, max: 3 } },
      ]);
      // La funzione prende SOLO il ciclo: nessun parametro per il ruolo.
      expect(prCycleLineFor.length).toBe(1);
    });

    it("con un giro: UNA frase «Giro N di M · correzione ferma · …», per ogni motivo", () => {
      const cases: [NonNullable<Reader<PrCycle>["heldReason"]>, boolean, string][] = [
        ["budget", true, "mobile.work.pr.cycle.heldBudgetRound"],
        ["budget", false, "mobile.work.pr.cycle.heldBudgetNeedsMaintainerRound"],
        ["limit", false, "mobile.work.pr.cycle.heldLimitRound"],
        ["other", true, "mobile.work.pr.cycle.heldOtherRound"],
      ];
      for (const [heldReason, canResume, key] of cases) {
        const line = prCycleLineFor(cycle({ state: "correcting", round: 2, heldReason, canResume, heldJobId: HELD_JOB_ID }));
        expect(line.segments).toEqual([{ key, params: { round: 2, max: 3 } }]);
      }
    });

    it("limite del provider: riparte da sola, `canResume` non cambia la frase", () => {
      for (const canResume of [true, false]) {
        const line = prCycleLineFor(
          cycle({ state: "correcting", heldReason: "limit", canResume, heldJobId: HELD_JOB_ID }),
        );
        expect(line.tone).toBe("sky");
        expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.heldLimit", params: {} }]);
      }
    });

    it("altro motivo: heldOther, tono signal", () => {
      const line = prCycleLineFor(
        cycle({ state: "correcting", heldReason: "other", canResume: true, heldJobId: HELD_JOB_ID }),
      );
      expect(line.tone).toBe("signal");
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.heldOther", params: {} }]);
    });

    it("un motivo che l'app non conosce (UNKNOWN da readerSchema): heldOther, tono signal, non lancia", () => {
      const c = oldServerCycle({ state: "correcting", heldReason: "futuro", heldJobId: HELD_JOB_ID });
      expect(c.heldReason).toBe(UNKNOWN);
      const line = prCycleLineFor(c);
      expect(line.tone).toBe("signal");
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.heldOther", params: {} }]);
    });

    it("richiesta umana (giro 0) poi ferma: chi l'ha chiesta resta, il motivo prende il posto di «in corso»", () => {
      expect(
        keys(
          cycle({
            state: "correcting",
            heldReason: "budget",
            canResume: false,
            heldJobId: HELD_JOB_ID,
            lastRequest: { via: "stubwise", platform: null, name: "ada@acme.test", at: "2026-09-30T10:00:00.000Z" },
          }),
        ),
      ).toEqual(["mobile.work.pr.cycle.requestedInStubwise", "mobile.work.pr.cycle.heldBudgetNeedsMaintainer"]);
    });

    it("richiesta in coda dietro una correzione ferma per budget: il motivo, poi chi aspetta", () => {
      expect(
        keys(
          cycle({
            state: "correcting",
            round: 1,
            heldReason: "budget",
            canResume: true,
            heldJobId: HELD_JOB_ID,
            pendingRequest: true,
            lastRequest: { via: "provider", platform: "github", name: "octo", at: "2026-09-30T10:00:00.000Z" },
          }),
        ),
      ).toEqual([
        "mobile.work.pr.cycle.heldBudgetRound",
        "mobile.work.pr.cycle.requestedOnPlatform",
        "mobile.work.pr.cycle.queued",
      ]);
    });

    it("heldReason su uno stato che non è `correcting` non cambia la riga", () => {
      expect(keys(cycle({ state: "reviewing", heldReason: "budget", canResume: false }))).toEqual([
        "mobile.work.pr.cycle.reviewing",
      ]);
    });
  });

  describe("chi ha chiesto: la richiesta in attesa non si attribuisce il lavoro in corso", () => {
    const A_BUT_B_PENDING = {
      via: "provider" as const,
      platform: "bitbucket" as const,
      name: "bruno",
      at: "2026-09-30T11:00:00.000Z",
    };

    it("correcting, giro 0, pending: niente prefisso; il nome sta solo davanti a «in coda», UNA volta", () => {
      const line = prCycleLineFor(cycle({ state: "correcting", round: 0, pendingRequest: true, lastRequest: A_BUT_B_PENDING }));
      expect(line.segments).toEqual([
        { key: "mobile.work.pr.cycle.correcting", params: {} },
        { key: "mobile.work.pr.cycle.requestedOnPlatform", params: { name: "bruno", platform: "Bitbucket" } },
        { key: "mobile.work.pr.cycle.queued", params: {} },
      ]);
    });

    it("stessa combinazione con la correzione ferma: il motivo, poi chi aspetta in coda", () => {
      expect(
        keys(
          cycle({
            state: "correcting",
            round: 0,
            pendingRequest: true,
            heldReason: "budget",
            canResume: false,
            heldJobId: HELD_JOB_ID,
            lastRequest: A_BUT_B_PENDING,
          }),
        ),
      ).toEqual([
        "mobile.work.pr.cycle.heldBudgetNeedsMaintainer",
        "mobile.work.pr.cycle.requestedOnPlatform",
        "mobile.work.pr.cycle.queued",
      ]);
    });
  });

  describe("nome vuoto: la frase omette «da X»", () => {
    const at = "2026-09-30T10:00:00.000Z";

    it("Stubwise, nome vuoto", () => {
      const line = prCycleLineFor(cycle({ state: "correcting", lastRequest: { via: "stubwise", platform: null, name: "", at } }));
      expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedInStubwiseAnon", params: {} });
    });

    it("piattaforma nota, nome di soli spazi", () => {
      const line = prCycleLineFor(
        cycle({ state: "correcting", lastRequest: { via: "provider", platform: "github", name: "   ", at } }),
      );
      expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedOnPlatformAnon", params: { platform: "GitHub" } });
    });

    it("provider senza piattaforma, nome vuoto, in coda", () => {
      expect(
        prCycleLineFor(
          oldServerCycle({ state: "reviewing", pendingRequest: true, lastRequest: { via: "provider", name: "", at } }),
        ).segments,
      ).toEqual([
        { key: "mobile.work.pr.cycle.reviewing", params: {} },
        { key: "mobile.work.pr.cycle.requestedOnPrAnon", params: {} },
        { key: "mobile.work.pr.cycle.queued", params: {} },
      ]);
    });
  });

  describe("chiavi, toni e parametri di ogni stato", () => {
    it("changes_requested: chiave e tono signal", () => {
      const line = prCycleLineFor(cycle({ state: "changes_requested" }));
      expect(line.tone).toBe("signal");
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.changesRequested", params: {} }]);
    });

    it("idle: chiave e tono faint", () => {
      const line = prCycleLineFor(cycle({ state: "idle" }));
      expect(line.tone).toBe("faint");
      expect(line.segments).toEqual([{ key: "mobile.work.pr.cycle.idle", params: {} }]);
    });

    it("correction_failed: la chiave", () => {
      expect(prCycleLineFor(cycle({ state: "correction_failed" })).segments).toEqual([
        { key: "mobile.work.pr.cycle.correctionFailed", params: {} },
      ]);
    });

    it("stato sconosciuto: tono faint", () => {
      expect(prCycleLineFor(rawUnknownStateCycle()).tone).toBe("faint");
    });

    it("reviewing: tono sky", () => {
      expect(prCycleLineFor(cycle({ state: "reviewing" })).tone).toBe("sky");
    });

    it("requestedInStubwise porta il nome", () => {
      const line = prCycleLineFor(
        cycle({
          state: "correcting",
          lastRequest: { via: "stubwise", platform: null, name: "ada@acme.test", at: "2026-09-30T10:00:00.000Z" },
        }),
      );
      expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedInStubwise", params: { name: "ada@acme.test" } });
    });

    it("piattaforma github → «GitHub»", () => {
      const line = prCycleLineFor(
        cycle({
          state: "correcting",
          lastRequest: { via: "provider", platform: "github", name: "octo", at: "2026-09-30T10:00:00.000Z" },
        }),
      );
      expect(line.segments[0]).toEqual({ key: "mobile.work.pr.cycle.requestedOnPlatform", params: { name: "octo", platform: "GitHub" } });
    });
  });
});

/**
 * La riga del ciclo SPEZZATA per la card della PR (pagina del ticket a tab,
 * 2 ott 2026, design §5): chip (lo stato, il primo pezzo che si legge),
 * dettagli in grigio, chi ha chiesto. Solo l'app: il web tiene la frase
 * intera di `prCycleLineFor`. Che i pezzi dicano la stessa cosa del web lo
 * verifica la parità più sotto (`CARD_PIECES`).
 */
describe("prCycleCardFor", () => {
  const C = "mobile.work.pr.card";
  const L = "mobile.work.pr.cycle";
  const REQUEST = { via: "provider" as const, platform: "bitbucket" as const, name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" };

  it.each([
    ["reviewing", `${L}.reviewing`, "sky"],
    ["changes_requested", `${L}.changesRequested`, "signal"],
    ["correction_failed", `${L}.correctionFailed`, "danger"],
    ["idle", `${L}.idle`, "faint"],
  ] as const)("%s: il chip è la frase di oggi, nessun dettaglio", (state, chipKey, tone) => {
    const card = prCycleCardFor(cycle({ state }));
    expect(card.tone).toBe(tone);
    expect(card.chip).toEqual({ key: chipKey, params: {} });
    expect(card.details).toEqual([]);
    expect(card.request).toBeNull();
    expect(card.requestAt).toBeNull();
    expect(card.queued).toBe(false);
  });

  it("approved: chip «Approvata dalla review», dettaglio «pronta per il merge»", () => {
    const card = prCycleCardFor(cycle({ state: "approved" }));
    expect(card.tone).toBe("ok");
    expect(card.chip).toEqual({ key: `${C}.chip.approved`, params: {} });
    expect(card.details).toEqual([{ key: `${C}.detail.readyToMerge`, params: {} }]);
  });

  it("approved su una PR NON aperta (mergiata, chiusa): niente «pronta per il merge»", () => {
    const card = prCycleCardFor(cycle({ state: "approved" }), { prOpen: false });
    expect(card.chip).toEqual({ key: `${C}.chip.approved`, params: {} });
    expect(card.details).toEqual([]);
  });

  it("correcting a giro 0: chip «Correzione in corso», nessun «giro 0 di 3»", () => {
    const card = prCycleCardFor(cycle({ state: "correcting", round: 0 }));
    expect(card.tone).toBe("sky");
    expect(card.chip).toEqual({ key: `${L}.correcting`, params: {} });
    expect(card.details).toEqual([]);
  });

  it("correcting a giro 2: il giro è un dettaglio, il chip resta lo stato", () => {
    const card = prCycleCardFor(cycle({ state: "correcting", round: 2 }));
    expect(card.chip).toEqual({ key: `${L}.correcting`, params: {} });
    expect(card.details).toEqual([{ key: `${C}.detail.round`, params: { round: 2, max: 3 } }]);
  });

  it("stopped_at_cap: chip «Ciclo fermo», dettaglio coi giri EFFETTIVI", () => {
    const card = prCycleCardFor(cycle({ state: "stopped_at_cap", round: 3 }));
    expect(card.tone).toBe("signal");
    expect(card.chip).toEqual({ key: `${C}.chip.stoppedAtCap`, params: {} });
    expect(card.details).toEqual([{ key: `${C}.detail.stoppedAtCap`, params: { count: 3 } }]);
  });

  describe("correzione ferma", () => {
    const held = (overrides: Partial<Reader<PrCycle>>) =>
      prCycleCardFor(cycle({ state: "correcting", heldJobId: HELD_JOB_ID, ...overrides }));

    it("budget, chi guarda la riprende: chip ferma, dettaglio budget, tono signal", () => {
      const card = held({ heldReason: "budget", canResume: true });
      expect(card.tone).toBe("signal");
      expect(card.chip).toEqual({ key: `${C}.chip.correctionHeld`, params: {} });
      expect(card.details).toEqual([{ key: `${C}.detail.budget`, params: {} }]);
    });

    it("budget, chi guarda NON la riprende: in più «chiedi a un maintainer»", () => {
      const card = held({ heldReason: "budget", canResume: false });
      expect(card.details).toEqual([
        { key: `${C}.detail.budget`, params: {} },
        { key: `${C}.detail.askMaintainer`, params: {} },
      ]);
    });

    it("limit: riparte da sola, tono sky, `canResume` non cambia niente", () => {
      for (const canResume of [true, false]) {
        const card = held({ heldReason: "limit", canResume });
        expect(card.tone).toBe("sky");
        expect(card.chip).toEqual({ key: `${C}.chip.correctionHeld`, params: {} });
        expect(card.details).toEqual([{ key: `${C}.detail.limit`, params: {} }]);
      }
    });

    it("other: solo il chip, tono signal", () => {
      const card = held({ heldReason: "other", canResume: true });
      expect(card.tone).toBe("signal");
      expect(card.chip).toEqual({ key: `${C}.chip.correctionHeld`, params: {} });
      expect(card.details).toEqual([]);
    });

    it("con un giro: il giro viene PRIMA del motivo, come nella frase del web", () => {
      const card = held({ round: 2, heldReason: "budget", canResume: false });
      expect(card.details).toEqual([
        { key: `${C}.detail.round`, params: { round: 2, max: 3 } },
        { key: `${C}.detail.budget`, params: {} },
        { key: `${C}.detail.askMaintainer`, params: {} },
      ]);
    });

    it("un motivo sconosciuto (UNKNOWN da readerSchema): come `other`, non lancia", () => {
      const card = prCycleCardFor(oldServerCycle({ state: "correcting", heldReason: "futuro", heldJobId: HELD_JOB_ID }));
      expect(card.tone).toBe("signal");
      expect(card.chip).toEqual({ key: `${C}.chip.correctionHeld`, params: {} });
      expect(card.details).toEqual([]);
    });
  });

  describe("chi ha chiesto", () => {
    it("c'è ogni volta che c'è `lastRequest`, col suo istante", () => {
      const card = prCycleCardFor(cycle({ state: "approved", lastRequest: REQUEST }));
      expect(card.request).toEqual({ key: `${L}.requestedOnPlatform`, params: { name: "mario.rossi", platform: "Bitbucket" } });
      expect(card.requestAt).toBe("2026-09-30T10:00:00.000Z");
      expect(card.queued).toBe(false);
    });

    it("in attesa dietro il lavoro corrente: il chip resta lo stato CORRENTE, la richiesta è quella in coda", () => {
      const card = prCycleCardFor(
        cycle({
          state: "correcting",
          round: 0,
          pendingRequest: true,
          lastRequest: { via: "stubwise", platform: null, name: "bruno@acme.test", at: "2026-09-30T11:00:00.000Z" },
        }),
      );
      expect(card.chip).toEqual({ key: `${L}.correcting`, params: {} });
      expect(card.request).toEqual({ key: `${L}.requestedInStubwise`, params: { name: "bruno@acme.test" } });
      expect(card.requestAt).toBe("2026-09-30T11:00:00.000Z");
      expect(card.queued).toBe(true);
    });

    it("un ciclo GREZZO senza la chiave `pendingRequest` (doppio, fixture): `queued` è false, mai undefined", () => {
      const c = cycle({ state: "reviewing", lastRequest: REQUEST });
      // Tolta a runtime, come arriva da un doppio che non parsa: il tipo resta
      // quello del ciclo, senza cast.
      Reflect.deleteProperty(c, "pendingRequest");
      expect("pendingRequest" in c).toBe(false);
      expect(prCycleCardFor(c).queued).toBe(false);
    });

    it("`pendingRequest` senza `lastRequest`: niente richiesta, niente coda inventata", () => {
      const card = prCycleCardFor(cycle({ state: "reviewing", pendingRequest: true }));
      expect(card.request).toBeNull();
      expect(card.queued).toBe(false);
    });
  });

  it("SOLO i campi nuovi del ciclo popolati: la card li usa", () => {
    const card = prCycleCardFor(
      cycle({ state: "correcting", heldReason: "budget", canResume: true, heldJobId: HELD_JOB_ID }),
    );
    expect(card.chip.key).toBe(`${C}.chip.correctionHeld`);
    expect(card.details.map((d) => d.key)).toEqual([`${C}.detail.budget`]);
  });

  it("server più vecchio (senza heldReason/canResume/heldJobId): «in corso», non «ferma»", () => {
    const card = prCycleCardFor(oldServerCycle({ state: "correcting", round: 1 }));
    expect(card.tone).toBe("sky");
    expect(card.chip).toEqual({ key: `${L}.correcting`, params: {} });
    expect(card.details).toEqual([{ key: `${C}.detail.round`, params: { round: 1, max: 3 } }]);
  });

  it("stato grezzo sconosciuto (non parsato): chip unknown, tono faint, non lancia", () => {
    const card = prCycleCardFor(rawUnknownStateCycle());
    expect(card.chip).toEqual({ key: `${L}.unknown`, params: {} });
    expect(card.tone).toBe("faint");
    expect(card.details).toEqual([]);
  });

  it("lo stesso stato passato da readerSchema (UNKNOWN): chip unknown", () => {
    expect(prCycleCardFor(oldServerCycle({ state: "stato_futuro" })).chip.key).toBe(`${L}.unknown`);
  });

  it("i pezzi tradotti, in italiano", () => {
    const card = prCycleCardFor(cycle({ state: "stopped_at_cap", round: 1 }));
    expect(t(card.chip.key, card.chip.params)).toBe("Ciclo fermo");
    expect(card.details.map((d) => t(d.key, d.params))).toEqual(["dopo 1 correzione automatica"]);
  });

  it("ogni chiave che `prCycleCardFor` può produrre esiste nei due cataloghi", () => {
    const produced = new Set<string>();
    const reasons = [null, "budget", "limit", "other", UNKNOWN] as const;
    const states = ["reviewing", "correcting", "approved", "changes_requested", "stopped_at_cap", "correction_failed", "idle", UNKNOWN] as const;
    const requests = [
      null,
      { via: "stubwise" as const, platform: null, name: "a", at: "2026-09-30T10:00:00.000Z" },
      { via: "provider" as const, platform: "github" as const, name: "", at: "2026-09-30T10:00:00.000Z" },
      { via: "provider" as const, platform: null, name: "a", at: "2026-09-30T10:00:00.000Z" },
    ];
    for (const state of states)
      for (const heldReason of reasons)
        for (const canResume of [true, false])
          for (const round of [0, 2])
            for (const pendingRequest of [true, false])
              for (const lastRequest of requests) {
                const card = prCycleCardFor(cycle({ state, heldReason, canResume, round, pendingRequest, lastRequest }));
                for (const s of [card.chip, ...card.details, ...(card.request ? [card.request] : [])]) produced.add(s.key);
              }
    expect(produced.size).toBeGreaterThan(10);
    for (const key of produced) {
      for (const lang of ["it", "en"]) {
        expect([lang, key, i18n.exists(key, { lng: lang, count: 2 })]).toEqual([lang, key, true]);
      }
    }
  });
});

/**
 * La regola che toglie il rilancio generico su una correzione ferma, sul dato
 * GREZZO: niente `readerSchema`, quindi un ciclo senza la chiave `heldJobId` o
 * una voce senza `cycle` arrivano così come sono (doppi, fixture, server
 * vecchio). Gemello di `$id.test.tsx` del web, «server vecchio (niente `cycle`
 * né `heldJobId`)». La regola deve TACERE, non lanciare.
 */
describe("isHeldCorrectionJob sul dato grezzo", () => {
  const job = { id: HELD_JOB_ID };

  it("una voce SENZA la chiave `cycle`: tace", () => {
    const raw: { cycle?: { heldJobId?: string | null } | null }[] = [{}];
    expect("cycle" in raw[0]!).toBe(false);
    expect(isHeldCorrectionJob(raw, job)).toBe(false);
  });

  it("un ciclo SENZA la chiave `heldJobId`: tace", () => {
    const raw: { cycle?: { heldJobId?: string | null } | null }[] = [{ cycle: {} }];
    expect("heldJobId" in raw[0]!.cycle!).toBe(false);
    expect(isHeldCorrectionJob(raw, job)).toBe(false);
  });

  it("`job` undefined (nessun job sul ticket): tace", () => {
    expect(isHeldCorrectionJob([{ cycle: { heldJobId: HELD_JOB_ID } }], undefined)).toBe(false);
  });

  it("le voci grezze non coprono una voce valida accanto: l'id combacia → true", () => {
    const raw: { cycle?: { heldJobId?: string | null } | null }[] = [
      {},
      { cycle: {} },
      { cycle: null },
      { cycle: { heldJobId: HELD_JOB_ID } },
    ];
    expect(isHeldCorrectionJob(raw, job)).toBe(true);
    expect(isHeldCorrectionJob(raw, { id: "un-altro-job" })).toBe(false);
  });
});

describe("prCycleText: la riga tradotta, segmenti uniti da « · »", () => {
  it("giro con correzione ferma per budget, chi guarda non la riprende", () => {
    const line = prCycleLineFor(cycle({ state: "correcting", round: 2, heldReason: "budget", canResume: false, heldJobId: HELD_JOB_ID }));
    expect(prCycleText(line, t)).toBe(
      "Giro 2 di 3 · correzione ferma · budget esaurito · chiedi a un maintainer di riprenderla",
    );
  });

  it("richiesta in coda dalla piattaforma, nome noto", () => {
    const line = prCycleLineFor(
      cycle({
        state: "correcting",
        round: 1,
        pendingRequest: true,
        lastRequest: { via: "provider", platform: "github", name: "mario-rossi", at: "2026-09-30T10:00:00.000Z" },
      }),
    );
    expect(prCycleText(line, t)).toBe(
      "Giro 1 di 3 · correzione in corso · Modifiche richieste da mario-rossi su GitHub · in coda · parte quando finisce il lavoro in corso sul ticket",
    );
  });

  it("nome vuoto: mai «da » seguito dal vuoto", () => {
    const line = prCycleLineFor(
      cycle({ state: "correcting", lastRequest: { via: "provider", platform: "bitbucket", name: "", at: "2026-09-30T10:00:00.000Z" } }),
    );
    expect(prCycleText(line, t)).toBe("Modifiche richieste su Bitbucket · Correzione in corso");
  });

  it("plurale del tetto: _one e _other", () => {
    expect(prCycleText(prCycleLineFor(cycle({ state: "stopped_at_cap", round: 1 })), t)).toBe(
      "Ciclo fermo dopo 1 correzione automatica",
    );
    expect(prCycleText(prCycleLineFor(cycle({ state: "stopped_at_cap", round: 3, maxRounds: 1 })), t)).toBe(
      "Ciclo fermo dopo 3 correzioni automatiche",
    );
  });

  it("stato sconosciuto: l'app dice di aggiornarsi (unica differenza voluta dal web)", () => {
    expect(prCycleText(prCycleLineFor(cycle({ state: UNKNOWN })), t)).toBe(
      "Stato del ciclo di correzione non riconosciuto: aggiorna l'app",
    );
  });
});

/**
 * PARITÀ COL WEB: le due superfici non possono dire cose diverse (design §9).
 * Ogni testo della riga di stato, degli errori e del pannello che il web ha,
 * l'app lo ha IDENTICO, in entrambe le lingue — letto dai cataloghi del web,
 * non copiato qui. `unknown` è l'unica eccezione voluta: solo l'app può
 * restare indietro rispetto al server, e allora dice «aggiorna l'app».
 *
 * ⚠️ **Limite della CI, da conoscere.** Su una pull request la CI lancia solo
 * i test dei pacchetti toccati e di chi ne dipende (`--filter "...[$BASE_SHA]"`
 * in `.github/workflows/ci.yml`). `apps/mobile` non dipende da `apps/web`:
 * questo file legge i suoi JSON per percorso, non per dipendenza. Quindi una
 * PR che cambia SOLO i testi del web (`apps/web/src/i18n/locales/*.json`) non
 * seleziona l'app, e questo test su quella PR NON gira: la divergenza passa la
 * review verde.
 * Emerge al push su main, dove la CI lancia TUTTI i test, quindi dopo il merge
 * e prima che qualcuno faccia il deploy guardando una CI verde su main. Il
 * deploy però è manuale e la CI non lo blocca: va controllata.
 *
 * **Se questo test fallisce su main**, si ALLINEANO le due copie: si porta lo
 * stesso testo nel catalogo dell'app (`apps/mobile/src/i18n/{it,en}.json`) o,
 * se il cambio sul web era sbagliato, lo si riporta indietro là. Il test non
 * si disattiva, non si salta e non si indebolisce (niente chiave tolta
 * dall'elenco, niente `toEqual` sostituito da un confronto più largo): è
 * l'unico punto che tiene d'accordo due superfici di cui una si aggiorna dagli
 * store e non può essere corretta dopo.
 */
describe("parità dei testi con il web", () => {
  const LINE_KEYS = [
    "reviewing",
    "correcting",
    "correctingRound",
    "approved",
    "changesRequested",
    "stoppedAtCap_one",
    "stoppedAtCap_other",
    "correctionFailed",
    "idle",
    "heldBudget",
    "heldBudgetRound",
    "heldBudgetNeedsMaintainer",
    "heldBudgetNeedsMaintainerRound",
    "heldLimit",
    "heldLimitRound",
    "heldOther",
    "heldOtherRound",
    "needsMaintainer",
    "correctionNotHeld",
    "requestedOnPlatform",
    "requestedOnPlatformAnon",
    "requestedOnPr",
    "requestedOnPrAnon",
    "requestedInStubwise",
    "requestedInStubwiseAnon",
    "queued",
  ] as const;

  /** errore del server (`code`, chiave in `errors.*` del web) → chiave dell'app. */
  const ERROR_KEYS = [
    ["correction_in_flight", "errors.correctionInFlight"],
    ["job_in_flight", "errors.jobInFlight"],
    ["pr_not_open", "errors.prNotOpen"],
    ["not_stubwise_pr", "errors.notStubwisePr"],
    ["pr_not_found", "errors.prNotFound"],
    // Questi due il web li mostra con i testi del CICLO (`resumeErrorText` in
    // `pr-cycle-row.tsx`), e così l'app: `needs_maintainer` ha lo stesso testo
    // in `errors.*` del web; `correction_not_held` no («ricarica il ticket»),
    // perché la riga del ciclo il ticket l'ha già ricaricato.
    ["needs_maintainer", "cycle.needsMaintainer"],
  ] as const;

  /**
   * Testi del pannello e dei bottoni: chiave dell'app (sotto `mobile.work.pr`)
   * → chiave del web (sotto `tickets.cycle`). Sono quelli dichiarati identici
   * nella nota di F2 nel piano; `sheet.title`, `sheet.offline`, `title` e
   * `openPr` non hanno un equivalente sul web e restano fuori.
   */
  const PANEL_KEYS = [
    ["requestCorrection", "apply"],
    ["resume", "resume"],
    ["resuming", "resuming"],
    ["sheet.body", "hint"],
    ["sheet.noteLabel", "noteLabel"],
    ["sheet.placeholder", "notePlaceholder"],
    ["sheet.confirm", "confirm"],
    ["sheet.confirming", "confirming"],
    ["sheet.cancel", "cancel"],
  ] as const;

  const catalogs = [
    ["it", appIt, webIt],
    ["en", appEn, webEn],
  ] as const;

  it.each(catalogs)("%s: ogni chiave della riga ha lo stesso testo del web", (_lang, app, web) => {
    for (const key of LINE_KEYS) {
      expect([key, app.mobile.work.pr.cycle[key]]).toEqual([key, web.tickets.cycle[key]]);
    }
  });

  it.each(catalogs)("%s: l'app non ha chiavi della riga che il web non ha (salvo `unknown`)", (_lang, app, web) => {
    const appOnly = Object.keys(app.mobile.work.pr.cycle).filter((key) => !(key in web.tickets.cycle));
    expect(appOnly).toEqual([]);
    expect(app.mobile.work.pr.cycle.unknown.startsWith(web.tickets.cycle.unknown)).toBe(true);
    expect(app.mobile.work.pr.cycle.unknown).not.toBe(web.tickets.cycle.unknown);
  });

  it.each(catalogs)("%s: ogni errore della rotta ha il testo del web", (_lang, app, web) => {
    for (const [code, appKey] of ERROR_KEYS) {
      const appText = appKey.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], app.mobile.work.pr);
      expect([code, appText]).toEqual([code, web.errors[code]]);
    }
  });

  it.each(catalogs)("%s: ogni testo del pannello ha il testo del web", (_lang, app, web) => {
    for (const [appKey, webKey] of PANEL_KEYS) {
      const appText = appKey.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], app.mobile.work.pr);
      expect([appKey, appText]).toEqual([appKey, web.tickets.cycle[webKey]]);
    }
  });

  /**
   * La CARD della PR (solo app) spezza la frase del web in pezzi: chip,
   * dettagli. Per ogni chiave della riga del web, quali pezzi dell'app la
   * ricompongono, in quale ORDINE (quello del web: nella frase il giro viene
   * prima dello stato) e con quale separatore. Il confronto ignora solo la
   * maiuscola iniziale di ogni pezzo: il chip è maiuscolo per
   * `textTransform`, e «Correzione in corso» dentro `correctingRound` è
   * minuscolo. Chiavi relative a `mobile.work.pr`.
   */
  const CARD_PIECES: readonly (readonly [string, readonly string[], string])[] = [
    ["reviewing", ["cycle.reviewing"], " · "],
    ["correcting", ["cycle.correcting"], " · "],
    ["correctingRound", ["card.detail.round", "cycle.correcting"], " · "],
    ["approved", ["card.chip.approved", "card.detail.readyToMerge"], " · "],
    ["changesRequested", ["cycle.changesRequested"], " · "],
    ["stoppedAtCap_one", ["card.chip.stoppedAtCap", "card.detail.stoppedAtCap_one"], " "],
    ["stoppedAtCap_other", ["card.chip.stoppedAtCap", "card.detail.stoppedAtCap_other"], " "],
    ["correctionFailed", ["cycle.correctionFailed"], " · "],
    ["idle", ["cycle.idle"], " · "],
    ["heldBudget", ["card.chip.correctionHeld", "card.detail.budget"], " · "],
    ["heldBudgetRound", ["card.detail.round", "card.chip.correctionHeld", "card.detail.budget"], " · "],
    ["heldBudgetNeedsMaintainer", ["card.chip.correctionHeld", "card.detail.budget", "card.detail.askMaintainer"], " · "],
    [
      "heldBudgetNeedsMaintainerRound",
      ["card.detail.round", "card.chip.correctionHeld", "card.detail.budget", "card.detail.askMaintainer"],
      " · ",
    ],
    ["heldLimit", ["card.chip.correctionHeld", "card.detail.limit"], " · "],
    ["heldLimitRound", ["card.detail.round", "card.chip.correctionHeld", "card.detail.limit"], " · "],
    ["heldOther", ["card.chip.correctionHeld"], " · "],
    ["heldOtherRound", ["card.detail.round", "card.chip.correctionHeld"], " · "],
  ];

  /** Il testo GREZZO del catalogo (nessun `t()`: niente plurali scelti per noi), coi segnaposto riempiti. */
  const raw = (catalog: unknown, path: string): string => {
    const text = path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], catalog);
    expect([path, typeof text]).toEqual([path, "string"]);
    return (text as string).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => ({ round: "2", max: "3", count: "7" })[name] ?? `?${name}?`);
  };
  const lowerFirst = (piece: string) => piece.charAt(0).toLowerCase() + piece.slice(1);
  /**
   * Ricompone i pezzi come li legge il web: la maiuscola iniziale si abbassa
   * SOLO sui pezzi dopo il primo (il chip «Correzione in corso» dentro «Giro
   * 2 di 3 · correzione in corso»). Il testo del web resta com'è: nessuna
   * altra lettera viene toccata, nemmeno le iniziali delle parole quando il
   * separatore è uno spazio.
   */
  const compose = (pieces: readonly string[], separator: string) =>
    pieces.map((piece, index) => (index === 0 ? piece : lowerFirst(piece))).join(separator);

  it.each(catalogs)("%s: i pezzi della card ricompongono la frase del web", (_lang, app, web) => {
    for (const [webKey, pieces, separator] of CARD_PIECES) {
      const composed = compose(pieces.map((piece) => raw(app.mobile.work.pr, piece)), separator);
      const webText = raw(web.tickets.cycle, webKey);
      expect([webKey, composed]).toEqual([webKey, webText]);
    }
  });

  /**
   * Il ciclo che produce ciascuna chiave della riga del web: lega
   * `CARD_PIECES` all'OUTPUT di `prCycleCardFor`. Senza, la tabella
   * verificherebbe solo i cataloghi, e una card che mette i pezzi nell'ordine
   * sbagliato (o ne usa altri) passerebbe.
   */
  const CYCLE_FOR: Record<string, Partial<Reader<PrCycle>>> = {
    reviewing: { state: "reviewing" },
    correcting: { state: "correcting" },
    correctingRound: { state: "correcting", round: 2 },
    approved: { state: "approved" },
    changesRequested: { state: "changes_requested" },
    stoppedAtCap_one: { state: "stopped_at_cap", round: 1 },
    stoppedAtCap_other: { state: "stopped_at_cap", round: 3 },
    correctionFailed: { state: "correction_failed" },
    idle: { state: "idle" },
    heldBudget: { state: "correcting", heldReason: "budget", canResume: true, heldJobId: HELD_JOB_ID },
    heldBudgetRound: { state: "correcting", round: 2, heldReason: "budget", canResume: true, heldJobId: HELD_JOB_ID },
    heldBudgetNeedsMaintainer: { state: "correcting", heldReason: "budget", canResume: false, heldJobId: HELD_JOB_ID },
    heldBudgetNeedsMaintainerRound: {
      state: "correcting",
      round: 2,
      heldReason: "budget",
      canResume: false,
      heldJobId: HELD_JOB_ID,
    },
    heldLimit: { state: "correcting", heldReason: "limit", canResume: false, heldJobId: HELD_JOB_ID },
    heldLimitRound: { state: "correcting", round: 2, heldReason: "limit", canResume: false, heldJobId: HELD_JOB_ID },
    heldOther: { state: "correcting", heldReason: "other", canResume: true, heldJobId: HELD_JOB_ID },
    heldOtherRound: { state: "correcting", round: 2, heldReason: "other", canResume: true, heldJobId: HELD_JOB_ID },
  };

  /** Un i18next coi cataloghi del WEB, per mettere in parole la riga del web con i SUOI testi. */
  const webI18n = i18next.createInstance();
  beforeAll(async () => {
    await webI18n.init({
      compatibilityJSON: "v4",
      resources: { it: { translation: webIt }, en: { translation: webEn } },
      lng: "it",
      interpolation: { escapeValue: false },
    });
  });

  /** L'ordine della frase del web: il giro prima dello stato, poi il resto. */
  const webOrder = (card: ReturnType<typeof prCycleCardFor>) => {
    const isRound = (segment: { key: string }) => segment.key === "mobile.work.pr.card.detail.round";
    return [...card.details.filter(isRound), card.chip, ...card.details.filter((segment) => !isRound(segment))];
  };

  it.each(["it", "en"] as const)("%s: la card PRODOTTA ricompone la frase del web, coi pezzi della tabella", (lang) => {
    const tApp = i18n.getFixedT(lang);
    const tWebFixed = webI18n.getFixedT(lang);
    const tWeb = ((key: string, params?: Record<string, unknown>) =>
      tWebFixed(key.replace("mobile.work.pr.cycle.", "tickets.cycle."), params)) as TFunction;
    expect(Object.keys(CYCLE_FOR).sort()).toEqual(CARD_PIECES.map(([webKey]) => webKey).sort());
    for (const [webKey, pieces, separator] of CARD_PIECES) {
      const c = cycle(CYCLE_FOR[webKey]);
      const ordered = webOrder(prCycleCardFor(c));
      // I pezzi sono quelli della tabella (le varianti `_one`/`_other` le sceglie i18next da `count`).
      expect([webKey, ordered.map((segment) => segment.key)]).toEqual([
        webKey,
        pieces.map((piece) => `mobile.work.pr.${piece.replace(/_(one|other)$/, "")}`),
      ]);
      const composed = compose(
        ordered.map((segment) => tApp(segment.key, segment.params)),
        separator,
      );
      const webLine = prCycleLineFor(c);
      expect(webLine.segments.map((segment) => segment.key)).toEqual([`mobile.work.pr.cycle.${webKey.replace(/_(one|other)$/, "")}`]);
      expect([webKey, composed]).toEqual([webKey, prCycleText(webLine, tWeb)]);
    }
  });

  it.each(catalogs)("%s: nessun pezzo della card senza gemello sul web", (_lang, app) => {
    const used = new Set(CARD_PIECES.flatMap(([, pieces]) => pieces));
    const card = app.mobile.work.pr.card as Record<string, Record<string, string>>;
    const declared = Object.entries(card).flatMap(([group, entries]) => Object.keys(entries).map((key) => `card.${group}.${key}`));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((key) => !used.has(key))).toEqual([]);
  });

  it("ogni chiave che `prCycleLineFor` può produrre esiste nei due cataloghi", () => {
    const produced = new Set<string>();
    const reasons = [null, "budget", "limit", "other", UNKNOWN] as const;
    const states = ["reviewing", "correcting", "approved", "changes_requested", "stopped_at_cap", "correction_failed", "idle", UNKNOWN] as const;
    const requests = [
      null,
      { via: "stubwise" as const, platform: null, name: "a", at: "2026-09-30T10:00:00.000Z" },
      { via: "stubwise" as const, platform: null, name: "", at: "2026-09-30T10:00:00.000Z" },
      { via: "provider" as const, platform: "github" as const, name: "a", at: "2026-09-30T10:00:00.000Z" },
      { via: "provider" as const, platform: "github" as const, name: "", at: "2026-09-30T10:00:00.000Z" },
      { via: "provider" as const, platform: null, name: "a", at: "2026-09-30T10:00:00.000Z" },
      { via: "provider" as const, platform: null, name: "", at: "2026-09-30T10:00:00.000Z" },
    ];
    for (const state of states)
      for (const heldReason of reasons)
        for (const canResume of [true, false])
          for (const round of [0, 2])
            for (const pendingRequest of [true, false])
              for (const lastRequest of requests)
                for (const s of prCycleLineFor(cycle({ state, heldReason, canResume, round, pendingRequest, lastRequest })).segments)
                  produced.add(s.key);
    for (const key of produced) {
      for (const lang of ["it", "en"]) {
        // `stoppedAtCap` vive come `_one`/`_other`: i18next sceglie da `count`.
        expect([lang, key, i18n.exists(key, { lng: lang, count: 2 })]).toEqual([lang, key, true]);
      }
    }
  });
});
