import type { PrCycle, Reader } from "@stubwise/shared";
import { prCycleSchema, readerSchema, UNKNOWN } from "@stubwise/shared";
import type { TFunction } from "i18next";
import webEn from "../../../web/src/i18n/locales/en.json";
import webIt from "../../../web/src/i18n/locales/it.json";
import i18n from "../i18n";
import appEn from "../i18n/en.json";
import appIt from "../i18n/it.json";
import { prCycleLineFor, prCycleText } from "./pr-cycle";

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

  it("uno stato che l'app non conosce (UNKNOWN da readerSchema) non lancia: chiave neutra", () => {
    const line = prCycleLineFor(oldServerCycle({ state: "stato_futuro" }));
    expect(line.segments[0]!.key).toBe("mobile.work.pr.cycle.unknown");
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
      expect(prCycleLineFor(cycle({ state: UNKNOWN })).tone).toBe("faint");
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
 * Ogni testo della riga di stato e degli errori che il web ha, l'app lo ha
 * IDENTICO, in entrambe le lingue — letto dai cataloghi del web, non copiato
 * qui. `unknown` è l'unica eccezione voluta: solo l'app può restare indietro
 * rispetto al server, e allora dice «aggiorna l'app».
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
