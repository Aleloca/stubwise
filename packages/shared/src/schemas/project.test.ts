import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { projectDetailSchema, projectListItemSchema, projectSchema } from "./project.js";

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
