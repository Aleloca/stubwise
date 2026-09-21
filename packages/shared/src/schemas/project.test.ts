import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import {
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
  projectSchema,
} from "./project.js";

/**
 * COMPATIBILITÀ VERSO L'APP GIÀ INSTALLATA.
 *
 * `projectListItemSchema` è lo schema con cui `@stubwise/api-client` valida
 * `GET /api/projects`, e quel client è compilato DENTRO l'app mobile: l'app si
 * aggiorna dagli store, il server dai nostri deploy. Un'app dell'ondata 5
 * contro un server senza fase 5 (rollback, o un'istanza self-hosted non ancora
 * aggiornata — l'app è UNA per tutte le istanze) riceve una lista progetti
 * SENZA `weeklyBriefEnabled`.
 *
 * `readerSchema` non copre questo caso: apre gli enum, non i campi mancanti.
 * Quindi un campo nuovo obbligatorio fa fallire il parse dell'INTERA lista →
 * tab Progetti e onboarding vuoti su ogni telefono. È la trappola di
 * `notificationPrefsViewSchema.push` della fase 4 in forma nuova, e la regola
 * che ne discende è: ogni campo nuovo in uno schema che l'app LEGGE nasce
 * `.default()`, `.optional()` o `.nullable()`.
 */

/** Progetto come lo emette un server SENZA la fase 5 (nessun campo brief). */
function progettoSenzaFase5(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Stubwise",
    slug: "stubwise",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    ingestionKey: "ing_esempio",
    nextTicketNumber: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("projectSchema: campi della fase 5 verso un server più vecchio", () => {
  it("parsa un progetto senza `weeklyBriefEnabled`, che diventa false", () => {
    const parsed = projectSchema.parse(progettoSenzaFase5());
    expect(parsed.weeklyBriefEnabled).toBe(false);
  });

  it("la LISTA progetti — la risposta che l'app legge all'avvio — regge il campo assente", () => {
    const parsed = projectListItemSchema.parse({
      ...progettoSenzaFase5(),
      repositoryCount: 2,
    });
    expect(parsed.weeklyBriefEnabled).toBe(false);
    expect(parsed.repositoryCount).toBe(2);
  });

  it("anche il DETTAGLIO progetto regge il campo assente", () => {
    const parsed = projectDetailSchema.parse({
      ...progettoSenzaFase5(),
      repositories: [],
    });
    expect(parsed.weeklyBriefEnabled).toBe(false);
  });

  it("regge anche attraverso `readerSchema`, che è la strada vera del client", () => {
    const parsed = readerSchema(projectListItemSchema).parse({
      ...progettoSenzaFase5(),
      repositoryCount: 0,
    }) as { weeklyBriefEnabled: boolean };
    expect(parsed.weeklyBriefEnabled).toBe(false);
  });

  it("un server CON la fase 5 continua a essere letto verbatim", () => {
    const parsed = projectSchema.parse(progettoSenzaFase5({ weeklyBriefEnabled: true }));
    expect(parsed.weeklyBriefEnabled).toBe(true);
  });
});

/**
 * STESSA REGOLA, campo nuovo: il quarto secchio del polso (21 set 2026).
 *
 * `projectPulseSummarySchema` è la risposta di `GET /api/projects/pulse`, la
 * vista di APERTURA dell'app mobile. Un'app che conosce `stalled` e
 * `waitingForMerge` può benissimo parlare con un server che non li manda — un
 * rollback, o un'istanza self-hosted rimasta indietro — e se quei campi
 * fossero obbligatori il parse dell'INTERA risposta fallirebbe: non una riga
 * mancante, la schermata di apertura vuota su ogni telefono.
 *
 * La fixture qui sotto è lasciata SENZA i due campi APPOSTA: è la prova che la
 * difesa c'è, non una svista da completare.
 */
function polsoSenzaQuartoSecchio(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "22222222-2222-4222-8222-222222222222",
    projectName: "Stubwise",
    waitingForYou: [],
    waitingForOthers: [],
    running: [],
    failedCount: 0,
    backlogReadyCount: 0,
    idleDays: 3,
    lastReportDate: null,
    ...overrides,
  };
}

describe("projectPulseSummarySchema: il quarto secchio verso un server più vecchio", () => {
  it("parsa un polso senza `stalled` e `waitingForMerge`, che diventano liste vuote", () => {
    const parsed = projectPulseSummarySchema.parse(polsoSenzaQuartoSecchio());
    expect(parsed.stalled).toEqual([]);
    expect(parsed.waitingForMerge).toEqual([]);
  });

  it("regge anche attraverso `readerSchema`, che è la strada vera del client", () => {
    const parsed = readerSchema(projectPulseSummarySchema).parse(polsoSenzaQuartoSecchio()) as {
      stalled: unknown[];
      waitingForMerge: unknown[];
    };
    expect(parsed.stalled).toEqual([]);
    expect(parsed.waitingForMerge).toEqual([]);
  });

  it("un motivo SCONOSCIUTO non fa fallire il parse del client: `readerSchema` lo apre", () => {
    // Il verso opposto: un server PIÙ NUOVO che aggiunge un quinto motivo. Con
    // un enum chiuso il polso sparirebbe; `readerSchema` lo riporta come
    // ignoto e la riga resta disegnabile (stesso trattamento di
    // `pulseWaitingKind` in `apps/mobile/src/lib/pulse-line.ts`).
    const parsed = readerSchema(projectPulseSummarySchema).parse(
      polsoSenzaQuartoSecchio({
        stalled: [
          {
            ticketId: "33333333-3333-4333-8333-333333333333",
            ticketNumber: 25,
            title: "Un ticket fermo",
            stalledSince: "2026-09-01T10:00:00.000Z",
            reason: "un_motivo_che_non_esiste_ancora",
          },
        ],
      }),
    ) as { stalled: { reason: unknown }[] };
    expect(parsed.stalled).toHaveLength(1);
    expect(parsed.stalled[0]!.reason).not.toBe("un_motivo_che_non_esiste_ancora");
  });

  it("un server CON il quarto secchio continua a essere letto verbatim", () => {
    const parsed = projectPulseSummarySchema.parse(
      polsoSenzaQuartoSecchio({
        waitingForMerge: [
          {
            ticketId: "44444444-4444-4444-8444-444444444444",
            ticketNumber: 31,
            title: "Una PR da mergiare",
            prUrl: "https://example.com/pr/31",
            canMerge: false,
          },
        ],
      }),
    );
    expect(parsed.waitingForMerge[0]?.canMerge).toBe(false);
  });
});
