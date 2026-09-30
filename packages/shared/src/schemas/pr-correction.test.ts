import { describe, expect, it } from "vitest";
import { readerSchema, UNKNOWN } from "../reader.js";
import {
  prCommentSchema,
  prCycleEventSchema,
  prCycleSchema,
  requestCorrectionBodySchema,
  requestCorrectionResponseSchema,
} from "./pr-correction.js";

/**
 * Il ciclo di una PR lo DERIVA il server e il client lo legge (stessa regola
 * di `canMerge`): web e app non possono dire cose diverse. Lo schema passa da
 * `readerSchema` perché è così che l'app legge davvero — e un server futuro
 * che aggiungesse uno stato non deve far fallire il parse del dettaglio
 * ticket su un telefono già installato.
 */

const CICLO = {
  state: "correcting",
  round: 2,
  maxRounds: 3,
  pendingRequest: false,
  lastRequest: {
    via: "provider",
    platform: "bitbucket",
    name: "mario.rossi",
    at: "2026-09-30T10:00:00.000Z",
  },
  canRequestCorrection: false,
};

describe("prCycleSchema", () => {
  it("parsa un ciclo completo", () => {
    expect(prCycleSchema.parse(CICLO)).toEqual(CICLO);
  });

  it("lastRequest può essere null (nessuna richiesta umana)", () => {
    expect(prCycleSchema.parse({ ...CICLO, lastRequest: null }).lastRequest).toBeNull();
  });

  it("lastRequest SENZA platform (server più vecchio) si legge platform null", () => {
    // Regola dell'app mobile: un campo nuovo non è mai obbligatorio. Un server
    // che non manda `platform` non deve far fallire il parse del dettaglio
    // ticket su un telefono già installato.
    const senzaPiattaforma = { via: "provider", name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" };
    const parsed = readerSchema(prCycleSchema).parse({ ...CICLO, lastRequest: senzaPiattaforma });
    expect(parsed.lastRequest?.platform).toBeNull();
    expect(prCycleSchema.parse({ ...CICLO, lastRequest: senzaPiattaforma }).lastRequest?.platform).toBeNull();
  });

  it("uno stato che il client non conosce diventa UNKNOWN, non un parse fallito", () => {
    const parsed = readerSchema(prCycleSchema).parse({ ...CICLO, state: "merging" });
    expect(parsed.state).toBe(UNKNOWN);
  });

  it("una richiesta dal bottone non ha piattaforma: platform null", () => {
    const parsed = prCycleSchema.parse({
      ...CICLO,
      lastRequest: { ...CICLO.lastRequest, via: "stubwise", platform: null },
    });
    expect(parsed.lastRequest?.platform).toBeNull();
  });

  it("una piattaforma che il client non conosce diventa UNKNOWN", () => {
    const parsed = readerSchema(prCycleSchema).parse({
      ...CICLO,
      lastRequest: { ...CICLO.lastRequest, platform: "gitlab" },
    });
    expect(parsed.lastRequest?.platform).toBe(UNKNOWN);
  });

  it("anche un `via` sconosciuto dentro lastRequest diventa UNKNOWN", () => {
    const parsed = readerSchema(prCycleSchema).parse({
      ...CICLO,
      lastRequest: { ...CICLO.lastRequest, via: "gitlab" },
    });
    expect(parsed.lastRequest?.via).toBe(UNKNOWN);
  });

  it("lo schema RIGIDO (quello del server) rifiuta uno stato sconosciuto", () => {
    expect(() => prCycleSchema.parse({ ...CICLO, state: "merging" })).toThrow();
  });
});

describe("requestCorrectionBodySchema", () => {
  it("la nota è facoltativa: `{}` è un corpo valido", () => {
    expect(requestCorrectionBodySchema.parse({})).toEqual({});
  });

  it("la nota viene ripulita dagli spazi ai bordi", () => {
    expect(requestCorrectionBodySchema.parse({ note: "  rinomina la funzione  " }).note).toBe(
      "rinomina la funzione",
    );
  });

  it("oltre 4000 caratteri è rifiutata", () => {
    expect(() => requestCorrectionBodySchema.parse({ note: "x".repeat(4001) })).toThrow();
  });
});

describe("requestCorrectionResponseSchema", () => {
  it("porta l'id della correzione", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(requestCorrectionResponseSchema.parse({ correctionId: id }).correctionId).toBe(id);
  });
});

describe("prCommentSchema", () => {
  it("un commento generale ha path e line null; uno inline li porta", () => {
    const base = {
      id: "1",
      authorId: "{abc}",
      authorLogin: "mario.rossi",
      body: "qui manca il test",
      createdAt: "2026-09-30T10:00:00.000Z",
    };
    expect(prCommentSchema.parse({ ...base, path: null, line: null }).path).toBeNull();
    expect(prCommentSchema.parse({ ...base, path: "src/a.ts", line: 12 }).line).toBe(12);
  });
});

describe("prCycleEventSchema", () => {
  it("la fotografia del ciclo nell'evento review.completed", () => {
    expect(prCycleEventSchema.parse({ round: 3, max: 3, stopped: true })).toEqual({
      round: 3,
      max: 3,
      stopped: true,
    });
  });
});
